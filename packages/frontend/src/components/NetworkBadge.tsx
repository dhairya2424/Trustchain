import { useEffect, useState } from "react";

import { env } from "../config/env";

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

export function NetworkBadge() {
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

        const body = (await response.json()) as { active: NetworkInfo };
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
      <span data-testid="network-badge" data-network="loading">
        Checking network…
      </span>
    );
  }

  if (state.status === "unavailable") {
    return (
      <span data-testid="network-badge" data-network="unavailable" role="status">
        {state.detail}
      </span>
    );
  }

  const { network } = state;

  return (
    <span
      data-testid="network-badge"
      data-network={network.id}
      data-verifiability={network.verifiability}
      role="status"
      title={`Chain id ${network.chainId}`}
    >
      <strong>{network.label}</strong> — {network.verifiabilityLabel}
      {network.isFallback ? (
        // Named plainly. A fallback that looks like the primary is the failure this whole
        // mechanism is meant to prevent.
        <em data-testid="fallback-notice">
          {" "}
          (fallback — Polygon Amoy unavailable; records are not publicly verifiable)
        </em>
      ) : null}
    </span>
  );
}
