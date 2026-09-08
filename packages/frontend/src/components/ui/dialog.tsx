import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Dialog, on Radix.
 *
 * This replaces a hand-rolled focus trap. The hand-rolled one worked and was tested, but it
 * was reimplementing a list of things that are easy to get subtly wrong and impossible to
 * notice without a screen reader: focus containment including into and out of iframes,
 * restoring focus to the opener, `aria-hidden` on the rest of the document while open,
 * pointer and scroll locking that survives nested overlays, and Escape ordering when two
 * layers are open at once.
 *
 * Radix is also what every shadcn and 21st.dev dialog is built on, so anything pulled from
 * that catalog composes with this rather than fighting it.
 *
 * The scrim is the one place backdrop-blur survives in this design: there are two live
 * layers, and separating them is a job rather than an effect.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]",
        "dialog-overlay",
        className,
      )}
      {...props}
    />
  );
}

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Renders the built-in close control. */
  showClose?: boolean;
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        /*
         * Radix does not set this itself — it marks the rest of the document `aria-hidden`
         * instead, which is arguably stronger but is not what every screen reader looks
         * for. `aria-modal="true"` on a role="dialog" is the attribute the ARIA spec names
         * and the one assistive technology has been reading for a decade, so it is set here
         * explicitly. The two mechanisms are complementary, not alternatives.
         */
        aria-modal="true"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[420px]",
          "-translate-x-1/2 -translate-y-1/2",
          "rounded-lg border border-line-strong bg-raised p-6",
          // Real elevation: a plain dark shadow, no colour in it.
          "shadow-[0_24px_64px_-16px_rgba(0,0,0,0.8)]",
          "dialog-content",
          className,
        )}
        {...props}
      >
        {children}

        {showClose && (
          <DialogPrimitive.Close
            className={cn(
              "absolute right-4 top-4 grid size-8 place-items-center rounded",
              "text-fg-faint transition-colors hover:bg-hover hover:text-fg",
            )}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
