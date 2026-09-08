/**
 * Which hero renderer this device should get.
 *
 * The landing hero is the most expensive thing in the app: a few thousand particles with
 * per-frame link recomputation. On a modern laptop that is nothing; on a low-end Android
 * over a metered connection it is a hot phone, a drained battery and a stuttering page —
 * on the one screen that has to make a first impression.
 *
 * So the choice is made from declared capability rather than assumed. It is a pure function
 * over a capability snapshot precisely so it can be tested: the interesting cases (no
 * WebGL, two cores, data saver on) are all but impossible to reproduce in a real browser
 * during a test run, and a decision this consequential should not be the one piece of the
 * hero that goes unverified.
 *
 * Three tiers:
 *   webgl    — the full three.js particle network
 *   canvas2d — a lighter 2D approximation, far fewer nodes, no depth
 *   static   — a painted gradient and no animation loop at all
 */

export type RendererKind = "webgl" | "canvas2d" | "static";

export interface DeviceCapabilities {
  /** The visitor asked the system to reduce motion. Overrides everything else. */
  reducedMotion: boolean;
  /** A WebGL context could actually be created — not merely that the symbol exists. */
  webgl: boolean;
  /** navigator.hardwareConcurrency, when the browser reports it. */
  cores?: number | undefined;
  /** navigator.deviceMemory in GB, when the browser reports it. Chromium only. */
  memoryGb?: number | undefined;
  /** navigator.connection.saveData — the visitor turned on data saver. */
  saveData?: boolean | undefined;
  /** The effective connection type, e.g. "4g", "2g". */
  connection?: string | undefined;
}

/** Below these, the full particle field is not worth what it costs. */
const MIN_CORES = 4;
const MIN_MEMORY_GB = 4;
const SLOW_CONNECTIONS = new Set(["slow-2g", "2g", "3g"]);

export function selectRenderer(capabilities: DeviceCapabilities): RendererKind {
  // Checked first and unconditionally. A reduced-motion visitor gets no animation loop of
  // any kind, not a cheaper one — the preference is about motion, not about performance.
  if (capabilities.reducedMotion) return "static";

  if (!capabilities.webgl) return "canvas2d";

  // Data saver is an explicit request to spend less, so it is honoured like a preference
  // rather than weighed as a hint.
  if (capabilities.saveData) return "canvas2d";

  if (capabilities.connection && SLOW_CONNECTIONS.has(capabilities.connection)) {
    return "canvas2d";
  }

  // Undefined is not treated as failing. Safari and Firefox report neither value, and
  // penalising them for privacy-motivated omissions would downgrade a large share of
  // perfectly capable machines.
  if (capabilities.cores !== undefined && capabilities.cores < MIN_CORES) return "canvas2d";
  if (capabilities.memoryGb !== undefined && capabilities.memoryGb < MIN_MEMORY_GB) {
    return "canvas2d";
  }

  return "webgl";
}

/** True if a WebGL context can actually be created, which is stricter than feature-detecting the API. */
export function detectWebgl(): boolean {
  if (typeof document === "undefined") return false;

  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");

    if (!context) return false;

    // Release it immediately. Browsers cap the number of live WebGL contexts, and a probe
    // that leaks one can cost the real renderer its context on a page with several canvases.
    const lose = (context as WebGLRenderingContext).getExtension?.("WEBGL_lose_context");
    lose?.loseContext();

    return true;
  } catch {
    return false;
  }
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}

/** Reads what this browser will tell us. Everything is optional by design. */
export function readCapabilities(reducedMotion: boolean): DeviceCapabilities {
  if (typeof navigator === "undefined") {
    return { reducedMotion, webgl: false };
  }

  const nav = navigator as NavigatorWithHints;

  return {
    reducedMotion,
    webgl: detectWebgl(),
    cores: nav.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
    saveData: nav.connection?.saveData,
    connection: nav.connection?.effectiveType,
  };
}
