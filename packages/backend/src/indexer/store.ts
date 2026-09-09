import type { RawAuditEvent } from "../audit/events";

/**
 * Where indexed chain events and in-flight transactions are kept.
 *
 * This store holds a **cache, not a record**. Every row in it is derived from the chain and
 * can be thrown away and rebuilt by re-scanning; the chain remains the only source of
 * truth. That property is what makes Redis an honest home for it rather than a shortcut —
 * losing the store costs a re-scan, never a fact. If the event volume ever outgrows a
 * single Redis instance, this interface is the seam to put Postgres behind.
 *
 * An interface with a memory implementation, for the same reason `store/kv.ts` has one:
 * the interesting behaviour here is deduplication, checkpoint advancement and reorg
 * handling, and behaviour that can only be exercised against live Redis tends not to be
 * exercised at all.
 */

/** An audit event, tagged with the network it was observed on. */
export interface IndexedEvent extends RawAuditEvent {
  network: string;
}

export type TransactionStatus = "submitted" | "pending" | "confirmed" | "failed" | "dropped";

/**
 * A relayed transaction, from submission to its resting state.
 *
 * A transaction is not a moment. Reporting only the end states leaves the interface silent
 * for exactly the seconds a person is watching; reporting "confirmed" at submission time
 * asserts something the chain has not yet agreed to.
 */
export interface TrackedTransaction {
  network: string;
  transactionHash: string;
  status: TransactionStatus;
  /** The identity that signed the request — from the session, never from the browser. */
  actor: string | null;
  /** What was asked for, so a pending row can describe itself before any event exists. */
  action: string | null;
  submittedAt: number;
  confirmedAt?: number | undefined;
  blockNumber?: number | undefined;
  /** Why it failed or was dropped, so the UI can explain rather than hang. */
  detail?: string | undefined;
}

export interface IndexQuery {
  actor?: string | undefined;
  didHash?: string | undefined;
  actionCode?: number | undefined;
  beforeEntryId?: number | undefined;
  limit: number;
}

export interface EventIndexStore {
  /** Highest block whose events are fully written, or null before the first pass. */
  getCheckpoint(network: string): Promise<number | null>;
  setCheckpoint(network: string, block: number): Promise<void>;

  /**
   * Writes events, ignoring ones already held.
   *
   * Returns only those that were genuinely new. Callers use that to decide what to
   * broadcast, so an overlapping re-scan after a restart does not replay old events at
   * everyone watching.
   */
  putEvents(events: readonly IndexedEvent[]): Promise<IndexedEvent[]>;

  queryEvents(network: string, query: IndexQuery): Promise<IndexedEvent[]>;

  /** Newest indexed entry id, for reporting how far the index has got. */
  latestEntryId(network: string): Promise<number | null>;

  putTransaction(transaction: TrackedTransaction): Promise<void>;
  getTransaction(network: string, hash: string): Promise<TrackedTransaction | null>;
  /** Transactions still awaiting a receipt. */
  openTransactions(network: string): Promise<TrackedTransaction[]>;
  transactionsFor(network: string, actor: string, limit: number): Promise<TrackedTransaction[]>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function matches(event: IndexedEvent, query: IndexQuery): boolean {
  if (query.actor && event.actor?.toLowerCase() !== query.actor.toLowerCase()) return false;
  if (query.didHash && event.didHash.toLowerCase() !== query.didHash.toLowerCase()) return false;
  if (query.actionCode !== undefined && event.actionCode !== query.actionCode) return false;
  if (query.beforeEntryId !== undefined && event.entryId >= query.beforeEntryId) return false;
  return true;
}

export class MemoryEventIndex implements EventIndexStore {
  private readonly events = new Map<string, IndexedEvent>();
  private readonly checkpoints = new Map<string, number>();
  private readonly transactions = new Map<string, TrackedTransaction>();

  private static key(network: string, entryId: number): string {
    return `${network}:${entryId}`;
  }

  async getCheckpoint(network: string): Promise<number | null> {
    return this.checkpoints.get(network) ?? null;
  }

  async setCheckpoint(network: string, block: number): Promise<void> {
    this.checkpoints.set(network, block);
  }

  async putEvents(events: readonly IndexedEvent[]): Promise<IndexedEvent[]> {
    const added: IndexedEvent[] = [];
    for (const event of events) {
      const key = MemoryEventIndex.key(event.network, event.entryId);
      if (this.events.has(key)) continue;
      this.events.set(key, event);
      added.push(event);
    }
    return added;
  }

  async queryEvents(network: string, query: IndexQuery): Promise<IndexedEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.network === network && matches(event, query))
      .sort((a, b) => b.entryId - a.entryId)
      .slice(0, query.limit);
  }

  async latestEntryId(network: string): Promise<number | null> {
    const ids = [...this.events.values()]
      .filter((event) => event.network === network)
      .map((event) => event.entryId);
    return ids.length > 0 ? Math.max(...ids) : null;
  }

  async putTransaction(transaction: TrackedTransaction): Promise<void> {
    this.transactions.set(
      `${transaction.network}:${transaction.transactionHash.toLowerCase()}`,
      transaction,
    );
  }

  async getTransaction(network: string, hash: string): Promise<TrackedTransaction | null> {
    return this.transactions.get(`${network}:${hash.toLowerCase()}`) ?? null;
  }

  async openTransactions(network: string): Promise<TrackedTransaction[]> {
    return [...this.transactions.values()].filter(
      (tx) => tx.network === network && (tx.status === "submitted" || tx.status === "pending"),
    );
  }

  async transactionsFor(
    network: string,
    actor: string,
    limit: number,
  ): Promise<TrackedTransaction[]> {
    return [...this.transactions.values()]
      .filter((tx) => tx.network === network && tx.actor?.toLowerCase() === actor.toLowerCase())
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** The ioredis surface this store uses, typed here so ioredis need not be imported. */
export interface RedisIndexClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hvals(key: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  /**
   * Declared as the exact overload used, not as varargs.
   *
   * ioredis types this command with a set of precise overloads, the last argument of each
   * being an optional callback. A `...args: (string | number)[]` signature therefore fails
   * to match any of them — the callback slot cannot accept a string. Naming the LIMIT form
   * explicitly both compiles and documents the only way this store paginates.
   */
  zrevrangebyscore(
    key: string,
    max: string | number,
    min: string | number,
    limitToken: "LIMIT",
    offset: number,
    count: number,
  ): Promise<string[]>;
}

/**
 * Redis-backed index.
 *
 * Layout, and why each part is shaped as it is:
 *
 *   idx:{net}:events        HASH  entryId -> JSON. The hash field is the dedupe key, so
 *                                 re-indexing an overlapping range is a no-op by
 *                                 construction rather than by a prior read.
 *   idx:{net}:order         ZSET  entryId scored by entryId, for ordered pagination
 *                                 without loading and sorting the whole hash.
 *   idx:{net}:checkpoint    STR   highest fully-written block.
 *   idx:{net}:tx            HASH  txHash -> JSON, the lifecycle rows.
 *
 * Nothing here has a TTL. The index is small — one entry per on-chain action — and an
 * expiring audit index would develop holes that look exactly like actions that never
 * happened, which is the one failure this project cannot tolerate.
 */
export class RedisEventIndex implements EventIndexStore {
  constructor(private readonly redis: RedisIndexClient) {}

  private eventsKey = (network: string) => `idx:${network}:events`;
  private orderKey = (network: string) => `idx:${network}:order`;
  private checkpointKey = (network: string) => `idx:${network}:checkpoint`;
  private txKey = (network: string) => `idx:${network}:tx`;

  async getCheckpoint(network: string): Promise<number | null> {
    const raw = await this.redis.get(this.checkpointKey(network));
    return raw === null ? null : Number(raw);
  }

  async setCheckpoint(network: string, block: number): Promise<void> {
    await this.redis.set(this.checkpointKey(network), String(block));
  }

  async putEvents(events: readonly IndexedEvent[]): Promise<IndexedEvent[]> {
    const added: IndexedEvent[] = [];

    for (const event of events) {
      // HSET returns 1 for a new field and 0 for an overwrite, which is exactly the
      // "was this genuinely new?" answer, decided by Redis rather than by a read-then-write
      // that two indexer passes could interleave.
      const isNew = await this.redis.hset(
        this.eventsKey(event.network),
        String(event.entryId),
        JSON.stringify(event),
      );
      await this.redis.zadd(this.orderKey(event.network), event.entryId, String(event.entryId));
      if (isNew === 1) added.push(event);
    }

    return added;
  }

  async queryEvents(network: string, query: IndexQuery): Promise<IndexedEvent[]> {
    const max = query.beforeEntryId !== undefined ? `(${query.beforeEntryId}` : "+inf";

    // Over-fetch, because actor/did/action filters are applied after loading: the ZSET is
    // ordered by entry id alone. A generous multiple keeps a filtered page full without
    // walking the whole index.
    const span = Math.min(Math.max(query.limit * 20, 100), 2000);
    const ids = await this.redis.zrevrangebyscore(
      this.orderKey(network),
      max,
      "-inf",
      "LIMIT",
      0,
      span,
    );
    if (ids.length === 0) return [];

    const out: IndexedEvent[] = [];
    for (const id of ids) {
      const raw = await this.redis.hget(this.eventsKey(network), id);
      if (!raw) continue;
      const event = JSON.parse(raw) as IndexedEvent;
      if (matches(event, query)) out.push(event);
      if (out.length >= query.limit) break;
    }
    return out;
  }

  async latestEntryId(network: string): Promise<number | null> {
    const ids = await this.redis.zrevrangebyscore(
      this.orderKey(network),
      "+inf",
      "-inf",
      "LIMIT",
      0,
      1,
    );
    return ids.length > 0 ? Number(ids[0]) : null;
  }

  async putTransaction(transaction: TrackedTransaction): Promise<void> {
    await this.redis.hset(
      this.txKey(transaction.network),
      transaction.transactionHash.toLowerCase(),
      JSON.stringify(transaction),
    );
  }

  async getTransaction(network: string, hash: string): Promise<TrackedTransaction | null> {
    const raw = await this.redis.hget(this.txKey(network), hash.toLowerCase());
    return raw ? (JSON.parse(raw) as TrackedTransaction) : null;
  }

  async openTransactions(network: string): Promise<TrackedTransaction[]> {
    const rows = await this.redis.hvals(this.txKey(network));
    return rows
      .map((row) => JSON.parse(row) as TrackedTransaction)
      .filter((tx) => tx.status === "submitted" || tx.status === "pending");
  }

  async transactionsFor(
    network: string,
    actor: string,
    limit: number,
  ): Promise<TrackedTransaction[]> {
    const rows = await this.redis.hvals(this.txKey(network));
    return rows
      .map((row) => JSON.parse(row) as TrackedTransaction)
      .filter((tx) => tx.actor?.toLowerCase() === actor.toLowerCase())
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, limit);
  }
}
