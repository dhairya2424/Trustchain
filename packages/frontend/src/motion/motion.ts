import type { Transition, Variants } from "framer-motion";

/**
 * Motion tokens, and the one function that applies the reduced-motion preference.
 *
 * The shape here is deliberate: components do not receive a boolean and decide what to do
 * with it, they receive an already-resolved `MotionScheme`. That means the decision is made
 * in exactly one place, and a component that forgets to handle the preference cannot —
 * there is no un-resolved duration for it to reach for.
 *
 * Reduced motion is implemented as "instant, not absent". Every transition collapses to a
 * zero-length one, so elements still arrive in their final state and the interface still
 * tells the user what changed; nothing slides, pulses, drifts or parallaxes. Removing the
 * animation entirely would also remove the state change it communicates, which is a
 * different and worse failure.
 */

/** Durations in seconds, matching framer-motion's unit. */
export const DURATION = {
  instant: 0.12,
  quick: 0.24,
  base: 0.4,
  slow: 0.7,
  scene: 1.2,
} as const;

/**
 * A single custom easing used across the app.
 *
 * Slightly overshooting on entry reads as physical rather than mechanical, which is the
 * whole difference between "a dashboard" and "a command deck".
 */
export const EASE = [0.22, 1, 0.36, 1] as const;
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export interface MotionScheme {
  /** True when the visitor asked for reduced motion. */
  readonly reduced: boolean;
  /** Seconds. Zero under reduced motion. */
  duration(of: keyof typeof DURATION): number;
  /** A framer-motion transition, already collapsed if required. */
  transition(of?: keyof typeof DURATION, delay?: number): Transition;
  /**
   * Stagger delay for the nth item in a list. Zero under reduced motion, so a staggered
   * list appears at once rather than marching in.
   */
  stagger(index: number, step?: number): number;
  /** Collapses a variant pair so `animate` still runs but takes no time. */
  variants(full: Variants): Variants;
}

const ZERO_TRANSITION: Transition = { duration: 0 };

export function createMotionScheme(reduced: boolean): MotionScheme {
  return {
    reduced,

    duration(of) {
      return reduced ? 0 : DURATION[of];
    },

    transition(of = "base", delay = 0) {
      if (reduced) return ZERO_TRANSITION;
      return { duration: DURATION[of], ease: EASE, ...(delay ? { delay } : {}) };
    },

    stagger(index, step = 0.06) {
      return reduced ? 0 : index * step;
    },

    variants(full) {
      if (!reduced) return full;

      // Keep the same variant names and the same final values, and strip only the
      // travel: no offsets, no scale, no rotation, no duration. A component written
      // against these variants therefore needs no reduced-motion branch of its own.
      const flattened: Variants = {};
      for (const [name, value] of Object.entries(full)) {
        if (typeof value !== "object" || value === null) {
          flattened[name] = value;
          continue;
        }

        const { x, y, scale, rotate, rotateX, rotateY, transition, ...rest } = value as Record<
          string,
          unknown
        >;
        void x;
        void y;
        void scale;
        void rotate;
        void rotateX;
        void rotateY;
        void transition;

        flattened[name] = { ...rest, transition: ZERO_TRANSITION };
      }
      return flattened;
    },
  };
}
