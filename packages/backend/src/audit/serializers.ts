import { actionName } from "./actions";
import type { RawAuditEvent } from "./events";

/**
 * The audit entry as the API presents it.
 *
 * An explicit projection, like every other DTO here. The point is not that the raw event
 * holds secrets — it holds none, since the chain is public — but that the response shape
 * is a contract with the frontend, and `res.json(rawEvent)` makes every internal field
 * rename a breaking API change.
 */
export interface AuditEntryDto {
  entryId: number;
  action: string;
  actionCode: number;
  /** Initiating account, or null when the source could not attribute it. */
  actor: string | null;
  didHash: string;
  refHash: string;
  /** System contract that recorded the entry. */
  via: string;
  blockNumber: number;
  transactionHash: string;
  occurredAt: string;
}

export function toAuditEntryDto(event: RawAuditEvent): AuditEntryDto {
  return {
    entryId: event.entryId,
    action: actionName(event.actionCode),
    actionCode: event.actionCode,
    actor: event.actor,
    didHash: event.didHash,
    refHash: event.refHash,
    via: event.via,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    occurredAt: new Date(event.timestamp * 1000).toISOString(),
  };
}

export interface AuditPageDto {
  entries: AuditEntryDto[];
  /** Opaque; pass back as `cursor`. Null when the page is the last one. */
  nextCursor: string | null;
  /**
   * Which source answered.
   *
   * Reported rather than hidden. A verifier reading an audit log is entitled to know
   * whether the answer came from an indexer that may lag or from the chain itself, and
   * a UI can say so. Concealing a degraded read is how a stale answer gets treated as
   * authoritative.
   */
  source: "subgraph" | "chain";
}
