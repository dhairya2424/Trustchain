import { AnimatePresence, motion as fm } from "framer-motion";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { actionLabel, type AuditEntry } from "@/api/queries";
import { ApiError } from "@/api/client";
import { useMotion } from "@/motion/MotionProvider";
import { truncateAddress } from "@/lib/utils";

/**
 * The user's own on-chain activity, newest first.
 *
 * Every row is a real audit entry. The two addresses shown are the point of the whole
 * actor-attribution work: `actor` is the identity that requested the action and `executor`
 * is the account that submitted the transaction. When they differ, a relayer paid the gas —
 * and saying so plainly is more honest than showing one address and letting the reader
 * assume it did everything. (`via`, a third field, is neither: it is the system contract
 * that wrote the entry.)
 *
 * New entries slide in from the right. `AnimatePresence` keyed on entryId means only
 * genuinely new rows animate; a poll that returns the same page moves nothing, which is
 * what keeps a 30-second refresh from looking like a nervous tic.
 */

export interface ActivityFeedProps {
  entries: AuditEntry[] | undefined;
  isLoading: boolean;
  error: ApiError | null;
}

export function ActivityFeed({ entries, isLoading, error }: ActivityFeedProps) {
  const motion = useMotion();

  if (error) return <ActivityError error={error} />;

  if (isLoading && !entries) {
    return (
      <div className="space-y-px" data-testid="activity-loading">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="ml-auto h-3 w-20" />
          </div>
        ))}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        illustration="activity"
        title="Nothing recorded yet"
        body="Actions you take appear here the moment they are confirmed on-chain, with the identity that requested them and the account that submitted them."
      />
    );
  }

  return (
    <ul data-testid="activity-feed">
      <AnimatePresence initial={false}>
        {entries.map((event) => (
          <fm.li
            key={event.entryId}
            layout={!motion.reduced}
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={motion.reduced ? { opacity: 0 } : { opacity: 0, x: -12 }}
            transition={motion.transition("base")}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-5 py-4 last:border-b-0"
            data-testid="activity-row"
          >
            <span className="text-base font-medium text-fg">{actionLabel(event.action)}</span>

            <span
              className="font-mono text-xs text-fg-muted"
              title={event.actor ?? "no actor recorded"}
            >
              by {event.actor ? truncateAddress(event.actor) : "unattributed"}
            </span>

            {event.executor && event.executor.toLowerCase() !== event.actor?.toLowerCase() && (
              // The distinction the audit trail exists to preserve: who asked, and who paid
              // the gas to submit it. `via` is neither — it is the system contract that
              // recorded the entry.
              <span className="font-mono text-xs text-fg-faint" title={event.executor}>
                submitted by {truncateAddress(event.executor)}
              </span>
            )}

            <time
              className="ml-auto font-mono text-xs tabular text-fg-faint"
              dateTime={event.occurredAt}
            >
              {formatWhen(event.occurredAt)}
            </time>

            <span className="w-full font-mono text-2xs text-fg-faint">
              block {event.blockNumber} · {truncateAddress(event.transactionHash)}
            </span>
          </fm.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function ActivityError({ error }: { error: ApiError }) {
  // A missing permission is not a failure — it is the RBAC working, and the interface
  // should say which of the two it is rather than showing one red box for both.
  if (error.isForbidden) {
    return (
      <div className="px-5 py-10 text-center" data-testid="activity-forbidden">
        <Status tone="neutral">Permission required</Status>
        <p className="mx-auto mt-3 max-w-[46ch] text-sm leading-relaxed text-fg-muted">
          Reading the audit trail needs the <span className="font-mono">VIEW_AUDIT</span>{" "}
          permission, which your roles do not currently include. The records exist; this account is
          not authorized to read them.
        </p>
      </div>
    );
  }

  if (error.isUnavailable) {
    return (
      <div className="px-5 py-10 text-center" data-testid="activity-unavailable">
        <Status tone="fallback">No network</Status>
        <p className="mx-auto mt-3 max-w-[46ch] text-sm leading-relaxed text-fg-muted">
          No blockchain network is currently usable, so there is nothing to read from. That is an
          availability problem, not an empty history.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 py-10 text-center" data-testid="activity-error">
      <Status tone="revoked">Could not load</Status>
      <p className="mx-auto mt-3 max-w-[46ch] text-sm leading-relaxed text-fg-muted">
        {error.message}
      </p>
    </div>
  );
}

/** Relative for anything recent, absolute once "3 days ago" stops being useful. */
function formatWhen(timestamp: string): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return timestamp;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;

  return new Date(then).toISOString().slice(0, 10);
}
