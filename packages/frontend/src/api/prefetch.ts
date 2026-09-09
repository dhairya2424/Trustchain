import type { QueryClient } from "@tanstack/react-query";

import { apiGet } from "./client";
import { NETWORK_POLL_MS } from "@/components/NetworkBadge";

/**
 * Warming a route's data while the pointer is still on its way to the link.
 *
 * The gap between hover and click is typically 100–300ms — usually enough for a local API
 * round trip to finish, so the destination renders with data instead of skeletons. It is a
 * real perceived-latency win for a cost that is easy to get wrong, so two rules:
 *
 *   - **Prefetch only what the route is certain to need.** Speculatively fetching a page's
 *     every query would spend requests on hovers that never become clicks.
 *   - **Never prefetch a mutation, and never anything gated behind a permission the visitor
 *     may not hold.** A hover is not consent, and a 403 fired on mouse-over is a wasted
 *     request that also lands in the audit log's rate limiter.
 *
 * `prefetchQuery` is a no-op when fresh data is already cached, so hovering a link
 * repeatedly costs nothing.
 */

/** Queries worth warming, per route. Deliberately conservative. */
const ROUTE_PREFETCH: Record<string, (client: QueryClient) => Promise<unknown>> = {
  "/dashboard": (client) =>
    client.prefetchQuery({
      queryKey: ["session"],
      queryFn: () => apiGet("/auth/session"),
      staleTime: 60_000,
      retry: false,
    }),

  "/admin": (client) =>
    client.prefetchQuery({
      queryKey: ["session"],
      queryFn: () => apiGet("/auth/session"),
      staleTime: 60_000,
      retry: false,
    }),

  // The verifier needs no session and its verification is a POST, so the only thing worth
  // warming is the network badge it renders.
  "/verify": (client) =>
    client.prefetchQuery({
      queryKey: ["network"],
      queryFn: () => apiGet("/network"),
      staleTime: NETWORK_POLL_MS,
      retry: false,
    }),
};

export function prefetchRoute(client: QueryClient, path: string): void {
  const warm = ROUTE_PREFETCH[path];
  if (!warm) return;

  // Fire and forget. A failed prefetch must never surface — the visitor has not asked for
  // anything yet, and the real navigation will report its own errors.
  void warm(client).catch(() => {});
}
