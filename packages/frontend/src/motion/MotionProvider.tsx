import { createContext, useContext, useMemo, type ReactNode } from "react";

import { createMotionScheme, type MotionScheme } from "./motion";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Supplies the resolved motion scheme to the tree.
 *
 * A context rather than a hook call per component so the media query is observed once
 * instead of once per animated element — there are a lot of animated elements here, and a
 * listener on each is wasteful for a value that is identical everywhere.
 *
 * `useMotion` throws outside the provider on purpose. The alternative, quietly returning
 * an un-reduced scheme, would mean a component rendered outside the provider animates for
 * people who asked it not to — a silent failure of exactly the promise this module exists
 * to keep. Failing at the first render surfaces it immediately instead.
 */

const MotionContext = createContext<MotionScheme | null>(null);

export function MotionProvider({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const scheme = useMemo(() => createMotionScheme(reduced), [reduced]);

  return <MotionContext.Provider value={scheme}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionScheme {
  const scheme = useContext(MotionContext);

  if (!scheme) {
    throw new Error(
      "useMotion must be used inside <MotionProvider>. Without it, animations would ignore " +
        "the visitor's prefers-reduced-motion setting.",
    );
  }

  return scheme;
}
