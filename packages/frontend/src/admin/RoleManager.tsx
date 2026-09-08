import { useSession } from "@/api/queries";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/utils";

/**
 * Role manager.
 *
 * The build plan asks for inline grant/revoke with animated toggles. That is not built
 * here, and the reason is worth stating plainly rather than shipping something that looks
 * like it works.
 *
 * **There is no API for it.** The backend exposes no endpoint to grant or revoke a role,
 * and none to read the roles of an address other than your own. Building the toggles anyway
 * would mean a switch that flips, animates, and changes nothing on-chain — on the one screen
 * in the product where a control that lies about authorization is most dangerous. Someone
 * would flip "ADMIN" for a colleague, watch it turn green, and believe the grant happened.
 *
 * So this shows what is genuinely known — the role model from the contracts, and your own
 * roles read from the chain at sign-in — and says exactly what is missing.
 *
 * What it would take, in the order it has to happen:
 *   1. `encodeGrantRole` / `encodeRevokeRole` beside the existing encoders in
 *      `packages/backend/src/chain/forwarding.ts`
 *   2. a prepare endpoint returning EIP-712 typed data, matching how mint and credential
 *      issuance already work, so the ADMIN signs and the relayer merely submits
 *   3. `RoleAccessControl` in the forwarder's target allowlist
 *   4. a read endpoint for another address's roles
 *
 * Doing it through the existing two-phase signing flow is what keeps attribution intact: a
 * role change would be recorded against the ADMIN who requested it, not the relayer that
 * paid for it.
 */

/** The four roles the platform defines. Fixed by the contracts; not configurable. */
const ROLES = [
  {
    id: "ADMIN",
    summary:
      "Governs the platform. Grants and revokes every other role, and exports the audit log.",
  },
  {
    id: "MANAGER",
    summary: "Mints assets and issues credentials. Cannot change who holds a role.",
  },
  {
    id: "AUDITOR",
    summary: "Reads the audit trail in full. Changes nothing.",
  },
  {
    id: "USER",
    summary: "Holds an identity and owns assets. The default for every registered DID.",
  },
] as const;

export function RoleManager() {
  const session = useSession();
  const mine = new Set(session.data?.roles ?? []);

  return (
    <div className="min-w-0">
      <h2 className="text-[15px] font-semibold">Roles</h2>
      <p className="mt-1 max-w-[64ch] text-[13px] leading-relaxed text-fg-muted">
        Authorization lives in a contract, not a database. Every grant and revocation is itself an
        on-chain event, which is what stops permissions being edited behind the audit trail&rsquo;s
        back.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <div className="grid grid-cols-[7rem_minmax(0,1fr)_6rem] gap-4 border-b border-line px-5 py-2.5 text-[11px] uppercase tracking-[0.08em] text-fg-faint">
          <span>Role</span>
          <span>Authority</span>
          <span className="text-right">You</span>
        </div>

        {ROLES.map((role) => {
          const held = mine.has(role.id);

          return (
            <div
              key={role.id}
              className="grid grid-cols-[7rem_minmax(0,1fr)_6rem] items-center gap-4 border-b border-line px-5 py-4 last:border-b-0"
              data-testid="role-row"
              data-role={role.id}
              data-held={held ? "true" : "false"}
            >
              <span className="font-mono text-[12.5px] text-fg">{role.id}</span>
              <span className="text-[13px] leading-relaxed text-fg-muted">{role.summary}</span>
              <span className="text-right">
                {held ? (
                  <Status tone="verified">Held</Status>
                ) : (
                  <span className={cn("text-[12px] text-fg-faint")}>—</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/*
        Stated rather than mocked. A disabled toggle would still imply the mechanism exists
        and is merely switched off; this says the API is absent.
      */}
      <div
        className="mt-6 rounded-lg border border-line bg-surface px-6 py-6"
        data-testid="roles-not-wired"
      >
        <Status tone="fallback">Grant and revoke not available</Status>

        <p className="mt-3 max-w-[68ch] text-[13.5px] leading-relaxed text-fg-muted">
          The API exposes no endpoint to change a role, and none to read another address&rsquo;s
          roles. Rather than ship toggles that animate and change nothing on-chain, this console
          shows only what it can actually verify. A switch that appears to grant ADMIN and silently
          does not is worse than no switch at all.
        </p>

        <p className="mt-3 max-w-[68ch] text-[13px] leading-relaxed text-fg-faint">
          Wiring it means adding grant and revoke to the existing two-phase signing flow, the same
          path mint and credential issuance already take — so the change is recorded against the
          ADMIN who requested it rather than the relayer that submitted it. Details are in{" "}
          <span className="font-mono">docs/ADMIN.md</span>.
        </p>
      </div>
    </div>
  );
}
