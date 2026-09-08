import { AnimatePresence, motion as fm } from "framer-motion";
import { Check, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";

/**
 * Transaction status toasts.
 *
 * A blockchain write is slow enough that a button which merely stops being disabled tells
 * the user nothing about whether anything happened. These carry a transaction from
 * "submitted" to "confirmed" or "failed", and stay on screen long enough to read.
 *
 * Two rules that matter more than the animation:
 *
 *   - **A pending toast never auto-dismisses.** It resolves when the transaction does. A
 *     toast that vanishes on a timer while the write is still in flight leaves the user
 *     believing it finished.
 *   - **A failed toast never auto-dismisses either.** An error the user did not see is an
 *     error they will hit again.
 *
 * Only success expires on its own, because it is the outcome that needs no action.
 */

export type ToastStatus = "pending" | "success" | "error";

export interface Toast {
  id: string;
  status: ToastStatus;
  title: string;
  detail?: string | undefined;
  /** Shown as a monospace line — a transaction hash, an entry id. */
  reference?: string | undefined;
}

interface ToastApi {
  /** Opens a toast and returns its id, so a caller can resolve it later. */
  push(toast: Omit<Toast, "id">): string;
  /** Moves an existing toast to its outcome. */
  resolve(id: string, next: Omit<Toast, "id" | "title"> & { title?: string }): void;
  dismiss(id: string): void;
  toasts: readonly Toast[];
}

const ToastContext = createContext<ToastApi | null>(null);

const SUCCESS_TTL_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const scheduleExpiry = useCallback(
    (id: string, status: ToastStatus) => {
      const existing = timers.current.get(id);
      if (existing) {
        clearTimeout(existing);
        timers.current.delete(id);
      }

      // Pending and error stay until something changes them or the user closes them.
      if (status !== "success") return;

      timers.current.set(
        id,
        setTimeout(() => dismiss(id), SUCCESS_TTL_MS),
      );
    },
    [dismiss],
  );

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      setToasts((current) => [...current, { ...toast, id }]);
      scheduleExpiry(id, toast.status);
      return id;
    },
    [scheduleExpiry],
  );

  const resolve = useCallback<ToastApi["resolve"]>(
    (id, next) => {
      setToasts((current) =>
        current.map((toast) =>
          toast.id === id ? { ...toast, ...next, title: next.title ?? toast.title, id } : toast,
        ),
      );
      scheduleExpiry(id, next.status);
    },
    [scheduleExpiry],
  );

  const api = useMemo<ToastApi>(
    () => ({ push, resolve, dismiss, toasts }),
    [push, resolve, dismiss, toasts],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}) {
  const motion = useMotion();

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-90 flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2"
      // Polite rather than assertive: a confirmation should not interrupt whatever the
      // screen reader is in the middle of saying.
      role="status"
      aria-live="polite"
      data-testid="toast-viewport"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <fm.div
            key={toast.id}
            layout={!motion.reduced}
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motion.reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
            transition={motion.transition("quick")}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-lg border bg-raised px-4 py-3",
              "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.8)]",
              toast.status === "success" && "border-verified/40",
              toast.status === "error" && "border-revoked/40",
              toast.status === "pending" && "border-line-strong",
            )}
            data-testid="toast"
            data-status={toast.status}
          >
            <ToastIcon status={toast.status} />

            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-fg">{toast.title}</p>
              {toast.detail && (
                <p className="mt-0.5 text-[12.5px] leading-snug text-fg-muted [overflow-wrap:anywhere]">
                  {toast.detail}
                </p>
              )}
              {toast.reference && (
                <p className="mt-1 font-mono text-[11.5px] text-fg-faint [overflow-wrap:anywhere]">
                  {toast.reference}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="grid size-6 shrink-0 place-items-center rounded text-fg-faint transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Dismiss</span>
            </button>
          </fm.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Spinner that morphs into a check.
 *
 * Same 20px box in all three states so the toast does not reflow when it resolves — the
 * text beside it would otherwise jump at the exact moment the user is reading it.
 */
function ToastIcon({ status }: { status: ToastStatus }) {
  const motion = useMotion();

  if (status === "pending") {
    return (
      <span
        className={cn(
          "mt-0.5 size-5 shrink-0 rounded-full border-2 border-line-strong border-t-fg",
          !motion.reduced && "animate-spin",
        )}
        aria-hidden="true"
        data-testid="toast-spinner"
      />
    );
  }

  if (status === "error") {
    return (
      <span
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-revoked text-revoked"
        aria-hidden="true"
      >
        <X className="size-3" />
      </span>
    );
  }

  return (
    <fm.span
      className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-verified text-verified"
      initial={motion.reduced ? false : { scale: 0.6 }}
      animate={{ scale: 1 }}
      transition={motion.transition("quick")}
      aria-hidden="true"
      data-testid="toast-check"
    >
      <Check className="size-3" />
    </fm.span>
  );
}
