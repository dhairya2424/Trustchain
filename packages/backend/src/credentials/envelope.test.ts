import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { EnvelopeError, openCredential, sealCredential, ENVELOPE_FORMAT } from "./envelope";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkaWQ6dHJ1c3RjaGFpbjoweGFiYyJ9.c2ln"; // secrets-scan:allow inert fixture
const HASH = `0x${"a".repeat(64)}`;
const SCHEMA = `0x${"b".repeat(64)}`;

const seal = () => sealCredential({ jwt: JWT, credentialHash: HASH, schemaId: SCHEMA });

describe("sealCredential", () => {
  it("round-trips the credential", () => {
    const { envelope, contentKey } = seal();

    expect(openCredential(envelope, contentKey)).toBe(JWT);
  });

  /**
   * The reason this module exists. IPFS is public and effectively permanent, so pinning a
   * credential in the clear would publish the very personal data the chain deliberately
   * avoids — it would have moved the PII sideways into a store with no access control and
   * no delete, rather than protected it.
   */
  it("does not leave the credential readable in the pinned document", () => {
    const { envelope } = seal();

    expect(JSON.stringify(envelope)).not.toContain(JWT);
    expect(JSON.stringify(envelope)).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("does not put the content key in the pinned document", () => {
    const { envelope, contentKey } = seal();

    expect(JSON.stringify(envelope)).not.toContain(contentKey);
  });

  it("uses a fresh key and IV per credential, so two seals never match", () => {
    const a = seal();
    const b = seal();

    expect(a.contentKey).not.toBe(b.contentKey);
    expect(a.envelope.iv).not.toBe(b.envelope.iv);
    expect(a.envelope.ciphertext).not.toBe(b.envelope.ciphertext);
  });

  it("is self-describing, so a recovered blob can be identified years later", () => {
    const { envelope } = seal();

    expect(envelope.format).toBe(ENVELOPE_FORMAT);
    expect(envelope.version).toBe(1);
    expect(envelope.alg).toBe("A256GCM");
    // Already public on-chain, so carrying them discloses nothing new.
    expect(envelope.credentialHash).toBe(HASH);
    expect(envelope.schemaId).toBe(SCHEMA);
  });

  it("issues a 32-byte content key", () => {
    expect(Buffer.from(seal().contentKey, "base64")).toHaveLength(32);
  });

  it("refuses a content key of the wrong length", () => {
    expect(() =>
      sealCredential({
        jwt: JWT,
        credentialHash: HASH,
        schemaId: SCHEMA,
        contentKey: randomBytes(16),
      }),
    ).toThrowError(EnvelopeError);
  });
});

describe("openCredential", () => {
  it("rejects the wrong key", () => {
    const { envelope } = seal();

    expect(() => openCredential(envelope, randomBytes(32).toString("base64"))).toThrowError(
      /authentication failed/,
    );
  });

  it("rejects altered ciphertext", () => {
    const { envelope, contentKey } = seal();
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] as number) ^ 0xff;

    expect(() =>
      openCredential({ ...envelope, ciphertext: bytes.toString("base64") }, contentKey),
    ).toThrowError(EnvelopeError);
  });

  /**
   * The on-chain anchors are bound into the GCM tag. Without that, an envelope could be
   * relabelled to claim it belongs to a different credential — the bytes would still
   * decrypt, and a recovery tool would report a credential under the wrong hash.
   */
  it("rejects an envelope relabelled to a different credential hash", () => {
    const { envelope, contentKey } = seal();

    expect(() =>
      openCredential({ ...envelope, credentialHash: `0x${"c".repeat(64)}` }, contentKey),
    ).toThrowError(/relabelled|authentication failed/);
  });

  it("rejects an envelope relabelled to a different schema", () => {
    const { envelope, contentKey } = seal();

    expect(() =>
      openCredential({ ...envelope, schemaId: `0x${"d".repeat(64)}` }, contentKey),
    ).toThrowError(EnvelopeError);
  });

  /**
   * The envelope comes back from IPFS, where anyone can pin a malformed document. Node's
   * cipher throws a raw TypeError on a wrong-sized tag or IV, so these must be
   * length-checked first — otherwise attacker-supplied data crashes the handler instead of
   * being rejected.
   */
  it("rejects a truncated authentication tag without throwing a raw TypeError", () => {
    const { envelope, contentKey } = seal();

    expect(() => openCredential({ ...envelope, tag: "AAAA" }, contentKey)).toThrowError(
      EnvelopeError,
    );
  });

  it("rejects a wrong-sized IV without throwing a raw TypeError", () => {
    const { envelope, contentKey } = seal();

    expect(() => openCredential({ ...envelope, iv: "AAAA" }, contentKey)).toThrowError(
      EnvelopeError,
    );
  });

  it("rejects an unrecognised format", () => {
    const { envelope, contentKey } = seal();

    expect(() =>
      openCredential({ ...envelope, format: "something-else" as never }, contentKey),
    ).toThrowError(/unrecognised/);
  });

  it("rejects a future envelope version rather than misreading it", () => {
    const { envelope, contentKey } = seal();

    expect(() => openCredential({ ...envelope, version: 2 }, contentKey)).toThrowError(
      /unrecognised/,
    );
  });

  it("rejects a content key of the wrong length", () => {
    const { envelope } = seal();

    expect(() => openCredential(envelope, randomBytes(16).toString("base64"))).toThrowError(
      /32 bytes/,
    );
  });
});
