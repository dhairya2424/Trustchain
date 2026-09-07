import { describe, expect, it } from "vitest";
import { detectType, inspectUpload, MAX_UPLOAD_BYTES, safeDisplayName } from "./upload";
import { stripMetadata } from "./metadata";
import { PinataClient, PinningError } from "./pinata";
import { toAssetDto, toOwnProfileDto, toPublicProfileDto, type AssetRecord } from "./serializers";
import {
  buildProvenance,
  FallbackEventSource,
  ProvenanceError,
  type RawAssetEvent,
} from "./provenance";
import { ClamAvScanner, ScannerUnavailableError, StubScanner } from "./malware";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngWith(chunks: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from(PNG_HEADER)];

  for (const chunk of chunks) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.data.length);
    parts.push(length, Buffer.from(chunk.type, "ascii"), chunk.data, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

function jpegWith(segments: { marker: number; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  for (const segment of segments) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(segment.data.length + 2);
    parts.push(Buffer.from([0xff, segment.marker]), length, segment.data);
  }
  // Start of scan plus some entropy-coded data.
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0x01, 0x02, 0x03]));
  return Buffer.concat(parts);
}

const PNG = pngWith([{ type: "IDAT", data: Buffer.from([1, 2, 3]) }]);
const JPEG = jpegWith([{ marker: 0xdb, data: Buffer.alloc(4) }]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)]);

// ---------------------------------------------------------------------------

describe("upload validation", () => {
  it("accepts each permitted format", () => {
    for (const [buffer, mime] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [PDF, "application/pdf"],
    ] as const) {
      const result = inspectUpload({ buffer, declaredMime: mime });
      expect(result.ok, `${mime} should be accepted`).toBe(true);
    }
  });

  it("REJECTS an executable renamed to .png with a spoofed content type", () => {
    // MZ header — a Windows executable claiming to be an image.
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);

    const result = inspectUpload({
      buffer: exe,
      declaredMime: "image/png",
      originalName: "avatar.png",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unrecognised_content");
  });

  it("REJECTS a real image whose declared type disagrees with its bytes", () => {
    const result = inspectUpload({ buffer: PNG, declaredMime: "application/pdf" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mime_mismatch");
  });

  it("rejects a type outside the allowlist even when the content is genuine", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]);

    const result = inspectUpload({ buffer: gif, declaredMime: "image/gif" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("declared_mime_not_allowed");
  });

  it("enforces the 5MB ceiling", () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);

    const result = inspectUpload({ buffer: oversized, declaredMime: "image/png" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  it("rejects an empty upload", () => {
    const result = inspectUpload({ buffer: Buffer.alloc(0), declaredMime: "image/png" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_file");
  });

  it("assigns a random storage name derived only from the detected type", () => {
    const first = inspectUpload({
      buffer: PNG,
      declaredMime: "image/png",
      originalName: "../../etc/passwd.png",
    });
    const second = inspectUpload({ buffer: PNG, declaredMime: "image/png" });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.storageName).not.toBe(second.storageName);
      expect(first.storageName).toMatch(/^[0-9a-f-]{36}\.png$/);
      // The attacker-supplied name contributes nothing to the stored path.
      expect(first.storageName).not.toContain("passwd");
      expect(first.storageName).not.toContain("..");
    }
  });

  it("sanitises a display name without ever using it for storage", () => {
    expect(safeDisplayName("../../etc/passwd")).not.toContain("..");
    expect(safeDisplayName("a\0b.png")).not.toContain("\0");
    expect(safeDisplayName("")).toBe("upload");
  });

  it("identifies webp by both RIFF markers, not just the first", () => {
    const notWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);

    expect(detectType(notWebp)).toBeNull();
  });
});

describe("metadata stripping", () => {
  it("removes EXIF from a JPEG while keeping image data", () => {
    const withExif = jpegWith([
      { marker: 0xe1, data: Buffer.from("Exif\0\0GPS 51.5074N 0.1278W") },
      { marker: 0xdb, data: Buffer.alloc(4) },
    ]);

    const result = stripMetadata(withExif, "image/jpeg");

    expect(result.removed).toContain("APP1 (EXIF/XMP)");
    expect(result.buffer.toString("latin1")).not.toContain("GPS");
    // The quantisation table and the scan survive.
    expect(result.buffer.length).toBeLessThan(withExif.length);
    expect(result.buffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("removes eXIf and text chunks from a PNG while keeping IDAT", () => {
    const withMetadata = pngWith([
      { type: "eXIf", data: Buffer.from("GPS 51.5074N") },
      { type: "tEXt", data: Buffer.from("Author\0alice") },
      { type: "IDAT", data: Buffer.from([9, 9, 9]) },
      { type: "IEND", data: Buffer.alloc(0) },
    ]);

    const result = stripMetadata(withMetadata, "image/png");

    expect(result.removed).toEqual(expect.arrayContaining(["eXIf", "tEXt"]));
    expect(result.buffer.toString("latin1")).not.toContain("GPS");
    expect(result.buffer.toString("latin1")).not.toContain("alice");
    expect(result.buffer.toString("latin1")).toContain("IDAT");
    // Signature preserved, so the result is still a valid PNG.
    expect([...result.buffer.subarray(0, 8)]).toEqual(PNG_HEADER);
  });

  it("leaves a clean image byte-identical", () => {
    const result = stripMetadata(PNG, "image/png");

    expect(result.removed).toEqual([]);
    expect(result.buffer.equals(PNG)).toBe(true);
  });

  it("reports honestly that PDFs are not stripped", () => {
    const result = stripMetadata(PDF, "application/pdf");

    expect(result.removed).toEqual([]);
    expect(result.buffer.equals(PDF)).toBe(true);
  });
});

describe("malware scanning", () => {
  it("treats a FOUND reply as infected and names the signature", async () => {
    const socket = fakeSocket("stream: Eicar-Test-Signature FOUND");
    const scanner = new ClamAvScanner({ host: "clamav", port: 3310 }, () => socket.socket);

    const verdict = await scanner.scan(Buffer.from("x"));

    expect(verdict.clean).toBe(false);
    if (!verdict.clean) expect(verdict.signature).toBe("Eicar-Test-Signature");
  });

  it("treats an OK reply as clean", async () => {
    const socket = fakeSocket("stream: OK");
    const scanner = new ClamAvScanner({ host: "clamav", port: 3310 }, () => socket.socket);

    expect((await scanner.scan(Buffer.from("x"))).clean).toBe(true);
  });

  it("THROWS when the scanner is unreachable rather than reporting clean", async () => {
    const scanner = new ClamAvScanner({ host: "clamav", port: 3310 }, () => {
      const socket = fakeSocket("").socket;
      queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket;
    });

    // Failing open would silently disable virus scanning for every upload.
    await expect(scanner.scan(Buffer.from("x"))).rejects.toThrowError(ScannerUnavailableError);
  });

  it("stub scanner is usable in tests", async () => {
    expect((await new StubScanner().scan(Buffer.alloc(1))).clean).toBe(true);
  });
});

describe("Pinata pinning", () => {
  it("returns an ipfs:// URI for on-chain use and a gateway URL for display", async () => {
    const client = new PinataClient(
      { jwt: "jwt", gateway: "https://x.mypinata.cloud/" },
      async () =>
        new Response(JSON.stringify({ IpfsHash: "bafyabc", PinSize: 10 }), { status: 200 }),
    );

    const pinned = await client.pinFile({
      buffer: PNG,
      filename: "a.png",
      mime: "image/png",
    });

    // The token URI must not depend on one vendor's hostname staying alive.
    expect(pinned.uri).toBe("ipfs://bafyabc");
    expect(pinned.gatewayUrl).toBe("https://x.mypinata.cloud/ipfs/bafyabc");
  });

  it("sends the JWT as a bearer token and nowhere else", async () => {
    let seen: Record<string, string> = {};
    const client = new PinataClient(
      { jwt: "super-secret-jwt", gateway: "https://x.mypinata.cloud" },
      async (_url, init) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ IpfsHash: "bafy" }), { status: 200 });
      },
    );

    await client.pinJson({ a: 1 }, "meta");

    expect(seen.authorization).toBe("Bearer super-secret-jwt");
  });

  it("does not echo the provider's response body into the error", async () => {
    const client = new PinataClient(
      { jwt: "super-secret-jwt", gateway: "https://x.mypinata.cloud" },
      async () =>
        new Response(JSON.stringify({ error: "auth failed for Bearer super-secret-jwt" }), {
          status: 401,
        }),
    );

    await expect(client.pinJson({}, "n")).rejects.toThrowError(PinningError);
    await expect(client.pinJson({}, "n")).rejects.not.toThrowError(/super-secret-jwt/);
  });
});

describe("response projection", () => {
  const record: AssetRecord = {
    tokenId: 1,
    ownerDid: "0xdid",
    ownerAddress: "0xowner",
    tokenUri: "ipfs://meta",
    gatewayUrl: "https://gw/ipfs/meta",
    soulbound: false,
    mintedAt: "2026-01-01T00:00:00.000Z",
    internalStoragePath: "/var/data/secret.png",
    uploaderIp: "203.0.113.9",
    scanSignature: null,
    pinataJobId: "job-42",
  };

  it("omits every internal field, even though the record carries them", () => {
    const dto = toAssetDto(record);
    const serialised = JSON.stringify(dto);

    expect(Object.keys(dto).sort()).toEqual([
      "gatewayUrl",
      "mintedAt",
      "ownerAddress",
      "ownerDid",
      "soulbound",
      "tokenId",
      "tokenUri",
    ]);
    expect(serialised).not.toContain("/var/data");
    expect(serialised).not.toContain("203.0.113.9");
    expect(serialised).not.toContain("job-42");
  });

  it("never exposes personal fields on a public profile", () => {
    const dto = toPublicProfileDto({
      didHash: "0xdid",
      address: "0xaddr",
      displayName: "Alice",
      bio: null,
      avatarUri: null,
      role: "USER",
      isPublic: true,
      email: "alice@example.com",
      kycRef: "KYC-1",
      emailEncrypted: Buffer.from([1, 2, 3]),
    });

    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain("alice@example.com");
    expect(serialised).not.toContain("KYC-1");
    expect(serialised).not.toContain("emailEncrypted");
  });

  it("returns personal fields only through the owner-scoped serializer", () => {
    const dto = toOwnProfileDto({
      didHash: "0xdid",
      address: "0xaddr",
      displayName: "Alice",
      bio: null,
      avatarUri: null,
      role: "USER",
      isPublic: false,
      email: "alice@example.com",
      kycRef: "KYC-1",
    });

    expect(dto.email).toBe("alice@example.com");
    // Even here, ciphertext never leaves the server.
    expect(JSON.stringify(dto)).not.toContain("Encrypted");
  });
});

describe("provenance timeline", () => {
  const base = {
    tokenId: 1,
    toAddress: "0xb",
    transactionHash: "0xtx",
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  const mint: RawAssetEvent = {
    ...base,
    kind: "AssetMinted",
    toDid: "0xalice",
    blockNumber: 10,
    logIndex: 0,
  };
  const transfer: RawAssetEvent = {
    ...base,
    kind: "AssetTransferred",
    fromDid: "0xalice",
    toDid: "0xbob",
    blockNumber: 20,
    logIndex: 1,
  };

  it("orders by block and log index, not by timestamp", () => {
    // Same timestamp on both, as events in one block genuinely have.
    const sameBlock: RawAssetEvent = { ...transfer, blockNumber: 10, logIndex: 1 };

    const result = buildProvenance(1, [sameBlock, mint]);

    expect(result.timeline.map((e) => e.type)).toEqual(["mint", "transfer"]);
    expect(result.currentOwnerDid).toBe("0xbob");
  });

  it("builds an ordered timeline and reports the current owner", () => {
    const result = buildProvenance(1, [transfer, mint]);

    expect(result.verified).toBe(true);
    expect(result.timeline).toHaveLength(2);
    expect(result.currentOwnerDid).toBe("0xbob");
  });

  it("keeps the DID unchanged across a reclaim, which moves keys not identities", () => {
    const reclaim: RawAssetEvent = {
      ...base,
      kind: "AssetReclaimed",
      fromDid: "0xalice",
      toDid: "0xalice",
      blockNumber: 15,
      logIndex: 0,
    };

    const result = buildProvenance(1, [mint, reclaim]);

    expect(result.currentOwnerDid).toBe("0xalice");
    expect(result.timeline.map((e) => e.type)).toEqual(["mint", "reclaim"]);
  });

  it("REFUSES a history that does not begin with a mint", () => {
    // What a still-indexing subgraph returns.
    expect(() => buildProvenance(1, [transfer])).toThrowError(ProvenanceError);
  });

  it("REFUSES a chain with a gap rather than presenting it as authoritative", () => {
    const orphan: RawAssetEvent = {
      ...base,
      kind: "AssetTransferred",
      fromDid: "0xcarol", // never owned it
      toDid: "0xdave",
      blockNumber: 30,
      logIndex: 0,
    };

    expect(() => buildProvenance(1, [mint, orphan])).toThrowError(/chain breaks/);
  });

  it("reports not_found for a token with no events", () => {
    try {
      buildProvenance(99, []);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ProvenanceError).code).toBe("not_found");
    }
  });

  it("falls back to the chain when the subgraph fails or lags", async () => {
    const failing = {
      eventsForToken: async () => {
        throw new Error("subgraph down");
      },
    };
    const empty = { eventsForToken: async () => [] };
    const chain = { eventsForToken: async () => [mint] };

    expect(await new FallbackEventSource(failing, chain).eventsForToken(1)).toHaveLength(1);
    // An empty result from a lagging indexer is confirmed against the chain.
    expect(await new FallbackEventSource(empty, chain).eventsForToken(1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

function fakeSocket(reply: string) {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};

  const socket = {
    on(event: string, handler: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(handler);
      if (event === "connect") queueMicrotask(() => handler());
      return socket;
    },
    emit(event: string, arg?: unknown) {
      listeners[event]?.forEach((h) => h(arg));
    },
    setTimeout() {},
    write() {
      if (reply) {
        queueMicrotask(() => {
          socket.emit("data", Buffer.from(reply));
          socket.emit("close");
        });
      }
      return true;
    },
    destroy() {},
  };

  return { socket: socket as never };
}
