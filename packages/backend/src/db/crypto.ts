import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Envelope version, so a future key rotation can be told apart from this format. */
const VERSION = 1;

export class DecryptionError extends Error {
  constructor(
    message: string,
    readonly code: "bad_key" | "tampered" | "malformed" | "wrong_context",
  ) {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Identifies which row and column a ciphertext belongs to.
 *
 * Bound into the GCM authentication tag as additional authenticated data. Without it,
 * ciphertext is portable: someone with UPDATE on the table could copy another user's
 * encrypted kyc_ref into their own row and the application would decrypt it happily,
 * because the bytes are perfectly valid. Binding makes that a decryption failure.
 */
export interface FieldContext {
  table: string;
  column: string;
  rowId: string;
}

function aad(context: FieldContext): Buffer {
  return Buffer.from(`v${VERSION}:${context.table}:${context.column}:${context.rowId}`, "utf8");
}

export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`field encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/**
 * AES-256-GCM field encryption.
 *
 * Application-layer rather than pgsodium: the database never sees plaintext or the key,
 * so a database backup, a replica, or a compromised `SELECT *` yields ciphertext only.
 * With in-database encryption the key lives where the data lives, which weakens exactly
 * the scenario this is meant to survive.
 *
 * Envelope layout: version(1) || iv(12) || tag(16) || ciphertext
 */
export class FieldCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = parseKey(base64Key);
  }

  encrypt(plaintext: string, context: FieldContext): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(aad(context));

    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
  }

  decrypt(envelope: Buffer, context: FieldContext): string {
    if (envelope.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new DecryptionError("ciphertext envelope is too short", "malformed");
    }

    const version = envelope[0];
    if (version !== VERSION) {
      throw new DecryptionError(`unsupported envelope version ${version}`, "malformed");
    }

    const iv = envelope.subarray(1, 1 + IV_BYTES);
    const tag = envelope.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = envelope.subarray(1 + IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // GCM cannot distinguish a wrong key from altered bytes from the wrong row —
      // all three fail the same tag check, which is the property that makes it useful.
      throw new DecryptionError(
        "authentication failed: wrong key, altered ciphertext, or wrong row/column",
        "tampered",
      );
    }
  }

  /** Null-tolerant helpers, since these columns are optional. */
  encryptOptional(value: string | null | undefined, context: FieldContext): Buffer | null {
    return value === null || value === undefined ? null : this.encrypt(value, context);
  }

  decryptOptional(envelope: Buffer | null | undefined, context: FieldContext): string | null {
    return envelope === null || envelope === undefined ? null : this.decrypt(envelope, context);
  }
}

/** Constant-time comparison for any equality check on secret material. */
export function safeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
