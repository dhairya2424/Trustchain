import { motion as fm } from "framer-motion";
import { useAccount } from "wagmi";

import { useMotion } from "@/motion/MotionProvider";
import { ConnectButton } from "../wallet/ConnectButton";

/**
 * The shell for a route whose contents arrive in a later phase.
 *
 * These are deliberately empty of invented data. A placeholder dashboard showing plausible
 * asset counts and audit rows would demo well and be a lie — and on a platform whose entire
 * claim is that its records are verifiable, mocked-up records are the worst possible
 * placeholder. So each route states what it will hold and what it is waiting on.
 */

export interface PlaceholderProps {
  title: string;
  lead: string;
  /** What this route will contain once its phase lands. */
  contents: readonly string[];
  /** Whether the route is meaningless without a connected wallet. */
  requiresWallet?: boolean;
  phase: string;
}

export function Placeholder({
  title,
  lead,
  contents,
  requiresWallet = false,
  phase,
}: PlaceholderProps) {
  const motion = useMotion();
  const { isConnected } = useAccount();

  return (
    <section
      className="mx-auto w-full max-w-[1200px] px-4 py-16 sm:px-6"
      aria-labelledby="route-title"
    >
      <fm.div
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motion.transition("base")}
      >
        <div className="border-b border-line pb-6">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-fg-faint">{phase}</p>
          <h1 id="route-title" className="mt-2 text-title">
            {title}
          </h1>
          <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-fg-muted">{lead}</p>
        </div>

        {requiresWallet && !isConnected && (
          <div
            className="mt-6 flex flex-wrap items-center justify-between gap-5 rounded-lg border border-line-strong bg-surface px-6 py-5"
            data-testid="wallet-gate"
          >
            <p className="max-w-[52ch] text-[14px] text-fg-muted">
              This view is scoped to your identity, so it needs a connected wallet before it can
              show anything real.
            </p>
            <ConnectButton />
          </div>
        )}

        <div className="mt-6 rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-6 py-4 text-[13px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
            Planned contents
          </h2>

          <ul>
            {contents.map((item, index) => (
              <li
                key={item}
                className="flex gap-5 border-b border-line px-6 py-4 text-[14px] leading-relaxed text-fg-muted last:border-b-0"
              >
                <span className="font-mono text-[12px] text-fg-faint tabular" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="max-w-[74ch]">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-5 max-w-[70ch] border-l-2 border-line-strong pl-4 text-[13px] leading-relaxed text-fg-faint">
          Nothing is rendered here yet because there is no real data to render. This page will show
          on-chain state or nothing at all — never a placeholder standing in for a record.
        </p>
      </fm.div>
    </section>
  );
}
