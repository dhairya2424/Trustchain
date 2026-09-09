import { motion as fm } from "framer-motion";

import { useNetwork } from "@/api/queries";
import { useMotion } from "@/motion/MotionProvider";
import { Status } from "@/components/ui/status";

/**
 * What the platform actually guarantees, and how an action becomes a record.
 *
 * This panel exists because the dashboard was showing *what* happened without ever saying
 * *why any of it can be trusted*. A list of credentials looks identical whether it came
 * from a chain or from a table someone can edit; the difference is the entire product, and
 * it was nowhere on the page.
 *
 * Two rules govern what it may say:
 *
 *  1. **It describes mechanisms, not data.** Every claim here is a property of the code —
 *     the ERC-2771 forwarder, the RBAC contract, the audit trail. Nothing is derived from
 *     a record, so there is no way for this panel to invent one.
 *  2. **The verifiability claim is read live, never assumed.** "Anyone can check this
 *     independently" is true on Amoy and false on a local chain. Hardcoding the stronger
 *     sentence would be the single most misleading thing on the page, so the wording is
 *     driven by the network the API reports, and it degrades to the honest version.
 */

interface Guarantee {
  title: string;
  body: string;
}

/**
 * The mechanisms, in the order a sceptic would ask about them: who are you, what may you
 * do, who really asked, what got written down, and what is deliberately absent.
 */
const GUARANTEES: readonly Guarantee[] = [
  {
    title: "Your key never leaves your device",
    body: "Sign-in is a signature, not a password. The platform stores no credential that could be stolen from it, and never asks for the key itself — only for proof you hold it.",
  },
  {
    title: "Authority lives in a contract, not a database",
    body: "ADMIN, MANAGER, AUDITOR, USER. Roles are held on-chain and attach to a DID, so permissions cannot be edited behind the audit trail's back — changing authority is itself a recorded event.",
  },
  {
    title: "Paying for an action is not permission to take it",
    body: "A relayer submits transactions and pays the gas. The contract recovers your address from your signature and authorizes against that, so the relayer holds no power to act as you.",
  },
  {
    title: "No personal data is ever written to the chain",
    body: "Only hashes and commitments — values that prove a claim without revealing it. Asset metadata lives on IPFS; the chain stores the pointer, never the contents.",
  },
  {
    title: "Every critical action leaves an event",
    body: "Each entry names both the actor who asked and the executor who submitted. Who did it and who paid for it are different questions, and the trail answers them separately.",
  },
];

/** The path a request takes. Four steps, because the third is the one people miss. */
const FLOW: readonly { step: string; body: string }[] = [
  {
    step: "You sign",
    body: "Your wallet shows the exact typed request and you approve it. Nothing is submitted yet.",
  },
  {
    step: "The relayer submits",
    body: "A funded service forwards your signed request and pays the gas so you need no tokens.",
  },
  {
    step: "The contract checks you",
    body: "Your address is recovered from the signature and checked against on-chain roles — not the relayer's.",
  },
  {
    step: "The trail records it",
    body: "The action emits an event naming both of you. That event is what anyone later verifies against.",
  },
];

export function SystemPanel() {
  const motion = useMotion();
  const network = useNetwork();
  const active = network.data?.active;

  // Absent until the network is known: a claim about verifiability is exactly the kind of
  // thing that must not be guessed at while loading.
  const isPublic = active?.verifiability === "public";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <section aria-labelledby="how-title" className="min-w-0">
        <h3 id="how-title" className="section-label">
          How an action becomes a record
        </h3>

        <ol className="mt-4 panel divide-y divide-line">
          {FLOW.map((item, index) => (
            <fm.li
              key={item.step}
              className="flex gap-4 px-5 py-4"
              initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motion.transition("base", motion.stagger(index))}
            >
              <span aria-hidden="true" className="font-mono text-2xs text-fg-faint tabular">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{item.step}</p>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">{item.body}</p>
              </div>
            </fm.li>
          ))}
        </ol>

        {/*
         * The one place on this page where the active network changes the claim rather
         * than only the label, so it is stated in words rather than left to a badge.
         */}
        <div className="mt-4 panel px-5 py-4">
          {/*
           * Three states, not two.
           *
           * `isPublic` is false both when the chain is local and when the network is not
           * known yet, so branching on it alone asserted "Verifiable locally" before the
           * API had answered — a claim about the chain made while ignorant of it. Not-yet-
           * known is its own state and says so.
           */}
          <Status tone={!active ? "neutral" : isPublic ? "verified" : "fallback"}>
            {!active
              ? "Checking network"
              : isPublic
                ? "Independently verifiable"
                : "Verifiable locally"}
          </Status>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            {active
              ? isPublic
                ? `Records are written to ${active.label}, a public network. Anyone can read them on a block explorer without this platform's help — or its permission.`
                : `Records are written to ${active.label}. They are real and independently checkable against that chain, but it is not public, so an outside party still has to trust whoever runs it.`
              : "Waiting for the API to report which network is active."}
          </p>
        </div>
      </section>

      <section aria-labelledby="guarantees-title" className="min-w-0">
        <h3 id="guarantees-title" className="section-label">
          What makes it secure
        </h3>

        <ul className="mt-4 grid gap-3">
          {GUARANTEES.map((guarantee, index) => (
            <fm.li
              key={guarantee.title}
              className="panel px-5 py-4 transition-colors hover:border-line-strong"
              initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motion.transition("base", motion.stagger(index))}
            >
              <p className="text-sm font-semibold">{guarantee.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-fg-muted">{guarantee.body}</p>
            </fm.li>
          ))}
        </ul>
      </section>
    </div>
  );
}
