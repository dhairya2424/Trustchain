import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptionError, FieldCipher, parseKey, safeEquals } from "./crypto";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

const context = (rowId = "did:alice", column = "kyc_ref") => ({
  table: "profiles",
  column,
  rowId,
});

describe("FieldCipher", () => {
  const cipher = new FieldCipher(KEY);

  it("round-trips a value", () => {
    const envelope = cipher.encrypt("KYC-REF-12345", context());

    expect(cipher.decrypt(envelope, context())).toBe("KYC-REF-12345");
  });

  it("never stores the plaintext in the ciphertext", () => {
    const envelope = cipher.encrypt("alice@example.com", context("did:alice", "email"));

    expect(envelope.toString("utf8")).not.toContain("alice@example.com");
    expect(envelope.toString("hex")).not.toContain(
      Buffer.from("alice@example.com").toString("hex"),
    );
  });

  it("produces a different ciphertext each time, so equal values are not linkable", () => {
    const first = cipher.encrypt("same-value", context());
    const second = cipher.encrypt("same-value", context());

    expect(first.equals(second)).toBe(false);
    expect(cipher.decrypt(first, context())).toBe(cipher.decrypt(second, context()));
  });

  it("rejects a ciphertext encrypted under a different key", () => {
    const envelope = new FieldCipher(OTHER_KEY).encrypt("secret", context());

    expect(() => cipher.decrypt(envelope, context())).toThrowError(DecryptionError);
  });

  it("detects a single flipped bit", () => {
    const envelope = cipher.encrypt("secret-value", context());
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 0x01;

    expect(() => cipher.decrypt(tampered, context())).toThrowError(/authentication failed/i);
  });

  it("detects a tampered authentication tag", () => {
    const envelope = cipher.encrypt("secret-value", context());
    const tampered = Buffer.from(envelope);
    tampered[14] ^= 0xff; // inside the tag

    expect(() => cipher.decrypt(tampered, context())).toThrowError(DecryptionError);
  });

  it("CONTEXT BINDING: a ciphertext cannot be moved to another user's row", () => {
    const aliceSecret = cipher.encrypt("alice-kyc-ref", context("did:alice"));

    // Someone with UPDATE on the table copies Alice's ciphertext into Bob's row. The
    // bytes are valid, so without AAD binding this would decrypt cleanly.
    expect(() => cipher.decrypt(aliceSecret, context("did:bob"))).toThrowError(
      /wrong key, altered ciphertext, or wrong row\/column/,
    );
  });

  it("CONTEXT BINDING: a ciphertext cannot be moved to another column", () => {
    const envelope = cipher.encrypt("value", context("did:alice", "kyc_ref"));

    expect(() => cipher.decrypt(envelope, context("did:alice", "email"))).toThrowError(
      DecryptionError,
    );
  });

  it("rejects a truncated or empty envelope rather than misreading it", () => {
    expect(() => cipher.decrypt(Buffer.alloc(0), context())).toThrowError(/too short/);
    expect(() => cipher.decrypt(Buffer.alloc(10), context())).toThrowError(/too short/);
  });

  it("rejects an unknown envelope version", () => {
    const envelope = cipher.encrypt("value", context());
    const rewritten = Buffer.from(envelope);
    rewritten[0] = 99;

    expect(() => cipher.decrypt(rewritten, context())).toThrowError(/unsupported envelope version/);
  });

  it("passes null through both directions, since these columns are optional", () => {
    expect(cipher.encryptOptional(null, context())).toBeNull();
    expect(cipher.decryptOptional(null, context())).toBeNull();
    expect(cipher.decryptOptional(cipher.encryptOptional("v", context()), context())).toBe("v");
  });

  it("handles unicode and long values", () => {
    const value = `${"नमस्ते ".repeat(50)}🔐`;
    expect(cipher.decrypt(cipher.encrypt(value, context()), context())).toBe(value);
  });
});

describe("key handling", () => {
  it("requires exactly 32 bytes", () => {
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrowError(/must be 32 bytes/);
    expect(() => parseKey(randomBytes(64).toString("base64"))).toThrowError(/must be 32 bytes/);
    expect(parseKey(KEY)).toHaveLength(32);
  });

  it("compares secret material in constant time", () => {
    const a = randomBytes(32);
    expect(safeEquals(a, Buffer.from(a))).toBe(true);
    expect(safeEquals(a, randomBytes(32))).toBe(false);
    expect(safeEquals(a, randomBytes(16))).toBe(false);
  });
});
