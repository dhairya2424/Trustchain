import { motion as fm } from "framer-motion";

import { Status } from "@/components/ui/status";
import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";
import { useTransaction, type LiveTransaction, type TransactionStatus } from "./LiveChainProvider";

/**
 * What happened to a transaction, from submission to a link anyone can check.
 *
 * The interface used to end at "submitted". A relayed write returns 202 with a transaction
 * id, and there was nothing further to say — so a person who had just minted an asset saw a
 * success message and an interface that never mentioned it again. Whether the chain
 * accepted it was, from the outside, unknowable.
 *
 * Four things are worth being precise about here.
 *
 * **Submitted is not confirmed.** They are drawn differently and worded differently.
 * Showing a green tick the instant the relayer accepts the request would assert something
 * the chain has not yet agreed to, and on a platform whose entire claim is verifiability
 * that is the worst available lie.
 *
 * **Dropped is a real outcome.** A transaction can simply never be mined. Without that
 * state the row would say "pending" indefinitely, which reads as "still working" when it
 * means "gone".
 *
 * **The explorer link only appears when there is something to look at.** A link to a hash
 * the chain has not recorded is a broken promise, so it is rendered on confirmation, and on
 * a public network — a local chain has no explorer, and inventing one would imply an
 * independence that does not exist there.
 *
 * **Colour is the status, not decoration.** Green means the chain confirmed it, red means
 * it failed, amber means still moving. Nothing else on this component carries colour.
 */

export interface TransactionTrailProps {
  /** The hash to follow. Null while the relayer has not broadcast one yet. */
  hash: string | null | undefined;
  /** Explorer base URL for the active network, or null when it has none. */
  explorerUrl?: string | null;
  /** Network label, so "confirmed" says confirmed *where*. */
  networkLabel?: string | undefined;
  className?: string;
}

const TONE: Record<TransactionStatus, "verified" | "fallback" | "revoked" | "neutral"> = {
  submitted: "neutral",
  pending: "fallback",
  confirmed: "verified",
  failed: "revoked",
  dropped: "revoked",
};

const LABEL: Record<TransactionStatus, string> = {
  submitted: "Submitted",
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  dropped: "Never mined",
};

function describe(transaction: LiveTransaction, networkLabel: string | undefined): string {
  switch (transaction.status) {
    case "submitted":
      return "Handed to the relayer. It has not reached the chain yet.";
    case "pending":
      return "In the mempool, waiting to be included in a block.";
    case "confirmed":
      return networkLabel
        ? `Included in block ${transaction.blockNumber} on ${networkLabel}.`
        : `Included in block ${transaction.blockNumber}.`;
    case "failed":
      return transaction.detail ?? "The chain mined it and the call reverted.";
    case "dropped":
      return transaction.detail ?? "No receipt arrived. It was probably never mined.";
  }
}

export function TransactionTrail({
  hash,
  explorerUrl,
  networkLabel,
  className,
}: TransactionTrailProps) {
  const motion = useMotion();
  const transaction = useTransaction(hash);

  if (!hash) return null;

  const status: TransactionStatus = transaction?.status ?? "submitted";
  const isSettled = status === "confirmed" || status === "failed" || status === "dropped";

  return (
    <fm.div
      className={cn("panel px-5 py-4", className)}
      initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motion.transition("base")}
      data-testid="transaction-trail"
      data-status={status}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Status tone={TONE[status]}>{LABEL[status]}</Status>

        {/*
         * A moving marker only while it is genuinely moving. A spinner that keeps turning
         * after the outcome is known is a small lie about what the system is doing.
         */}
        {!isSettled && !motion.reduced && <span aria-hidden="true" className="caret" />}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        {transaction
          ? describe(transaction, networkLabel)
          : "Waiting for the relayer to report a transaction hash."}
      </p>

      <dl className="mt-3 border-t border-line pt-3">
        <dt className="eyebrow">Transaction</dt>
        <dd className="mt-1 break-all font-mono text-xs text-fg-muted">{hash}</dd>
      </dl>

      {status === "confirmed" && explorerUrl && (
        <a
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-4 transition-colors hover:text-fg"
          href={`${explorerUrl}/tx/${hash}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on PolygonScan
          <span aria-hidden="true">↗</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}

      {status === "confirmed" && !explorerUrl && (
        <p className="mt-3 text-xs leading-relaxed text-fg-faint">
          This network has no public explorer, so the record can be checked against the chain
          directly but not linked to.
        </p>
      )}
    </fm.div>
  );
}
