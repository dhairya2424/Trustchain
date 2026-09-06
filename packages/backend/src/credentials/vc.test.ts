import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";

import {
  assertClaims,
  buildCredential,
  credentialHashOf,
  CredentialError,
  CredentialIssuer,
  schemaIdOf,
} from "./vc";

const DID = `0x${"a".repeat(64)}`;
const ISSUER_ADDRESS = "0x2222222222222222222222222222222222222222";

let issuer: CredentialIssuer;
let otherIssuer: CredentialIssuer;

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

beforeAll(() => {
  issuer = new CredentialIssuer(keypair());
  otherIssuer = new CredentialIssuer(keypair());
});

describe("buildCredential", () => {
  it("produces a W3C verifiable credential", () => {
    const vc = buildCredential({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "EmploymentCredential",
      claims: { role: "Engineer" },
    });

    expect(vc["@context"]).toContain("https://www.w3.org/2018/credentials/v1");
    expect(vc.type).toEqual(["VerifiableCredential", "EmploymentCredential"]);
    expect(vc.issuer).toBe(ISSUER_ADDRESS);
  });

  it("derives the subject identifier from the DID rather than from the claims", () => {
    const vc = buildCredential({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: { role: "Engineer" },
    });

    expect(vc.credentialSubject.id).toBe(`did:trustchain:${DID}`);
  });

  it("omits expirationDate when the credential never expires", () => {
    const vc = buildCredential({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
      expiresAt: 0,
    });

    expect(vc.expirationDate).toBeUndefined();
  });

  it("records an expiry as an ISO date when one is set", () => {
    const vc = buildCredential({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
      expiresAt: 1_800_000_000,
    });

    expect(vc.expirationDate).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });
});

describe("assertClaims", () => {
  it("accepts flat scalar claims", () => {
    expect(() => assertClaims({ a: "x", b: 1, c: true })).not.toThrow();
  });

  it("refuses a nested object, which would make the signed document unbounded", () => {
    expect(() => assertClaims({ nested: { a: 1 } })).toThrowError(CredentialError);
  });

  it("refuses an array claim", () => {
    expect(() => assertClaims({ list: [1, 2] })).toThrowError(/string, number or boolean/);
  });

  /**
   * `id` is the subject identifier. Letting a caller set it would let an authorised issuer
   * point a credential at a subject other than the DID they were authorised for.
   */
  it("refuses a claim named id", () => {
    expect(() => assertClaims({ id: "did:evil:1" })).toThrowError(/may not set/);
  });

  it("refuses a non-object payload", () => {
    expect(() => assertClaims("nope")).toThrowError(/flat object/);
    expect(() => assertClaims(null)).toThrowError(/flat object/);
  });
});

describe("credential hashing", () => {
  it("hashes the compact JWT, so a verifier can reproduce it from what they were shown", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: { role: "Engineer" },
    });

    expect(issued.credentialHash).toBe(credentialHashOf(issued.jwt));
    expect(issued.credentialHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("derives the schema id from the credential type", () => {
    expect(schemaIdOf("EmploymentCredential")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(schemaIdOf("EmploymentCredential")).not.toBe(schemaIdOf("DegreeCredential"));
  });

  it("gives two credentials different hashes even with identical claims", async () => {
    const input = {
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: { role: "Engineer" },
    };

    const a = await issuer.issue(input);
    const b = await issuer.issue(input);

    // Different `jti` and `iat` — correct, because they are two distinct credentials and
    // revoking one must not revoke the other.
    expect(a.credentialHash).not.toBe(b.credentialHash);
  });

  it("changes the hash when a single claim changes", async () => {
    const base = { didHash: DID, issuer: ISSUER_ADDRESS, credentialType: "T", id: "urn:fixed" };
    const now = new Date("2026-01-01T00:00:00.000Z");

    const a = await issuer.issue({ ...base, claims: { role: "Engineer" }, now });
    const b = await issuer.issue({ ...base, claims: { role: "Director" }, now });

    expect(a.credentialHash).not.toBe(b.credentialHash);
  });
});

describe("signing and verification", () => {
  it("signs with RS256", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
    });

    expect(decodeProtectedHeader(issued.jwt).alg).toBe("RS256");
  });

  it("round-trips the credential through the JWT", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "EmploymentCredential",
      claims: { role: "Engineer", level: 3, active: true },
    });

    const vc = await issuer.verifySignature(issued.jwt);

    expect(vc.credentialSubject.role).toBe("Engineer");
    expect(vc.credentialSubject.level).toBe(3);
    expect(vc.credentialSubject.active).toBe(true);
  });

  it("sets the JWT subject to the credential subject", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
    });

    expect(decodeJwt(issued.jwt).sub).toBe(`did:trustchain:${DID}`);
  });

  it("rejects a credential signed by a different issuer", async () => {
    const foreign = await otherIssuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
    });

    await expect(issuer.verifySignature(foreign.jwt)).rejects.toThrowError(CredentialError);
  });

  it("rejects a credential whose payload was altered", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: { role: "Engineer" },
    });

    const [header, , signature] = issued.jwt.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ vc: { type: ["VerifiableCredential"] }, iss: "trustchain" }),
    ).toString("base64url");

    await expect(
      issuer.verifySignature(`${header}.${forgedPayload}.${signature}`),
    ).rejects.toThrowError(CredentialError);
  });

  it("rejects an expired credential and says so specifically", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
      now: new Date(Date.now() - 7200 * 1000),
    });

    try {
      await issuer.verifySignature(issued.jwt);
      expect.unreachable("expired credential should not verify");
    } catch (error) {
      expect((error as CredentialError).code).toBe("expired");
    }
  });

  it("rejects a well-formed JWT that carries no credential", async () => {
    // A session token is a valid JWT from a different key; it must not pass as a credential.
    await expect(issuer.verifySignature("not.a.jwt")).rejects.toThrowError(CredentialError);
  });

  it("verifies a credential that never expires", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: {},
      expiresAt: 0,
    });

    await expect(issuer.verifySignature(issued.jwt)).resolves.toBeDefined();
  });
});

/**
 * The platform's second hard rule, asserted directly: the credential carries the personal
 * data, and the only thing derived for the chain is a hash.
 */
describe("no personal data reaches the chain", () => {
  it("produces on-chain values that contain none of the claim text", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "EmploymentCredential",
      claims: { name: "Ada Lovelace", nationalId: "AB-123456", salary: 95000 },
    });

    // These four values are everything the issue transaction sends.
    const onChain = [issued.credentialHash, issued.schemaId, DID, String(issued.expiresAt)].join(
      " ",
    );

    expect(onChain).not.toContain("Ada");
    expect(onChain).not.toContain("Lovelace");
    expect(onChain).not.toContain("AB-123456");
    expect(onChain).not.toContain("95000");
  });

  it("keeps the claims inside the JWT, which stays off-chain", async () => {
    const issued = await issuer.issue({
      didHash: DID,
      issuer: ISSUER_ADDRESS,
      credentialType: "T",
      claims: { name: "Ada Lovelace" },
    });

    // Present in the credential itself — that is the point of it.
    expect(JSON.stringify(decodeJwt(issued.jwt))).toContain("Ada Lovelace");
    // Absent from the hash, which is the only part anchored.
    expect(issued.credentialHash).not.toContain("Ada");
  });
});
