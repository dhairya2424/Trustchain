import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { hardhat } from "wagmi/chains";
import { mock } from "wagmi/connectors";

import { MotionProvider } from "../motion/MotionProvider";
import { ToastProvider } from "@/components/ui/toast";
import { REDUCED_MOTION_QUERY } from "../motion/useReducedMotion";

/**
 * Test harness.
 *
 * jsdom implements no media queries at all, so `matchMedia` has to be supplied before any
 * component that reads the reduced-motion preference will render. That makes it easy to
 * accidentally test only the un-reduced path forever, which is why `setReducedMotion` is
 * mandatory-feeling: every render helper here takes the flag explicitly.
 */

interface Listener {
  (event: MediaQueryListEvent): void;
}

const listeners = new Set<Listener>();
let currentlyReduced = false;

/** Installs a controllable matchMedia. Call from beforeEach. */
export function installMatchMedia(reduced = false): void {
  currentlyReduced = reduced;
  listeners.clear();

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      media: query,
      matches: query === REDUCED_MOTION_QUERY ? currentlyReduced : false,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => false,
    }),
  });
}

/** Flips the preference and notifies subscribers, as a real browser does. */
export function setReducedMotion(reduced: boolean): void {
  currentlyReduced = reduced;
  for (const listener of listeners) {
    listener({ matches: reduced } as MediaQueryListEvent);
  }
}

/**
 * A wagmi config backed by the mock connector.
 *
 * Real connectors reach for `window.ethereum` or open a WalletConnect socket; neither
 * belongs in a unit test. The mock connector goes through the same wagmi state machine, so
 * the connect flow under test is the real one.
 */
export function createTestWagmiConfig(accounts: readonly `0x${string}`[] = []) {
  return createConfig({
    chains: [hardhat],
    connectors: [
      mock({
        accounts: (accounts.length > 0
          ? accounts
          : ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]) as unknown as readonly [
          `0x${string}`,
          ...`0x${string}`[],
        ],
      }),
    ],
    transports: { [hardhat.id]: http("http://127.0.0.1:8545") },
  });
}

export interface HarnessOptions extends Omit<RenderOptions, "wrapper"> {
  reduced?: boolean;
  route?: string;
  wagmi?: boolean;
}

export function renderWithProviders(ui: ReactElement, options: HarnessOptions = {}) {
  const { reduced = false, route = "/", wagmi = false, ...rest } = options;

  installMatchMedia(reduced);

  const config = wagmi ? createTestWagmiConfig() : null;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    /*
     * The query client is always provided; only wagmi is optional.
     *
     * Data fetching and wallets are unrelated concerns, and tying them together here meant
     * any component that reads a query but needs no wallet — the network badge, for one —
     * failed with "No QueryClient set" unless the test opted into wagmi it did not want.
     * A harness should not make a component look broken for asking a reasonable thing.
     *
     * ToastProvider sits inside MotionProvider for the same reason it does in the real
     * tree: toasts animate, so they need the resolved motion scheme.
     */
    const inner = (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <MotionProvider>
            <ToastProvider>{children}</ToastProvider>
          </MotionProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    if (!config) return inner;

    return <WagmiProvider config={config}>{inner}</WagmiProvider>;
  }

  return render(ui, { wrapper: Wrapper, ...rest });
}
