import { useEffect, useState } from "react";

import { env } from "../config/env";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/utils";

/**
 * Shows which chain the platform is actually running on.
 *
 * This is a correctness feature, not decoration. The platform prefers Polygon Amoy but
 * falls back to a local Hardhat node when Amoy cannot carry a transaction, and the two
 * differ in the one property that matters to anyone relying on a record: whether a third
 * party can verify it independently. Leaving that ambiguous — or worse, showing "Polygon
 * Amoy" while running locally — would misrepresent the guarantee the whole system exists
 * to provide.
 *
 * So the label always comes from the API's report of what actually executed. There is no
 * default, no optimistic guess, and no "Amoy" string anywhere in this component that is
 * not read from the server.
 *
 * The colour is load-bearing rather than decorative, which is why the rest of the interface
 * is monochrome: green here means a stranger can check the record, amber means they cannot.
 */

export interface NetworkInfo {
  id: string;
  label: string;
  chainId: number;
  verifiability: "public" | "local";
  verifiabilityLabel: string;
  explorerUrl: string | null;
  isPrimary: boolean;
  isFallback: boolean;
}

type State =
  | { status: "loading" }
  | { status: "ready"; network: NetworkInfo }
  | { status: "unavailable"; detail: string };

export interface NetworkBadgeProps {
  /** Compact renders the label only; full adds the verifiability sentence. */
  variant?: "compact" | "full";
  className?: string;
}

export function NetworkBadge({ variant = "compact", className }: NetworkBadgeProps) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${env.VITE_PUBLIC_API_URL}/network`, {
          credentials: "include",
        });

        if (!response.ok) {
          // 503 means no chain is usable at all. Saying so is far better than showing a
          // stale or invented network name.
          if (!cancelled) {
            setState({
              status: "unavailable",
              detail:
                response.status === 503
                  ? "No blockchain network is currently available"
                  : `Network status unavailable (${response.status})`,
            });
          }
          return;
        }

        const body = (await response.json()) as { active?: NetworkInfo };

        // Defensive on purpose. This component must never misreport which chain is active,
        // so a response missing `active` is treated as "cannot tell" rather than rendered —
        // an undefined network here would throw on `network.label` and take the whole page
        // down with it.
        if (!body?.active?.label) {
          if (!cancelled) {
            setState({ status: "unavailable", detail: "Network status unavailable" });
          }
          return;
        }

        if (!cancelled) setState({ status: "ready", network: body.active });
      } catch {
        if (!cancelled) {
          setState({ status: "unavailable", detail: "Cannot reach the API" });
        }
      }
    };

    void load();
    // Re-checked periodically so a switch to Amoy — which happens on its own once the
    // signer is funded — appears without a page reload.
    const timer = setInterval(() => void load(), 30_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (state.status === "loading") {
    return (
      <Status
        tone="neutral"
        className={className}
        data-testid="network-badge"
        data-network="loading"
      >
        Checking network…
      </Status>
    );
  }

  if (state.status === "unavailable") {
    return (
      <Status
        tone="revoked"
        className={className}
        data-testid="network-badge"
        data-network="unavailable"
        role="status"
      >
        {state.detail}
      </Status>
    );
  }

  const { network } = state;
  const tone = network.verifiability === "public" ? "verified" : "fallback";

  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-2", className)}
      data-testid="network-badge"
      data-network={network.id}
      data-verifiability={network.verifiability}
      role="status"
      title={`Chain id ${network.chainId}`}
    >
      <Status tone={tone}>{network.label}</Status>

      {/*
        Always rendered, never behind a variant flag.

        An earlier draft made this opt-in so the header chip could stay narrow, which would
        have hidden "Locally Verifiable" on the most-seen surface in the app — precisely the
        misrepresentation this component exists to prevent. `variant` may adjust how loudly
        it is set, never whether it is said.
      */}
      <span className={cn("text-fg-muted", variant === "full" ? "text-[13px]" : "text-[12px]")}>
        {network.verifiabilityLabel}
      </span>

      {network.isFallback && (
        // Named plainly. A fallback that looks like the primary is the failure this whole
        // mechanism is meant to prevent.
        <span className="text-[12px] text-fallback" data-testid="fallback-notice">
          Fallback — Polygon Amoy unavailable; records are not publicly verifiable
        </span>
      )}
    </span>
  );
}
