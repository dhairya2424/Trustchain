import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import {
  AuditSourceError,
  byEntryIdDescending,
  FallbackAuditSource,
  matchesFilter,
  OnChainAuditSource,
  SubgraphAuditSource,
  type AuditEventSource,
  type AuditFilter,
  type RawAuditEvent,
} from "./events";

const DID = `0x${"1".repeat(64)}`;
const TX = `0x${"3".repeat(64)}`;
const ACTOR = "0x2222222222222222222222222222222222222222";
const RELAYER = "0x5555555555555555555555555555555555555555";

function event(overrides: Partial<RawAuditEvent> = {}): RawAuditEvent {
  return {
    entryId: 5,
    didHash: DID,
    actionCode: 11,
    refHash: `0x${"2".repeat(64)}`,
    via: "0x1111111111111111111111111111111111111111",
    actor: ACTOR,
    executor: "0x4444444444444444444444444444444444444444",
    blockNumber: 100,
    logIndex: 0,
    transactionHash: TX,
    timestamp: 1_760_000_000,
    ...overrides,
  };
}

function subgraphRow(overrides: Record<string, unknown> = {}) {
  return {
    entryId: "5",
    didHash: DID,
    actionCode: 11,
    refHash: `0x${"2".repeat(64)}`,
    via: "0x1111111111111111111111111111111111111111",
    actor: ACTOR,
    executor: "0x4444444444444444444444444444444444444444",
    blockNumber: "100",
    logIndex: "0",
    transactionHash: TX,
    timestamp: "1760000000",
    ...overrides,
  };
}

const ok = (rows: unknown[]) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ data: { auditEntries: rows } }),
  }) as unknown as Response;

describe("matchesFilter", () => {
  it("matches an actor regardless of case", () => {
    expect(matchesFilter(event(), { actor: ACTOR.toUpperCase(), limit: 10 })).toBe(true);
  });

  it("rejects a different actor", () => {
    expect(matchesFilter(event(), { actor: "0xdead", limit: 10 })).toBe(false);
  });

  it("rejects an entry whose actor could not be resolved when an actor filter is set", () => {
    expect(matchesFilter(event({ actor: null }), { actor: ACTOR, limit: 10 })).toBe(false);
  });

  it("applies the time window inclusively at both ends", () => {
    const filter = { from: 1_760_000_000, to: 1_760_000_000, limit: 10 };

    expect(matchesFilter(event(), filter)).toBe(true);
    expect(matchesFilter(event({ timestamp: 1_759_999_999 }), filter)).toBe(false);
    expect(matchesFilter(event({ timestamp: 1_760_000_001 }), filter)).toBe(false);
  });

  it("excludes the cursor entry itself, so a page cannot repeat a row", () => {
    expect(matchesFilter(event({ entryId: 5 }), { beforeEntryId: 5, limit: 10 })).toBe(false);
    expect(matchesFilter(event({ entryId: 4 }), { beforeEntryId: 5, limit: 10 })).toBe(true);
  });

  it("matches an action code exactly", () => {
    expect(matchesFilter(event(), { actionCode: 11, limit: 10 })).toBe(true);
    expect(matchesFilter(event(), { actionCode: 12, limit: 10 })).toBe(false);
  });
});

describe("ordering", () => {
  it("sorts newest first by entry id", () => {
    const sorted = [event({ entryId: 1 }), event({ entryId: 9 }), event({ entryId: 5 })].sort(
      byEntryIdDescending,
    );

    expect(sorted.map((e) => e.entryId)).toEqual([9, 5, 1]);
  });
});

describe("SubgraphAuditSource", () => {
  it("maps string fields to numbers, since GraphQL returns big integers as strings", async () => {
    const source = new SubgraphAuditSource("http://subgraph", async () => ok([subgraphRow()]));

    const [entry] = await source.query({ limit: 10 });

    expect(entry?.entryId).toBe(5);
    expect(entry?.blockNumber).toBe(100);
    expect(entry?.timestamp).toBe(1_760_000_000);
  });

  it("pushes every filter down into the query rather than fetching and discarding", async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const source = new SubgraphAuditSource("http://subgraph", fetchImpl as unknown as typeof fetch);

    await source.query({
      actor: ACTOR.toUpperCase(),
      didHash: DID,
      actionCode: 11,
      from: 100,
      to: 200,
      beforeEntryId: 42,
      limit: 25,
    });

    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string }).body) as {
      variables: { first: number; where: Record<string, unknown> };
    };

    expect(body.variables.first).toBe(25);
    expect(body.variables.where).toEqual({
      actor: ACTOR.toLowerCase(),
      didHash: DID.toLowerCase(),
      actionCode: 11,
      timestamp_gte: "100",
      timestamp_lte: "200",
      entryId_lt: "42",
    });
  });

  it("omits absent filters instead of sending nulls the indexer would match on", async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    await new SubgraphAuditSource("http://s", fetchImpl as unknown as typeof fetch).query({
      limit: 10,
    });

    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string }).body) as {
      variables: { where: Record<string, unknown> };
    };

    expect(body.variables.where).toEqual({});
  });

  it("treats a GraphQL error as a failure even though the status is 200", async () => {
    const source = new SubgraphAuditSource(
      "http://s",
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ errors: [{ message: "bad field" }] }),
        }) as unknown as Response,
    );

    await expect(source.query({ limit: 10 })).rejects.toThrowError(AuditSourceError);
  });

  it("treats a non-2xx response as unavailable", async () => {
    const source = new SubgraphAuditSource(
      "http://s",
      async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response,
    );

    await expect(source.query({ limit: 10 })).rejects.toThrowError(/502/);
  });

  it("treats a network failure as unavailable rather than crashing the request", async () => {
    const source = new SubgraphAuditSource("http://s", async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(source.query({ limit: 10 })).rejects.toThrowError(/unreachable/);
  });
});

describe("OnChainAuditSource", () => {
  const log = (overrides: Record<string, unknown> = {}) => ({
    args: {
      entryId: 5n,
      didHash: DID,
      actionCode: 11,
      actor: ACTOR,
      refHash: `0x${"2".repeat(64)}`,
      caller: "0x1111111111111111111111111111111111111111",
      timestamp: 1_760_000_000n,
    },
    blockNumber: 100n,
    logIndex: 0,
    transactionHash: TX,
    ...overrides,
  });

  const client = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      getBlockNumber: async () => 1000n,
      getLogs: async () => [log()],
      getTransaction: async () => ({ from: RELAYER }),
      ...overrides,
    }) as unknown as PublicClient;

  /**
   * The actor now comes from the EVENT, not from the transaction sender.
   *
   * Before ERC-2771 the sender was the best available guess, which meant every entry was
   * attributed to the relayer. The event carries the proven requester, and the sender is
   * reported separately as the executor.
   */
  it("takes the actor from the event and the executor from the transaction", async () => {
    const source = new OnChainAuditSource({
      client: client(),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 0n,
    });

    const [entry] = await source.query({ limit: 10 });

    expect(entry?.entryId).toBe(5);
    // Proven on-chain, independent of who submitted.
    expect(entry?.actor).toBe(ACTOR);
    // The relayer that paid for the transaction.
    expect(entry?.executor).toBe(RELAYER);
    // The system contract that wrote the row — a third, distinct party.
    expect(entry?.via).toBe("0x1111111111111111111111111111111111111111");
  });

  it("fetches each transaction once even when several entries share it", async () => {
    const getTransaction = vi.fn(async () => ({ from: RELAYER }));
    const source = new OnChainAuditSource({
      client: client({
        getLogs: async () => [
          log({ args: { ...log().args, entryId: 5n } }),
          log({ args: { ...log().args, entryId: 6n } }),
          log({ args: { ...log().args, entryId: 7n } }),
        ],
        getTransaction,
      }),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 0n,
    });

    await source.query({ limit: 10 });

    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports a null executor when the sender cannot be resolved, rather than guessing", async () => {
    const source = new OnChainAuditSource({
      client: client({
        getTransaction: async () => {
          throw new Error("pruned");
        },
      }),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 0n,
    });

    const [entry] = await source.query({ limit: 10 });

    // The actor still comes from the event, so attribution survives an unresolvable sender.
    expect(entry?.executor).toBeNull();
    expect(entry?.actor).toBe(ACTOR);
  });

  it("never scans below the deployment block", async () => {
    const ranges: { fromBlock: bigint }[] = [];
    const source = new OnChainAuditSource({
      client: client({
        getLogs: async (args: { fromBlock: bigint }) => {
          ranges.push(args);
          return [];
        },
      }),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 900n,
      windowSize: 10n,
    });

    await source.query({ limit: 10 });

    expect(Math.min(...ranges.map((r) => Number(r.fromBlock)))).toBeGreaterThanOrEqual(900);
  });

  it("stops after the window budget rather than walking the whole chain", async () => {
    const getLogs = vi.fn(async () => []);
    const source = new OnChainAuditSource({
      client: client({ getLogs }),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 0n,
      windowSize: 1n,
      maxWindows: 3,
    });

    await source.query({ limit: 10 });

    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("applies a filter the node could not, such as actor", async () => {
    const source = new OnChainAuditSource({
      client: client(),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 0n,
      maxWindows: 1,
    });

    const entries = await source.query({ actor: "0xdead", limit: 10 });

    expect(entries).toEqual([]);
  });

  it("surfaces an unreachable RPC rather than returning an empty log", async () => {
    const source = new OnChainAuditSource({
      client: client({
        getBlockNumber: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deploymentBlock: 0n,
    });

    // An empty result would read as "nothing ever happened", which is the most dangerous
    // wrong answer an audit log can give.
    await expect(source.query({ limit: 10 })).rejects.toThrowError(AuditSourceError);
  });
});

describe("FallbackAuditSource", () => {
  const stub = (impl: (f: AuditFilter) => Promise<RawAuditEvent[]>): AuditEventSource => ({
    query: impl,
  });

  it("uses the subgraph when it answers, and says so", async () => {
    const chain = vi.fn(async () => []);
    const source = new FallbackAuditSource(
      stub(async () => [event()]),
      stub(chain),
    );

    const result = await source.query({ limit: 10 });

    expect(result.source).toBe("subgraph");
    expect(chain).not.toHaveBeenCalled();
  });

  /**
   * Deliberately different from the asset provenance fallback. There, an empty result is
   * ambiguous and worth confirming on-chain. Here the query is a filtered search, so "no
   * matches" is an ordinary answer — retrying every empty search as a full chain scan
   * would make the cheapest query the most expensive one.
   */
  it("does not fall back when the subgraph legitimately returns nothing", async () => {
    const chain = vi.fn(async () => [event()]);
    const source = new FallbackAuditSource(
      stub(async () => []),
      stub(chain),
    );

    const result = await source.query({ limit: 10 });

    expect(result.events).toEqual([]);
    expect(result.source).toBe("subgraph");
    expect(chain).not.toHaveBeenCalled();
  });

  it("falls back to the chain when the subgraph fails, and reports the degraded source", async () => {
    const source = new FallbackAuditSource(
      stub(async () => {
        throw new AuditSourceError("indexer down", "unavailable");
      }),
      stub(async () => [event()]),
    );

    const result = await source.query({ limit: 10 });

    expect(result.source).toBe("chain");
    expect(result.events).toHaveLength(1);
  });

  it("notifies the caller when it falls back, so an outage is visible in the logs", async () => {
    const onFallback = vi.fn();
    const source = new FallbackAuditSource(
      stub(async () => {
        throw new Error("boom");
      }),
      stub(async () => []),
      onFallback,
    );

    await source.query({ limit: 10 });

    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("propagates the error when both sources fail rather than reporting an empty log", async () => {
    const source = new FallbackAuditSource(
      stub(async () => {
        throw new Error("indexer down");
      }),
      stub(async () => {
        throw new Error("rpc down");
      }),
    );

    await expect(source.query({ limit: 10 })).rejects.toThrowError(/rpc down/);
  });
});
