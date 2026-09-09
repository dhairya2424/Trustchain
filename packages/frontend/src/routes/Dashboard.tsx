import { motion as fm } from "framer-motion";
import { useMemo } from "react";

import { ApiError } from "@/api/client";
import { useActivity, useSession, type AuditEntry } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { NetworkBadge } from "@/components/NetworkBadge";
import { Status } from "@/components/ui/status";
import { ActivityFeed } from "@/dashboard/ActivityFeed";
import { AssetGrid } from "@/dashboard/AssetGrid";
import { CredentialBadges } from "@/dashboard/CredentialBadges";
import { IdentityCard } from "@/dashboard/IdentityCard";
import { StatCounter } from "@/dashboard/StatCounter";
import { useMotion } from "@/motion/MotionProvider";
import { ConnectButton } from "@/wallet/ConnectButton";

/**
 * The user cockpit.
 *
 * Everything on this page is read from the API or absent. There is no seeded example
 * account and no illustrative row: on a platform whose claim is that its records are
 * independently verifiable, a convincing fake record is the one thing that would undermine
 * it, and a dashboard is exactly where such a fake would be most persuasive.
 *
 * That honesty costs something, and it shows. The asset and credential panels are derived
 * from the audit trail rather than from a dedicated endpoint, because no such endpoint
 * exists yet; they say so where they cannot answer fully. Reading the trail also needs the
 * VIEW_AUDIT permission, so an account without it sees the RBAC working rather than an
 * empty page pretending nothing has happened.
 */

const SHELL = "shell";

export function Dashboard() {
  const motion = useMotion();
  const session = useSession();
  const address = session.data?.address;

  const activity = useActivity(address);
  const entries = activity.data?.entries;

  const { mints, issued, revoked } = useMemo(() => partition(entries), [entries]);

  // Not signed in is the ordinary first state, not an error.
  if (session.isError && session.error.isUnauthenticated) {
    return <SignInPrompt />;
  }

  if (session.isError) {
    return (
      <section className={`${SHELL} py-12`}>
        <h1 className="text-title">Dashboard</h1>
        <div className="mt-6 panel px-6 py-10 text-center">
          <Status tone="revoked">Cannot load your session</Status>
          <p className="mx-auto mt-3 max-w-[46ch] text-sm text-fg-muted">{session.error.message}</p>
        </div>
      </section>
    );
  }

  if (session.isLoading || !session.data) return <DashboardSkeleton />;

  const me = session.data;
  const auditError = activity.error instanceof ApiError ? activity.error : null;

  // One shared explanation, so the asset and credential panels do not each invent their own
  // wording for the same cause.
  const blocked = auditError ? <PanelBlocked error={auditError} /> : undefined;

  return (
    <section className={`${SHELL} py-12`} aria-labelledby="dash-title">
      <fm.header
        className="border-b border-line pb-6"
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motion.transition("base")}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-mono eyebrow">Your cockpit</p>
            <h1 id="dash-title" className="mt-2 text-title">
              Dashboard
            </h1>
          </div>
          <NetworkBadge variant="full" />
        </div>
      </fm.header>

      {/* Stats. Counts are of what the trail actually returned, never estimated. */}
      <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <StatCounter
          value={mints.length}
          label="Assets minted"
          unavailable={auditError ? "Requires the audit trail" : undefined}
        />
        <StatCounter
          value={issued.length}
          label="Credentials issued"
          unavailable={auditError ? "Requires the audit trail" : undefined}
        />
        <StatCounter
          value={revoked.length}
          label="Revocations"
          unavailable={auditError ? "Requires the audit trail" : undefined}
        />
        <StatCounter value={me.roles.length} label="Roles held" />
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <IdentityCard session={me} />

        <section aria-labelledby="credentials-title" className="min-w-0">
          <h2 id="credentials-title" className="section-label">
            My credentials
          </h2>
          <div className="mt-4">
            <CredentialBadges
              issued={issued}
              revoked={revoked}
              isLoading={activity.isLoading}
              blocked={blocked}
            />
          </div>
        </section>
      </div>

      <section aria-labelledby="assets-title" className="mt-12">
        <h2 id="assets-title" className="section-label">
          My assets
        </h2>
        <div className="mt-4">
          <AssetGrid mints={mints} isLoading={activity.isLoading} blocked={blocked} />
        </div>
      </section>

      <section aria-labelledby="activity-title" className="mt-12">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="activity-title" className="section-label">
            Activity
          </h2>
          {activity.data?.source && (
            <span className="font-mono text-2xs text-fg-faint">source: {activity.data.source}</span>
          )}
        </div>

        <div className="mt-4 overflow-hidden panel">
          <ActivityFeed entries={entries} isLoading={activity.isLoading} error={auditError} />
        </div>
      </section>
    </section>
  );
}

/**
 * The loading state, shaped like the loaded page.
 *
 * This replaced a one-line "Reading your session…", which measured **0.64 CLS** in the
 * browser — six times Google's "good" threshold. The cause was structural rather than
 * cosmetic: a single line of text occupies almost no height, so when the real dashboard
 * arrived it pushed the entire viewport down at once. Anything the reader had started
 * reading moved out from under them.
 *
 * So every block below reserves roughly the height its real counterpart will occupy. It is
 * approximate by nature — the activity feed's length is not known until it arrives — but
 * the difference between "approximately right" and "one line" is the difference between a
 * settle and a jolt.
 *
 * Only a browser can catch this; jsdom computes no layout, so the regression test for it
 * lives in the Playwright suite.
 */
function DashboardSkeleton() {
  return (
    <section className={`${SHELL} py-12`} aria-busy="true" data-testid="dashboard-skeleton">
      <div className="border-b border-line pb-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-8 w-48" />
      </div>

      <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[0, 1, 2, 3].map((stat) => (
          <div key={stat} className="border-l border-line pl-4">
            <Skeleton className="h-7 w-12" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Skeleton className="h-64 w-full rounded-lg" />
        <div>
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-4 h-16 w-52 rounded-lg" />
        </div>
      </div>

      <div className="mt-12">
        <Skeleton className="h-3 w-24" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <Skeleton key={card} className="h-56 w-full rounded-lg" />
          ))}
        </div>
      </div>

      <div className="mt-12">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-4 h-64 w-full rounded-lg" />
      </div>
    </section>
  );
}

/** Splits one audit page into the three views this page needs. */
function partition(entries: AuditEntry[] | undefined) {
  const mints: AuditEntry[] = [];
  const issued: AuditEntry[] = [];
  const revoked: AuditEntry[] = [];

  for (const event of entries ?? []) {
    if (event.action === "ASSET_MINTED") mints.push(event);
    else if (event.action === "CREDENTIAL_ISSUED") issued.push(event);
    else if (event.action === "CREDENTIAL_REVOKED") revoked.push(event);
  }

  return { mints, issued, revoked };
}

function PanelBlocked({ error }: { error: ApiError }) {
  return (
    <div className="panel px-5 py-8 text-center">
      <Status tone={error.isForbidden ? "neutral" : "fallback"}>
        {error.isForbidden ? "Permission required" : "Unavailable"}
      </Status>
      <p className="mx-auto mt-3 max-w-[48ch] text-sm leading-relaxed text-fg-muted">
        {error.isForbidden
          ? "This panel is derived from the audit trail, which needs the VIEW_AUDIT permission. Rather than show an empty grid that would read as 'you own nothing', it says what is actually missing."
          : "The audit trail could not be read, so this panel has no source. It is not empty — it is unknown, and those are different things."}
      </p>
    </div>
  );
}

function SignInPrompt() {
  return (
    <section className={`${SHELL} py-12`} aria-labelledby="dash-title">
      <p className="font-mono eyebrow">Your cockpit</p>
      <h1 id="dash-title" className="mt-2 text-title">
        Dashboard
      </h1>

      <div className="mt-8 panel" data-testid="signin-prompt">
        <EmptyState
          illustration="credentials"
          title="Sign in to see your identity"
          body="This view is scoped to one identity, and that identity is proved by a signature rather than a password. Connect a wallet and sign in — nothing here is shown until the chain says who you are."
          action={<ConnectButton />}
        />
      </div>

      <p className="mt-6 text-center text-sm text-fg-faint">
        Verifying a credential needs no account at all —{" "}
        <Button asChild variant="ghost" size="sm" className="px-1 underline">
          <a href="/verify">use the public verify page</a>
        </Button>
      </p>
    </section>
  );
}
