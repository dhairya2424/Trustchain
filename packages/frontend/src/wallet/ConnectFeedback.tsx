import { motion as fm } from "framer-motion";
import { useMemo } from "react";

import { useMotion } from "../motion/MotionProvider";

/**
 * The three states of connecting, as animation.
 *
 * All three are `aria-hidden`: they illustrate a state that is already announced in text by
 * the modal's live region. A screen reader user gets "Connecting to MetaMask" and then
 * "Wallet connected" as words; duplicating that as decorative SVG would just be noise.
 *
 * Each one degrades to a still frame under reduced motion rather than disappearing, because
 * the shape itself carries the meaning — a checkmark still says "connected" whether or not
 * it was drawn on.
 */

/** Expanding rings while a connection is pending. */
export function PulseRings() {
  const motion = useMotion();

  if (motion.reduced) {
    // A static ring. Still clearly "in progress" next to the spinner text, with nothing
    // expanding or fading.
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
          initial={{ scale: 0.4, opacity: 0.55 }}
          animate={{ scale: 1.9, opacity: 0 }}
          transition={{
            duration: 1.8,
            // Evenly offset so the rings read as a steady pulse rather than a burst.
            delay: ring * 0.6,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      ))}
      <span className="pulse-core" />
    </span>
  );
}

/**
 * A checkmark that draws itself.
 *
 * Implemented with stroke-dashoffset rather than a path morph: one animated property, and
 * it degrades to a fully drawn check simply by leaving the offset at zero.
 */
export function CheckmarkDraw() {
  const motion = useMotion();

  return (
    <svg
      className="checkmark"
      viewBox="0 0 52 52"
      aria-hidden="true"
      data-testid="checkmark"
      data-animated={motion.reduced ? "false" : "true"}
    >
      <fm.circle
        cx="26"
        cy="26"
        r="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.35"
        initial={motion.reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={motion.transition("slow")}
      />
      <fm.path
        d="M15 27 L23 35 L38 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={motion.reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={
          motion.reduced ? { duration: 0 } : { duration: 0.45, delay: 0.25, ease: "easeOut" }
        }
      />
    </svg>
  );
}

const CONFETTI_COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24"];
const CONFETTI_COUNT = 14;

/**
 * A small burst on success.
 *
 * Deliberately a micro-burst: fourteen pieces, half a second, contained in the modal. A
 * full-screen cannon on every wallet connection would be exhausting by the third time, and
 * this is an action people repeat.
 *
 * Renders nothing under reduced motion. Unlike the checkmark there is no meaning here to
 * preserve — it is pure celebration, so the honest reduced form is its absence.
 */
export function ConfettiBurst() {
  const motion = useMotion();

  // Seeded once per mount so a re-render mid-flight does not reshuffle the pieces.
  const pieces = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, index) => {
        const angle = (index / CONFETTI_COUNT) * Math.PI * 2;
        const distance = 46 + Math.random() * 38;
        return {
          id: index,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          rotate: Math.random() * 320 - 160,
          color: CONFETTI_COLORS[index % CONFETTI_COLORS.length]!,
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
          className="confetti-piece"
          style={{ background: piece.color }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1, rotate: 0 }}
          animate={{
            x: piece.x,
            y: piece.y,
            opacity: 0,
            scale: 0.4,
            rotate: piece.rotate,
          }}
          transition={{ duration: 0.72, ease: "easeOut" }}
        />
      ))}
    </span>
  );
}
