import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { MotionProvider } from "../motion/MotionProvider";
import { ToastProvider } from "@/components/ui/toast";
import { buildWagmiConfig } from "../wallet/config";

/**
 * Everything the tree needs, in the order it needs it.
 *
 * The config and the query client are built inside `useState` initialisers rather than at
 * module scope. At module scope they would be constructed at import time — before any test
 * could substitute them, and once per module graph in a way that survives between tests and
 * leaks connection state from one to the next.
 *
 * MotionProvider is outermost because the reduced-motion preference is not specific to
 * wallets or data, and a component anywhere below must be able to ask for it.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [config] = useState(buildWagmiConfig);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain reads are not free and rarely change between renders.
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <MotionProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </MotionProvider>
  );
}
