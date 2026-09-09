import { motion as fm } from "framer-motion";

import { Status } from "@/components/ui/status";
import { useMotion } from "@/motion/MotionProvider";
import { truncateAddress } from "@/lib/utils";

/**
 * What a scanned identity QR resolves to.
 *
 * The dashboard's QR used to encode the bare DID hash, so a camera read it as a hex string
 * and there was nowhere to go. It now carries a link here, and this is what the link has to
 * be worth arriving at: who controls the identity, whether it is still active, what it is
 * authorized to do, and what it holds — every field read from the chain, none of it from a
 * database this platform could edit.
 *
 * Three answers, kept distinct because they mean different things to somebody checking a
 * badge at a door:
 *
 *   unregistered  the chain has never heard of this identifier. Not "not yet loaded" and
 *                 not an error — a definite negative, which is the most useful answer a
 *                 verifier can get from a forged code.
 *   revoked       registered and deliberately deactivated. Worse than unknown: somebody
 *                 held this and it was taken away.
 *   active        registered, live, with these roles and these assets.
 */

export interface ResolvedIdentity {
  didHash: string;
  registered: boolean;
  controller: string | null;
  active: boolean;
  roles: string[];
  assets: { balance: number; tokenIds: number[] } | null;
  network: {
    id: string;
    label: string;
    chainId: number;
    explorerUrl: string | null;
    verifiability: string;
  };
}

export function IdentityVerdict({ identity }: { identity: ResolvedIdentity }) {
  const motion = useMotion();

  const state = !identity.registered ? "unregistered" : identity.active ? "active" : "revoked";
  const tone = state === "active" ? "verified" : state === "revoked" ? "revoked" : "neutral";
  const heading =
    state === "active"
      ? "IDENTITY VERIFIED"
      : state === "revoked"
        ? "IDENTITY REVOKED"
        : "NOT REGISTERED";

  return (
    <fm.section
      className="mt-8 panel px-6 py-8"
      initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motion.transition("base")}
      data-testid="identity-verdict"
      data-state={state}
      aria-live="polite"
    >
      <div className="text-center">
        <Status tone={tone}>{heading}</Status>

        <p className="mx-auto mt-3 max-w-[52ch] text-sm leading-relaxed text-fg-muted">
          {state === "active" &&
            `This identifier is registered on ${identity.network.label} and controlled by the address below. Its roles and holdings are read from the chain, not from this platform.`}
          {state === "revoked" &&
            "This identifier exists on the chain but has been deactivated. It was valid once; it is not now."}
          {!identity.registered &&
            `The chain holds no record of this identifier on ${identity.network.label}. Nothing was ever registered under it.`}
        </p>
      </div>

      {identity.registered && (
        <dl className="mt-6 grid gap-4 border-t border-line pt-6 sm:grid-cols-2">
          <Field term="Decentralized identifier">
            <span className="break-all font-mono text-xs">{identity.didHash}</span>
          </Field>

          <Field term="Controlled by">
            {identity.controller && identity.network.explorerUrl ? (
              <a
                className="font-mono text-xs underline underline-offset-4 transition-colors hover:text-fg"
                href={`${identity.network.explorerUrl}/address/${identity.controller}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {truncateAddress(identity.controller)} ↗
              </a>
            ) : (
              <span className="font-mono text-xs">
                {truncateAddress(identity.controller ?? "")}
              </span>
            )}
          </Field>

          <Field term="Roles held">
            {identity.roles.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {identity.roles.map((role) => (
                  <span
                    key={role}
                    className="rounded border border-line px-2 py-0.5 font-mono text-2xs"
                    data-testid="verified-role"
                  >
                    {role}
                  </span>
                ))}
              </span>
            ) : (
              // A registered identity with no roles is ordinary, and saying "none" is the
              // honest answer — an empty space would read as "not loaded".
              <span className="text-xs text-fg-faint">none</span>
            )}
          </Field>

          <Field term="Assets held">
            {identity.assets ? (
              <span className="font-mono text-xs" data-testid="verified-assets">
                {identity.assets.balance}
                {identity.assets.tokenIds.length > 0 && (
                  <span className="text-fg-faint"> (#{identity.assets.tokenIds.join(", #")})</span>
                )}
              </span>
            ) : (
              <span className="text-xs text-fg-faint">could not be read</span>
            )}
          </Field>
        </dl>
      )}

      <p className="mt-6 border-t border-line pt-4 text-center text-xs leading-relaxed text-fg-faint">
        {identity.network.verifiability === "public"
          ? `Read from ${identity.network.label}. Anyone can confirm this independently on a block explorer.`
          : `Read from ${identity.network.label}, which is not a public network — an outside party still has to trust whoever runs it.`}
      </p>
    </fm.section>
  );
}

function Field({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{term}</dt>
      <dd className="mt-1 min-w-0 text-fg">{children}</dd>
    </div>
  );
}
