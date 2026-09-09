import type { ReactNode } from "react";

import { LiveChainContext, type LiveChain } from "./LiveChainProvider";

/**
 * Supplies live-chain state directly, for tests.
 *
 * `EventSource` does not exist in jsdom, so the real provider cannot run there. Stubbing it
 * would mean testing a hand-written imitation of the browser instead of the rules that
 * matter — when a transaction may be called confirmed, and when a link may be offered.
 */
export function LiveChainContextForTests({
  value,
  children,
}: {
  value: LiveChain;
  children: ReactNode;
}) {
  return <LiveChainContext.Provider value={value}>{children}</LiveChainContext.Provider>;
}
