import type { ProvenanceDto, ProvenanceEvent } from "./serializers";

/** Raw on-chain events, from the subgraph or from a getLogs fallback. */
export interface RawAssetEvent {
  kind: "AssetMinted" | "AssetTransferred" | "AssetReclaimed";
  tokenId: number;
  fromDid?: string | null;
  toDid: string;
  fromAddress?: string | null;
  toAddress: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  timestamp: string;
}

export interface AssetEventSource {
  eventsForToken(tokenId: number): Promise<RawAssetEvent[]>;
}

export class ProvenanceError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "broken_chain",
  ) {
    super(message);
    this.name = "ProvenanceError";
  }
}

const KIND_TO_TYPE = {
  AssetMinted: "mint",
  AssetTransferred: "transfer",
  AssetReclaimed: "reclaim",
} as const;

/**
 * Builds an ordered ownership timeline for a token.
 *
 * Ordered by (blockNumber, logIndex), not by timestamp. Several events can share a block,
 * and two events in the same block have identical timestamps — ordering by time would put
 * a transfer before the mint that created the token, roughly half the time.
 *
 * The chain is then verified link by link: each event must start where the previous one
 * ended. A timeline with a gap means the event source is incomplete — a subgraph still
 * indexing, or a getLogs window that missed a range — and reporting that as provenance
 * would be worse than reporting nothing, because it looks authoritative.
 */
export function buildProvenance(tokenId: number, events: RawAssetEvent[]): ProvenanceDto {
  if (events.length === 0) {
    throw new ProvenanceError(`no events found for token ${tokenId}`, "not_found");
  }

  const ordered = [...events].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );

  const first = ordered[0];
  if (!first || first.kind !== "AssetMinted") {
    throw new ProvenanceError(
      `token ${tokenId} history does not begin with a mint; the event source is incomplete`,
      "broken_chain",
    );
  }

  const timeline: ProvenanceEvent[] = [];
  let holder = first.toDid;

  for (const [index, event] of ordered.entries()) {
    if (index > 0) {
      // A reclaim moves keys within one identity, so the DID is unchanged either side.
      const expected = event.kind === "AssetReclaimed" ? holder : holder;
      if (event.fromDid && event.fromDid !== expected) {
        throw new ProvenanceError(
          `ownership chain breaks at block ${event.blockNumber}: expected ${expected}, saw ${event.fromDid}`,
          "broken_chain",
        );
      }
      holder = event.kind === "AssetReclaimed" ? holder : event.toDid;
    }

    timeline.push({
      type: KIND_TO_TYPE[event.kind],
      fromDid: event.fromDid ?? null,
      toDid: event.toDid,
      fromAddress: event.fromAddress ?? null,
      toAddress: event.toAddress,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      occurredAt: event.timestamp,
    });
  }

  return { tokenId, currentOwnerDid: holder, verified: true, timeline };
}

/**
 * Event source with a fallback.
 *
 * The subgraph is fast but lags the chain and can be down. getLogs is slow but
 * authoritative. Trying the subgraph first and falling back keeps provenance available
 * during an indexer outage — the one moment a verifier is most likely to distrust an
 * answer.
 */
export class FallbackEventSource implements AssetEventSource {
  constructor(
    private readonly primary: AssetEventSource,
    private readonly fallback: AssetEventSource,
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  async eventsForToken(tokenId: number): Promise<RawAssetEvent[]> {
    try {
      const events = await this.primary.eventsForToken(tokenId);
      if (events.length > 0) return events;
      // An empty result from a lagging indexer is indistinguishable from a token that
      // does not exist, so confirm against the chain before saying "not found".
      return this.fallback.eventsForToken(tokenId);
    } catch (error) {
      this.onFallback?.(error);
      return this.fallback.eventsForToken(tokenId);
    }
  }
}
