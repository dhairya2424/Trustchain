import { motion as fm } from "framer-motion";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";
import type { TimelineNode } from "./verdict";

/**
 * The credential's provenance, built node by node with the connecting line drawing itself.
 *
 * Every node is a fact the API returned — issued, signature checked, expires, revoked — and
 * nothing is inferred to pad the sequence. The build plan describes a
 * "mint → transfers → current owner" chain; that shape belongs to assets, and the asset
 * event indexer does not exist yet, so inventing transfer nodes here would be fabricating
 * provenance on the one screen whose entire purpose is proving provenance. The timeline is
 * short because the truthful version is short.
 *
 * The connector is an SVG line animated by `pathLength`, which is what makes it *draw*
 * rather than fade. Each node waits for the line reaching it, so the sequence reads as the
 * verifier working through the record rather than a list appearing at once.
 */

const TONE_RING: Record<TimelineNode["tone"], string> = {
  verified: "border-verified text-verified",
  fallback: "border-fallback text-fallback",
  revoked: "border-revoked text-revoked",
  neutral: "border-line-strong text-fg-faint",
};

const TONE_LINE: Record<TimelineNode["tone"], string> = {
  verified: "text-verified",
  fallback: "text-fallback",
  revoked: "text-revoked",
  neutral: "text-line-strong",
};

const NODE_SPACING = 92;
const STEP_SECONDS = 0.42;

export function ProvenanceTimeline({ nodes }: { nodes: TimelineNode[] }) {
  const motion = useMotion();

  if (nodes.length === 0) {
    return (
      <p className="text-[13px] text-fg-faint" data-testid="timeline-empty">
        The chain returned no dated events for this credential.
      </p>
    );
  }

  const height = (nodes.length - 1) * NODE_SPACING + 24;

  return (
    <div className="relative" data-testid="provenance-timeline">
      {/*
        The connector, drawn as one continuous stroke behind the nodes. Absolutely
        positioned so the node list owns the layout and the line simply follows it.
      */}
      <svg
        className="pointer-events-none absolute left-[11px] top-3 w-6"
        height={height}
        viewBox={`0 0 2 ${height}`}
        preserveAspectRatio="none"
        fill="none"
        aria-hidden="true"
      >
        <fm.line
          x1="1"
          y1="0"
          x2="1"
          y2={height}
          stroke="currentColor"
          strokeWidth="1"
          className="text-line-strong"
          initial={motion.reduced ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={
            motion.reduced
              ? { duration: 0 }
              : { duration: STEP_SECONDS * nodes.length, ease: "easeInOut" }
          }
        />
      </svg>

      <ol className="relative space-y-0">
        {nodes.map((node, index) => (
          <fm.li
            key={node.id}
            className="flex gap-4 pb-8 last:pb-0"
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            // Each node waits for the drawing line to reach it.
            transition={motion.transition("quick", motion.stagger(index, STEP_SECONDS))}
            data-testid="timeline-node"
            data-tone={node.tone}
          >
            <span
              className={cn(
                "relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border bg-base",
                TONE_RING[node.tone],
              )}
            >
              <span className={cn("size-1.5 rounded-full bg-current", TONE_LINE[node.tone])} />
            </span>

            <div className="min-w-0 pt-0.5">
              <p className="text-[13.5px] font-medium text-fg">{node.label}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
                {node.value}
              </p>
              {node.at && (
                <time
                  className="mt-1 block font-mono text-[11.5px] tabular text-fg-faint"
                  dateTime={node.at}
                >
                  {new Date(node.at).toISOString().replace("T", " ").slice(0, 19)} UTC
                </time>
              )}
            </div>
          </fm.li>
        ))}
      </ol>
    </div>
  );
}
