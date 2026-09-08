import { useEffect, useRef } from "react";

import { useMotion } from "../motion/MotionProvider";

/**
 * Scroll-driven section reveals, via GSAP ScrollTrigger.
 *
 * The failure mode this is written around: a reveal animation normally starts its target at
 * `opacity: 0` and animates to 1. If the animation never runs — reduced motion, a GSAP load
 * failure, ScrollTrigger not firing because an ancestor scrolls instead of the window — the
 * content stays invisible. The page then has no content for exactly the visitors least able
 * to work out why.
 *
 * So the rule here is that the hidden state is only ever applied by the same code that has
 * already committed to animating it back. Markup ships visible; GSAP hides and reveals.
 * Under reduced motion this hook does nothing at all, which leaves everything on screen.
 *
 * GSAP is imported dynamically for the same reason three.js is: a reduced-motion visitor
 * should not download an animation engine in order to not animate.
 */

export interface ScrollRevealOptions {
  /** Distance in px the element travels up as it reveals. */
  y?: number;
  /** Seconds between children when the target has several. */
  stagger?: number;
  /** Selector for children to reveal individually. Reveals the container itself if unset. */
  childSelector?: string;
}

export function useScrollReveal<T extends HTMLElement>(options: ScrollRevealOptions = {}) {
  const ref = useRef<T | null>(null);
  const motion = useMotion();
  const { y = 28, stagger = 0.09, childSelector } = options;

  useEffect(() => {
    // The whole point: no hiding, no loading, nothing to undo.
    if (motion.reduced) return;

    const element = ref.current;
    if (!element) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const run = async () => {
      let gsap: typeof import("gsap").gsap;
      let ScrollTrigger: typeof import("gsap/ScrollTrigger").ScrollTrigger;

      try {
        const core = await import("gsap");
        const plugin = await import("gsap/ScrollTrigger");
        gsap = core.gsap;
        ScrollTrigger = plugin.ScrollTrigger;
        gsap.registerPlugin(ScrollTrigger);
      } catch {
        // Content is already visible, so a failed load costs the animation and nothing else.
        return;
      }

      if (cancelled) return;

      const targets: Element[] = childSelector
        ? Array.from(element.querySelectorAll(childSelector))
        : [element];

      if (targets.length === 0) return;

      const tween = gsap.fromTo(
        targets,
        { opacity: 0, y },
        {
          opacity: 1,
          y: 0,
          duration: 0.75,
          ease: "power3.out",
          stagger,
          scrollTrigger: {
            trigger: element,
            // Fires when the element is 85% of the way down the viewport: far enough in to
            // feel deliberate, early enough that a fast scroller never sees a blank block.
            start: "top 85%",
            // Plays once. Re-running on every pass turns a scroll back up into a flicker.
            once: true,
          },
        },
      );

      cleanup = () => {
        tween.scrollTrigger?.kill();
        tween.kill();
        // Whatever happened, leave the DOM in the visible state rather than mid-tween.
        gsap.set(targets, { clearProps: "opacity,transform" });
      };
    };

    void run();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [motion.reduced, y, stagger, childSelector]);

  return ref;
}
