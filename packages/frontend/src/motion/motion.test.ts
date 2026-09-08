import { describe, expect, it } from "vitest";

import { createMotionScheme, DURATION } from "./motion";

/**
 * The reduced-motion contract, tested at the one place it is decided.
 *
 * Every animated component in the app takes its durations from a scheme, so if the scheme
 * collapses correctly under the preference, no component can animate against it. That makes
 * these the load-bearing tests for the accessibility promise rather than a formality.
 */

describe("createMotionScheme — normal motion", () => {
  const scheme = createMotionScheme(false);

  it("reports the real durations", () => {
    expect(scheme.duration("base")).toBe(DURATION.base);
    expect(scheme.duration("slow")).toBe(DURATION.slow);
  });

  it("builds a transition with an easing curve", () => {
    const transition = scheme.transition("quick") as { duration: number; ease: unknown };
    expect(transition.duration).toBe(DURATION.quick);
    expect(transition.ease).toBeDefined();
  });

  it("staggers a list so items arrive in sequence", () => {
    expect(scheme.stagger(0)).toBe(0);
    expect(scheme.stagger(3, 0.1)).toBeCloseTo(0.3);
  });

  it("leaves variants untouched, travel included", () => {
    const variants = { hidden: { opacity: 0, y: 20 }, shown: { opacity: 1, y: 0 } };
    expect(scheme.variants(variants)).toEqual(variants);
  });
});

describe("createMotionScheme — reduced motion", () => {
  const scheme = createMotionScheme(true);

  it("reports the preference so a component can branch when it must", () => {
    expect(scheme.reduced).toBe(true);
  });

  it("collapses every duration to zero", () => {
    for (const name of Object.keys(DURATION) as (keyof typeof DURATION)[]) {
      expect(scheme.duration(name)).toBe(0);
    }
  });

  it("collapses transitions, including ones asking for a delay", () => {
    expect(scheme.transition("scene", 0.8)).toEqual({ duration: 0 });
  });

  it("removes the stagger, so a list appears at once instead of marching in", () => {
    expect(scheme.stagger(7, 0.2)).toBe(0);
  });

  it("strips travel from variants but keeps the final opacity", () => {
    // The important half: `shown` must still reach opacity 1, or reduced motion would mean
    // invisible content rather than still content.
    const flattened = scheme.variants({
      hidden: { opacity: 0, y: 40, scale: 0.8 },
      shown: { opacity: 1, y: 0, scale: 1 },
    });

    expect(flattened.shown).toMatchObject({ opacity: 1 });
    expect(flattened.hidden).toMatchObject({ opacity: 0 });
  });

  it("leaves no positional or scale keys anywhere in the flattened variants", () => {
    const flattened = scheme.variants({
      a: { opacity: 1, x: 10, y: 20, scale: 2, rotate: 45, rotateX: 10, rotateY: 5 },
    });

    for (const key of ["x", "y", "scale", "rotate", "rotateX", "rotateY"]) {
      expect(flattened.a).not.toHaveProperty(key);
    }
  });

  it("gives every flattened variant a zero-length transition", () => {
    const flattened = scheme.variants({
      a: { opacity: 1, transition: { duration: 3, ease: "linear" } },
    });

    expect(flattened.a).toMatchObject({ transition: { duration: 0 } });
  });

  it("passes non-object variant values through untouched", () => {
    // Framer accepts a variant expressed as a function; flattening must not corrupt it.
    const fn = () => ({ opacity: 1 });
    expect(createMotionScheme(true).variants({ a: fn }).a).toBe(fn);
  });
});
