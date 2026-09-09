import { motion as fm } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useConnect, type Connector } from "wagmi";

import { humanError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";
import { CheckmarkDraw, ConfettiBurst, PulseRings } from "./ConnectFeedback";

/**
 * The wallet picker.
 *
 * Built on the Radix dialog primitive, which owns focus containment, focus restoration,
 * Escape, scroll locking and `aria-hidden` on the rest of the document. An earlier version
 * hand-rolled all of that; it worked, but it was reimplementing a list of things that are
 * easy to get subtly wrong and impossible to notice without a screen reader.
 *
 * Connector state comes from wagmi rather than being tracked locally, so a connection
 * started here and one restored from a previous session cannot disagree.
 */

export interface ConnectModalProps {
  open: boolean;
  onClose: () => void;
}

type Phase = "choosing" | "pending" | "connected";

/** A stable, human name per connector, since wagmi ids are not presentable. */
function connectorLabel(connector: Connector): string {
  if (connector.name) return connector.name;
  if (connector.id === "walletConnect") return "WalletConnect";
  if (connector.id === "injected") return "Browser Wallet";
  return connector.id;
}

export function ConnectModal({ open, onClose }: ConnectModalProps) {
  const motion = useMotion();
  const { connectors, connect, status, error, reset } = useConnect();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("choosing");

  useEffect(() => {
    if (open) {
      setPhase("choosing");
      setPendingId(null);
      reset();
    }
  }, [open, reset]);

  // Advance the phase from what wagmi reports.
  useEffect(() => {
    if (phase !== "pending") return;

    if (status === "success") {
      setPhase("connected");
      return;
    }

    if (status === "error") {
      setPhase("choosing");
      setPendingId(null);
    }
  }, [status, phase]);

  /*
   * Auto-close, keyed on the connected phase alone.
   *
   * This deliberately does not live in the effect above. There, setting the timer and
   * calling setPhase("connected") in the same pass meant the state change re-ran the
   * effect, whose cleanup cleared the timer it had just set — and since the new run no
   * longer matched the condition, no replacement was ever scheduled. The modal reached the
   * success state and then sat there forever.
   */
  useEffect(() => {
    if (phase !== "connected") return;

    // Long enough to read the checkmark, short enough not to feel like a hang.
    const timer = setTimeout(onClose, motion.reduced ? 450 : 1250);
    return () => clearTimeout(timer);
  }, [phase, onClose, motion.reduced]);

  const onPick = (connector: Connector) => {
    setPendingId(connector.uid);
    setPhase("pending");
    connect({ connector });
  };

  const pendingConnector = connectors.find((c) => c.uid === pendingId);

  /*
   * Can anything here actually connect?
   *
   * wagmi always lists the `injected` connector, whether or not a provider exists behind
   * it. So with no extension installed the modal offered a button whose only possible
   * outcome was an error — the user clicks "Injected", waits, and is told a library version.
   *
   * WalletConnect is the exception: it needs no extension, because it pairs with a phone.
   * If one is configured there is still a real route in, so the list stays.
   */
  const hasInjectedProvider =
    typeof window !== "undefined" &&
    typeof (window as { ethereum?: unknown }).ethereum !== "undefined";

  // Narrow on purpose: only the *generic* injected connector is a dead end without a
  // provider. A wallet discovered through EIP-6963 gets its own connector id and may not
  // set window.ethereum at all, and WalletConnect pairs with a phone rather than an
  // extension — so the presence of anything else means there is still a route in.
  const onlyGenericInjected =
    connectors.length > 0 && connectors.every((connector) => connector.id === "injected");
  const nothingToConnectWith = onlyGenericInjected && !hasInjectedProvider;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="connect-modal" data-phase={phase}>
        <DialogTitle className="text-lg font-semibold tracking-tight">
          {phase === "connected" ? "Wallet connected" : "Connect a wallet"}
        </DialogTitle>

        {/*
          One live region for the whole flow. Announcements are text, so assistive
          technology follows the same states the animation shows.
        */}
        <p className="sr-only" role="status" aria-live="polite">
          {phase === "pending" &&
            `Connecting to ${pendingConnector ? connectorLabel(pendingConnector) : "wallet"}`}
          {phase === "connected" && "Wallet connected"}
          {status === "error" && error ? `Connection failed: ${error.message}` : ""}
        </p>

        {phase === "choosing" && (
          <>
            <DialogDescription className="mt-1.5 text-sm leading-relaxed text-fg-muted">
              Your wallet is your identity here. TrustChain never sees your keys — you sign, we
              verify.
            </DialogDescription>

            {/*
              No wallet, and no way to pair one. Say so plainly, and point at the thing that
              still works without an account — a dead button and a library error was the
              worst of both.
            */}
            {nothingToConnectWith && (
              <div
                className="mt-5 rounded border border-line bg-canvas px-4 py-4"
                data-testid="no-wallet-guidance"
              >
                <p className="text-sm font-medium text-fg">No wallet extension detected</p>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                  Signing in needs an Ethereum wallet in this browser. Install{" "}
                  <a
                    className="underline underline-offset-4 hover:text-fg"
                    href="https://metamask.io/download/"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    MetaMask
                  </a>{" "}
                  or another EIP-1193 wallet, then reload this page.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                  Verifying a credential needs no wallet and no account —{" "}
                  <a className="underline underline-offset-4 hover:text-fg" href="/verify">
                    use the public verify page
                  </a>
                  .
                </p>
              </div>
            )}

            <ul className={cn("mt-5 grid gap-1.5", nothingToConnectWith && "hidden")}>
              {connectors.map((connector, index) => (
                <fm.li
                  key={connector.uid}
                  initial={motion.reduced ? { opacity: 0 } : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={motion.transition("quick", motion.stagger(index, 0.06))}
                >
                  <button
                    type="button"
                    onClick={() => onPick(connector)}
                    data-testid={`wallet-option-${connector.id}`}
                    className="group flex min-h-14 w-full items-center justify-between gap-3 rounded border border-line bg-canvas px-4 text-base font-medium text-fg transition-colors hover:border-line-strong hover:bg-hover"
                  >
                    {connectorLabel(connector)}
                    <ArrowRight
                      className="size-4 shrink-0 text-fg-faint transition-colors group-hover:text-fg"
                      aria-hidden="true"
                    />
                  </button>
                </fm.li>
              ))}
            </ul>

            {status === "error" && error && (
              <div
                className="mt-4 rounded border border-revoked/40 bg-revoked/8 px-3 py-2.5 text-sm text-revoked"
                data-testid="connect-error"
              >
                {/*
                  Through humanError, never raw.
                  
                  This used to render `error.message` directly, which put
                  "Provider not found. Version: @wagmi/core@3.6.5" in front of a person who
                  had simply not installed a wallet — a sentence that names a library, leaks
                  its version, and does not say the one thing they need to do. api/errors.ts
                  already existed for exactly this and says so in its own header; this was
                  the one place that bypassed it.

                  Still text, never markup: a malicious injected provider controls this
                  string, so it is displayed rather than interpreted.
                */}
                <p>{humanError(error).message}</p>
                {humanError(error).action && (
                  <p className="mt-1 text-revoked/80">{humanError(error).action}</p>
                )}
              </div>
            )}
          </>
        )}

        {phase === "pending" && (
          <div
            className="flex flex-col items-center gap-5 py-8 text-center"
            data-testid="connect-pending"
          >
            <PulseRings />
            <p className="text-base text-fg-muted">
              Approve the connection in{" "}
              <strong className="font-medium text-fg">
                {pendingConnector ? connectorLabel(pendingConnector) : "your wallet"}
              </strong>
            </p>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
        )}

        {phase === "connected" && (
          <div
            className="flex flex-col items-center gap-4 py-8 text-center"
            data-testid="connect-success"
          >
            <span className="relative inline-flex items-center justify-center">
              <CheckmarkDraw />
              <ConfettiBurst />
            </span>
            <p className="text-base font-medium text-verified">You&rsquo;re in.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
