import { motion as fm } from "framer-motion";
import { useMemo } from "react";

import { ApiError } from "@/api/client";
import { useActivity, useSession, type AuditEntry } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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

const SHELL = "mx-auto w-full max-w-[1200px] px-4 sm:px-6";

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
      <section className={`${SHELL} py-16`}>
        <h1 className="text-title">Dashboard</h1>
        <div className="mt-6 rounded-lg border border-line bg-surface px-6 py-10 text-center">
          <Status tone="revoked">Cannot load your session</Status>
          <p className="mx-auto mt-3 max-w-[46ch] text-[13.5px] text-fg-muted">
            {session.error.message}
          </p>
        </div>
      </section>
    );
  }

  if (session.isLoading || !session.data) {
    return (
      <section className={`${SHELL} py-16`} aria-busy="true">
        <h1 className="text-title">Dashboard</h1>
        <p className="mt-3 text-[14px] text-fg-muted">Reading your session…</p>
      </section>
    );
  }

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
            <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-fg-faint">
              Your cockpit
            </p>
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
          <h2
            id="credentials-title"
            className="text-[13px] font-semibold uppercase tracking-[0.1em] text-fg-muted"
          >
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
        <h2
          id="assets-title"
          className="text-[13px] font-semibold uppercase tracking-[0.1em] text-fg-muted"
        >
          My assets
        </h2>
        <div className="mt-4">
          <AssetGrid mints={mints} isLoading={activity.isLoading} blocked={blocked} />
        </div>
      </section>

      <section aria-labelledby="activity-title" className="mt-12">
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="activity-title"
            className="text-[13px] font-semibold uppercase tracking-[0.1em] text-fg-muted"
          >
            Activity
          </h2>
          {activity.data?.source && (
            <span className="font-mono text-[11.5px] text-fg-faint">
              source: {activity.data.source}
            </span>
          )}
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
          <ActivityFeed entries={entries} isLoading={activity.isLoading} error={auditError} />
        </div>
      </section>
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
    <div className="rounded-lg border border-line bg-surface px-5 py-8 text-center">
      <Status tone={error.isForbidden ? "neutral" : "fallback"}>
        {error.isForbidden ? "Permission required" : "Unavailable"}
      </Status>
      <p className="mx-auto mt-3 max-w-[48ch] text-[13px] leading-relaxed text-fg-muted">
        {error.isForbidden
          ? "This panel is derived from the audit trail, which needs the VIEW_AUDIT permission. Rather than show an empty grid that would read as 'you own nothing', it says what is actually missing."
          : "The audit trail could not be read, so this panel has no source. It is not empty — it is unknown, and those are different things."}
      </p>
    </div>
  );
}

function SignInPrompt() {
  return (
    <section className={`${SHELL} py-16`} aria-labelledby="dash-title">
      <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-fg-faint">
        Your cockpit
      </p>
      <h1 id="dash-title" className="mt-2 text-title">
        Dashboard
      </h1>

      <div className="mt-8 rounded-lg border border-line bg-surface" data-testid="signin-prompt">
        <EmptyState
          illustration="credentials"
          title="Sign in to see your identity"
          body="This view is scoped to one identity, and that identity is proved by a signature rather than a password. Connect a wallet and sign in — nothing here is shown until the chain says who you are."
          action={<ConnectButton />}
        />
      </div>

      <p className="mt-6 text-center text-[13px] text-fg-faint">
        Verifying a credential needs no account at all —{" "}
        <Button asChild variant="ghost" size="sm" className="px-1 underline">
          <a href="/verify">use the public verify page</a>
        </Button>
      </p>
    </section>
  );
}
