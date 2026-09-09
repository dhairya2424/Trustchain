import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Address } from "viem";

import type { Logger } from "../http/logger";
import type { NetworkSelector } from "../chain/networkSelector";
import { NETWORKS_BY_PRIORITY } from "../chain/networks";
import { ChainIndexer, type IndexerStatus } from "./indexer";
import type { EventIndexStore, IndexedEvent, TrackedTransaction } from "./store";

/**
 * Keeps exactly one indexer running, bound to whichever network is currently active.
 *
 * The platform can switch chains underneath the application — that is the point of the
 * fallback — and an indexer pinned at boot would keep reading the chain the product has
 * stopped using, filling the index with entries from one network while the UI reports
 * another. So the active network is re-checked, and a switch stops the old indexer and
 * starts one for the new chain.
 *
 * Indexers are kept per network rather than discarded, because a switch back (Amoy
 * recovering, say) should resume from that chain's checkpoint rather than re-scan it.
 */

/**
 * Deployment blocks, read from the deployment records rather than configuration.
 *
 * There was a single `AUDIT_TRAIL_DEPLOYMENT_BLOCK` for all networks, holding 18 — the
 * local Hardhat value. Applied to Amoy that instructs the indexer to scan from block 18 to
 * the head, some forty-seven million blocks, in windows of ten. One environment variable
 * cannot describe two chains, and the deployment record already records the answer for
 * each, so it is read from there and cannot drift from the deployment it describes.
 */
export function readDeploymentBlocks(deploymentsDir: string): Record<string, number> {
  const blocks: Record<string, number> = {};

  for (const network of NETWORKS_BY_PRIORITY) {
    const file = path.join(deploymentsDir, network.deploymentFile);
    if (!existsSync(file)) continue;

    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as { blockNumber?: number | string };
      const block = Number(record.blockNumber ?? 0);
      if (Number.isFinite(block) && block >= 0) blocks[network.id] = block;
    } catch {
      // A record we cannot read leaves this network absent, and the caller treats that as
      // "do not index" rather than guessing a start block. Guessing low is catastrophic on
      // a public chain and guessing high silently loses history.
    }
  }

  return blocks;
}

export interface SupervisorOptions {
  selector: NetworkSelector;
  store: EventIndexStore;
  logger: Logger;
  deploymentBlocks: Record<string, number>;
  /** How often to confirm the active network has not changed. */
  superviseIntervalMs?: number;
  confirmations?: number;
  pollIntervalMs?: number;
}

export class IndexerSupervisor {
  private readonly indexers = new Map<string, ChainIndexer>();
  private active: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  private readonly eventListeners = new Set<(events: readonly IndexedEvent[]) => void>();
  private readonly transactionListeners = new Set<(transaction: TrackedTransaction) => void>();

  constructor(private readonly options: SupervisorOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.supervise();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const indexer of this.indexers.values()) indexer.stop();
  }

  onEvents(listener: (events: readonly IndexedEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onTransaction(listener: (transaction: TrackedTransaction) => void): () => void {
    this.transactionListeners.add(listener);
    return () => this.transactionListeners.delete(listener);
  }

  /** The indexer for the active network, when one is running. */
  current(): ChainIndexer | undefined {
    return this.active ? this.indexers.get(this.active) : undefined;
  }

  status(): IndexerStatus | { running: false; network: null; detail: string } {
    const indexer = this.current();
    if (!indexer) {
      return { running: false, network: null, detail: "no indexer for the active network" };
    }
    return indexer.status();
  }

  /** Records a relayed transaction so its lifecycle can be followed. */
  async trackSubmission(input: {
    transactionHash: string;
    actor: string | null;
    action: string | null;
  }): Promise<void> {
    await this.current()?.trackSubmission(input);
  }

  private async supervise(): Promise<void> {
    while (this.running) {
      try {
        await this.ensureCurrent();
      } catch (error) {
        this.options.logger.log({
          level: "warn",
          msg: "indexer.supervise_failed",
          detail: error instanceof Error ? error.message : "unknown",
        });
      }

      if (!this.running) return;
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.options.superviseIntervalMs ?? 30_000);
      });
    }
  }

  private async ensureCurrent(): Promise<void> {
    const active = await this.options.selector.active();
    const id = active.network.id;

    if (this.active === id && this.indexers.get(id)?.status().running) return;

    // Pause the previous chain's indexer rather than destroying it: if the platform
    // switches back, it should resume from its checkpoint instead of re-reading.
    if (this.active && this.active !== id) {
      this.indexers.get(this.active)?.stop();
      this.options.logger.log({
        level: "info",
        msg: "indexer.network_switched",
        from: this.active,
        to: id,
      });
    }

    const deploymentBlock = this.options.deploymentBlocks[id];
    if (deploymentBlock === undefined) {
      // No record means no trustworthy start block. Indexing from a guess would either
      // scan the whole chain or silently omit history, so it does neither.
      this.options.logger.log({
        level: "warn",
        msg: "indexer.no_deployment_block",
        network: id,
      });
      this.active = undefined;
      return;
    }

    let indexer = this.indexers.get(id);
    if (!indexer) {
      indexer = new ChainIndexer({
        client: active.client,
        network: id,
        auditTrailAddress: active.contracts.AuditTrail as Address,
        deploymentBlock,
        store: this.options.store,
        logger: this.options.logger,
        ...(this.options.confirmations !== undefined
          ? { confirmations: this.options.confirmations }
          : {}),
        ...(this.options.pollIntervalMs !== undefined
          ? { pollIntervalMs: this.options.pollIntervalMs }
          : {}),
      });

      indexer.onEvents((events) => {
        for (const listener of this.eventListeners) listener(events);
      });
      indexer.onTransaction((transaction) => {
        for (const listener of this.transactionListeners) listener(transaction);
      });

      this.indexers.set(id, indexer);
    }

    indexer.start();
    this.active = id;

    this.options.logger.log({
      level: "info",
      msg: "indexer.started",
      network: id,
      deploymentBlock,
    });
  }
}
