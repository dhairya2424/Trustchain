import { useNetwork } from "@/api/queries";
import { Status } from "@/components/ui/status";
import { useScrollReveal } from "@/scroll/useScrollReveal";

/**
 * What makes the platform's records trustworthy — on the page that has to make the case.
 *
 * This began on the dashboard, which was the wrong home for it. Somebody signed in and
 * looking at their own credentials has already accepted the premise; they want their
 * records, not an argument for them. The visitor who has accepted nothing is on the landing
 * page, and that is where the case belongs.
 *
 * The flow half of the original panel is gone rather than moved, because the landing page
 * already walks through what happens when you act. Saying it twice on one page would make
 * both weaker.
 *
 * Two rules still govern what this may claim:
 *
 *  1. **It describes mechanisms, not data.** Every statement is a property of the code —
 *     the ERC-2771 forwarder, the RBAC contract, the audit trail. Nothing is derived from a
 *     record, so there is no way for it to invent one.
 *  2. **The verifiability claim is read live.** "Anyone can check this independently" is
 *     true on Amoy and false on a local chain. Hardcoding the stronger sentence would be
 *     the single most misleading thing on the page.
 */

interface Guarantee {
  title: string;
  body: string;
}

/**
 * The mechanisms, in the order a sceptic asks about them: who are you, what may you do, who
 * really asked, what got written down, and what is deliberately absent.
 */
const GUARANTEES: readonly Guarantee[] = [
  {
    title: "Your key never leaves your device",
    body: "Sign-in is a signature, not a password. The platform stores no credential that could be stolen from it, and never asks for the key itself — only for proof you hold it.",
  },
  {
    title: "Authority lives in a contract, not a database",
    // The four roles are named by the pillar above. Repeating them here would be the same
    // duplication the flow section was dropped to avoid.
    body: "Roles are held on-chain and attach to a DID, so permissions cannot be edited behind the audit trail's back — changing authority is itself a recorded event, in the same ledger it governs.",
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

export function SecuritySection() {
  const network = useNetwork();
  const active = network.data?.active;

  // Reveal on scroll, matching the sections above it. `useScrollReveal` ships the markup
  // visible and lets GSAP hide and restore it, so a failed load costs the animation and
  // never the content.
  const cardsRef = useScrollReveal<HTMLUListElement>({ y: 18, childSelector: ".guarantee" });

  // Three states, not two: `isPublic` is false both when the chain is local and when the
  // network is not known yet, so branching on it alone would assert "verifiable locally"
  // before the API had answered — a claim about a chain made while ignorant of it.
  const isPublic = active?.verifiability === "public";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-12">
      <div>
        <div className="panel px-5 py-4">
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
      </div>

      <ul className="grid gap-3 sm:grid-cols-2" ref={cardsRef}>
        {GUARANTEES.map((guarantee) => (
          <li
            key={guarantee.title}
            className="guarantee panel px-5 py-4 transition-colors duration-200 hover:border-line-strong"
          >
            <p className="text-base font-semibold">{guarantee.title}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{guarantee.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
