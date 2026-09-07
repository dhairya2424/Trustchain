import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createServer } from "../server";
import { testChain } from "../chain/testBinding";
import { MemoryLogger } from "../http/logger";
import type { AssetDependencies } from "./routes";

/**
 * Route-level tests for asset minting.
 *
 * This file exists because the P2.6 end-to-end run found a privilege-escalation bug that
 * 439 unit tests had missed: `/assets/mint` authenticated the caller but never checked
 * their authority, and every one of those tests exercised the units beneath the route
 * rather than the route itself. The lesson is recorded here as coverage.
 */

const DID = `0x${"a".repeat(64)}`;
const MANAGER = { didHash: DID, address: "0x2222222222222222222222222222222222222222" };
const USER = {
  didHash: `0x${"b".repeat(64)}`,
  address: "0x3333333333333333333333333333333333333333",
};

/** A real 1×1 PNG: the uploader decides the type from content, not the declared header. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200" +
    "0105fe02fa0000000049454e44ae426082",
  "hex",
);

interface Harness {
  caller?: typeof MANAGER | null;
  permitted?: boolean | Error;
  omitPermissionReader?: boolean;
}

function build(options: Harness = {}) {
  const logger = new MemoryLogger();
  const relayMint = vi.fn(async () => ({
    transactionId: "0xtx",
    hash: "0xtx",
    status: "mined" as const,
  }));
  const pinJson = vi.fn(async () => ({
    cid: "bafytest",
    uri: "ipfs://bafytest",
    gatewayUrl: "http://g/bafytest",
    size: 1,
  }));

  const assets: AssetDependencies = {
    scanner: { scan: async () => ({ clean: true }) },
    pinner: {
      pinFile: async () => ({
        cid: "bafyfile",
        uri: "ipfs://bafyfile",
        gatewayUrl: "http://g/bafyfile",
        size: PNG.length,
      }),
      pinJson,
    },
    chain: testChain({ relayMint }),
    events: { eventsForToken: async () => [] },
    assets: { find: async () => null },
    logger,
    resolveCaller: async () => (options.caller === undefined ? MANAGER : options.caller),
    ...(options.omitPermissionReader
      ? {}
      : {
          permissions: {
            hasPermission: async () => {
              if (options.permitted instanceof Error) throw options.permitted;
              return options.permitted !== false;
            },
          },
        }),
  };

  return { app: createServer({ assets, logger }), logger, relayMint, pinJson };
}

function mintRequest(app: ReturnType<typeof build>["app"], toDID = DID) {
  return request(app)
    .post("/assets/mint")
    .field("toDID", toDID)
    .field("name", "Test asset")
    .field("soulbound", "false")
    .attach("file", PNG, { filename: "pixel.png", contentType: "image/png" });
}

describe("POST /assets/mint — authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    const { app, relayMint } = build({ caller: null });

    const res = await mintRequest(app);

    expect(res.status).toBe(401);
    expect(relayMint).not.toHaveBeenCalled();
  });

  /**
   * The regression test for the bug the end-to-end run caught.
   *
   * Minting goes through a relayer that signs with its own key, so the contract's
   * `onlyPermission(MINT_ASSET)` modifier checks the RELAYER's authority — which the
   * relayer must hold, or it could not relay anything at all. That makes the contract
   * check useless as a guard on the caller: from the chain's point of view the call is
   * perfectly legitimate no matter who asked for it.
   *
   * Before the fix this returned 202 and actually minted an asset for a plain USER.
   */
  it("refuses a caller the chain does not grant MINT_ASSET", async () => {
    const { app, relayMint } = build({ caller: USER, permitted: false });

    const res = await mintRequest(app);

    expect(res.status).toBe(403);
    expect(relayMint).not.toHaveBeenCalled();
  });

  it("does not let an unauthorised caller reach the pinner either", async () => {
    // Pinning is irreversible and costs money, so it must not happen before the gate.
    const { app, pinJson } = build({ caller: USER, permitted: false });

    await mintRequest(app);

    expect(pinJson).not.toHaveBeenCalled();
  });

  it("admits a caller the chain does grant MINT_ASSET", async () => {
    const { app } = build({ caller: MANAGER, permitted: true });

    const res = await mintRequest(app);

    // 200, not 202: the metadata is pinned but nothing is submitted until the requester
    // signs. A mint attributed to the relayer is exactly what this replaces.
    expect(res.status).toBe(200);
  });

  it("returns a request for the requester to sign, rather than submitting one itself", async () => {
    const { app, relayMint } = build({ caller: MANAGER, permitted: true });

    const res = await mintRequest(app);

    expect(res.body.typedData?.primaryType).toBe("ForwardRequest");
    expect(res.body.typedData?.message?.from).toBe(MANAGER.address);
    expect(res.body.tokenURI).toMatch(/^ipfs:\/\//);
    expect(relayMint).not.toHaveBeenCalled();
  });

  it("asks the chain about the caller, not about the relayer", async () => {
    const hasPermission = vi.fn(async () => true);
    const logger = new MemoryLogger();
    const relayMint = vi.fn(async () => ({ transactionId: "0xtx", status: "mined" as const }));

    const app = createServer({
      logger,
      assets: {
        scanner: { scan: async () => ({ clean: true }) },
        pinner: {
          pinFile: async () => ({ cid: "c", uri: "ipfs://c", gatewayUrl: "g", size: 1 }),
          pinJson: async () => ({ cid: "c", uri: "ipfs://c", gatewayUrl: "g", size: 1 }),
        },
        chain: testChain({ relayMint }),
        events: { eventsForToken: async () => [] },
        assets: { find: async () => null },
        logger,
        resolveCaller: async () => MANAGER,
        permissions: { hasPermission },
      },
    });

    await mintRequest(app);

    expect(hasPermission).toHaveBeenCalledWith(MANAGER.address, "MINT_ASSET");
  });

  it("fails closed with 503 when the chain cannot be consulted", async () => {
    const { app, relayMint } = build({ permitted: new Error("ECONNREFUSED") });

    const res = await mintRequest(app);

    expect(res.status).toBe(503);
    expect(relayMint).not.toHaveBeenCalled();
  });

  it("fails closed when no permission reader is configured at all", async () => {
    // A deployment that forgot to wire the reader must not mint for everyone.
    const { app, relayMint } = build({ omitPermissionReader: true });

    const res = await mintRequest(app);

    expect(res.status).toBe(503);
    expect(relayMint).not.toHaveBeenCalled();
  });

  it("logs the refusal with the actor, so escalation attempts are visible", async () => {
    const { app, logger } = build({ caller: USER, permitted: false });

    await mintRequest(app);

    const record = logger.find("security.authorization_denied");
    expect(record?.actor).toBe(USER.address);
    expect(record?.permission).toBe("MINT_ASSET");
  });
});

describe("POST /assets/mint — validation still applies after the gate", () => {
  it("rejects a request with no file", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/assets/mint")
      .field("toDID", DID)
      .field("name", "No file")
      .field("soulbound", "false");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("file_required");
  });

  it("rejects a malformed DID", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/assets/mint")
      .field("toDID", "0x1234")
      .field("name", "Bad DID")
      .field("soulbound", "false")
      .attach("file", PNG, { filename: "pixel.png", contentType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("rejects content whose bytes are not the declared type", async () => {
    const { app } = build();

    const res = await request(app)
      .post("/assets/mint")
      .field("toDID", DID)
      .field("name", "Not a png")
      .field("soulbound", "false")
      .attach("file", Buffer.from("#!/bin/sh\nrm -rf /"), {
        filename: "evil.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(415);
  });

  it("refuses to mint when the malware scanner is unavailable", async () => {
    const logger = new MemoryLogger();
    const relayMint = vi.fn(async () => ({ transactionId: "0xtx", status: "mined" as const }));

    const app = createServer({
      logger,
      assets: {
        scanner: {
          scan: async () => {
            throw new Error("clamd down");
          },
        },
        pinner: {
          pinFile: async () => ({ cid: "c", uri: "ipfs://c", gatewayUrl: "g", size: 1 }),
          pinJson: async () => ({ cid: "c", uri: "ipfs://c", gatewayUrl: "g", size: 1 }),
        },
        chain: testChain({ relayMint }),
        events: { eventsForToken: async () => [] },
        assets: { find: async () => null },
        logger,
        resolveCaller: async () => MANAGER,
        permissions: { hasPermission: async () => true },
      },
    });

    const res = await mintRequest(app);

    expect(res.status).toBe(503);
    expect(relayMint).not.toHaveBeenCalled();
  });
});
