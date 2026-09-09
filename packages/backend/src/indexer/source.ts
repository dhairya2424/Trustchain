import type { AuditEventSource, AuditFilter, RawAuditEvent } from "../audit/events";
import { matchesFilter } from "../audit/events";
import type { EventIndexStore } from "./store";

/**
 * Serves the audit trail from the index rather than by scanning the chain.
 *
 * This is the fast path, and on a rate-limited provider it is the only workable one: a read
 * here costs a bounded number of Redis calls instead of a walk backwards through the chain
 * in ten-block windows.
 *
 * It is deliberately not the *only* path. The index is a cache, and a cache can be empty —
 * on first boot, after a flush, or while the indexer is still catching up. Answering
 * "nothing happened" from an index that has not read the chain yet would be a false
 * statement about the ledger, and on this product that is the worst available failure. So
 * an empty result is reported as a miss and the caller falls back to the chain, which is
 * slow, authoritative, and always right.
 *
 * Time filters are applied here rather than pushed down: entries are ordered by entry id,
 * and entry id is monotonic with time, so a timestamp filter cannot narrow the scan without
 * a second index that would have to be kept consistent with the first.
 */
export class IndexedAuditSource implements AuditEventSource {
  constructor(
    private readonly store: EventIndexStore,
    private readonly network: string,
  ) {}

  async query(filter: AuditFilter): Promise<RawAuditEvent[]> {
    const rows = await this.store.queryEvents(this.network, {
      actor: filter.actor,
      didHash: filter.didHash,
      actionCode: filter.actionCode,
      beforeEntryId: filter.beforeEntryId,
      // Over-fetch so post-filtering on time cannot return a short page while matching
      // entries remain just past the limit.
      limit: filter.from !== undefined || filter.to !== undefined ? filter.limit * 4 : filter.limit,
    });

    return rows.filter((event) => matchesFilter(event, filter)).slice(0, filter.limit);
  }

  /** True when the index holds anything at all for this network. */
  async hasData(): Promise<boolean> {
    return (await this.store.latestEntryId(this.network)) !== null;
  }
}
