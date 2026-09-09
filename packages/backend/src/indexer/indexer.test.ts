import { describe, expect, it, vi } from "vitest";

import { ChainIndexer } from "./indexer";
import { MemoryEventIndex } from "./store";
import type { Logger } from "../http/logger";

/**
 * The indexer's job is easy on the happy path and entirely about the unhappy ones. These
 * tests pin the behaviours that are invisible when things work: that a restart does not
 * replay history, that a reorg is repaired rather than left stale, that a transaction which
 * is never mined stops claiming to be pending, and that a broken RPC slows the loop down
 * instead of stopping it.
 */

const AUDIT_TRAIL = "0x1A6a0A359119e111E3c33104b38176C1C74e4265" as const;
const TX = `0x${"ab".repeat(32)}` as const; // secrets-scan:allow inert fixture transaction hash
const OTHER_TX = `0x${"cd".repeat(32)}` as const; // secrets-scan:allow inert fixture transaction hash

const logger: Logger = { log: () => {} } as unknown as Logger;

function log(entryId: number, overrides: Record<string, unknown> = {}) {
  return {
    args: {
      entryId: BigInt(entryId),
      didHash: `0x${"11".repeat(32)}`,
      actionCode: 1,
      actor: "0xAAAAaaaAAAAAaAaaAAAaAAaAaaAaAaaAAaAaAAAA",
      refHash: `0x${"22".repeat(32)}`,
      caller: "0xBBBBbbbBBBBBbBbbBBBbBBbBbbBbBbbBBbBbBBBB",
      timestamp: 1_700_000_000n,
    },
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: TX,
    ...overrides,
  };
}

/** A client that answers exactly what a test needs and records what it was asked. */
function fakeClient(options: {
  head: bigint;
  logs?: unknown[];
  onGetLogs?: (args: { fromBlock: bigint; toBlock: bigint }) => unknown[];
  receipt?: { status: "success" | "reverted"; blockNumber: bigint } | Error;
}) {
  const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
  return {
    calls,
    client: {
      getBlockNumber: async () => options.head,
      getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
        return options.onGetLogs ? options.onGetLogs(args) : (options.logs ?? []);
      },
      getTransaction: async () => ({ from: "0xCCCCccCCCCCCCCcccCCCcCcCcCCCCcCcCCCCcCCC" }),
      getTransactionReceipt: async () => {
        if (options.receipt instanceof Error) throw options.receipt;
        if (!options.receipt) throw new Error("not found");
        return options.receipt;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

function makeIndexer(client: unknown, store = new MemoryEventIndex(), extra = {}) {
  return new ChainIndexer({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    network: "amoy",
    auditTrailAddress: AUDIT_TRAIL,
    deploymentBlock: 90,
    store,
    logger,
    confirmations: 5,
    ...extra,
  });
}

describe("ChainIndexer — ingesting events", () => {
  it("writes events and advances the checkpoint to the confirmed head", async () => {
    const store = new MemoryEventIndex();
    const { client } = fakeClient({ head: 200n, logs: [log(1)] });

    await makeIndexer(client, store).tick();

    expect(await store.latestEntryId("amoy")).toBe(1);
    // 200 head minus 5 confirmations. Never the head itself.
    expect(await store.getCheckpoint("amoy")).toBe(195);
  });

  it("never indexes into blocks that could still be reorganised out", async () => {
    const store = new MemoryEventIndex();
    const { client, calls } = fakeClient({ head: 200n, logs: [] });

    await makeIndexer(client, store).tick();

    // Not one call may reach past head - confirmations.
    for (const call of calls) expect(Number(call.toBlock)).toBeLessThanOrEqual(195);
  });

  it("does nothing when the chain has not produced a confirmed block yet", async () => {
    const store = new MemoryEventIndex();
    // Head is below the deployment block once confirmations are subtracted.
    const { client, calls } = fakeClient({ head: 92n, logs: [log(1)] });

    await makeIndexer(client, store).tick();

    expect(calls).toHaveLength(0);
    expect(await store.getCheckpoint("amoy")).toBeNull();
  });
});

describe("ChainIndexer — surviving the unhappy paths", () => {
  it("does not replay events at subscribers after a restart", async () => {
    const store = new MemoryEventIndex();
    const seen: number[][] = [];

    const first = makeIndexer(fakeClient({ head: 200n, logs: [log(1)] }).client, store);
    first.onEvents((events) => seen.push(events.map((event) => event.entryId)));
    await first.tick();

    // A second indexer over the same store — a restart. It deliberately re-reads an
    // overlap below the checkpoint and sees entry 1 again.
    const second = makeIndexer(fakeClient({ head: 200n, logs: [log(1)] }).client, store);
    second.onEvents((events) => seen.push(events.map((event) => event.entryId)));
    await second.tick();

    expect(seen).toEqual([[1]]);
  });

  it("keeps one row when the same entry arrives twice", async () => {
    const store = new MemoryEventIndex();
    const { client } = fakeClient({ head: 200n, logs: [log(1), log(1)] });

    await makeIndexer(client, store).tick();

    const rows = await store.queryEvents("amoy", { limit: 10 });
    expect(rows).toHaveLength(1);
  });

  it("re-reads below its checkpoint, so a rewritten block is repaired", async () => {
    const store = new MemoryEventIndex();
    await store.setCheckpoint("amoy", 150);

    const { client, calls } = fakeClient({ head: 200n, logs: [] });
    await makeIndexer(client, store, { overlapBlocks: 12 }).tick();

    // Starts below the checkpoint rather than at checkpoint + 1: a shallow reorg that
    // rewrote an already-indexed block is only ever caught by looking back at it.
    expect(Number(calls[0]!.fromBlock)).toBe(139);
  });

  it("narrows the window when the provider refuses the range", async () => {
    const store = new MemoryEventIndex();
    let refusals = 0;

    const client = {
      getBlockNumber: async () => 5_000n,
      getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
        if (args.toBlock - args.fromBlock + 1n > 10n) {
          refusals += 1;
          throw new Error(
            "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
          );
        }
        return [];
      },
      getTransaction: async () => ({ from: "0x0" }),
      getTransactionReceipt: async () => {
        throw new Error("none");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // A generous budget, so the test fails by timing out rather than by silent truncation
    // if narrowing ever stops working.
    await makeIndexer(client, store, { windowSize: 5_000 }).tick();

    expect(refusals).toBeGreaterThan(0);
    expect(await store.getCheckpoint("amoy")).toBe(4_995);
  });

  it("reports a failing pass without stopping", async () => {
    const client = {
      getBlockNumber: async () => {
        throw new Error("rpc exploded");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const indexer = makeIndexer(client);
    await expect(indexer.tick()).rejects.toThrow("rpc exploded");

    // The loop catches it; status is how an operator tells "quiet" from "broken".
    expect(indexer.status().running).toBe(false);
  });
});

describe("ChainIndexer — transaction lifecycle", () => {
  it("moves a mined transaction to confirmed with its block", async () => {
    const store = new MemoryEventIndex();
    const { client } = fakeClient({
      head: 200n,
      receipt: { status: "success", blockNumber: 190n },
    });

    const indexer = makeIndexer(client, store);
    const seen: string[] = [];
    indexer.onTransaction((tx) => seen.push(tx.status));

    await indexer.trackSubmission({ transactionHash: TX, actor: "0xabc", action: "ISSUE" });
    await indexer.tick();

    const tracked = await store.getTransaction("amoy", TX);
    expect(tracked?.status).toBe("confirmed");
    expect(tracked?.blockNumber).toBe(190);
    expect(seen).toEqual(["submitted", "confirmed"]);
  });

  it("marks a reverted transaction failed rather than confirmed", async () => {
    const store = new MemoryEventIndex();
    const { client } = fakeClient({
      head: 200n,
      receipt: { status: "reverted", blockNumber: 190n },
    });

    const indexer = makeIndexer(client, store);
    await indexer.trackSubmission({ transactionHash: TX, actor: null, action: null });
    await indexer.tick();

    const tracked = await store.getTransaction("amoy", TX);
    expect(tracked?.status).toBe("failed");
    expect(tracked?.detail).toMatch(/reverted/);
  });

  it("gives up on a transaction that is never mined", async () => {
    // The outcome usually left out. A dropped transaction produces no receipt and no
    // announcement; without a timeout the UI would show "pending" indefinitely, which
    // reads as "still working" when it means "gone".
    const store = new MemoryEventIndex();
    const { client } = fakeClient({ head: 200n });

    const indexer = makeIndexer(client, store, { dropAfterMs: 1 });
    await indexer.trackSubmission({ transactionHash: OTHER_TX, actor: null, action: null });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await indexer.tick();

    const tracked = await store.getTransaction("amoy", OTHER_TX);
    expect(tracked?.status).toBe("dropped");
    expect(tracked?.detail).toMatch(/never mined/);
  });

  it("promotes submitted to pending while it waits", async () => {
    const store = new MemoryEventIndex();
    const { client } = fakeClient({ head: 200n });

    const indexer = makeIndexer(client, store, { dropAfterMs: 60_000 });
    await indexer.trackSubmission({ transactionHash: TX, actor: null, action: null });
    await indexer.tick();

    expect((await store.getTransaction("amoy", TX))?.status).toBe("pending");
  });

  it("does not ask about transactions that already settled", async () => {
    const store = new MemoryEventIndex();
    const receipts = vi.fn(async () => ({ status: "success" as const, blockNumber: 190n }));

    const client = {
      getBlockNumber: async () => 200n,
      getLogs: async () => [],
      getTransaction: async () => ({ from: "0x0" }),
      getTransactionReceipt: receipts,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const indexer = makeIndexer(client, store);
    await indexer.trackSubmission({ transactionHash: TX, actor: null, action: null });

    await indexer.tick();
    await indexer.tick();

    // Settled once, then left alone — otherwise every confirmed transaction would cost an
    // RPC call on every pass, forever.
    expect(receipts).toHaveBeenCalledTimes(1);
  });
});
