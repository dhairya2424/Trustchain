import { AnimatePresence, motion as fm } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnect, type Connector } from "wagmi";

import { useMotion } from "../motion/MotionProvider";
import { CheckmarkDraw, ConfettiBurst, PulseRings } from "./ConnectFeedback";

/**
 * The wallet picker.
 *
 * The animation brief is a staggered list, pulse rings while pending and a drawn checkmark
 * with a confetti burst on success. The parts that are not in the brief but decide whether
 * this is usable are focus containment, Escape, a labelled dialog and a live region — a
 * modal that traps a keyboard user is broken no matter how well it animates.
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

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  // Remembered so focus can go back where it came from on close, rather than to the top of
  // the document — which would lose a keyboard user their place entirely.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
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

  // Focus the first option when the list appears, so the keyboard lands inside the dialog.
  useEffect(() => {
    if (open && phase === "choosing") {
      const timer = setTimeout(() => firstOptionRef.current?.focus(), 40);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open, phase]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      // Focus containment. Without this, Tab walks out of the dialog and into the page
      // behind it, which is still rendered and still focusable.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) {
      openerRef.current?.focus();
      return;
    }

    // The page behind must not scroll while a modal is over it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onPick = (connector: Connector) => {
    setPendingId(connector.uid);
    setPhase("pending");
    connect({ connector });
  };

  const pendingConnector = connectors.find((c) => c.uid === pendingId);

  return (
    <AnimatePresence>
      {open && (
        <fm.div
          className="modal-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motion.transition("quick")}
          onClick={onClose}
          data-testid="connect-scrim"
        >
          <fm.div
            ref={dialogRef}
            className="glass glass--lit modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-title"
            data-testid="connect-modal"
            data-phase={phase}
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
            animate={motion.reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
            transition={motion.transition("base")}
            onKeyDown={handleKeyDown}
            // The scrim closes on click; the dialog must not, or every click inside would
            // dismiss it.
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              <h2 id="connect-title">
                {phase === "connected" ? "Wallet connected" : "Connect a wallet"}
              </h2>
              <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                ×
              </button>
            </header>

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
                <p className="modal-lead">
                  Your wallet is your identity here. TrustChain never sees your keys — you sign, we
                  verify.
                </p>

                <ul className="wallet-list">
                  {connectors.map((connector, index) => (
                    <fm.li
                      key={connector.uid}
                      initial={motion.reduced ? { opacity: 0 } : { opacity: 0, x: -14 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={motion.transition("quick", motion.stagger(index, 0.07))}
                    >
                      <button
                        type="button"
                        ref={index === 0 ? firstOptionRef : undefined}
                        className="wallet-option"
                        onClick={() => onPick(connector)}
                        data-testid={`wallet-option-${connector.id}`}
                      >
                        <span className="wallet-option__name">{connectorLabel(connector)}</span>
                        <span className="wallet-option__arrow" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </fm.li>
                  ))}
                </ul>

                {status === "error" && error && (
                  <p className="modal-error" data-testid="connect-error">
                    {/*
                      Rendered as text by React, never as markup. A wallet's error string is
                      attacker-influencable in principle — a malicious dapp-injected provider
                      can set it — so it is displayed, not interpreted.
                    */}
                    {error.message}
                  </p>
                )}
              </>
            )}

            {phase === "pending" && (
              <div className="modal-state" data-testid="connect-pending">
                <PulseRings />
                <p>
                  Approve the connection in{" "}
                  <strong>
                    {pendingConnector ? connectorLabel(pendingConnector) : "your wallet"}
                  </strong>
                </p>
                <button type="button" className="btn btn--ghost" onClick={onClose}>
                  Cancel
                </button>
              </div>
            )}

            {phase === "connected" && (
              <div className="modal-state modal-state--ok" data-testid="connect-success">
                <span className="checkmark-wrap">
                  <CheckmarkDraw />
                  <ConfettiBurst />
                </span>
                <p>You're in.</p>
              </div>
            )}
          </fm.div>
        </fm.div>
      )}
    </AnimatePresence>
  );
}
