import type { Address, Hex, PublicClient } from "viem";
import { parseAbiItem } from "viem";

import { ACTION_NAMES, type ActionName } from "./actions";

/**
 * One entry from the on-chain audit trail.
 *
 * `via` and `actor` are two different things and conflating them would make the log
 * useless. The AuditTrail contract records `msg.sender`, which is always a sibling system
 * contract — CredentialRegistry, AssetRegistry — because only those are trusted callers.
 * The human or service that actually initiated the action is the transaction's sender, so
 * that is resolved separately and reported as `actor`. An auditor asking "who revoked
 * this?" means the account, not the contract that happened to write the row.
 */
export interface RawAuditEvent {
  /** Monotonic index assigned by the contract. Unique and gap-free — the cursor key. */
  entryId: number;
  didHash: string;
  actionCode: number;
  refHash: string;
  /** System contract that wrote the entry. */
  via: string;
  /** Externally-owned account that sent the transaction, when it could be resolved. */
  actor: string | null;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  /** Unix seconds, as recorded on-chain. */
  timestamp: number;
}

export interface AuditFilter {
  actor?: string | undefined;
  didHash?: string | undefined;
  actionCode?: number | undefined;
  /** Unix seconds, inclusive. */
  from?: number | undefined;
  to?: number | undefined;
  /** Return entries with an id strictly below this one. Descending order. */
  beforeEntryId?: number | undefined;
  limit: number;
}

export interface AuditEventSource {
  query(filter: AuditFilter): Promise<RawAuditEvent[]>;
}

export class AuditSourceError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "malformed",
  ) {
    super(message);
    this.name = "AuditSourceError";
  }
}

/** Applied after fetching, for predicates the source could not push down. */
export function matchesFilter(event: RawAuditEvent, filter: AuditFilter): boolean {
  if (filter.actor && event.actor?.toLowerCase() !== filter.actor.toLowerCase()) return false;
  if (filter.didHash && event.didHash.toLowerCase() !== filter.didHash.toLowerCase()) return false;
  if (filter.actionCode !== undefined && event.actionCode !== filter.actionCode) return false;
  if (filter.from !== undefined && event.timestamp < filter.from) return false;
  if (filter.to !== undefined && event.timestamp > filter.to) return false;
  if (filter.beforeEntryId !== undefined && event.entryId >= filter.beforeEntryId) return false;
  return true;
}

/** Newest first. Entry ids are assigned in order, so this is a total chronological sort. */
export function byEntryIdDescending(a: RawAuditEvent, b: RawAuditEvent): number {
  return b.entryId - a.entryId;
}

// ---------------------------------------------------------------------------
// Subgraph — the primary source
// ---------------------------------------------------------------------------

const SUBGRAPH_QUERY = `
query AuditEntries($first: Int!, $where: AuditEntry_filter!) {
  auditEntries(first: $first, orderBy: entryId, orderDirection: desc, where: $where) {
    entryId
    didHash
    actionCode
    refHash
    via
    actor
    blockNumber
    logIndex
    transactionHash
    timestamp
  }
}`;

interface SubgraphRow {
  entryId: string;
  didHash: string;
  actionCode: number | string;
  refHash: string;
  via: string;
  actor: string | null;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  timestamp: string;
}

/**
 * Reads indexed events from the subgraph.
 *
 * This is the fast path and the one that serves essentially every request: the indexer
 * has already walked the chain, resolved transaction senders, and made the fields
 * queryable. What it cannot promise is currency — a subgraph lags the head and can stop
 * indexing entirely — which is why it is never the only source.
 */
export class SubgraphAuditSource implements AuditEventSource {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  async query(filter: AuditFilter): Promise<RawAuditEvent[]> {
    const where: Record<string, unknown> = {};
    if (filter.actor) where.actor = filter.actor.toLowerCase();
    if (filter.didHash) where.didHash = filter.didHash.toLowerCase();
    if (filter.actionCode !== undefined) where.actionCode = filter.actionCode;
    if (filter.from !== undefined) where.timestamp_gte = String(filter.from);
    if (filter.to !== undefined) where.timestamp_lte = String(filter.to);
    if (filter.beforeEntryId !== undefined) where.entryId_lt = String(filter.beforeEntryId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: SUBGRAPH_QUERY,
          variables: { first: filter.limit, where },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AuditSourceError(
        `subgraph unreachable: ${error instanceof Error ? error.message : "unknown"}`,
        "unavailable",
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AuditSourceError(`subgraph responded ${response.status}`, "unavailable");
    }

    const body = (await response.json()) as {
      data?: { auditEntries?: SubgraphRow[] };
      errors?: { message: string }[];
    };

    if (body.errors?.length) {
      // GraphQL reports query errors with a 200, so this is the real error channel.
      throw new AuditSourceError(`subgraph query failed: ${body.errors[0]?.message}`, "malformed");
    }

    const rows = body.data?.auditEntries;
    if (!rows) throw new AuditSourceError("subgraph response contained no entries", "malformed");

    return rows.map(toRawEvent).sort(byEntryIdDescending);
  }
}

function toRawEvent(row: SubgraphRow): RawAuditEvent {
  return {
    entryId: Number(row.entryId),
    didHash: row.didHash,
    actionCode: Number(row.actionCode),
    refHash: row.refHash,
    via: row.via,
    actor: row.actor,
    blockNumber: Number(row.blockNumber),
    logIndex: Number(row.logIndex),
    transactionHash: row.transactionHash,
    timestamp: Number(row.timestamp),
  };
}

// ---------------------------------------------------------------------------
// getLogs — the authoritative fallback
// ---------------------------------------------------------------------------

const ACTION_LOGGED = parseAbiItem(
  "event ActionLogged(uint256 indexed entryId, bytes32 indexed didHash, uint8 indexed actionCode, bytes32 refHash, address caller, uint64 timestamp)",
);

export interface OnChainAuditOptions {
  client: PublicClient;
  address: Address;
  /** Block the AuditTrail was deployed in. Scanning below it is wasted work. */
  deploymentBlock: bigint;
  /** Blocks per getLogs call. Public RPCs cap the range; 10k is broadly safe. */
  windowSize?: bigint;
  /** Ceiling on windows per query, so one request cannot walk the whole chain. */
  maxWindows?: number;
}

/**
 * Reads the audit trail straight from the chain.
 *
 * Slow and deliberately bounded. It walks backwards from the head in fixed windows and
 * stops once it has enough rows, so a query for the most recent 25 entries costs one or
 * two calls. A query filtered to a narrow slice of ancient history can exhaust the window
 * budget and return a short page — that is reported honestly by the caller rather than
 * presented as "no more results", because an audit log that silently truncates is worse
 * than one that admits it is degraded.
 *
 * Transaction senders are resolved per unique transaction hash, not per entry: a single
 * transaction commonly writes several entries, and fetching it once each would multiply
 * the RPC cost for no new information.
 */
export class OnChainAuditSource implements AuditEventSource {
  private readonly windowSize: bigint;
  private readonly maxWindows: number;

  constructor(private readonly options: OnChainAuditOptions) {
    this.windowSize = options.windowSize ?? 10_000n;
    this.maxWindows = options.maxWindows ?? 20;
  }

  async query(filter: AuditFilter): Promise<RawAuditEvent[]> {
    const { client, address, deploymentBlock } = this.options;

    let head: bigint;
    try {
      head = await client.getBlockNumber();
    } catch (error) {
      throw new AuditSourceError(
        `rpc unreachable: ${error instanceof Error ? error.message : "unknown"}`,
        "unavailable",
      );
    }

    const collected: RawAuditEvent[] = [];
    let upper = head;
    let windows = 0;

    while (
      upper >= deploymentBlock &&
      collected.length < filter.limit &&
      windows < this.maxWindows
    ) {
      const lower =
        upper - this.windowSize + 1n > deploymentBlock
          ? upper - this.windowSize + 1n
          : deploymentBlock;

      const logs = await client.getLogs({
        address,
        event: ACTION_LOGGED,
        fromBlock: lower,
        toBlock: upper,
        // Indexed arguments are filtered by the node, so these cost nothing to apply.
        args: {
          ...(filter.didHash ? { didHash: filter.didHash as Hex } : {}),
          ...(filter.actionCode !== undefined ? { actionCode: filter.actionCode } : {}),
        },
      });

      const senders = await this.resolveSenders(logs.map((log) => log.transactionHash));

      for (const log of logs) {
        const args = log.args as {
          entryId?: bigint;
          didHash?: Hex;
          actionCode?: number;
          refHash?: Hex;
          caller?: Address;
          timestamp?: bigint;
        };

        if (args.entryId === undefined || args.didHash === undefined) continue;

        const event: RawAuditEvent = {
          entryId: Number(args.entryId),
          didHash: args.didHash,
          actionCode: Number(args.actionCode ?? 0),
          refHash: args.refHash ?? `0x${"0".repeat(64)}`,
          via: args.caller ?? "",
          actor: senders.get(log.transactionHash ?? "") ?? null,
          blockNumber: Number(log.blockNumber ?? 0n),
          logIndex: Number(log.logIndex ?? 0),
          transactionHash: log.transactionHash ?? "",
          timestamp: Number(args.timestamp ?? 0n),
        };

        if (matchesFilter(event, filter)) collected.push(event);
      }

      if (lower === deploymentBlock) break;
      upper = lower - 1n;
      windows += 1;
    }

    return collected.sort(byEntryIdDescending).slice(0, filter.limit);
  }

  private async resolveSenders(hashes: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(hashes.filter((h): h is string => Boolean(h)))];
    const senders = new Map<string, string>();

    await Promise.all(
      unique.map(async (hash) => {
        try {
          const tx = await this.options.client.getTransaction({ hash: hash as Hex });
          senders.set(hash, tx.from);
        } catch {
          // A sender we cannot resolve is reported as null rather than guessed. The
          // entry itself is still authoritative; only the attribution is missing.
        }
      }),
    );

    return senders;
  }
}

// ---------------------------------------------------------------------------
// Fallback composition
// ---------------------------------------------------------------------------

export interface AuditQueryResult {
  events: RawAuditEvent[];
  /** Which source answered. Surfaced to the caller so a degraded read is visible. */
  source: "subgraph" | "chain";
}

/**
 * Tries the subgraph, falls back to the chain.
 *
 * Unlike the asset provenance fallback, an empty subgraph result is NOT retried against
 * the chain. An audit query is a filtered search, and "no entries matched" is a perfectly
 * ordinary answer — re-running every empty search as a full chain scan would turn the
 * cheapest query into the most expensive one. Only an actual failure falls through.
 */
export class FallbackAuditSource {
  constructor(
    private readonly primary: AuditEventSource,
    private readonly fallback: AuditEventSource,
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  async query(filter: AuditFilter): Promise<AuditQueryResult> {
    try {
      return { events: await this.primary.query(filter), source: "subgraph" };
    } catch (error) {
      this.onFallback?.(error);
      return { events: await this.fallback.query(filter), source: "chain" };
    }
  }
}

export { ACTION_NAMES };
export type { ActionName };
