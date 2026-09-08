import { useEffect, useRef, useState } from "react";

import { useMotion } from "../motion/MotionProvider";
import { readCapabilities, selectRenderer, type RendererKind } from "./selectRenderer";
import { startCanvas2d, type FieldHandle } from "./renderCanvas2d";

/**
 * The animated chain-link particle field behind the landing page.
 *
 * Three tiers, chosen by `selectRenderer`: three.js, a 2D canvas, or a painted gradient
 * with no animation loop at all. The static tier is what a reduced-motion visitor gets, and
 * it is a real design rather than an empty box — the page should not look broken because
 * someone turned on an accessibility setting.
 *
 * Marked `aria-hidden` throughout. It is decoration with no information in it, and a screen
 * reader announcing a canvas would be noise; everything the hero actually says is in the
 * text beside it.
 */
export function ParticleNetwork() {
  const motion = useMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [kind, setKind] = useState<RendererKind | null>(null);

  useEffect(() => {
    // Recomputed whenever the preference changes, so turning reduced motion on stops the
    // loop immediately rather than at the next full page load.
    setKind(selectRenderer(readCapabilities(motion.reduced)));
  }, [motion.reduced]);

  useEffect(() => {
    if (kind === null || kind === "static") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    let handle: FieldHandle | null = null;
    let cancelled = false;

    const run = async () => {
      if (kind === "canvas2d") {
        handle = startCanvas2d(canvas);
        return;
      }

      try {
        const { startWebgl } = await import("./renderWebgl");
        // The import is awaited, so the component may have unmounted or the preference may
        // have changed in the meantime. Starting a renderer for a canvas nobody is looking
        // at leaks a WebGL context.
        if (cancelled) return;
        handle = await startWebgl(canvas);
        if (cancelled) handle.stop();
      } catch {
        // A driver can refuse a context even when the probe succeeded — a blocklisted GPU,
        // or too many live contexts on the page. Falling back is better than a blank hero.
        if (!cancelled) handle = startCanvas2d(canvas);
      }
    };

    void run();

    return () => {
      cancelled = true;
      handle?.stop();
    };
  }, [kind]);

  if (kind === "static") {
    return (
      <div className="hero-field hero-field--static" aria-hidden="true" data-renderer="static" />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="hero-field"
      aria-hidden="true"
      data-renderer={kind ?? "pending"}
    />
  );
}
