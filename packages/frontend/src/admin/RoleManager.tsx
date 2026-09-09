import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion as fm } from "framer-motion";
import { Search } from "lucide-react";
import { useState } from "react";
import { useSignTypedData } from "wagmi";

import { ApiError, apiGet } from "@/api/client";
import { humanErrorText } from "@/api/errors";
import { forwardSigned, toSignable, type PreparedTypedData } from "@/api/forward";
import { usePreparedAction } from "@/api/usePreparedAction";
import { useSession, type Session } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { apiBaseUrl } from "@/config/env";
import { useMotion } from "@/motion/MotionProvider";
import { cn, truncateAddress } from "@/lib/utils";

/**
 * Role administration.
 *
 * Roles attach to a **DID**, not to a wallet: the contract resolves that identity's active
 * controller when the transaction executes, so a key rotation carries the role with it
 * rather than stranding it on an old address. The lookup below therefore takes an address
 * only as a way to find the identity behind it, and refuses to act when there is none.
 *
 * Every change is two-phase. `POST /roles/prepare-grant` returns EIP-712 typed data, the
 * ADMIN signs it in their own wallet, and `POST /network/forward` relays it. The relayer
 * pays the gas and the contract still sees the ADMIN as the caller — which is the only
 * reason a role change can be attributed to the person who asked for it. Letting the
 * relayer call `grantRole` directly would hand it the authority to grant anything to
 * anyone, which is the confused deputy the whole ERC-2771 design exists to close.
 *
 * The switch is not the authorization. The API re-reads MANAGE_ROLES from the chain, and
 * the contract checks it again against the recovered signer, so a control rendered here for
 * someone who lacks the permission produces a 403 rather than a change.
 */

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
  { id: "AUDITOR", summary: "Reads the audit trail in full. Changes nothing." },
  {
    id: "USER",
    summary: "Holds an identity and owns assets. The default for every registered DID.",
  },
] as const;

type RoleId = (typeof ROLES)[number]["id"];

interface RolesOf {
  address: string;
  did: string | null;
  roles: string[];
}

export function RoleManager() {
  const session = useSession();
  const canManage = (session.data?.roles ?? []).includes("ADMIN");

  const [draft, setDraft] = useState("");
  const [subject, setSubject] = useState<string | null>(null);
  /**
   * True between signing a registration and the chain showing it.
   *
   * A registration is relayed, not executed inline: the wallet signs, the relayer broadcasts,
   * and the DID exists a block or two later. Refetching once on success — which is what this
   * did — asks the chain a question it cannot answer yet, gets `did: null` back, and leaves
   * every role control disabled. The registration had worked; the console just said it had
   * not, and the only cure was reloading the page half a minute later.
   */
  const [awaitingIdentity, setAwaitingIdentity] = useState(false);

  const lookup = useQuery<RolesOf, ApiError>({
    queryKey: ["roles", subject],
    queryFn: ({ signal }) => apiGet<RolesOf>(`/roles/${subject}`, signal),
    enabled: Boolean(subject),
    retry: false,
    // Poll only while waiting for a registration to land, and stop the moment it has.
    refetchInterval: awaitingIdentity ? 4000 : false,
  });

  // The identity arrived: stop polling. Done during render rather than in an effect because
  // it is derived from the query's own data and needs no subscription of its own.
  if (awaitingIdentity && lookup.data?.did) setAwaitingIdentity(false);

  return (
    <div className="min-w-0">
      <h2 className="text-base font-semibold">Identities and roles</h2>
      <p className="mt-1 max-w-[64ch] text-sm leading-relaxed text-fg-muted">
        Authorization lives in a contract, not a database. Roles attach to an identity rather than
        to a wallet, so look an address up to find the identity behind it — and register one when
        there is none. Every grant and revocation is itself an on-chain event signed by the
        administrator who requested it, which is what stops permissions being edited behind the
        audit trail&rsquo;s back.
      </p>

      <form
        className="mt-6 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSubject(draft.trim());
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block eyebrow">Look up an address</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="w-full rounded border border-line bg-canvas px-3 py-2 font-mono text-sm"
            data-testid="role-lookup-input"
          />
        </label>
        <Button type="submit" size="sm" disabled={!draft.trim()} data-testid="role-lookup">
          <Search className="size-3.5" aria-hidden="true" />
          Look up
        </Button>
      </form>

      {lookup.isError && (
        <p className="mt-4 text-sm text-revoked" data-testid="role-lookup-error">
          {lookup.error.status === 400
            ? "That does not look like an address."
            : lookup.error.message}
        </p>
      )}

      {lookup.data && (
        <SubjectPanel
          subject={lookup.data}
          canManage={canManage}
          session={session.data}
          awaitingIdentity={awaitingIdentity}
          onRegistrationSubmitted={() => setAwaitingIdentity(true)}
        />
      )}

      {!lookup.data && (
        <div className="mt-6 overflow-hidden panel">
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 border-b border-line px-5 py-2.5 eyebrow">
            <span>Role</span>
            <span>Authority</span>
          </div>
          {ROLES.map((role) => (
            <div
              key={role.id}
              className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 border-b border-line px-5 py-4 last:border-b-0"
              data-testid="role-reference"
            >
              <span className="font-mono text-xs text-fg">{role.id}</span>
              <span className="text-sm leading-relaxed text-fg-muted">{role.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SubjectPanel({
  subject,
  canManage,
  session,
  awaitingIdentity,
  onRegistrationSubmitted,
}: {
  subject: RolesOf;
  canManage: boolean;
  session: Session | undefined;
  /** True while a signed registration is on its way to the chain. */
  awaitingIdentity: boolean;
  onRegistrationSubmitted: () => void;
}) {
  const motion = useMotion();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { signTypedDataAsync } = useSignTypedData();
  const [pending, setPending] = useState<RoleId | null>(null);

  const change = useMutation({
    mutationFn: async ({ role, grant }: { role: RoleId; grant: boolean }) => {
      const prepared = await fetch(
        `${apiBaseUrl}/roles/${grant ? "prepare-grant" : "prepare-revoke"}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ didHash: subject.did, role }),
        },
      );

      const body = (await prepared.json().catch(() => ({}))) as Record<string, unknown>;

      if (!prepared.ok) {
        const code = typeof body.error === "string" ? body.error : `http_${prepared.status}`;
        throw new Error(
          prepared.status === 403
            ? "Changing a role needs the MANAGE_ROLES permission on your own identity."
            : humanErrorText(code),
        );
      }

      const typedData = body.typedData as PreparedTypedData;
      const signable = toSignable(typedData);

      // Signed in the administrator's own wallet. This is the step that makes the change
      // attributable: the contract recovers this signer, not the relayer.
      const signature = await signTypedDataAsync({
        domain: signable.domain,
        types: signable.types,
        primaryType: signable.primaryType,
        message: signable.message,
      } as never);

      return forwardSigned(typedData, signature);
    },
  });

  const run = async (role: RoleId, grant: boolean) => {
    if (!subject.did) return;

    setPending(role);
    const toastId = toast.push({
      status: "pending",
      title: `${grant ? "Granting" : "Revoking"} ${role}`,
      detail: "Sign the request in your wallet — it is relayed, but attributed to you.",
    });

    try {
      const result = await change.mutateAsync({ role, grant });

      toast.resolve(toastId, {
        status: "success",
        title: `${role} ${grant ? "granted" : "revoked"}`,
        detail: "Recorded on-chain against your identity.",
        reference: result.transactionHash,
      });

      // Re-read rather than flipping the switch optimistically. The chain is the authority
      // on who holds a role, and a switch that moves before the transaction confirms would
      // be asserting something nobody has verified.
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    } catch (error) {
      toast.resolve(toastId, {
        status: "error",
        title: `Could not ${grant ? "grant" : "revoke"} ${role}`,
        detail: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setPending(null);
    }
  };

  const held = new Set(subject.roles);
  const isSelf = session?.address?.toLowerCase() === subject.address.toLowerCase();

  return (
    <div className="mt-6" data-testid="role-subject">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-lg border border-line bg-surface px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-sm text-fg" title={subject.address}>
            {truncateAddress(subject.address)}
          </p>
          {subject.did ? (
            <p className="mt-1 break-all font-mono text-2xs text-fg-faint">{subject.did}</p>
          ) : (
            <p className="mt-1 text-xs text-fallback" data-testid="subject-no-did">
              No DID is registered for this address, so it cannot hold a role.
            </p>
          )}
        </div>
        {isSelf && <Status tone="neutral">This is you</Status>}
      </div>

      {/*
        The way out of the dead end above.

        Until this existed, "no DID is registered for this address" was the end of the road
        inside the product: the only remedy was an operator running tools/onboard-wallet.mjs
        against the deployer key. An administrator was shown a problem and no way to solve
        it, on the screen built for solving exactly that class of problem.
      */}
      {!subject.did && (
        <RegisterIdentity
          address={subject.address}
          awaiting={awaitingIdentity}
          onSubmitted={onRegistrationSubmitted}
        />
      )}

      <div className="overflow-hidden rounded-b-lg border border-x-line border-b-line bg-surface">
        {ROLES.map((role) => {
          const has = held.has(role.id);
          const busy = pending === role.id;

          // Revoking your own ADMIN is how an administrator locks themselves out of the
          // platform permanently — there is no recovery path if it was the last one.
          const selfLockout = isSelf && role.id === "ADMIN" && has;

          return (
            <div
              key={role.id}
              className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-4 last:border-b-0"
              data-testid="role-row"
              data-role={role.id}
              data-held={has ? "true" : "false"}
            >
              <div className="min-w-0">
                <span className="font-mono text-xs text-fg">{role.id}</span>
                <p className="mt-0.5 max-w-[54ch] text-xs leading-relaxed text-fg-muted">
                  {role.summary}
                </p>
                {selfLockout && (
                  <p className="mt-1 text-xs text-fallback" data-testid="self-lockout-warning">
                    Revoking your own ADMIN cannot be undone by you.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3">
                {has ? <Status tone="verified">Held</Status> : null}

                <button
                  type="button"
                  role="switch"
                  aria-checked={has}
                  aria-label={`${has ? "Revoke" : "Grant"} ${role.id}`}
                  disabled={!canManage || !subject.did || busy}
                  onClick={() => void run(role.id, !has)}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
                    has ? "border-verified/50 bg-verified/20" : "border-line-strong bg-hover",
                    (!canManage || !subject.did || busy) && "cursor-not-allowed opacity-45",
                  )}
                  data-testid={`role-toggle-${role.id}`}
                >
                  <fm.span
                    layout={!motion.reduced}
                    transition={motion.transition("quick")}
                    className={cn(
                      "absolute top-1/2 size-4 -translate-y-1/2 rounded-full",
                      has ? "left-[calc(100%-1.25rem)] bg-verified" : "left-1 bg-fg-faint",
                    )}
                  />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!canManage && (
        <p className="mt-3 text-xs text-fg-faint" data-testid="cannot-manage">
          You hold no ADMIN role, so these controls are inert. They are shown rather than hidden
          because knowing a capability exists and is denied to you is more useful than a console
          that quietly omits it — and the API and contract would both refuse the change regardless.
        </p>
      )}
    </div>
  );
}

/**
 * Registering an identity for an address that has none.
 *
 * Appears exactly where the problem does — under the "no DID is registered" line — because an
 * administrator who has just looked up an address and found nothing should be one click from
 * the remedy rather than one terminal session. Until this existed, that line was the end of
 * the road inside the product: the only cure was an operator running
 * `tools/onboard-wallet.mjs` against the deployer key.
 *
 * ## Why this can refuse an ADMIN
 *
 * `registerDIDFor` is gated on `ADMIN_ROLE` held **on the DIDRegistry contract**, a separate
 * grant made at deployment rather than the platform's RoleAccessControl matrix. So an account
 * can hold the platform's ADMIN role, see this control, and still be refused. The sentence
 * for that case says exactly that, rather than leaving somebody staring at their own role
 * badge trying to work out why the thing they are plainly an admin of said no.
 *
 * The identity hash is derived by the server from the address and the active network. It is
 * not chosen here and not supplied by the browser: a client able to name the hash could
 * register an address under an identity that already means something else.
 */
function RegisterIdentity({
  address,
  awaiting,
  onSubmitted,
}: {
  address: string;
  /** The registration is signed and relayed, and the chain has not shown it yet. */
  awaiting: boolean;
  onSubmitted: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const run = usePreparedAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = async () => {
    setBusy(true);
    setError(null);

    const toastId = toast.push({
      status: "pending",
      title: "Registering identity",
      detail: "Sign in your wallet — the registry records you as the administrator who did it.",
    });

    try {
      const { prepared, forwarded } = await run(
        "/identity/register",
        { address },
        {
          403: "Registering an identity needs ADMIN_ROLE on the DIDRegistry contract, which is a separate grant from the platform role you hold. The deployer account holds it.",
          identity_already_registered: "That address already has an identity.",
          address_already_has_identity: "That address already controls a different identity.",
        },
      );

      toast.resolve(toastId, {
        status: "success",
        title: "Identity submitted",
        detail: `${String(prepared.didHash).slice(0, 14)}… will resolve to this address once the transaction confirms.`,
        reference: forwarded.transactionHash,
      });

      /*
       * Start watching, rather than asking once.
       *
       * The registration is relayed: it is signed here and mined a block or two later. A
       * single refetch at this moment reads a chain that has not caught up, gets `did: null`
       * back, and leaves every role switch disabled — which is exactly what "I registered an
       * identity and the controls still do nothing" looks like from the outside.
       */
      onSubmitted();
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Registration failed.";
      setError(message);
      toast.resolve(toastId, {
        status: "error",
        title: "Identity not registered",
        detail: message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-x border-line bg-surface px-5 py-4" data-testid="register-identity">
      <p className="max-w-[68ch] text-sm leading-relaxed text-fg-muted">
        Registering an identity gives this address a DID that roles and assets can attach to. The
        record names the address as its own controller, so control stays with them — you are
        creating the identity, not holding it.
      </p>

      {error && (
        <p
          className="mt-3 max-w-[68ch] text-sm leading-relaxed text-revoked"
          data-testid="register-error"
        >
          {error}
        </p>
      )}

      {awaiting && (
        <p className="mt-3 text-sm text-fallback" data-testid="register-awaiting">
          Signed and handed to the relayer. The role controls below come alive as soon as the chain
          shows the identity — usually a few seconds. Nothing needs reloading.
        </p>
      )}

      <Button
        size="sm"
        className="mt-4"
        onClick={register}
        disabled={busy || awaiting}
        data-testid="register-identity-submit"
      >
        {busy
          ? "Awaiting signature…"
          : awaiting
            ? "Waiting for the chain…"
            : "Register an identity"}
      </Button>
    </div>
  );
}
