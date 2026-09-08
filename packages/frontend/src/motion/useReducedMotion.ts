import { useEffect, useState } from "react";

/**
 * Whether this visitor has asked the system to reduce motion.
 *
 * This is the single source of truth for the whole app. It is a hook rather than a
 * module-level constant for two reasons: the setting can change while the page is open
 * (macOS and Windows both apply it live), and a module-level read would be evaluated once
 * at import time, before any test could control it.
 *
 * The reason it is centralised at all is that "respect prefers-reduced-motion" is a promise
 * that decays. Any animation added later that queries the media list itself, or worse
 * forgets to, breaks the promise silently and only for the people who need it. So every
 * animated component in this app takes its cue from here, and `motion.ts` turns the answer
 * into concrete durations so a component cannot animate without having consulted it.
 *
 * Vestibular disorders make large motion genuinely unpleasant — a particle field and a
 * scroll-driven parallax are exactly the kind of thing the setting exists for. Treating it
 * as decoration to bolt on later is how it ends up half-applied.
 */

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Reads the preference once, defensively.
 *
 * `matchMedia` is absent in some server and test environments, and rather than let that
 * throw during render we treat "cannot tell" as "no preference expressed". The safer
 * default is arguable, but reporting a preference nobody set would strip the interface for
 * everyone whose environment merely lacks the API.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    let list: MediaQueryList;
    try {
      list = window.matchMedia(REDUCED_MOTION_QUERY);
    } catch {
      return;
    }

    // Re-read on mount as well as on change: the value captured by useState ran during the
    // first render, and in a hydration or test-remount the preference may already differ.
    setReduced(list.matches);

    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);

    // Safari below 14 exposes only the deprecated addListener pair. Supporting both is two
    // lines and avoids the app throwing on an older iPad, which is exactly the class of
    // device most likely to have the setting turned on.
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    }

    list.addListener(onChange);
    return () => list.removeListener(onChange);
  }, []);

  return reduced;
}
