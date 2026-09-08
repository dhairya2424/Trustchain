import type { ComponentProps } from "react";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder.
 *
 * The shimmer is a moving highlight across a flat block — it says "this is arriving"
 * rather than "this is empty", which matters most for IPFS images, where a gateway can
 * take seconds and a blank square reads as a broken asset.
 *
 * Under reduced motion the sweep stops and a still block remains. The block is the message;
 * the movement only makes it feel alive.
 *
 * `aria-hidden` with a `role="presentation"`: the surrounding panel owns the loading
 * announcement, and a screen reader reading out a dozen shimmering rectangles is noise.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  const motion = useMotion();

  return (
    <div
      role="presentation"
      aria-hidden="true"
      data-testid="skeleton"
      data-animated={motion.reduced ? "false" : "true"}
      className={cn(
        "relative overflow-hidden rounded bg-hover",
        !motion.reduced && "skeleton-shimmer",
        className,
      )}
      {...props}
    />
  );
}
