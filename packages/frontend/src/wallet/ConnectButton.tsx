import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";

import { humanError } from "@/api/errors";
import { useSessionSnapshot } from "@/api/queries";
import { useSignIn, useSignOut } from "@/auth/useSignIn";
import { Button } from "@/components/ui/button";
import { truncateAddress } from "@/lib/utils";
import { ConnectModal } from "./ConnectModal";

/**
 * Connect, sign in, and the connected identity — in the header.
 *
 * There are **three** states here, and only two were implemented. A connected wallet showed
 * its address and the dashboard still said "sign in", because connecting proves nothing:
 * the session exists only once the wallet has signed a nonce the server issued. Someone
 * whose address was already in the header was told to sign in, with no control anywhere
 * that would do it.
 *
 *   not connected   → Connect Wallet
 *   connected       → Sign in     (a signature is still owed)
 *   signed in       → the address, and a way out
 *
 * Sign-in starts on its own once a wallet connects, because the two-step version is a trap:
 * the wallet's own popup closes on connect and nothing else appears, so the interface looks
 * finished when it is halfway. It is attempted once per address — a rejected signature is a
 * decision, and re-prompting somebody who just declined is how a page becomes hostile.
 */
export function ConnectButton() {
  const [open, setOpen] = useState(false);
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  // Observed, not fetched — see useSessionSnapshot. Subscribing normally here makes the
  // sign-in prompt that renders this button flicker against its own loading state.
  const session = useSessionSnapshot();
  const signIn = useSignIn();
  const signOut = useSignOut();

  const signedIn = Boolean(session.data?.address);
  const attempted = useRef<string | null>(null);

  /*
   * The mutate function, held in a ref.
   *
   * `signIn` is a new object on every render, so listing it as an effect dependency makes
   * the effect re-run on every render — and since it sets state, that is an infinite loop.
   * `mutate` is stable in practice but not contractually, so it is read through a ref and
   * kept out of the dependency array entirely.
   */
  const startSignIn = useRef(signIn.mutate);
  startSignIn.current = signIn.mutate;

  useEffect(() => {
    if (!isConnected || !address || signedIn) return;
    // Wait for the session query to settle, or a signed-in visitor returning to the page
    // gets a signature request before their existing session has loaded.
    if (session.isLoading) return;
    if (attempted.current === address) return;

    attempted.current = address;
    startSignIn.current();
  }, [isConnected, address, signedIn, session.isLoading]);

  // A new address is a new identity, and is owed its own signature.
  useEffect(() => {
    if (address && attempted.current && attempted.current !== address) {
      attempted.current = null;
    }
  }, [address]);

  if (isConnected && address && signedIn) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          signOut.mutate();
          disconnect();
        }}
        title={`${address} — signed in. Click to sign out.`}
        data-testid="account-chip"
        className="gap-2"
      >
        <span className="size-1.5 rounded-full bg-verified" aria-hidden="true" />
        <span className="font-mono tabular text-sm">{truncateAddress(address)}</span>
      </Button>
    );
  }

  if (isConnected && address) {
    const pending = signIn.isPending;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          onClick={() => signIn.mutate()}
          disabled={pending}
          data-testid="sign-in-button"
        >
          {pending ? "Check your wallet…" : "Sign in"}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => disconnect()}
          title={`${address} — connected but not signed in`}
          data-testid="connected-not-signed-in"
          className="gap-2"
        >
          <span className="size-1.5 rounded-full bg-fallback" aria-hidden="true" />
          <span className="font-mono tabular text-sm">{truncateAddress(address)}</span>
        </Button>

        {signIn.isError && (
          <p
            className="w-full text-right text-xs text-revoked lg:w-auto"
            data-testid="sign-in-error"
          >
            {humanError(signIn.error).message}
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="connect-button">
        Connect Wallet
      </Button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
