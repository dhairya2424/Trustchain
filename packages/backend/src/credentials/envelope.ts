import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypted envelope for pinning a credential to IPFS.
 *
 * The build plan says to pin the credential payload. Pinning it as-is would be a serious
 * privacy failure, and it is worth stating plainly why: IPFS is a public content-addressed
 * network, so a pinned credential is world-readable to anyone who learns the CID, and it
 * is effectively permanent — unpinning removes our copy, not everyone else's. A credential
 * is the one document in this system that is *made of* personal data. Publishing it would
 * defeat the entire reason the chain stores only a hash; the PII would simply have moved
 * one layer sideways, into a store with no access control and no delete.
 *
 * So the payload is pinned encrypted. IPFS gets durable, content-addressed availability;
 * the plaintext stays readable only to whoever holds the content key.
 *
 * The content key is generated per credential, returned to the issuer exactly once in the
 * issuance response, and never stored by this service — not in the database, not in a log,
 * not on-chain. That is the deliberate consequence of the design: a lost key means a lost
 * IPFS copy. It is recoverable in the sense that matters, because the holder already has
 * the JWT itself; the pin is durable backup, not the system of record.
 *
 * Layout is a JSON document rather than a packed binary blob because it must remain
 * readable by a recovery tool written years from now, possibly not by us.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const ENVELOPE_FORMAT = "trustchain-encrypted-credential";
export const ENVELOPE_VERSION = 1;

export interface SealedEnvelope {
  format: typeof ENVELOPE_FORMAT;
  version: number;
  alg: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
  /**
   * Non-sensitive anchors, carried so a recovered envelope is self-describing.
   *
   * The credential hash and schema id are already public on-chain, so including them
   * discloses nothing new — while omitting them would leave a recovered blob with no way
   * to tell what it is or which on-chain record it belongs to.
   */
  credentialHash: string;
  schemaId: string;
  sealedAt: string;
}

export interface SealResult {
  envelope: SealedEnvelope;
  /** base64 content key. Returned to the caller once; never persisted here. */
  contentKey: string;
}

export class EnvelopeError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "bad_key",
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export function sealCredential(options: {
  jwt: string;
  credentialHash: string;
  schemaId: string;
  now?: Date;
  /** Injected only by tests that need a fixed key. */
  contentKey?: Buffer;
}): SealResult {
  const key = options.contentKey ?? randomBytes(KEY_BYTES);
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError(`content key must be ${KEY_BYTES} bytes`, "bad_key");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // The public anchors are bound into the authentication tag, so an envelope cannot be
  // relabelled to point at a different on-chain record without failing to decrypt.
  const aad = Buffer.from(`${options.credentialHash}:${options.schemaId}`, "utf8");
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(options.jwt, "utf8"), cipher.final()]);

  return {
    contentKey: key.toString("base64"),
    envelope: {
      format: ENVELOPE_FORMAT,
      version: ENVELOPE_VERSION,
      alg: "A256GCM",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      credentialHash: options.credentialHash,
      schemaId: options.schemaId,
      sealedAt: (options.now ?? new Date()).toISOString(),
    },
  };
}

/** Recovers the JWT. Used by the recovery path and by the round-trip tests. */
export function openCredential(envelope: SealedEnvelope, contentKey: string): string {
  if (envelope.format !== ENVELOPE_FORMAT || envelope.version !== ENVELOPE_VERSION) {
    throw new EnvelopeError("unrecognised envelope format or version", "malformed");
  }

  const key = Buffer.from(contentKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError(`content key must be ${KEY_BYTES} bytes`, "bad_key");
  }

  // Lengths are checked before the values are handed to the cipher. `createDecipheriv` and
  // `setAuthTag` throw raw TypeErrors on a wrong-sized IV or tag, and this envelope comes
  // from IPFS — a public store where anyone can pin a malformed document. An unhandled
  // TypeError from user-supplied data is a crash, not a rejection.
  const iv = Buffer.from(envelope.iv, "base64");
  if (iv.length !== IV_BYTES) {
    throw new EnvelopeError(`envelope iv must be ${IV_BYTES} bytes`, "malformed");
  }

  const tag = Buffer.from(envelope.tag, "base64");
  if (tag.length !== TAG_BYTES) {
    throw new EnvelopeError(`envelope tag must be ${TAG_BYTES} bytes`, "malformed");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(`${envelope.credentialHash}:${envelope.schemaId}`, "utf8"));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new EnvelopeError(
      "authentication failed: wrong key, altered ciphertext, or relabelled envelope",
      "bad_key",
    );
  }
}
