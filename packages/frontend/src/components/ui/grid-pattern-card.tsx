import { motion as fm, type HTMLMotionProps } from "framer-motion";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A bordered card over a fine square grid.
 *
 * Adapted from "Card with Grid Pattern" by @Ali-Hussein-dev on 21st.dev
 * (https://21st.dev/Ali-Hussein-dev/card-with-grid-pattern). Two changes were necessary
 * rather than cosmetic:
 *
 *  1. **The entrance animation is gone.** The original hardcodes a Framer tween that runs
 *     unconditionally — it would animate at visitors who asked the system not to, breaking
 *     the promise src/motion/ exists to keep. Routing it through `useMotion()` would have
 *     fixed that, but a `whileInView` variant carries a worse hazard: it starts the card at
 *     `opacity: 0` and depends on an IntersectionObserver firing to bring it back, so
 *     anywhere that observer is missing or never fires, the content is simply invisible.
 *     Reveal is therefore left to `useScrollReveal`, the one mechanism in this codebase
 *     that handles it safely, and this component is purely presentational.
 *  2. **The palette is ours.** The original is zinc-based with a light/dark pair; this uses
 *     the product's surface tokens so the card sits in the same monochrome system as
 *     everything else.
 *
 * The overlay is kept, and it is worth being precise about why it is not a decorative
 * gradient: it fades the grid out beneath the text, so the pattern reads at the card's edge
 * and never competes with a paragraph. It is one colour at varying alpha — a legibility
 * scrim doing a job, not two hues blended for effect.
 */

/*
 * Extends framer's own div props rather than React's.
 *
 * `ComponentProps<"div">` looks equivalent but is not: framer redefines onDrag and the
 * other pointer callbacks with its own PanInfo signatures, so spreading React's version
 * onto a motion component is a type error — and worse, would silently hand framer a handler
 * shaped for a different event.
 */
export interface GridPatternCardProps extends HTMLMotionProps<"div"> {
  children: ReactNode;
  className?: string;
}

export function GridPatternCard({ children, className, ...props }: GridPatternCardProps) {
  return (
    <fm.div
      className={cn(
        "w-full overflow-hidden rounded-lg border border-line bg-surface",
        "transition-colors duration-200 hover:border-line-strong",
        className,
      )}
      {...props}
    >
      <div
        className="size-full"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--color-line) 1px, transparent 1px)," +
            "linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
          backgroundSize: "38px 38px",
        }}
      >
        {/* Legibility scrim: one colour, varying alpha, so text never sits on a rule. */}
        <div className="size-full bg-linear-to-tr from-surface via-surface/85 to-surface">
          {children}
        </div>
      </div>
    </fm.div>
  );
}

export function GridPatternCardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-6", className)} {...props} />;
}
