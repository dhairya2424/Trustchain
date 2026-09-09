import { motion as fm } from "framer-motion";
import { useMemo } from "react";

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
 * It is still not colour alone. The verdict word, an icon and a full sentence of
 * explanation all carry it, because "is this document genuine" is not a question to answer
 * in a hue to someone who cannot separate green from red.
 *
 * The plan asks for a particle burst on success and a glitch on failure. Both are here and
 * both are restrained: the burst is a single expanding ring plus a dozen neutral flecks,
 * and the glitch is two brief horizontal offsets rather than a sustained effect. A verdict
 * that keeps shuddering is hard to read, and this is the text a judge is trying to read.
 */

const TONE_CLASSES: Record<Verdict["tone"], string> = {
  verified: "border-verified/45 bg-verified/8 text-verified",
  fallback: "border-fallback/45 bg-fallback/8 text-fallback",
  revoked: "border-revoked/45 bg-revoked/8 text-revoked",
};

export function VerdictBanner({ verdict }: { verdict: Verdict }) {
  const motion = useMotion();
  const positive = verdict.kind === "authentic";

  const flecks = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const angle = (index / 12) * Math.PI * 2;
        return { id: index, x: Math.cos(angle) * 70, y: Math.sin(angle) * 70 };
      }),
    [],
  );

  return (
    <fm.section
      className={cn(
        "relative overflow-hidden rounded-lg border px-6 py-10 text-center",
        TONE_CLASSES[verdict.tone],
      )}
      initial={motion.reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
      animate={
        motion.reduced || positive
          ? { opacity: 1, scale: 1, x: 0 }
          : // The glitch: two quick lateral slips, then still. Long enough to register as
            // wrong, short enough that the words stay readable.
            { opacity: 1, scale: 1, x: [0, -6, 5, -2, 0] }
      }
      transition={motion.reduced ? { duration: 0 } : { duration: positive ? 0.4 : 0.34 }}
      // The verdict is the answer to the user's question, so it is announced rather than
      // left for them to notice.
      role="status"
      aria-live="polite"
      data-testid="verdict"
      data-kind={verdict.kind}
    >
      <span className="relative mx-auto mb-5 grid size-16 place-items-center">
        {positive && !motion.reduced && (
          <>
            {/* Radial pulse. One ring, once — not a loop. */}
            <fm.span
              className="absolute inset-0 rounded-full border border-verified"
              initial={{ scale: 0.7, opacity: 0.8 }}
              animate={{ scale: 2.6, opacity: 0 }}
              transition={{ duration: 1.1, ease: "easeOut" }}
            />
            {flecks.map((fleck) => (
              <fm.span
                key={fleck.id}
                className="absolute size-1 rounded-full bg-verified"
                initial={{ x: 0, y: 0, opacity: 0.9 }}
                animate={{ x: fleck.x, y: fleck.y, opacity: 0 }}
                transition={{ duration: 0.8, ease: "easeOut" }}
              />
            ))}
          </>
        )}

        <span
          className={cn(
            "grid size-16 place-items-center rounded-full border-2 text-[26px] font-semibold",
            positive ? "border-verified" : "border-current",
          )}
          aria-hidden="true"
        >
          {positive ? "✓" : "✕"}
        </span>
      </span>

      <h2 className="text-[clamp(1.9rem,6vw,3rem)] font-semibold tracking-tight">
        {verdict.title}
      </h2>

      <p className="mx-auto mt-4 max-w-[58ch] text-base leading-relaxed text-fg-muted">
        {verdict.detail}
      </p>
    </fm.section>
  );
}
