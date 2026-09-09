import { motion as fm } from "framer-motion";
import { Link } from "react-router-dom";

import { NetworkBadge } from "../components/NetworkBadge";
import { Button } from "@/components/ui/button";
import { GridPatternCard, GridPatternCardBody } from "@/components/ui/grid-pattern-card";
import { ParticleNetwork } from "../hero/ParticleNetwork";
import { Typewriter } from "../hero/Typewriter";
import { useMotion } from "@/motion/MotionProvider";
import { useScrollReveal } from "../scroll/useScrollReveal";
import { SecuritySection } from "@/system/SecuritySection";
import { ConnectButton } from "../wallet/ConnectButton";

/**
 * The landing page.
 *
 * The one screen where the product has to argue for itself before anyone has signed in, so
 * the three pillars below are the problem statement's own terms — identity, authority,
 * ownership — rather than a feature list.
 *
 * Laid out as a spec sheet: an index number, a rule, a claim. The restraint is the point —
 * a page about verifiable records should look like a document, not a launch announcement.
 */

const PILLARS = [
  {
    key: "identity",
    index: "01",
    title: "Decentralized Identity",
    body: "A DID anchored on-chain, bound to a wallet the holder controls. No personal data is ever written to the ledger — only commitments that prove a claim without revealing it.",
  },
  {
    key: "rbac",
    index: "02",
    title: "On-Chain RBAC",
    body: "ADMIN, MANAGER, AUDITOR, USER. Roles live in a contract, not a database, so authorization cannot be edited behind the audit trail's back — every grant and revocation is itself an event.",
  },
  {
    key: "ownership",
    index: "03",
    title: "NFT Asset Ownership",
    body: "Assets are tokens with provenance. Metadata lives on IPFS, the chain holds the pointer, and every transfer leaves a record that outlives whoever ran the system.",
  },
] as const;

const FLOW = [
  {
    n: "01",
    title: "You sign",
    body: "Your wallet signs a typed request. The key never leaves your device and the platform never asks for it.",
  },
  {
    n: "02",
    title: "The contract checks you",
    body: "Authorization is evaluated against your address recovered from that signature — not the relayer's. A relayer that submits your transaction holds no power to act as you.",
  },
  {
    n: "03",
    title: "The trail records both",
    body: "Every entry names the actor who asked and the executor who submitted. Who did it and who paid for it are different questions, and the audit trail answers both.",
  },
] as const;

const SHELL = "shell";

export function Landing() {
  const motion = useMotion();
  const pillarsRef = useScrollReveal<HTMLDivElement>({ y: 16, childSelector: ".pillar" });
  const flowRef = useScrollReveal<HTMLDivElement>({ y: 20, childSelector: ".flow-row" });

  return (
    <div className="relative">
      <ParticleNetwork />

      <section className={`${SHELL} relative flex min-h-[78vh] items-center py-20`}>
        <fm.div
          className="w-full"
          initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motion.transition("slow")}
        >
          <p className="mb-6 inline-flex items-center gap-2.5 border-l border-line-strong pl-3 eyebrow">
            Trust, made verifiable
          </p>

          <h1 className="max-w-[16ch] text-display font-semibold">TrustChain</h1>

          <p className="mt-4 min-h-[1.6em] max-w-[52ch] text-[clamp(1rem,2vw,1.3rem)] text-fg-muted">
            <Typewriter text="Identity. Authority. Ownership. On one ledger." />
          </p>

          <p className="mt-7 max-w-[58ch] text-base leading-relaxed text-fg-muted">
            A centralized IAM dashboard asks you to trust its database. TrustChain replaces that
            promise with a proof anyone can check.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <ConnectButton />
            {/* asChild keeps this a real anchor: middle-clickable, copyable, announced as a link. */}
            <Button asChild variant="outline">
              <Link to="/verify">Verify a credential</Link>
            </Button>
          </div>

          <div className="mt-10 border-t border-line pt-5">
            <NetworkBadge variant="full" />
          </div>
        </fm.div>
      </section>

      <section
        className={`${SHELL} relative py-20`}
        aria-labelledby="pillars-title"
        ref={pillarsRef}
      >
        <div className="mb-10 flex items-baseline justify-between gap-4 border-b border-line pb-6">
          <h2 id="pillars-title" className="text-title">
            Three guarantees, one ledger
          </h2>
          <span className="hidden font-mono text-xs text-fg-faint sm:inline">001 / 003</span>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {PILLARS.map((pillar) => (
            <GridPatternCard key={pillar.key} className="pillar">
              <GridPatternCardBody>
                <span className="font-mono text-xs text-fg-faint">{pillar.index}</span>
                <h3 className="mt-3 text-lg font-semibold">{pillar.title}</h3>
                <p className="mt-2.5 text-base leading-relaxed text-fg-muted">{pillar.body}</p>
              </GridPatternCardBody>
            </GridPatternCard>
          ))}
        </div>
      </section>

      <section className={`${SHELL} relative py-20`} aria-labelledby="flow-title" ref={flowRef}>
        <div className="mb-10 border-b border-line pb-6">
          <h2 id="flow-title" className="text-title">
            What happens when you act
          </h2>
        </div>

        {/*
          Rows divided by rules rather than floated as cards. Three steps in sequence are a
          list, and a list reads better as a list.
        */}
        <ol className="border-t border-line">
          {FLOW.map((step) => (
            <li
              key={step.n}
              className="flow-row grid gap-x-8 gap-y-2 border-b border-line py-7 sm:grid-cols-[auto_1fr] md:grid-cols-[auto_18rem_1fr]"
            >
              <span className="font-mono text-sm text-fg-faint" aria-hidden="true">
                {step.n}
              </span>
              <h3 className="text-base font-semibold">{step.title}</h3>
              <p className="max-w-[62ch] text-base leading-relaxed text-fg-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/*
        The case for trusting any of it, on the page where it has to be made.
        
        This lived on the dashboard, which was the wrong audience: somebody signed in and
        looking at their own credentials has already accepted the premise. The visitor who
        has accepted nothing is here.
      */}
      <section className={`${SHELL} relative py-20`} aria-labelledby="security-title">
        <div className="mb-10 border-b border-line pb-6">
          <h2 id="security-title" className="text-title">
            What makes it secure
          </h2>
          <p className="mt-3 max-w-reading text-base leading-relaxed text-fg-muted">
            Every claim below is a property of the contracts, not a promise from us. The network
            badge says which chain is answering, and therefore how much an outsider can check
            without our help.
          </p>
        </div>

        <SecuritySection />
      </section>
    </div>
  );
}
