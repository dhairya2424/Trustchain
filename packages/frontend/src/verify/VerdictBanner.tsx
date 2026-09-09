import { motion as fm } from "framer-motion";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";
import type { Verdict } from "./verdict";

/**
 * The finale: the verdict, at the size of the claim it is making.
 *
 * Colour is doing real work here rather than decorating — this is the one screen the whole
 * status palette exists for. Green means a stranger checked it and it holds; red means it
 * does not. So the banner is allowed to be the loudest thing in the product.
 *
 * It is still not colour alone. The verdict word, a drawn mark and a full sentence of
 * explanation all carry it, because "is this document genuine" is not a question to answer
 * in a hue to someone who cannot separate green from red.
 *
 * ## Why this is the one authored moment
 *
 * Everything else in this app enters the same way — a short fade and rise, in twenty-odd
 * places. That is fine for panels arriving and useless for emphasis: when every section
 * moves identically, nothing reads as important. So the motion budget is spent here, on the
 * single instant the product exists to deliver, and the gesture is deliberately unlike any
 * other in the interface.
 *
 * The idea is drawn from what verification *is*: a mark struck against a ledger, and then
 * certainty. So the seal is **drawn** rather than popped — the ring traces, the mark
 * follows it — and the verdict word arrives under a **wipe**, as if pressed. A burst of
 * particles was the previous answer; it read as celebration, which is the wrong emotion for
 * a result that is just as often negative.
 *
 * Failure is not the same gesture in red. Its ring traces and **stops short of closing**,
 * and the gap is the message: the circuit did not complete. That replaced a lateral shudder,
 * which said only "something is wrong with the page" and made the words harder to read at
 * the moment somebody is trying hardest to read them.
 *
 * Under reduced motion every element is already in its final state. Reduced means instant,
 * not absent — the mark, the colour and the words all still arrive.
 */

const TONE_CLASSES: Record<Verdict["tone"], string> = {
  verified: "border-verified/45 bg-verified/8 text-verified",
  fallback: "border-fallback/45 bg-fallback/8 text-fallback",
  revoked: "border-revoked/45 bg-revoked/8 text-revoked",
};

/** Exponential ease-out: fast commitment, quiet settle. Confident, never bouncy. */
const SETTLE = [0.16, 1, 0.3, 1] as const;

export function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const motion = useMotion();
  const positive = verdict.kind === "authentic";
  const still = motion.reduced;

  // A ring that stops short of closing is the failure state's whole argument, so the value
  // is named rather than left as a number inside the markup.
  const ringLength = positive ? 1 : 0.82;

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-lg border px-6 py-10 text-center",
        TONE_CLASSES[verdict.tone],
      )}
      // The verdict is the answer to the user's question, so it is announced rather than
      // left for them to notice.
      role="status"
      aria-live="polite"
      data-testid="verdict"
      data-kind={verdict.kind}
    >
      {/*
        The seal, drawn.

        One SVG, two paths, no particles. Stroke geometry is the only place in this app that
        animates this way, which is what makes the moment legible as the important one.
      */}
      <svg
        className="mx-auto mb-6 size-16"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        data-testid="verdict-seal"
        data-animated={still ? "false" : "true"}
      >
        <fm.circle
          cx="32"
          cy="32"
          r="29"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          // Starts at the top and traces clockwise, so the gap on a failed verdict closes
          // last and sits where the eye finishes.
          transform="rotate(-90 32 32)"
          initial={still ? false : { pathLength: 0 }}
          animate={{ pathLength: ringLength }}
          transition={still ? { duration: 0 } : { duration: 0.52, ease: SETTLE }}
        />

        <fm.path
          d={positive ? "M20 33.5 L28.5 42 L45 24" : "M23 23 L41 41 M41 23 L23 41"}
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={still ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          // Begins as the ring is finishing, so the two read as one movement rather than a
          // sequence of two animations.
          transition={still ? { duration: 0 } : { duration: 0.28, ease: SETTLE, delay: 0.34 }}
        />
      </svg>

      {/*
        The word, wiped in.

        clip-path rather than a fade: a fade is the app's ambient gesture, and this line is
        the answer the whole page exists to give. `inset` keeps the text in normal flow, so
        nothing reflows and the measurement stays stable for the layout-shift test.
      */}
      <fm.h2
        className="text-[clamp(1.9rem,6vw,3rem)] font-semibold tracking-tight"
        initial={still ? false : { clipPath: "inset(0 100% 0 0)" }}
        animate={{ clipPath: "inset(0 0% 0 0)" }}
        transition={still ? { duration: 0 } : { duration: 0.44, ease: SETTLE, delay: 0.18 }}
      >
        {verdict.title}
      </fm.h2>

      <fm.p
        className="mx-auto mt-4 max-w-[58ch] text-base leading-relaxed text-fg-muted"
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        // The explanation follows the word it explains. Opacity only — the sentence must not
        // move while somebody is starting to read it.
        transition={still ? { duration: 0 } : { duration: 0.3, delay: 0.4 }}
      >
        {verdict.detail}
      </fm.p>
    </section>
  );
}
