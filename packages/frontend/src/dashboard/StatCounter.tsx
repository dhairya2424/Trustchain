import { useEffect, useRef, useState } from "react";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";

/**
 * A number that counts up the first time it is scrolled into view.
 *
 * Two things this is careful about, both of the same kind: the animation must never be able
 * to hide the value.
 *
 *   - If `IntersectionObserver` is unavailable, the final value is shown immediately rather
 *     than the counter sitting at zero waiting for an observer that will never fire. A
 *     stat stuck on "0" is not a missing animation, it is wrong information — and on a
 *     dashboard about verifiable records, wrong is much worse than static.
 *   - Under reduced motion it renders the value outright.
 *
 * The visible digits are `aria-hidden` and the real figure sits in a screen-reader-only
 * span, so assistive technology reads "3 assets" once instead of announcing every
 * intermediate number as the count climbs.
 */

export interface StatCounterProps {
  value: number;
  label: string;
  /** Rendered instead of the number when the figure genuinely is not known. */
  unavailable?: string | undefined;
  className?: string;
}

const DURATION_MS = 900;

export function StatCounter({ value, label, unavailable, className }: StatCounterProps) {
  const motion = useMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(() => (motion.reduced ? value : 0));
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (motion.reduced) {
      setShown(value);
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      // No observer, no waiting. Show the truth.
      setShown(value);
      setStarted(true);
      return;
    }

    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [motion.reduced, value]);

  useEffect(() => {
    if (!started || motion.reduced) return;

    let frame = 0;
    const from = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min((now - start) / DURATION_MS, 1);
      // Ease-out cubic: fast at first, settling rather than stopping dead.
      const eased = 1 - Math.pow(1 - progress, 3);
      setShown(Math.round(from + (value - from) * eased));

      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [started, value, motion.reduced]);

  return (
    <div
      ref={ref}
      className={cn("border-l border-line pl-4", className)}
      data-testid="stat-counter"
      data-value={value}
    >
      {unavailable ? (
        <p className="text-[22px] font-semibold text-fg-faint" title={unavailable}>
          —
        </p>
      ) : (
        <p className="text-[28px] font-semibold leading-none tracking-tight tabular">
          <span aria-hidden="true">{shown}</span>
          <span className="sr-only">{value}</span>
        </p>
      )}

      <p className="mt-2 text-[12px] uppercase tracking-[0.1em] text-fg-faint">{label}</p>

      {unavailable && (
        <p className="mt-1 text-[11.5px] leading-snug text-fg-faint">{unavailable}</p>
      )}
    </div>
  );
}
