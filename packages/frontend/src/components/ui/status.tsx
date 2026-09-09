import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Status chip — the only component in the app permitted to be coloured.
 *
 * The whole palette is monochrome so that these three hues stay legible as information.
 * Green means a record is checkable by a stranger; amber means it is real but only locally;
 * red means refused or revoked. A visitor who learns those three colours here can read them
 * anywhere in the product.
 *
 * Colour is never the only carrier. Each chip has a dot *and* text, because roughly one in
 * twelve men cannot reliably separate the green from the amber, and "is this record
 * publicly verifiable" is not a question to answer with hue alone.
 */

const statusVariants = cva(
  cn(
    "inline-flex items-center gap-2 rounded-full border px-2.5 py-1",
    "text-2xs font-medium uppercase tracking-label whitespace-nowrap",
  ),
  {
    variants: {
      tone: {
        verified: "border-verified/35 bg-verified/8 text-verified",
        fallback: "border-fallback/35 bg-fallback/8 text-fallback",
        revoked: "border-revoked/35 bg-revoked/8 text-revoked",
        // For "still checking" and other genuinely neutral states. Reaching for a colour
        // here would be exactly the decorative use this system exists to prevent.
        neutral: "border-line-strong bg-hover text-fg-muted",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface StatusProps extends ComponentProps<"span">, VariantProps<typeof statusVariants> {
  children: ReactNode;
  /** Hides the dot where the chip already sits beside another indicator. */
  dot?: boolean;
}

const DOT_TONE: Record<string, string> = {
  verified: "bg-verified",
  fallback: "bg-fallback",
  revoked: "bg-revoked",
  neutral: "bg-fg-faint",
};

export function Status({ className, tone, dot = true, children, ...props }: StatusProps) {
  return (
    <span className={cn(statusVariants({ tone }), className)} {...props}>
      {dot && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[tone ?? "neutral"])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
