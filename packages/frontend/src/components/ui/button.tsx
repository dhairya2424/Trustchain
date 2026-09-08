import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Button.
 *
 * The shadcn shape — cva variants, `asChild` via Radix Slot — with the palette rules of
 * this product rather than the shadcn defaults.
 *
 * No gradients and no coloured shadow. `primary` is a solid near-white fill on the dark
 * ground, which on a monochrome interface is the loudest thing available and needs no help
 * from a hue. That keeps green, amber and red free to mean verified, fallback and revoked
 * wherever they appear.
 *
 * `asChild` matters more than it looks: it lets a react-router `<Link>` wear button styling
 * while staying an anchor, so "Verify a credential" is still a real link — middle-clickable,
 * copyable, and announced as a link rather than a button.
 */
const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium",
    "rounded-[--radius] transition-colors duration-150",
    "disabled:pointer-events-none disabled:opacity-45",
    // 44px is the smallest reliably tappable target; below it, thumbs miss.
    "min-h-11",
  ),
  {
    variants: {
      variant: {
        primary: "bg-fg text-base hover:bg-fg/88 active:bg-fg/80",
        outline: "border border-line-strong text-fg hover:bg-hover hover:border-fg-faint",
        ghost: "text-fg-muted hover:text-fg hover:bg-hover",
        danger: "border border-revoked/45 text-revoked hover:bg-revoked/10",
      },
      size: {
        sm: "h-9 min-h-9 px-3 text-[13px]",
        md: "px-4 text-[14px]",
        lg: "px-6 text-[15px]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
