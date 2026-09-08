import { motion as fm } from "framer-motion";
import { Link } from "react-router-dom";

import { ParticleNetwork } from "../hero/ParticleNetwork";
import { Typewriter } from "../hero/Typewriter";
import { useMotion } from "../motion/MotionProvider";
import { useScrollReveal } from "../scroll/useScrollReveal";
import { NetworkBadge } from "../components/NetworkBadge";
import { ConnectButton } from "../wallet/ConnectButton";

/**
 * The landing page.
 *
 * The one screen where the product has to argue for itself before anyone has signed in, so
 * the three pillars below are the problem statement's own terms — identity, authority,
 * ownership — rather than a feature list.
 */

const PILLARS = [
  {
    key: "identity",
    title: "Decentralized Identity",
    body: "A DID anchored on-chain, bound to a wallet the holder controls. No personal data is ever written to the ledger — only commitments that prove a claim without revealing it.",
  },
  {
    key: "rbac",
    title: "On-Chain RBAC",
    body: "ADMIN, MANAGER, AUDITOR, USER. Roles live in a contract, not a database, so authorization cannot be edited behind the audit trail's back — every grant and revocation is itself an event.",
  },
  {
    key: "ownership",
    title: "NFT Asset Ownership",
    body: "Assets are tokens with provenance. Metadata lives on IPFS, the chain holds the pointer, and every transfer leaves a record that outlives whoever ran the system.",
  },
] as const;

export function Landing() {
  const motion = useMotion();
  const pillarsRef = useScrollReveal<HTMLDivElement>({ childSelector: ".pillar" });
  const flowRef = useScrollReveal<HTMLDivElement>({ y: 34 });

  return (
    <div className="landing">
      <ParticleNetwork />

      <section className="hero shell">
        <fm.div
          initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motion.transition("slow")}
        >
          <p className="hero-eyebrow">
            <span className="hero-dot" aria-hidden="true" />
            Trust, made verifiable
          </p>

          <h1 className="hero-title">
            TrustChain
            <span className="hero-title__sub">
              <Typewriter text="Identity. Authority. Ownership. On one ledger." />
            </span>
          </h1>

          <p className="hero-lead">
            A centralized IAM dashboard asks you to trust its database. TrustChain replaces that
            promise with a proof anyone can check.
          </p>

          <div className="hero-actions">
            <ConnectButton />
            <Link className="btn btn--ghost" to="/verify">
              Verify a credential
            </Link>
          </div>

          <div className="hero-network">
            <NetworkBadge />
          </div>
        </fm.div>
      </section>

      <section className="shell section" ref={pillarsRef} aria-labelledby="pillars-title">
        <h2 id="pillars-title" className="section-title">
          Three guarantees, one ledger
        </h2>

        <div className="pillars">
          {PILLARS.map((pillar) => (
            <article key={pillar.key} className="glass pillar">
              <h3>{pillar.title}</h3>
              <p>{pillar.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="shell section" ref={flowRef} aria-labelledby="flow-title">
        <h2 id="flow-title" className="section-title">
          What happens when you act
        </h2>

        <ol className="flow">
          <li className="glass flow-step">
            <span className="flow-step__n" aria-hidden="true">
              01
            </span>
            <div>
              <h3>You sign</h3>
              <p>
                Your wallet signs a typed request. The key never leaves your device and the platform
                never asks for it.
              </p>
            </div>
          </li>
          <li className="glass flow-step">
            <span className="flow-step__n" aria-hidden="true">
              02
            </span>
            <div>
              <h3>The contract checks you</h3>
              <p>
                Authorization is evaluated against <em>your</em> address recovered from that
                signature — not the relayer's. A relayer that submits your transaction holds no
                power to act as you.
              </p>
            </div>
          </li>
          <li className="glass flow-step">
            <span className="flow-step__n" aria-hidden="true">
              03
            </span>
            <div>
              <h3>The trail records both</h3>
              <p>
                Every entry names the actor who asked and the executor who submitted. Who did it and
                who paid for it are different questions, and the audit trail answers both.
              </p>
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}
