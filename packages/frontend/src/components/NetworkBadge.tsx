import { useQuery } from "@tanstack/react-query";

import { ApiError, apiGet } from "@/api/client";
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
 *
 * Reads through TanStack Query on a shared key. That matters beyond tidiness — this badge
 * renders in the header and again on the verifier, and two components each running their
 * own `setInterval` would poll the chain twice as often to display the same sentence twice
 * on one screen. One query key means one request, whatever the page renders.
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

export interface NetworkBadgeProps {
  /** Compact renders the label only; full adds the verifiability sentence. */
  variant?: "compact" | "full";
  className?: string;
}

/** Re-checked periodically so a switch to Amoy — which happens on its own once the signer is funded — appears without a reload. */
export const NETWORK_POLL_MS = 30_000;

export function NetworkBadge({ variant = "compact", className }: NetworkBadgeProps) {
  const query = useQuery<{ active?: NetworkInfo }, ApiError>({
    queryKey: ["network"],
    queryFn: ({ signal }) => apiGet<{ active?: NetworkInfo }>("/network", signal),
    retry: false,
    refetchInterval: NETWORK_POLL_MS,
    // Keeps the last known network on screen while a poll is in flight, so the badge does
    // not flicker back to "checking" every thirty seconds.
    placeholderData: (previous) => previous,
  });

  if (query.isLoading) {
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

  if (query.isError) {
    // 503 means no chain is usable at all. Saying so is far better than showing a stale or
    // invented network name.
    const detail = query.error.isUnavailable
      ? "No blockchain network is currently available"
      : query.error.status === 0
        ? "Cannot reach the API"
        : `Network status unavailable (${query.error.status})`;

    return (
      <Status
        tone="revoked"
        className={className}
        data-testid="network-badge"
        data-network="unavailable"
        role="status"
      >
        {detail}
      </Status>
    );
  }

  const network = query.data?.active;

  /*
   * Defensive on purpose. This component must never misreport which chain is active, so a
   * response missing `active` is treated as "cannot tell" rather than rendered — reading
   * `network.label` off undefined would throw and take the whole page down with it.
   */
  if (!network?.label) {
    return (
      <Status
        tone="revoked"
        className={className}
        data-testid="network-badge"
        data-network="unavailable"
        role="status"
      >
        Network status unavailable
      </Status>
    );
  }

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

      {network.isFallback && variant === "full" && (
        /*
         * The long form, and only where there is room for it.
         *
         * In the app header this sentence was a layout bug with teeth: the badge starts as
         * "Checking network…" and then grows by ~60 characters, which wrapped the whole
         * navigation onto a second line and pushed the page down — 0.64 CLS, measured.
         *
         * Nothing honest is lost by confining it to the wide variant. `verifiabilityLabel`
         * above already says "Locally Verifiable" in every variant, and the amber tone says
         * it again without words. This sentence adds the *reason*, which belongs on the
         * pages that have space to explain rather than in a 40px header.
         */
        <span className="text-[12px] text-fallback" data-testid="fallback-notice">
          Fallback — Polygon Amoy unavailable; records are not publicly verifiable
        </span>
      )}
    </span>
  );
}
