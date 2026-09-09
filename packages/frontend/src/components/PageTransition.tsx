import { AnimatePresence, motion as fm } from "framer-motion";
import { useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import { useMotion } from "@/motion/MotionProvider";

/**
 * Route transitions.
 *
 * `mode="wait"` so the outgoing page finishes leaving before the next arrives. The
 * alternative — both mounted at once — makes two full pages overlap mid-flight, which on a
 * dashboard means two sets of queries running and a visible double scrollbar.
 *
 * Deliberately small: a 12px rise and a fade, over 240ms. A page transition is the one
 * animation a user sees on *every* navigation, so anything theatrical becomes tiresome by
 * the fourth click and starts to feel like latency. Under reduced motion it collapses to
 * an instant swap.
 *
 * Keyed on `pathname` rather than the whole location, so a change to the query string —
 * which is how the verifier records what it just checked — does not re-mount the page and
 * throw away the result on screen.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const motion = useMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <fm.div
        key={location.pathname}
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={motion.reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={motion.transition("quick")}
      >
        {children}
      </fm.div>
    </AnimatePresence>
  );
}
