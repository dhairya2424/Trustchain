import { useEffect, useState } from "react";

import { useMotion } from "../motion/MotionProvider";

/**
 * The hero tagline, typed out a character at a time.
 *
 * Two things make this accessible rather than merely decorative:
 *
 *   - The full text is always in the DOM inside a visually-hidden span, and the animated
 *     copy is `aria-hidden`. A screen reader therefore reads the finished sentence once,
 *     instead of re-announcing a live region on every keystroke — which is what a naive
 *     typewriter does, and it is genuinely unusable.
 *   - Under reduced motion the text is simply present. Not typed faster: present.
 *
 * The caret keeps blinking via CSS, which the global reduced-motion rule already stops.
 */

export interface TypewriterProps {
  text: string;
  /** Milliseconds per character. */
  speed?: number;
  /** Milliseconds to wait before the first character. */
  startDelay?: number;
  className?: string;
}

export function Typewriter({ text, speed = 45, startDelay = 350, className }: TypewriterProps) {
  const motion = useMotion();
  const [shown, setShown] = useState(() => (motion.reduced ? text.length : 0));

  useEffect(() => {
    if (motion.reduced) {
      setShown(text.length);
      return;
    }

    setShown(0);

    let index = 0;
    let tick: ReturnType<typeof setInterval> | undefined;

    const begin = setTimeout(() => {
      tick = setInterval(() => {
        index += 1;
        setShown(index);
        if (index >= text.length && tick) clearInterval(tick);
      }, speed);
    }, startDelay);

    return () => {
      clearTimeout(begin);
      if (tick) clearInterval(tick);
    };
  }, [text, speed, startDelay, motion.reduced]);

  const done = shown >= text.length;

  return (
    <span className={className} data-testid="typewriter" data-complete={done ? "true" : "false"}>
      {/* What assistive technology reads: the whole sentence, once, never re-announced. */}
      <span className="sr-only">{text}</span>

      <span aria-hidden="true">
        {text.slice(0, shown)}
        {!done && <span className="caret" data-testid="typewriter-caret" />}
      </span>
    </span>
  );
}
