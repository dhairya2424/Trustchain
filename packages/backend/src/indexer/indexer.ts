import type { Address, Hex, PublicClient } from "viem";

import { ACTION_LOGGED, isRangeTooWide, suggestedWindow } from "../audit/events";
import type { Logger } from "../http/logger";
import type { EventIndexStore, IndexedEvent, TrackedTransaction } from "./store";

/**
 * Walks the chain once, forwards, and keeps a queryable index of what it finds.
 *
 * The alternative — which is what the audit endpoint did before this existed — is to scan
 * the chain with eth_getLogs on every read. That is fine against a local node and
 * unworkable against a real provider: Alchemy's free tier caps a log query at ten blocks,
 * so answering "the last 25 entries" becomes hundreds of round trips, repeated for every
 * reader, and rate limited long before it finishes.
 *
 * Scanning once and serving many readers from the result is the whole idea. The cost is a
 * cache that can be wrong; the mitigations are that it is rebuildable from the chain at any
 * time, that it never advances past unconfirmed blocks, and that writes are idempotent.
 *
 * ## What it is built to survive
 *
 * **Restarts.** Progress is a checkpoint in the store, so a restart resumes where it
 * stopped rather than re-scanning from deployment.
 *
 * **Duplicate delivery.** Every pass deliberately re-reads a small overlap below its
 * checkpoint, and writes are keyed by entry id, so seeing an event twice is a no-op. Only
 * genuinely new events are broadcast — otherwise a restart would replay history at everyone
 * watching.
 *
 * **Reorgs.** The checkpoint never passes `head - confirmations`. An event is only recorded
 * as final once it is buried, so a shallow reorg rewrites blocks the index has not yet
 * claimed. The overlap re-read means a reorged entry that changes transaction hash is
 * corrected rather than left stale.
 *
 * **RPC and network failure.** Every pass is wrapped; a failure backs off exponentially and
 * the loop continues. The indexer never throws into the process, because an audit index
 * that stops silently is worse than one that is briefly behind — and `status()` exposes the
 * last error so "quiet" and "broken" can be told apart.
 *
 * **Rate limits.** The log window narrows to whatever the provider will accept, and the
 * poll interval is deliberately slower than block time. When the chain is idle the loop
 * costs one `eth_blockNumber` per tick.
 */

export interface IndexerOptions {
  client: PublicClient;
  /** Network id — namespaces everything, so two chains never share an entry id. */
  network: string;
  auditTrailAddress: Address;
  /** Block the AuditTrail was deployed in. Nothing below it can hold an event. */
  deploymentBlock: number;
  store: EventIndexStore;
  logger: Logger;
  /** Blocks to wait before treating a block as final. */
  confirmations?: number;
  /** Milliseconds between passes when there is nothing to do. */
  pollIntervalMs?: number;
  /** Starting log window. Narrows automatically to the provider's cap. */
  windowSize?: number;
  /** Blocks re-read below the checkpoint each pass, to repair shallow reorgs. */
  overlapBlocks?: number;
  /** How long an unmined transaction may sit before it is called dropped. */
  dropAfterMs?: number;
}

export interface IndexerStatus {
  network: string;
  running: boolean;
  /** Highest block whose events are written. */
  checkpoint: number | null;
  /** Chain head as of the last pass. */
  head: number | null;
  /** Blocks between the checkpoint and the confirmed head. */
  lag: number | null;
  latestEntryId: number | null;
  lastError: string | null;
  lastPassAt: number | null;
}

export type IndexerListener = (events: readonly IndexedEvent[]) => void;
export type TransactionListener = (transaction: TrackedTransaction) => void;

const ZERO_HASH = `0x${"0".repeat(64)}`;

export class ChainIndexer {
  private readonly confirmations: number;
  private readonly pollIntervalMs: number;
  private readonly overlapBlocks: number;
  private readonly dropAfterMs: number;
  private windowSize: bigint;

  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private status_: IndexerStatus;

  private readonly eventListeners = new Set<IndexerListener>();
  private readonly transactionListeners = new Set<TransactionListener>();

  /** Smallest window worth attempting; below this a scan cannot make progress. */
  private static readonly MIN_WINDOW = 10n;

  constructor(private readonly options: IndexerOptions) {
    this.confirmations = options.confirmations ?? 5;
    this.pollIntervalMs = options.pollIntervalMs ?? 6_000;
    this.overlapBlocks = options.overlapBlocks ?? 12;
    this.dropAfterMs = options.dropAfterMs ?? 10 * 60_000;
    this.windowSize = BigInt(options.windowSize ?? 500);

    this.status_ = {
      network: options.network,
      running: false,
      checkpoint: null,
      head: null,
      lag: null,
      latestEntryId: null,
      lastError: null,
      lastPassAt: null,
    };
  }

  status(): IndexerStatus {
    return { ...this.status_ };
  }

  onEvents(listener: IndexerListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onTransaction(listener: TransactionListener): () => void {
    this.transactionListeners.add(listener);
    return () => this.transactionListeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.status_.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.status_.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass. Exposed so a test can drive the indexer without a timer. */
  async tick(): Promise<void> {
    await this.ingest();
    await this.reconcileTransactions();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let delay = this.pollIntervalMs;

      try {
        await this.tick();
        this.failures = 0;
        this.status_.lastError = null;
      } catch (error) {
        this.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.status_.lastError = message;

        // Exponential backoff, capped. A provider that is down or rate limiting is not
        // helped by being asked more often, and the loop must not exit either way.
        delay = Math.min(this.pollIntervalMs * 2 ** Math.min(this.failures, 5), 120_000);
        this.options.logger.log({
          level: "warn",
          msg: "indexer.pass_failed",
          network: this.options.network,
          failures: this.failures,
          detail: message,
        });
      }

      this.status_.lastPassAt = Date.now();
      if (!this.running) return;
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, delay);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private async ingest(): Promise<void> {
    const { client, store, network, deploymentBlock } = this.options;

    const head = Number(await client.getBlockNumber());
    this.status_.head = head;

    // Never index into blocks that can still be reorganised out.
    const safeHead = head - this.confirmations;
    if (safeHead < deploymentBlock) return;

    const checkpoint = await store.getCheckpoint(network);
    this.status_.checkpoint = checkpoint;

    // Re-read a little below the checkpoint. A shallow reorg that rewrote a block we
    // already indexed is corrected here, and the idempotent write makes the overlap free.
    const from =
      checkpoint === null
        ? deploymentBlock
        : Math.max(deploymentBlock, checkpoint - this.overlapBlocks + 1);

    if (from > safeHead) {
      this.status_.lag = 0;
      return;
    }

    this.status_.lag = safeHead - (checkpoint ?? deploymentBlock);

    let cursor = BigInt(from);
    const target = BigInt(safeHead);

    while (cursor <= target) {
      const { logs, to } = await this.getLogsAdaptive(cursor, target);

      const events = await this.decode(logs);
      const added = await store.putEvents(events);

      // Advance only after the write, so a crash between the two re-reads rather than skips.
      await store.setCheckpoint(network, Number(to));
      this.status_.checkpoint = Number(to);

      if (added.length > 0) {
        this.status_.latestEntryId = Math.max(...added.map((event) => event.entryId));
        this.options.logger.log({
          level: "info",
          msg: "indexer.events_indexed",
          network,
          count: added.length,
          throughBlock: Number(to),
        });
        this.broadcastEvents(added);
      }

      cursor = to + 1n;
    }
  }

  /**
   * getLogs over a forward range, narrowing until the provider accepts it.
   *
   * Returns the upper bound actually queried so the caller advances from the range that was
   * really read — computing it separately would step over blocks whenever the window
   * narrowed mid-scan.
   */
  private async getLogsAdaptive(
    from: bigint,
    target: bigint,
  ): Promise<{ logs: readonly unknown[]; to: bigint }> {
    const { client, auditTrailAddress } = this.options;

    for (;;) {
      const to = from + this.windowSize - 1n > target ? target : from + this.windowSize - 1n;

      try {
        const logs = await client.getLogs({
          address: auditTrailAddress,
          event: ACTION_LOGGED,
          fromBlock: from,
          toBlock: to,
        });
        return { logs, to };
      } catch (error) {
        if (!isRangeTooWide(error) || this.windowSize <= ChainIndexer.MIN_WINDOW) throw error;

        const next = suggestedWindow(error) ?? this.windowSize / 4n;
        this.windowSize = next < ChainIndexer.MIN_WINDOW ? ChainIndexer.MIN_WINDOW : next;
        this.options.logger.log({
          level: "info",
          msg: "indexer.window_narrowed",
          network: this.options.network,
          windowSize: Number(this.windowSize),
        });
      }
    }
  }

  private async decode(logs: readonly unknown[]): Promise<IndexedEvent[]> {
    const typed = logs as {
      args?: {
        entryId?: bigint;
        didHash?: Hex;
        actionCode?: number;
        actor?: Address;
        refHash?: Hex;
        caller?: Address;
        timestamp?: bigint;
      };
      blockNumber?: bigint;
      logIndex?: number;
      transactionHash?: Hex;
    }[];

    // Resolve each transaction once. A single transaction commonly writes several entries,
    // and fetching it per entry multiplies RPC cost for no new information.
    const hashes = [...new Set(typed.map((log) => log.transactionHash).filter(Boolean))] as Hex[];
    const senders = new Map<string, string>();

    for (const hash of hashes) {
      try {
        const transaction = await this.options.client.getTransaction({ hash });
        senders.set(hash.toLowerCase(), transaction.from);
      } catch {
        // A sender we cannot resolve is reported as unknown rather than guessed. The actor
        // — the field that attributes the action — comes from the event either way.
      }
    }

    const events: IndexedEvent[] = [];
    for (const log of typed) {
      const args = log.args;
      if (!args || args.entryId === undefined || args.didHash === undefined) continue;

      events.push({
        network: this.options.network,
        entryId: Number(args.entryId),
        didHash: args.didHash,
        actionCode: Number(args.actionCode ?? 0),
        refHash: args.refHash ?? ZERO_HASH,
        via: args.caller ?? "",
        actor: args.actor ?? null,
        executor: senders.get((log.transactionHash ?? "").toLowerCase()) ?? null,
        blockNumber: Number(log.blockNumber ?? 0n),
        logIndex: Number(log.logIndex ?? 0),
        transactionHash: log.transactionHash ?? "",
        timestamp: Number(args.timestamp ?? 0n),
      });
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Transaction lifecycle
  // -------------------------------------------------------------------------

  /** Records a transaction the moment it is handed to the relayer. */
  async trackSubmission(input: {
    transactionHash: string;
    actor: string | null;
    action: string | null;
  }): Promise<void> {
    const transaction: TrackedTransaction = {
      network: this.options.network,
      transactionHash: input.transactionHash,
      status: "submitted",
      actor: input.actor,
      action: input.action,
      submittedAt: Date.now(),
    };
    await this.options.store.putTransaction(transaction);
    this.broadcastTransaction(transaction);
  }

  /**
   * Moves open transactions to their resting state.
   *
   * Three outcomes, and the third is the one usually left out: a transaction can simply
   * never be mined. A relayer can under-price it, or the mempool can drop it, and nothing
   * announces that — the receipt just never arrives. Without a timeout the interface would
   * show "pending" forever, which reads as "still working" when it means "gone".
   */
  private async reconcileTransactions(): Promise<void> {
    const { client, store, network } = this.options;
    const open = await store.openTransactions(network);
    if (open.length === 0) return;

    for (const transaction of open) {
      let receipt: { status: "success" | "reverted"; blockNumber: bigint } | null = null;

      try {
        receipt = (await client.getTransactionReceipt({
          hash: transaction.transactionHash as Hex,
        })) as unknown as { status: "success" | "reverted"; blockNumber: bigint };
      } catch {
        // No receipt yet is the ordinary case for a transaction in the mempool, and is
        // indistinguishable at this layer from an RPC hiccup — both mean "not known yet".
        receipt = null;
      }

      if (receipt) {
        const next: TrackedTransaction = {
          ...transaction,
          status: receipt.status === "success" ? "confirmed" : "failed",
          blockNumber: Number(receipt.blockNumber),
          confirmedAt: Date.now(),
          ...(receipt.status === "reverted"
            ? { detail: "the transaction was mined but reverted" }
            : {}),
        };
        await store.putTransaction(next);
        this.broadcastTransaction(next);
        continue;
      }

      const age = Date.now() - transaction.submittedAt;
      if (age > this.dropAfterMs) {
        const next: TrackedTransaction = {
          ...transaction,
          status: "dropped",
          detail: `no receipt after ${Math.round(age / 60_000)} minutes — the transaction was probably never mined`,
        };
        await store.putTransaction(next);
        this.broadcastTransaction(next);
        continue;
      }

      if (transaction.status === "submitted") {
        const next: TrackedTransaction = { ...transaction, status: "pending" };
        await store.putTransaction(next);
        this.broadcastTransaction(next);
      }
    }
  }

  // -------------------------------------------------------------------------

  private broadcastEvents(events: readonly IndexedEvent[]): void {
    for (const listener of this.eventListeners) {
      try {
        listener(events);
      } catch {
        // A broken subscriber must not stop indexing, and must not stop the others.
      }
    }
  }

  private broadcastTransaction(transaction: TrackedTransaction): void {
    for (const listener of this.transactionListeners) {
      try {
        listener(transaction);
      } catch {
        // As above.
      }
    }
  }
}
