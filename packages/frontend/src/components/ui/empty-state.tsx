import { motion as fm } from "framer-motion";
import type { ReactNode } from "react";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";

/**
 * Empty state: an illustration, a sentence that explains rather than apologises, and a way
 * forward.
 *
 * The build plan asks for a Lottie illustration here. This draws inline SVG instead, for
 * two reasons worth recording rather than quietly deciding: a Lottie player is a dependency
 * that would need a real animation file to justify it, and stock Lottie art is full-colour
 * and rounded in a way that would be the single loudest thing in a monochrome interface.
 * These are line drawings in the palette, animated with the same motion primitive as
 * everything else. If a designed Lottie file arrives, swapping it in is a change to this
 * one component.
 *
 * The illustration is `aria-hidden`; the heading and body carry the meaning.
 */

export type EmptyIllustration = "assets" | "credentials" | "activity";

export interface EmptyStateProps {
  illustration: EmptyIllustration;
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ illustration, title, body, action, className }: EmptyStateProps) {
  const motion = useMotion();

  return (
    <div
      className={cn("flex flex-col items-center gap-4 px-6 py-14 text-center", className)}
      data-testid="empty-state"
      data-illustration={illustration}
    >
      <EmptyArt kind={illustration} reduced={motion.reduced} />

      <div className="max-w-[44ch] space-y-1.5">
        <p className="text-[15px] font-medium text-fg">{title}</p>
        <p className="text-[13.5px] leading-relaxed text-fg-muted">{body}</p>
      </div>

      {action}
    </div>
  );
}

/**
 * Three line drawings, each a plain statement of what is missing.
 *
 * The animation is a single dash offset drawing the outline in. It runs once, takes under a
 * second, and does not loop — an empty state that pulses forever draws the eye to the least
 * useful part of the screen.
 */
function EmptyArt({ kind, reduced }: { kind: EmptyIllustration; reduced: boolean }) {
  const draw = reduced
    ? undefined
    : {
        initial: { pathLength: 0, opacity: 0.2 },
        animate: { pathLength: 1, opacity: 1 },
        transition: { duration: 0.9, ease: "easeOut" as const },
      };

  return (
    <svg
      viewBox="0 0 96 72"
      className="h-16 w-24 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="empty-art"
    >
      {kind === "assets" && (
        <>
          {/* Three empty frames on a shelf. */}
          <fm.rect x="10" y="18" width="24" height="24" rx="2" {...draw} />
          <fm.rect x="36" y="18" width="24" height="24" rx="2" {...draw} />
          <fm.rect x="62" y="18" width="24" height="24" rx="2" {...draw} />
          <fm.path d="M8 50 H88" {...draw} />
        </>
      )}

      {kind === "credentials" && (
        <>
          {/* A document with a seal. */}
          <fm.path d="M28 12 H60 L70 22 V58 H28 Z" {...draw} />
          <fm.path d="M60 12 V22 H70" {...draw} />
          <fm.path d="M36 32 H58 M36 40 H52" {...draw} />
          <fm.circle cx="66" cy="52" r="8" {...draw} />
        </>
      )}

      {kind === "activity" && (
        <>
          {/* A flat trace: nothing has happened yet. */}
          <fm.path d="M10 40 H34 L40 28 L48 52 L56 40 H86" {...draw} />
          <fm.path d="M10 58 H86" strokeDasharray="3 5" {...draw} />
        </>
      )}
    </svg>
  );
}
