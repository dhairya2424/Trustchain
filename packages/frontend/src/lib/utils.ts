import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn `cn` helper, and the reason every component in this tree takes a `className`.
 *
 * `clsx` flattens conditionals; `twMerge` then resolves Tailwind conflicts by precedence
 * rather than by source order. Without the second half, `cn("px-4", "px-6")` emits both and
 * the winner depends on where the classes happen to sit in the compiled stylesheet — which
 * is how a component's own padding silently beats the override a caller passed in.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Shortens an address for display: 0x1234…cdef. Never used where the full value matters. */
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
