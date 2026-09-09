import { motion as fm, useMotionValue, useSpring, useTransform } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState, type PointerEvent } from "react";

import { Status } from "@/components/ui/status";
import { useMotion } from "@/motion/MotionProvider";
import { cn, truncateAddress } from "@/lib/utils";
import type { Session } from "@/api/queries";

/**
 * The identity card: DID, address, roles, and a QR code of the DID.
 *
 * Tilts toward the pointer. The effect is done with two motion values fed through springs
 * rather than by writing a transform on every mousemove, so the card settles instead of
 * snapping and React is not re-rendered sixty times a second — the transform is applied
 * outside the render cycle.
 *
 * Three things it will not do:
 *   - tilt at all under reduced motion, or on a touch device, where there is no hover to
 *     respond to and the tilt would fire on tap
 *   - encode anything but the real DID; when there is no DID, the QR is absent rather than
 *     a placeholder pattern
 *   - imply the DID is a secret. It is a public identifier and the QR exists to be
 *     scanned; the address is shown truncated only because 42 characters wreck the layout.
 */

const MAX_TILT_DEGREES = 7;

export interface IdentityCardProps {
  session: Session;
  className?: string;
}

export function IdentityCard({ session, className }: IdentityCardProps) {
  const motion = useMotion();
  const [interactive, setInteractive] = useState(false);

  // Raw pointer position, -0.5..0.5 on each axis.
  const px = useMotionValue(0);
  const py = useMotionValue(0);

  const springs = { stiffness: 220, damping: 24, mass: 0.6 };
  const rotateX = useSpring(
    useTransform(py, [-0.5, 0.5], [MAX_TILT_DEGREES, -MAX_TILT_DEGREES]),
    springs,
  );
  const rotateY = useSpring(
    useTransform(px, [-0.5, 0.5], [-MAX_TILT_DEGREES, MAX_TILT_DEGREES]),
    springs,
  );

  useEffect(() => {
    // Tilt only where there is a real hovering pointer. On a phone every "hover" is a tap,
    // and the card would lurch as you tried to read it.
    if (motion.reduced || typeof window === "undefined" || !window.matchMedia) {
      setInteractive(false);
      return;
    }

    try {
      setInteractive(window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    } catch {
      setInteractive(false);
    }
  }, [motion.reduced]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    px.set((event.clientX - rect.left) / rect.width - 0.5);
    py.set((event.clientY - rect.top) / rect.height - 0.5);
  };

  const reset = () => {
    px.set(0);
    py.set(0);
  };

  return (
    <div className={cn("[perspective:1200px]", className)}>
      <fm.div
        className="panel p-6"
        style={interactive ? { rotateX, rotateY, transformStyle: "preserve-3d" } : undefined}
        onPointerMove={onPointerMove}
        onPointerLeave={reset}
        data-testid="identity-card"
        data-tilt={interactive ? "on" : "off"}
      >
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="eyebrow">Decentralized identifier</p>

            {session.did ? (
              <p
                className="mt-2 break-all font-mono text-sm leading-relaxed text-fg"
                data-testid="identity-did"
              >
                {session.did}
              </p>
            ) : (
              <p className="mt-2 text-sm text-fg-muted" data-testid="identity-no-did">
                No DID is registered for this address yet. One is anchored on-chain the first time
                an identity is created for you.
              </p>
            )}

            <dl className="mt-5 space-y-3">
              <div>
                <dt className="eyebrow">Wallet</dt>
                <dd
                  className="mt-1 font-mono text-sm tabular text-fg-muted"
                  title={session.address}
                >
                  {truncateAddress(session.address)}
                </dd>
              </div>

              <div>
                <dt className="eyebrow">Roles, read from the chain</dt>
                <dd className="mt-2 flex flex-wrap gap-1.5">
                  {session.roles.length > 0 ? (
                    session.roles.map((role) => (
                      <span
                        key={role}
                        className="rounded border border-line-strong px-2 py-0.5 font-mono text-2xs text-fg-muted"
                        data-testid="identity-role"
                      >
                        {role}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-fg-muted">
                      No roles granted. You can read, but not change anything.
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {/*
            The QR encodes the DID and nothing else. Rendered as SVG so it stays sharp at
            any size and needs no canvas.
          */}
          {session.did && (
            <fm.div
              className="shrink-0 rounded border border-line bg-canvas p-2.5"
              initial={motion.reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={motion.transition("base")}
              data-testid="identity-qr"
              style={interactive ? { transform: "translateZ(28px)" } : undefined}
            >
              <QRCodeSVG
                value={session.did}
                size={96}
                bgColor="transparent"
                fgColor="#ececee"
                level="M"
                title={`QR code for ${session.did}`}
              />
            </fm.div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-2 border-t border-line pt-4">
          <Status tone={session.did ? "verified" : "neutral"}>
            {session.did ? "Identity anchored" : "No identity"}
          </Status>
          <span className="text-xs text-fg-faint">
            {session.did
              ? "This identifier exists on-chain and anyone can resolve it."
              : "Nothing is anchored on-chain for this wallet."}
          </span>
        </div>
      </fm.div>
    </div>
  );
}
