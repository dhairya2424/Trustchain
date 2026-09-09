import { useQuery } from "@tanstack/react-query";

import { ApiError, apiGet } from "./client";
import type { NetworkInfo } from "@/components/NetworkBadge";

/**
 * Every read the dashboard makes, and nothing it cannot actually read.
 *
 * The important discipline here is negative: there is no hook for "my assets" or "my
 * credentials", because the API has no endpoint that answers either question. The asset
 * repository and the event indexer are not implemented, and `GET /assets/:id` deliberately
 * answers 404 rather than inventing a record.
 *
 * What *is* real is the audit trail. Every mint, issuance and revocation is an on-chain
 * event attributed to the actor who requested it, so filtering the audit log by the signed-
 * in address gives a truthful — if minimal — account of what someone did. That is the
 * source these panels are built on, and where it cannot answer, the UI says so.
 */

export interface Session {
  address: string;
  did: string | null;
  roles: readonly string[];
}

/**
 * One audit entry, exactly as `AuditEntryDto` defines it in
 * `packages/backend/src/audit/serializers.ts`.
 *
 * Worth naming the two address fields carefully, because they are easy to swap and the
 * whole actor-attribution design rests on the distinction:
 *
 *   - `actor` is the identity that REQUESTED the action, proven on-chain through ERC-2771.
 *     Null only where the source could not supply it, which for a chain read means the
 *     entry predates attribution — not that the action was anonymous.
 *   - `executor` is the account that SUBMITTED the transaction: the relayer that paid gas.
 *   - `via` is neither. It is the system contract that recorded the entry.
 */
export interface AuditEntry {
  entryId: number;
  action: string;
  actionCode: number;
  actor: string | null;
  executor: string | null;
  didHash: string;
  refHash: string;
  via: string;
  blockNumber: number;
  transactionHash: string;
  occurredAt: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Opaque; pass back as `cursor`. Null on the last page. */
  nextCursor: string | null;
  /** "subgraph" or "chain" — which source answered. */
  source?: string;
}

export const queryKeys = {
  session: ["session"] as const,
  network: ["network"] as const,
  activity: (actor: string | undefined) => ["audit", "activity", actor ?? "anon"] as const,
  ownedAssets: ["assets", "owned"] as const,
};

/**
 * Who is signed in.
 *
 * Retry is off: a 401 here is the ordinary "not signed in" answer, and retrying it three
 * times just delays the sign-in prompt by a second for every visitor who is logged out.
 */
export function useSession() {
  return useQuery<Session, ApiError>({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => apiGet<Session>("/auth/session", signal),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * The session as the cache already holds it — observed, never fetched.
 *
 * ConnectButton needs to know whether there is a session, and it is rendered *by* the
 * sign-in prompt that the session state decides to show. Subscribing with `useSession`
 * there adds an observer that can trigger a fetch, which returns the page to its loading
 * branch, which unmounts ConnectButton, which drops the observer — and round again. The
 * page flickers between a skeleton and a sign-in prompt forever.
 *
 * `enabled: false` breaks the cycle at its source: this reads whatever is in the cache and
 * re-renders when it changes, but it never starts a request. Something else always owns the
 * fetching — the page that gates on the session, and the sign-in and sign-out mutations,
 * which write the result into this key directly.
 */
export function useSessionSnapshot() {
  return useQuery<Session, ApiError>({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => apiGet<Session>("/auth/session", signal),
    enabled: false,
    retry: false,
    staleTime: 60_000,
  });
}

/** One token the connected address actually owns, per the contract. */
export interface OwnedAsset {
  tokenId: number;
  tokenURI: string | null;
  ownerDidHash: string | null;
  soulbound: boolean;
}

export interface OwnedAssets {
  owner: string;
  /** What the contract reports. The number the list has to account for. */
  balance: number;
  tokens: OwnedAsset[];
  /** True when fewer tokens were found than the balance — an incomplete answer. */
  truncated: boolean;
  totalMinted: number;
  network: string;
  explorerUrl: string | null;
  assetRegistry: string;
}

/**
 * The tokens the signed-in address owns.
 *
 * Replaces deriving "my assets" from the audit trail, which answered a different question —
 * what you *minted* — and so was wrong in both directions: a token minted and transferred
 * away still showed, one transferred to you never did. It also needed VIEW_AUDIT, so an
 * ordinary user was told they lacked permission to see their own property.
 */
export function useOwnedAssets(enabled: boolean) {
  return useQuery<OwnedAssets, ApiError>({
    queryKey: queryKeys.ownedAssets,
    queryFn: ({ signal }) => apiGet<OwnedAssets>("/assets/owned", signal),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export interface NetworkResponse {
  active: NetworkInfo;
}

export function useNetwork() {
  return useQuery<NetworkResponse, ApiError>({
    queryKey: queryKeys.network,
    queryFn: ({ signal }) => apiGet<NetworkResponse>("/network", signal),
    retry: false,
    // Matches NetworkBadge's own cadence: a switch to Amoy happens on its own once the
    // signer is funded, and should appear without a reload.
    refetchInterval: 30_000,
  });
}

/**
 * The signed-in user's own on-chain activity.
 *
 * Polls, because there is no subgraph subscription to listen to and an audit trail that
 * only updates on reload is not a feed. Thirty seconds is slower than the chain but fast
 * enough that an action taken in another tab shows up without being asked for, and it does
 * not hammer a `getLogs` fallback that scans blocks on every call.
 *
 * `enabled` gates on having an address at all, so a logged-out dashboard makes no request
 * rather than firing one that is certain to 401.
 */
export function useActivity(actor: string | undefined, limit = 25) {
  return useQuery<AuditPage, ApiError>({
    queryKey: queryKeys.activity(actor),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (actor) params.set("actor", actor);
      return apiGet<AuditPage>(`/audit?${params.toString()}`, signal);
    },
    enabled: Boolean(actor),
    retry: false,
    refetchInterval: 30_000,
    // Keeps the previous page on screen while a poll is in flight, so the feed does not
    // blank out every thirty seconds.
    placeholderData: (previous) => previous,
  });
}

/** Action codes the audit trail emits, and how to say them in a sentence. */
export const ACTION_LABELS: Record<string, string> = {
  ASSET_MINTED: "Asset minted",
  ASSET_TRANSFERRED: "Asset transferred",
  CREDENTIAL_ISSUED: "Credential issued",
  CREDENTIAL_REVOKED: "Credential revoked",
  DID_REGISTERED: "DID registered",
  ROLE_GRANTED: "Role granted",
  ROLE_REVOKED: "Role revoked",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ").toLowerCase();
}
