import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { createSiweMessage } from "viem/siwe";

import { env } from "@/config/env";
import { queryKeys } from "@/api/queries";

/**
 * Sign-In With Ethereum, from the browser.
 *
 * This did not exist. The wallet connected through wagmi and nothing ever asked it to
 * prove anything — so `/auth/session` stayed 401 forever and the dashboard showed "sign in"
 * to somebody whose address was already in the header. Connecting a wallet and holding a
 * session are two different things, and only the first was implemented.
 *
 * It survived every test because the end-to-end tooling signs in from Node, driving these
 * same four HTTP calls directly. That exercised the server's half of the protocol
 * thoroughly and the browser's half not at all.
 *
 * ## The four steps
 *
 * 1. **Nonce** from the server, single-use, short-lived. It is what stops a captured
 *    signature being replayed: the server consumes it atomically on verify.
 * 2. **Message** built to EIP-4361. `domain` and `uri` must match what the server was
 *    configured with, because it re-derives the expected message and compares — a mismatch
 *    is rejected with no useful clue, which is why they come from one place here.
 * 3. **Signature** from the wallet. This is the only moment the key is used, and it never
 *    leaves the device; the platform receives a signature and recovers an address from it.
 * 4. **Verify**, which sets the httpOnly session cookie. `credentials: "include"` on both
 *    calls, or the nonce is issued to one session and spent by another.
 */

export interface SignInResult {
  address: string;
  did: string | null;
  roles: string[];
}

/**
 * Bot protection, as far as the browser is concerned.
 *
 * The server always calls Cloudflare's siteverify, so the field is never optional. Where the
 * token comes from depends on whether a widget exists:
 *
 *   site key configured    → a real Turnstile widget rendered the challenge, and its
 *                            response is what siteverify checks.
 *   no site key            → there is no widget to ask, so a placeholder goes instead.
 *
 * The placeholder is not a bypass. A deployment with no site key is necessarily paired with
 * a permissive secret — in development that is Cloudflare's published always-passes test
 * key — and siteverify still runs and still decides. Sending an *empty* token fails even
 * against the test secret, which is what "The bot check did not pass" meant when the browser
 * sign-in was first driven end to end: the flow was correct and the field was blank.
 */
function turnstileToken(): string {
  const widget = (globalThis as { turnstile?: { getResponse?: () => string | undefined } })
    .turnstile;
  const response = widget?.getResponse?.();
  if (response) return response;

  // No widget to read. Shaped like a token so siteverify has something to evaluate.
  return "XXXX.DUMMY.TOKEN.XXXX";
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${env.VITE_PUBLIC_API_URL}${path}`, {
    method: body ? "POST" : "GET",
    // The session is an httpOnly cookie on another origin. Without this the nonce is
    // issued into a session this request will never be part of.
    credentials: "include",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Left as text; the status check below decides what to do with it.
  }

  if (!response.ok) {
    const error = parsed as { error?: string; retryAfterSeconds?: number };
    throw new Error(error?.error ?? `HTTP ${response.status}`);
  }

  return parsed as T;
}

export function useSignIn() {
  const queryClient = useQueryClient();
  const { address, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();

  return useMutation<SignInResult, Error>({
    mutationFn: async () => {
      if (!address) throw new Error("connect a wallet first");

      const { nonce } = await post<{ nonce: string }>("/auth/nonce");

      const message = createSiweMessage({
        address,
        // The chain the wallet is on, which may not be the chain the platform writes to —
        // the backend decides that. Recorded here only because EIP-4361 requires it.
        chainId: chainId ?? 80002,
        // Taken from the address bar rather than configuration, because the server
        // compares against what the browser actually showed the user. Two sources for the
        // same fact is how they drift, and a drift here rejects every signature with no
        // clue as to why. The deployment's job is to make SIWE_DOMAIN match this.
        domain: globalThis.location.host,
        nonce,
        uri: globalThis.location.origin,
        version: "1",
        statement: "Sign in to TrustChain. This proves you control this address.",
      });

      const signature = await signMessageAsync({ message });

      return post<SignInResult>("/auth/verify", {
        message,
        signature,
        turnstileToken: turnstileToken(),
      });
    },

    onSuccess: (result) => {
      // Seed rather than only invalidate: the dashboard reads this immediately, and a
      // refetch round trip would show the signed-out state for a beat after success.
      queryClient.setQueryData(queryKeys.session, result);
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** Ends the session server-side and clears the cached identity. */
export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation<void, Error>({
    mutationFn: async () => {
      await post("/auth/logout", {});
    },
    onSettled: () => {
      // Cleared even if the request failed: the intent was to stop being signed in, and
      // leaving a stale identity on screen after that is worse than a failed call.
      queryClient.setQueryData(queryKeys.session, null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}
