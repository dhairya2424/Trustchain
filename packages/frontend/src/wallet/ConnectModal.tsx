import { motion as fm } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useConnect, type Connector } from "wagmi";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMotion } from "@/motion/MotionProvider";
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

            <ul className="mt-5 grid gap-1.5">
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
              <p
                className="mt-4 rounded border border-revoked/40 bg-revoked/8 px-3 py-2.5 text-sm text-revoked [overflow-wrap:anywhere]"
                data-testid="connect-error"
              >
                {/*
                  Rendered as text by React, never as markup. A wallet's error string is
                  attacker-influencable in principle — a malicious injected provider
                  controls it — so it is displayed, not interpreted.
                */}
                {error.message}
              </p>
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
