import { motion as fm } from "framer-motion";
import { useAccount } from "wagmi";

import { useMotion } from "../motion/MotionProvider";
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
    <section className="shell section" aria-labelledby="route-title">
      <fm.div
        initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motion.transition("base")}
      >
        <p className="route-phase mono">{phase}</p>
        <h1 id="route-title">{title}</h1>
        <p className="route-lead">{lead}</p>

        {requiresWallet && !isConnected && (
          <div className="glass route-gate" data-testid="wallet-gate">
            <p>
              This view is scoped to your identity, so it needs a connected wallet before it can
              show anything real.
            </p>
            <ConnectButton />
          </div>
        )}

        <div className="glass route-plan">
          <h2>Planned contents</h2>
          <ul>
            {contents.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="route-note">
            Nothing is rendered here yet because there is no real data to render. This page will
            show on-chain state or nothing at all — never a placeholder standing in for a record.
          </p>
        </div>
      </fm.div>
    </section>
  );
}
