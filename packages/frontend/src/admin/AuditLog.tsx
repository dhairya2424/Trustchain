import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion as fm } from "framer-motion";
import { useMemo, useRef, useState } from "react";

import { ApiError, apiGet } from "@/api/client";
import { ACTION_LABELS, actionLabel, type AuditEntry, type AuditPage } from "@/api/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { useMotion } from "@/motion/MotionProvider";
import { cn, truncateAddress } from "@/lib/utils";

/**
 * The audit log console.
 *
 * Entirely real: `GET /audit` with the filters the API already accepts (actor, action,
 * from, to) and cursor pagination. Nothing here is derived or approximated.
 *
 * Virtualized because an audit log is the one table in this product with no natural upper
 * bound — a busy deployment produces thousands of rows and the honest response to "show me
 * everything" cannot be to render every node. Rows are a fixed height so the virtualizer
 * needs no measurement pass.
 */

interface Filters {
  actor: string;
  action: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { actor: "", action: "", from: "", to: "" };
const ROW_HEIGHT = 56;
const LIVE_INTERVAL_MS = 10_000;

function toParams(filters: Filters, limit: number): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.action) params.set("action", filters.action);

  // The API takes unix seconds; the inputs give a calendar date.
  if (filters.from) {
    const at = Date.parse(`${filters.from}T00:00:00Z`);
    if (!Number.isNaN(at)) params.set("from", String(Math.floor(at / 1000)));
  }
  if (filters.to) {
    const at = Date.parse(`${filters.to}T23:59:59Z`);
    if (!Number.isNaN(at)) params.set("to", String(Math.floor(at / 1000)));
  }

  return params.toString();
}

export function AuditLog() {
  const motion = useMotion();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const query = useQuery<AuditPage, ApiError>({
    queryKey: ["audit", "console", applied],
    queryFn: ({ signal }) => apiGet<AuditPage>(`/audit?${toParams(applied, 200)}`, signal),
    retry: false,
    ...(live ? { refetchInterval: LIVE_INTERVAL_MS } : {}),
    placeholderData: (previous) => previous,
  });

  const entries = useMemo(() => query.data?.entries ?? [], [query.data]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rows = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const apply = () => {
    setApplied(draft);
    setSelected(null);
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Audit log</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Every recorded action, with the identity that requested it and the account that
            submitted it.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {query.data?.source && (
            <span className="font-mono text-2xs text-fg-faint" data-testid="audit-source">
              source: {query.data.source}
            </span>
          )}
          <LiveToggle live={live} onChange={setLive} refreshing={query.isFetching} />
        </div>
      </div>

      <form
        className="mt-5 grid gap-3 panel p-4 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        data-testid="audit-filters"
      >
        <Field label="Actor address">
          <input
            value={draft.actor}
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            placeholder="0x…"
            spellCheck={false}
            className={inputClass}
            data-testid="filter-actor"
          />
        </Field>

        <Field label="Action">
          <select
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
            className={inputClass}
            data-testid="filter-action"
          >
            <option value="">Any action</option>
            {Object.keys(ACTION_LABELS).map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="From">
          <input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            className={inputClass}
            data-testid="filter-from"
          />
        </Field>

        <Field label="To">
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            className={inputClass}
            data-testid="filter-to"
          />
        </Field>

        <div className="flex items-end gap-2">
          <Button type="submit" size="sm" data-testid="filter-apply">
            Apply
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
              setSelected(null);
            }}
          >
            Reset
          </Button>
        </div>
      </form>

      {query.isError ? (
        <AuditError error={query.error} />
      ) : entries.length === 0 && !query.isLoading ? (
        <div className="mt-5 panel">
          <EmptyState
            illustration="activity"
            title="No entries match"
            body="Either nothing has been recorded yet, or no entry matches these filters. Widening the date range is usually the quickest way to tell which."
          />
        </div>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 overflow-hidden panel">
            <div className="grid grid-cols-[7rem_1fr_9rem] gap-4 border-b border-line px-4 py-2.5 eyebrow">
              <span>Entry</span>
              <span>Action</span>
              <span className="text-right">When</span>
            </div>

            <div ref={scrollRef} className="h-[32rem] overflow-auto" data-testid="audit-scroller">
              <div style={{ height: rows.getTotalSize(), position: "relative" }}>
                {rows.getVirtualItems().map((row) => {
                  const entry = entries[row.index];
                  if (!entry) return null;

                  return (
                    <button
                      key={entry.entryId}
                      type="button"
                      onClick={() => setSelected(entry)}
                      onMouseEnter={() => setSelected(entry)}
                      className={cn(
                        "absolute left-0 top-0 grid w-full grid-cols-[7rem_1fr_9rem] items-center gap-4 border-b border-line px-4 text-left transition-colors",
                        selected?.entryId === entry.entryId ? "bg-hover" : "hover:bg-hover/60",
                      )}
                      style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                      data-testid="audit-row"
                    >
                      <span className="font-mono text-xs tabular text-fg-faint">
                        #{entry.entryId}
                      </span>
                      <span className="min-w-0 truncate text-sm">
                        {actionLabel(entry.action)}
                        <span className="ml-2 font-mono text-xs text-fg-muted">
                          {entry.actor ? truncateAddress(entry.actor) : "unattributed"}
                        </span>
                      </span>
                      <span className="text-right font-mono text-xs tabular text-fg-faint">
                        {new Date(entry.occurredAt).toISOString().slice(5, 16).replace("T", " ")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-line px-4 py-2 text-2xs text-fg-faint">
              {entries.length} entr{entries.length === 1 ? "y" : "ies"} loaded
              {query.data?.nextCursor ? " · more available" : ""}
            </div>
          </div>

          {/* Detail panel, sliding in from the right when a row is hovered or clicked. */}
          <AnimatePresence mode="wait">
            {selected && (
              <fm.aside
                key={selected.entryId}
                initial={motion.reduced ? { opacity: 0 } : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={motion.reduced ? { opacity: 0 } : { opacity: 0, x: 12 }}
                transition={motion.transition("quick")}
                className="w-full panel p-5 xl:w-[22rem]"
                data-testid="audit-detail"
                aria-label={`Entry ${selected.entryId} detail`}
              >
                <p className="font-mono text-xs text-fg-faint">Entry #{selected.entryId}</p>
                <h3 className="mt-1 text-base font-semibold">{actionLabel(selected.action)}</h3>

                <dl className="mt-5 space-y-3.5 text-xs">
                  <Detail term="Actor — who requested it">
                    {selected.actor ? (
                      <span title={selected.actor}>{truncateAddress(selected.actor)}</span>
                    ) : (
                      <span className="text-fg-faint">
                        not recorded (entry predates attribution)
                      </span>
                    )}
                  </Detail>

                  <Detail term="Executor — who submitted it">
                    {selected.executor ? (
                      <span title={selected.executor}>{truncateAddress(selected.executor)}</span>
                    ) : (
                      <span className="text-fg-faint">not recorded</span>
                    )}
                  </Detail>

                  <Detail term="Recorded by contract">
                    <span title={selected.via}>{truncateAddress(selected.via)}</span>
                  </Detail>

                  <Detail term="Subject DID hash">
                    <span title={selected.didHash}>{truncateAddress(selected.didHash)}</span>
                  </Detail>

                  <Detail term="Reference hash">
                    <span title={selected.refHash}>{truncateAddress(selected.refHash)}</span>
                  </Detail>

                  <Detail term="Block">{selected.blockNumber}</Detail>

                  <Detail term="Transaction">
                    <span title={selected.transactionHash}>
                      {truncateAddress(selected.transactionHash)}
                    </span>
                  </Detail>

                  <Detail term="Occurred at">
                    {new Date(selected.occurredAt).toISOString().replace("T", " ").slice(0, 19)}
                  </Detail>
                </dl>
              </fm.aside>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded border border-line bg-canvas px-2.5 py-2 text-sm text-fg placeholder:text-fg-faint";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block eyebrow">{label}</span>
      {children}
    </label>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="eyebrow">{term}</dt>
      <dd className="mt-1 font-mono text-fg-muted [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * Live mode.
 *
 * Off by default. Polling an audit trail that falls back to `getLogs` scans blocks on every
 * request, so it is opt-in rather than something a console does to a chain unasked.
 */
function LiveToggle({
  live,
  onChange,
  refreshing,
}: {
  live: boolean;
  onChange: (next: boolean) => void;
  refreshing: boolean;
}) {
  const motion = useMotion();

  return (
    <button
      type="button"
      onClick={() => onChange(!live)}
      aria-pressed={live}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-2xs font-medium uppercase tracking-label transition-colors",
        live
          ? "border-verified/45 bg-verified/8 text-verified"
          : "border-line-strong text-fg-muted hover:bg-hover",
      )}
      data-testid="live-toggle"
      data-live={live ? "on" : "off"}
    >
      <span className="relative grid size-2 place-items-center">
        {live && !motion.reduced && (
          <fm.span
            className="absolute inset-0 rounded-full border border-verified"
            initial={{ scale: 1, opacity: 0.7 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className={cn("size-1.5 rounded-full", live ? "bg-verified" : "bg-fg-faint")} />
      </span>
      {live ? (refreshing ? "Live · refreshing" : "Live") : "Live off"}
    </button>
  );
}

function AuditError({ error }: { error: ApiError }) {
  const forbidden = error.isForbidden;

  return (
    <div className="mt-5 panel px-6 py-12 text-center" data-testid="audit-error">
      <Status tone={forbidden ? "neutral" : error.isUnavailable ? "fallback" : "revoked"}>
        {forbidden ? "Permission required" : error.isUnavailable ? "No network" : "Could not load"}
      </Status>
      <p className="mx-auto mt-3 max-w-[50ch] text-sm leading-relaxed text-fg-muted">
        {forbidden
          ? "Reading the audit trail needs the VIEW_AUDIT permission, which your roles do not include. The records exist; this account is not authorized to read them."
          : error.isUnavailable
            ? "No blockchain network is currently usable, so there is nothing to read from. That is an availability problem, not an empty log."
            : error.message}
      </p>
    </div>
  );
}
