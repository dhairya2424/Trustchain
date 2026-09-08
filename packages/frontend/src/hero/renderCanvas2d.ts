import { computeLinks, createNodes, stepNodes, FIELD_PRESETS } from "./field";

export interface FieldHandle {
  stop(): void;
}

/**
 * The 2D fallback.
 *
 * Deliberately the same artwork as the WebGL path — same simulation, same palette, same
 * link rule — just fewer nodes, no depth-of-field and flat line widths. A visitor on a
 * low-end phone should feel they are seeing the same product, not a degraded placeholder.
 *
 * Everything here is `ctx.arc`, `ctx.moveTo` and `ctx.lineTo`. No string is ever parsed as
 * markup, so this file introduces no injection surface even though it draws to the screen.
 */
export function startCanvas2d(canvas: HTMLCanvasElement): FieldHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { stop: () => {} };

  const preset = FIELD_PRESETS.canvas2d;
  const nodes = createNodes(preset);

  let frame = 0;
  let last = 0;
  let running = true;
  let width = 0;
  let height = 0;

  const resize = () => {
    // Cap the device pixel ratio at 2. A 3x phone screen costs 2.25x the fill rate of a 2x
    // one for a difference nobody can see on a blurred particle field.
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    width = Math.max(rect.width, 1);
    height = Math.max(rect.height, 1);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  resize();

  const toScreenX = (x: number) => ((x + 1) / 2) * width;
  const toScreenY = (y: number) => ((y + 1) / 2) * height;

  const draw = (timestamp: number) => {
    if (!running) return;

    const delta = last === 0 ? 0 : (timestamp - last) / 1000;
    last = timestamp;

    stepNodes(nodes, delta);
    ctx.clearRect(0, 0, width, height);

    const links = computeLinks(nodes, preset.linkDistance, 500);

    ctx.lineWidth = 1;
    for (const link of links) {
      const a = nodes[link.a];
      const b = nodes[link.b];
      if (!a || !b) continue;

      // Neutral grey, matching the WebGL tier. Colour in this product means status.
      ctx.strokeStyle = `rgba(150, 150, 160, ${(link.strength * 0.3).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
      ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
      ctx.stroke();
    }

    for (const node of nodes) {
      // z drives the radius so the flat render still reads as having depth.
      const depth = (node.z + 1) / 2;
      ctx.fillStyle = `rgba(138, 138, 147, ${(0.28 + depth * 0.42).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(toScreenX(node.x), toScreenY(node.y), 0.8 + depth * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    frame = requestAnimationFrame(draw);
  };

  frame = requestAnimationFrame(draw);

  /*
   * A hidden tab still receives rAF in some browsers, and a phone that backgrounds the page
   * should not keep burning battery on an animation nobody is looking at.
   */
  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      last = 0;
      frame = requestAnimationFrame(draw);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("resize", resize);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("resize", resize);
    },
  };
}
