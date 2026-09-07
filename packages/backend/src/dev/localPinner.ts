import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { IpfsPinner, PinnedFile } from "../assets/pinata";

/**
 * A content-addressed store on the local filesystem, for development and the demo only.
 *
 * Pinata is a hosted service with a paid API key. Requiring one to run the stack locally
 * would mean the system could not be demonstrated or exercised end-to-end without a
 * vendor account, so this stands in.
 *
 * It preserves the property that actually matters for correctness testing — **content
 * addressing**. The identifier is derived from a SHA-256 of the bytes, so identical
 * content yields an identical address and altered content yields a different one, exactly
 * as a real CID does. What it does *not* do is produce a genuine IPFS CID: a real CIDv1
 * commits to a multicodec, a multihash prefix and the DAG-PB chunking of the content, and
 * faking those would produce an identifier that looks authentic and resolves to nothing.
 * The digest here is base32-encoded to the same shape and length so it satisfies the
 * `ipfs://` schema, and it is prefixed `bafydev` so anyone reading a log or a database row
 * can tell at a glance that it is a development address rather than a real pin.
 *
 * Guarded the same way as the local relayer: it refuses to construct in production, where
 * writing "pinned" content to a container's ephemeral filesystem would silently produce a
 * chain full of permanent references to bytes that vanish on the next deploy.
 */

export class LocalPinnerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalPinnerRefused";
  }
}

/** RFC 4648 base32, lowercase, no padding — the alphabet real CIDv1 base32 uses. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export interface LocalPinnerOptions {
  /** Directory the content is written to. Created if absent. */
  directory: string;
  /** Base URL reported as the gateway, for display only. */
  gateway?: string;
  nodeEnv?: string;
}

export class LocalPinner implements IpfsPinner {
  constructor(private readonly options: LocalPinnerOptions) {
    const env = options.nodeEnv ?? process.env.NODE_ENV;
    if (env === "production") {
      throw new LocalPinnerRefused(
        "LocalPinner writes to the local filesystem and produces addresses that are not " +
          "real IPFS CIDs; it must never run in production. Configure PINATA_JWT instead.",
      );
    }

    mkdirSync(options.directory, { recursive: true });
  }

  private store(bytes: Buffer, extension: string): PinnedFile {
    // `bafydev` marks these unmistakably as development addresses. The digest is
    // truncated to keep the total length in the range a CIDv1 base32 occupies.
    const digest = base32(createHash("sha256").update(bytes).digest()).slice(0, 45);
    const cid = `bafydev${digest}`;

    writeFileSync(path.join(this.options.directory, `${cid}${extension}`), bytes);

    const gateway = (this.options.gateway ?? "http://localhost:8080").replace(/\/$/, "");

    return {
      cid,
      uri: `ipfs://${cid}`,
      gatewayUrl: `${gateway}/ipfs/${cid}`,
      size: bytes.length,
    };
  }

  async pinFile(file: { buffer: Buffer; filename: string; mime: string }): Promise<PinnedFile> {
    return this.store(file.buffer, path.extname(file.filename) || ".bin");
  }

  async pinJson(value: unknown, _name: string): Promise<PinnedFile> {
    return this.store(Buffer.from(JSON.stringify(value), "utf8"), ".json");
  }
}
