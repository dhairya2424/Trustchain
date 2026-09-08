import { motion as fm } from "framer-motion";
import { useMemo } from "react";

import { useMotion } from "@/motion/MotionProvider";

/**
 * The three states of connecting, as animation.
 *
 * All three are `aria-hidden`: they illustrate a state that is already announced in text by
 * the modal's live region. A screen reader user gets "Connecting to MetaMask" and then
 * "Wallet connected" as words; duplicating that as decorative SVG would just be noise.
 *
 * Everything here is drawn in the neutral palette except the checkmark, which is allowed
 * the verified green — success is a status, and status is what colour is reserved for.
 */

/** Expanding rings while a connection is pending. A thin ring, not a glow. */
export function PulseRings() {
  const motion = useMotion();

  if (motion.reduced) {
    // A static ring. Still clearly "in progress" next to the text, with nothing expanding.
    return (
      <span
        className="pulse-rings pulse-rings--static"
        aria-hidden="true"
        data-testid="pulse-rings"
      />
    );
  }

  return (
    <span className="pulse-rings" aria-hidden="true" data-testid="pulse-rings">
      {[0, 1, 2].map((ring) => (
        <fm.span
          key={ring}
          className="pulse-ring"
          initial={{ scale: 0.35, opacity: 0.7 }}
          animate={{ scale: 1.85, opacity: 0 }}
          transition={{
            duration: 2,
            // Evenly offset so the rings read as a steady pulse rather than a burst.
            delay: ring * 0.66,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      ))}
      <span className="size-2 rounded-full bg-fg-muted" />
    </span>
  );
}

/**
 * A checkmark that draws itself.
 *
 * `pathLength` rather than a path morph: one animated property, and it degrades to a fully
 * drawn check simply by starting at 1.
 */
export function CheckmarkDraw() {
  const motion = useMotion();

  return (
    <svg
      className="size-14 text-verified"
      viewBox="0 0 52 52"
      fill="none"
      aria-hidden="true"
      data-testid="checkmark"
      data-animated={motion.reduced ? "false" : "true"}
    >
      <circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="1" opacity="0.3" />
      <fm.path
        d="M15 26.5 L22.5 34 L37 19"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={motion.reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={motion.reduced ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
      />
    </svg>
  );
}

const CONFETTI_COUNT = 10;

/**
 * A small burst on success.
 *
 * Deliberately tiny: ten neutral flecks, contained in the modal, gone in half a second. A
 * full-screen colour cannon on every wallet connection would be exhausting by the third
 * time, and this is an action people repeat — and coloured confetti would spend the status
 * palette on celebration, which is the one thing it must not be used for.
 *
 * Renders nothing under reduced motion. Unlike the checkmark there is no meaning here to
 * preserve, so the honest reduced form is its absence.
 */
export function ConfettiBurst() {
  const motion = useMotion();

  // Seeded once per mount so a re-render mid-flight does not reshuffle the pieces.
  const pieces = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, index) => {
        const angle = (index / CONFETTI_COUNT) * Math.PI * 2;
        const distance = 40 + Math.random() * 26;
        return {
          id: index,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          rotate: Math.random() * 220 - 110,
        };
      }),
    [],
  );

  if (motion.reduced) return null;

  return (
    <span className="confetti" aria-hidden="true" data-testid="confetti">
      {pieces.map((piece) => (
        <fm.span
          key={piece.id}
          className="confetti-piece bg-fg-faint"
          initial={{ x: 0, y: 0, opacity: 0.9, scale: 1, rotate: 0 }}
          animate={{ x: piece.x, y: piece.y, opacity: 0, scale: 0.4, rotate: piece.rotate }}
          transition={{ duration: 0.62, ease: "easeOut" }}
        />
      ))}
    </span>
  );
}
