import { keccak256, toBytes } from "viem";
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from "jose";

/**
 * W3C Verifiable Credentials, issued as signed JWTs.
 *
 * The division of labour is the whole design:
 *
 *   - the **credential** carries the claims, and lives off-chain;
 *   - the **chain** stores only `keccak256(jwt)` plus issuance and revocation state;
 *   - a **verifier** hashes the credential it was handed and asks the chain about it.
 *
 * So the chain can answer "is this genuine, and is it still valid?" without ever learning
 * what the credential says. That is what makes the platform's second hard rule — never
 * store PII on-chain — hold in the one place it is most tempting to break, because a
 * credential is exactly the object that contains personal data.
 *
 * The hash is taken over the compact JWT serialisation rather than over a canonicalised
 * JSON form. A JWT is already a fixed byte string that both parties possess verbatim, so
 * there is nothing to canonicalise and no chance of two implementations disagreeing about
 * key ordering or Unicode normalisation. The tradeoff is that re-signing the same claims
 * yields a different hash, which is correct: it is a different credential.
 */

const ALGORITHM = "RS256";
const VC_CONTEXT = "https://www.w3.org/2018/credentials/v1";
const VC_TYPE = "VerifiableCredential";

export interface CredentialClaims {
  readonly [key: string]: string | number | boolean;
}

export interface IssueInput {
  /** Subject's DID hash, as registered in DIDRegistry. */
  didHash: string;
  /** Issuer's wallet address. */
  issuer: string;
  credentialType: string;
  claims: CredentialClaims;
  /** Unix seconds; 0 means it never expires. */
  expiresAt?: number;
  /** Injected so tests are deterministic. */
  now?: Date;
  /** Stable identifier for this credential. Generated when absent. */
  id?: string;
}

export interface VerifiableCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: { id: string } & CredentialClaims;
}

export interface IssuedCredential {
  /** Compact JWT. This is the artifact handed to the holder. */
  jwt: string;
  /** keccak256 of the JWT — the only part that reaches the chain. */
  credentialHash: `0x${string}`;
  /** keccak256 of the credential type — the on-chain schema identifier. */
  schemaId: `0x${string}`;
  credential: VerifiableCredential;
  expiresAt: number;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_jwt" | "expired" | "bad_signature" | "malformed_claims",
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Derives the on-chain schema id from the credential type name. */
export function schemaIdOf(credentialType: string): `0x${string}` {
  return keccak256(toBytes(credentialType));
}

/** The hash a verifier computes from the credential they were shown. */
export function credentialHashOf(jwt: string): `0x${string}` {
  return keccak256(toBytes(jwt));
}

/**
 * Rejects claim payloads that do not belong in a credential.
 *
 * Nesting is refused rather than flattened: a nested object invites arbitrary structure
 * into a document that is signed, pinned and then permanent, and every downstream
 * consumer would have to agree on how to traverse it. Flat scalar claims keep the
 * credential reviewable by the person it describes.
 */
export function assertClaims(claims: unknown): asserts claims is CredentialClaims {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new CredentialError("claims must be a flat object", "malformed_claims");
  }

  for (const [key, value] of Object.entries(claims)) {
    if (key === "id") {
      throw new CredentialError(
        "claims may not set `id`; the subject identifier is derived from the DID",
        "malformed_claims",
      );
    }
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new CredentialError(
        `claim \`${key}\` must be a string, number or boolean`,
        "malformed_claims",
      );
    }
  }
}

export function buildCredential(input: IssueInput): VerifiableCredential {
  assertClaims(input.claims);

  const now = input.now ?? new Date();
  const id = input.id ?? `urn:uuid:${crypto.randomUUID()}`;

  return {
    "@context": [VC_CONTEXT],
    id,
    type: [VC_TYPE, input.credentialType],
    issuer: input.issuer,
    issuanceDate: now.toISOString(),
    ...(input.expiresAt && input.expiresAt > 0
      ? { expirationDate: new Date(input.expiresAt * 1000).toISOString() }
      : {}),
    credentialSubject: { id: `did:trustchain:${input.didHash}`, ...input.claims },
  };
}

/**
 * Signs credentials and verifies them.
 *
 * The signing key is separate from the session-token key by construction — this class
 * takes its own PEM. A session token is short-lived and internal; a credential is
 * long-lived and verified by third parties who need the public half. Sharing one key
 * would mean handing every credential verifier the means to check session tokens, and
 * would tie the rotation schedule of a seven-day secret to that of a multi-year one.
 */
export class CredentialIssuer {
  constructor(
    private readonly keys: { privateKeyPem: string; publicKeyPem: string },
    private readonly issuerId = "trustchain",
  ) {}

  async issue(input: IssueInput): Promise<IssuedCredential> {
    const credential = buildCredential(input);
    const now = input.now ?? new Date();
    const issuedAtSeconds = Math.floor(now.getTime() / 1000);

    const payload: JWTPayload = {
      vc: credential,
      // JWT registered claims mirror the VC fields, per the W3C JWT encoding. A verifier
      // that only understands JWTs still gets correct subject, expiry and issuer.
      jti: credential.id,
    };

    let builder = new SignJWT(payload)
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setIssuer(this.issuerId)
      .setSubject(credential.credentialSubject.id)
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds);

    if (input.expiresAt && input.expiresAt > 0) {
      builder = builder.setExpirationTime(input.expiresAt);
    }

    const key = await importPKCS8(normalisePem(this.keys.privateKeyPem), ALGORITHM);
    const jwt = await builder.sign(key);

    return {
      jwt,
      credentialHash: credentialHashOf(jwt),
      schemaId: schemaIdOf(input.credentialType),
      credential,
      expiresAt: input.expiresAt ?? 0,
    };
  }

  /**
   * Verifies the signature and returns the embedded credential.
   *
   * Signature only — this says the credential was issued by us and has not been altered.
   * It says nothing about revocation, which is a live question only the chain can answer.
   * The two checks are kept apart so neither can be mistaken for the other.
   */
  async verifySignature(jwt: string): Promise<VerifiableCredential> {
    const key = await importSPKI(normalisePem(this.keys.publicKeyPem), ALGORITHM);

    let payload: JWTPayload;
    try {
      payload = (await jwtVerify(jwt, key, { issuer: this.issuerId })).payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      if (message.includes('"exp"')) {
        throw new CredentialError("credential has expired", "expired");
      }
      throw new CredentialError(`credential signature is not valid: ${message}`, "bad_signature");
    }

    const vc = payload.vc as VerifiableCredential | undefined;
    if (!vc || !Array.isArray(vc.type) || !vc.type.includes(VC_TYPE)) {
      throw new CredentialError("token does not carry a verifiable credential", "invalid_jwt");
    }

    return vc;
  }
}

/** Accepts PEMs whose newlines survived an environment variable as `\n`. */
function normalisePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}
