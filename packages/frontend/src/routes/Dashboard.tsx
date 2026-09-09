import { motion as fm } from "framer-motion";
import { useMemo } from "react";

import { ApiError } from "@/api/client";
import { useActivity, useOwnedAssets, useSession, type AuditEntry } from "@/api/queries";
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
 * Each panel reads the source that actually answers its question. Assets come from the
 * registry, because ownership is a fact the contract holds — deriving them from
 * ASSET_MINTED events answered "what did you mint", which is wrong in both directions once
 * a token moves, and needed VIEW_AUDIT to see your own property. Credentials are still
 * derived from the trail, because no dedicated endpoint exists for them yet, and they say
 * so where they cannot answer fully.
 *
 * Reading the trail needs VIEW_AUDIT, so an account without it sees the RBAC working rather
 * than an empty page pretending nothing has happened.
 */

const SHELL = "shell";

export function Dashboard() {
  const motion = useMotion();
  const session = useSession();
  const address = session.data?.address;

  const activity = useActivity(address);
  // Ownership comes from the contract, not from who minted — and needs no VIEW_AUDIT.
  const owned = useOwnedAssets(Boolean(address));
  const entries = activity.data?.entries;

  const { issued, revoked } = useMemo(() => partition(entries), [entries]);

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

  /*
   * Only the first load shows a skeleton.
   *
   * This was `isLoading || !session.data`, and the second half made the page oscillate once
   * ConnectButton began reading the session too. The sign-in prompt renders ConnectButton;
   * ConnectButton subscribing to the session query adds an observer, which refetches; during
   * the refetch there is still no data, so the page fell back to the skeleton, which
   * unmounted ConnectButton, which removed the observer — and round again.
   *
   * `isPending` is true only before the query has ever settled, so a refetch cannot send a
   * settled page backwards. A settled query with no data means signed out, which is a state
   * to render, not a state to wait on.
   */
  if (session.isPending) return <DashboardSkeleton />;
  if (!session.data) return <SignInPrompt />;

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

      {/*
       * Stats. Counts are of what the trail actually returned, never estimated.
       *
       * The stagger is mount-based rather than scroll-based on purpose: these sit above the
       * fold, so a scroll trigger would either fire instantly anyway or — if an observer
       * never fired — leave the figures invisible. A dashboard that hides its numbers is
       * worse than one that shows them without ceremony.
       */}
      <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[
          {
            value: owned.data?.balance ?? 0,
            label: "Assets owned",
            unavailable: owned.isError ? "Could not read the registry" : undefined,
          },
          {
            value: issued.length,
            label: "Credentials issued",
            unavailable: auditError ? "Requires the audit trail" : undefined,
          },
          {
            value: revoked.length,
            label: "Revocations",
            unavailable: auditError ? "Requires the audit trail" : undefined,
          },
          { value: me.roles.length, label: "Roles held", unavailable: undefined },
        ].map((stat, index) => (
          <fm.div
            key={stat.label}
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={motion.transition("base", motion.stagger(index))}
          >
            <StatCounter value={stat.value} label={stat.label} unavailable={stat.unavailable} />
          </fm.div>
        ))}
      </div>

      {/*
       * The sections arrive in reading order, a beat apart.
       *
       * Mount-based rather than scroll-based, for the same reason the stats above are: a
       * dashboard's content must never depend on an observer firing to become visible. The
       * delays continue the stats' stagger so the page assembles as one movement instead of
       * two unrelated ones.
       */}
      <fm.div
        className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motion.transition("base", motion.stagger(4))}
      >
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
      </fm.div>

      <fm.section
        aria-labelledby="assets-title"
        className="mt-12"
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motion.transition("base", motion.stagger(5))}
      >
        <h2 id="assets-title" className="section-label">
          My assets
        </h2>
        <div className="mt-4">
          <AssetGrid
            owned={owned.data}
            isLoading={owned.isLoading}
            blocked={owned.isError ? <AssetsUnavailable /> : undefined}
          />
        </div>
      </fm.section>

      <fm.section
        aria-labelledby="activity-title"
        className="mt-12"
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motion.transition("base", motion.stagger(6))}
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="activity-title" className="section-label">
            Activity
          </h2>
          {activity.data?.source && (
            <span className="font-mono text-2xs text-fg-faint">source: {activity.data.source}</span>
          )}
        </div>

        <div className="mt-4 overflow-hidden panel transition-colors hover:border-line-strong">
          <ActivityFeed entries={entries} isLoading={activity.isLoading} error={auditError} />
        </div>
      </fm.section>
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
  const issued: AuditEntry[] = [];
  const revoked: AuditEntry[] = [];

  // ASSET_MINTED is deliberately not collected any more. It answers "what did this address
  // mint", which is not "what does it own" — the asset panel reads ownership from the
  // registry instead, so a token that was transferred away stops appearing and one
  // transferred in starts.
  for (const event of entries ?? []) {
    if (event.action === "CREDENTIAL_ISSUED") issued.push(event);
    else if (event.action === "CREDENTIAL_REVOKED") revoked.push(event);
  }

  return { issued, revoked };
}

/**
 * Ownership could not be read.
 *
 * Deliberately different from the audit panels' message: this is not a permissions problem.
 * Owning a token requires no role, so a failure here means the registry or the network is
 * unreachable — and saying "permission required" would send somebody to ask for a role that
 * would not help.
 */
function AssetsUnavailable() {
  return (
    <div className="panel px-5 py-8 text-center" data-testid="assets-unavailable">
      <Status tone="fallback">Unavailable</Status>
      <p className="mx-auto mt-3 max-w-[48ch] text-sm leading-relaxed text-fg-muted">
        The asset registry could not be read, so what you own is unknown rather than empty. This is
        not a permissions problem — ownership needs no role.
      </p>
    </div>
  );
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
