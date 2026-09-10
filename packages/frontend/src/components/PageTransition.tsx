import { useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import { useMotion } from "@/motion/MotionProvider";

/**
 * Route transitions.
 *
 * A 12px rise and a fade over 240ms, on arrival. A page transition is the one animation a
 * user sees on *every* navigation, so anything theatrical becomes tiresome by the fourth
 * click and starts to feel like latency. Under reduced motion it is an instant swap.
 *
 * Keyed on `pathname` rather than the whole location, so a change to the query string —
 * which is how the verifier records what it just checked — does not re-mount the page and
 * throw away the result on screen.
 *
 * ## Why there is no AnimatePresence here any more
 *
 * This was `AnimatePresence mode="wait"` with a symmetrical `initial → animate → exit`, and
 * it produced a black screen: the route changed, the content was complete and correct in the
 * DOM, and the page was invisible until a reload.
 *
 * The captured state of a failing navigation named the cause exactly. The *incoming* page
 * carried `transform: translateY(-8px); opacity: 0` inline — the **exit** state, applied to
 * the element that was arriving. Under `mode="wait"` a navigation that begins while another
 * exit is still in flight makes AnimatePresence mislabel the new child as outgoing, and it
 * animates to a hidden state it will never animate back from. Two clicks in quick succession
 * is all it takes, which is an ordinary thing for a person to do; it reproduced on roughly
 * one navigation in thirty under that pattern and one in three under heavier clicking.
 *
 * Moving the entrance to CSS was not enough on its own, because the inline exit styles still
 * won. The coupling itself had to go. So the exit animation is gone and the entrance is a CSS
 * keyframe whose **resting style is the visible one** — the animation is a departure from
 * that state rather than the only route to it, so one that is skipped, interrupted or never
 * started leaves the page exactly where it belongs.
 *
 * What that costs is the outgoing fade, which nobody watches. What it removes is a class of
 * bug where the interface is blank and correct at the same time — and, incidentally, the
 * 240ms of dead time `mode="wait"` inserted before every single page appeared.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const motion = useMotion();

  return (
    /*
     * The key is what makes this animate at all: React discards the old element and mounts a
     * new one per route, so the CSS animation runs from its start each time. Nothing here
     * holds a hidden state between renders.
     */
    <div key={location.pathname} className={motion.reduced ? undefined : "page-enter"}>
      {children}
    </div>
  );
}
