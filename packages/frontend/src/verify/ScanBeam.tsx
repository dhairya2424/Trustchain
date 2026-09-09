import { motion as fm } from "framer-motion";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";

/**
 * A scanning beam that sweeps the card while verification is in flight.
 *
 * This is honest theatre, and the distinction matters: the sweep runs for exactly as long
 * as the request does, and stops when it resolves. It is a progress indicator wearing a
 * costume, not an animation on a timer pretending work is happening. A fixed-duration
 * "scanning…" that finishes before the answer arrives — or keeps going after — would be
 * telling the viewer something false about the system's state.
 *
 * A thin line and a faint gradient trail, not a glowing bar. Under reduced motion it
 * becomes a static horizontal rule and the surrounding text carries the state.
 */
export function ScanBeam({ active, className }: { active: boolean; className?: string }) {
  const motion = useMotion();

  if (!active) return null;

  return (
    <span
      className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-lg", className)}
      aria-hidden="true"
      data-testid="scan-beam"
      data-animated={motion.reduced ? "false" : "true"}
    >
      {motion.reduced ? (
        <span className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
      ) : (
        <fm.span
          className="absolute inset-x-0 h-24"
          style={{
            background:
              "linear-gradient(to bottom, transparent, rgb(255 255 255 / 5%) 45%, rgb(255 255 255 / 9%) 50%, rgb(255 255 255 / 5%) 55%, transparent)",
          }}
          initial={{ top: "-6rem" }}
          animate={{ top: "100%" }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
        />
      )}

      {/* Corner brackets: the frame of an instrument looking at something. */}
      {[
        "left-0 top-0 border-l border-t",
        "right-0 top-0 border-r border-t",
        "left-0 bottom-0 border-l border-b",
        "right-0 bottom-0 border-r border-b",
      ].map((corner) => (
        <span key={corner} className={cn("absolute size-4 border-fg-faint", corner)} />
      ))}
    </span>
  );
}
