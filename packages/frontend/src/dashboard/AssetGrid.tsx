import { motion as fm } from "framer-motion";
import { useState } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { useMotion } from "@/motion/MotionProvider";
import { truncateAddress } from "@/lib/utils";
import type { AuditEntry } from "@/api/queries";

/**
 * Assets this identity minted, derived from the audit trail.
 *
 * Read the derivation carefully, because it is the honest part. There is no
 * "GET /assets?owner=" endpoint — the asset repository and the event indexer are not
 * implemented, and `GET /assets/:id` answers 404 by design rather than inventing a record.
 * What *does* exist is an `ASSET_MINTED` audit entry per mint, attributed on-chain to the
 * actor who requested it. That is real, verifiable data, and it is enough to say "you
 * minted this token, in this block, in this transaction".
 *
 * What it is not enough for is a picture. Token metadata lives on IPFS behind a CID the
 * audit entry does not carry, so these cards show a placeholder frame and say why — rather
 * than a stock image, a gradient, or a spinner that will never resolve. The skeleton
 * shimmer below is wired and waiting for the day the indexer supplies a CID.
 */

export interface AssetGridProps {
  mints: AuditEntry[] | undefined;
  isLoading: boolean;
  /** Rendered when the caller cannot read the audit trail at all. */
  blocked?: React.ReactNode;
}

export function AssetGrid({ mints, isLoading, blocked }: AssetGridProps) {
  const motion = useMotion();

  if (blocked) return <>{blocked}</>;

  if (isLoading && !mints) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="assets-loading">
        {[0, 1, 2].map((card) => (
          <div key={card} className="panel p-4">
            <Skeleton className="aspect-4/3 w-full" />
            <Skeleton className="mt-4 h-3 w-24" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
    );
  }

  if (!mints || mints.length === 0) {
    return (
      <EmptyState
        illustration="assets"
        title="No assets yet"
        body="Assets you mint appear here with their provenance. Each one is an NFT whose metadata lives on IPFS and whose history is a chain of events nobody can quietly rewrite."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="asset-grid">
      {mints.map((mint, index) => (
        <fm.article
          key={mint.entryId}
          className="group panel p-4 transition-colors hover:border-line-strong"
          initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motion.transition("base", motion.stagger(index, 0.07))}
          // Lift on hover, but no glow: elevation is the signal, and a coloured halo would
          // spend a hue that means nothing here.
          whileHover={motion.reduced ? undefined : { y: -3 }}
          data-testid="asset-card"
        >
          <AssetArtwork />

          <div className="mt-4 space-y-1.5">
            <p className="font-mono text-xs text-fg-faint">{truncateAddress(mint.refHash)}</p>
            <p className="text-base font-medium">Minted asset</p>
            <p className="font-mono text-2xs text-fg-faint">
              block {mint.blockNumber} · {truncateAddress(mint.transactionHash)}
            </p>
          </div>
        </fm.article>
      ))}
    </div>
  );
}

/**
 * The artwork slot.
 *
 * Holds the shimmer while an IPFS image loads, and — until the indexer exists to supply a
 * CID — states plainly that there is no image rather than showing one that is not the
 * asset's.
 */
function AssetArtwork({ cid }: { cid?: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">(cid ? "loading" : "failed");

  if (!cid) {
    return (
      <div
        className="grid aspect-4/3 w-full place-items-center rounded border border-dashed border-line bg-canvas px-4 text-center"
        data-testid="asset-artwork-absent"
      >
        <p className="text-2xs leading-snug text-fg-faint">
          Metadata pending
          <br />
          the asset indexer
        </p>
      </div>
    );
  }

  return (
    <div className="relative aspect-4/3 w-full overflow-hidden rounded bg-canvas">
      {state === "loading" && <Skeleton className="absolute inset-0" />}

      <img
        src={cid}
        alt=""
        loading="lazy"
        className="size-full object-cover"
        onLoad={() => setState("loaded")}
        onError={() => setState("failed")}
        data-testid="asset-image"
      />

      {state === "failed" && (
        <div className="absolute inset-0 grid place-items-center bg-canvas">
          <Status tone="neutral">Image unavailable</Status>
        </div>
      )}
    </div>
  );
}
