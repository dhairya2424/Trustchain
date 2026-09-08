import { motion as fm } from "framer-motion";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useMotion } from "@/motion/MotionProvider";
import { truncateAddress } from "@/lib/utils";
import type { AuditEntry } from "@/api/queries";

/**
 * Credentials this identity issued or had revoked, derived from the audit trail.
 *
 * Same derivation as the asset grid, and the same limits. There is no
 * "list credentials for a subject" endpoint; what exists is a `CREDENTIAL_ISSUED` or
 * `CREDENTIAL_REVOKED` entry per action, anchored on-chain. A hash that appears in both is
 * shown as revoked, because the later fact wins — and quietly showing it as valid because
 * the issuance event came first would be the worst bug this screen could have.
 *
 * `POST /credentials/verify` is the authority on whether a credential is live. These
 * badges say what the trail recorded; the verify page proves it.
 */

export interface CredentialBadgesProps {
  issued: AuditEntry[] | undefined;
  revoked: AuditEntry[] | undefined;
  isLoading: boolean;
  blocked?: React.ReactNode;
}

export function CredentialBadges({ issued, revoked, isLoading, blocked }: CredentialBadgesProps) {
  const motion = useMotion();

  if (blocked) return <>{blocked}</>;

  if (isLoading && !issued) {
    return (
      <div className="flex flex-wrap gap-3" data-testid="credentials-loading">
        {[0, 1].map((chip) => (
          <Skeleton key={chip} className="h-16 w-52" />
        ))}
      </div>
    );
  }

  if (!issued || issued.length === 0) {
    return (
      <EmptyState
        illustration="credentials"
        title="No credentials yet"
        body="A credential is a signed claim anchored on-chain by its hash. Only the hash is ever written to the ledger, so the claim itself stays private while remaining provable."
      />
    );
  }

  const revokedHashes = new Set((revoked ?? []).map((event) => event.refHash.toLowerCase()));

  return (
    <div className="flex flex-wrap gap-3" data-testid="credential-badges">
      {issued.map((credential, index) => {
        // The later fact wins. Showing a revoked credential as valid because its issuance
        // came first would be the worst possible error on this screen.
        const isRevoked = revokedHashes.has(credential.refHash.toLowerCase());

        return (
          <fm.div
            key={credential.entryId}
            className={[
              "relative flex min-w-[13rem] flex-col gap-1 rounded-lg border px-4 py-3",
              isRevoked ? "border-revoked/40 bg-revoked/5" : "border-verified/35 bg-verified/5",
            ].join(" ")}
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={motion.transition("base", motion.stagger(index, 0.06))}
            data-testid="credential-badge"
            data-revoked={isRevoked ? "true" : "false"}
          >
            <span className="flex items-center gap-2">
              {/*
                The pulse marks a live credential, and only a live one — an animation on a
                revoked badge would read as "active" to anyone skimming. It stops entirely
                under reduced motion, where the dot and the label still carry the state.
              */}
              <span className="relative grid size-2.5 place-items-center">
                {!isRevoked && !motion.reduced && (
                  <fm.span
                    className="absolute inset-0 rounded-full border border-verified"
                    initial={{ scale: 1, opacity: 0.6 }}
                    animate={{ scale: 2.2, opacity: 0 }}
                    transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
                  />
                )}
                <span
                  className={[
                    "size-1.5 rounded-full",
                    isRevoked ? "bg-revoked" : "bg-verified",
                  ].join(" ")}
                />
              </span>

              <span
                className={[
                  "text-[11px] font-medium uppercase tracking-[0.08em]",
                  isRevoked ? "text-revoked" : "text-verified",
                ].join(" ")}
              >
                {isRevoked ? "Revoked" : "Verified"}
              </span>
            </span>

            <span className="font-mono text-[12px] text-fg-muted" title={credential.refHash}>
              {truncateAddress(credential.refHash)}
            </span>

            <span className="font-mono text-[11px] text-fg-faint">
              block {credential.blockNumber}
            </span>
          </fm.div>
        );
      })}
    </div>
  );
}
