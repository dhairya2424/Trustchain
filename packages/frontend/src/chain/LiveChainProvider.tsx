import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { env } from "@/config/env";
import { queryKeys } from "@/api/queries";

/**
 * One connection to the server's chain stream, shared by the whole application.
 *
 * A provider rather than a hook each component calls, because `EventSource` opens a real
 * connection: a hook used in five places would open five, and browsers cap concurrent
 * connections per origin at six. The dashboard alone would exhaust that and then quietly
 * stop loading anything else.
 *
 * ## What it is for
 *
 * Two things arrive on this stream, and they answer different questions.
 *
 * `transaction` follows one action the signed-in person just took, through submitted →
 * pending → confirmed or failed. This is the one that matters while someone is watching:
 * before it existed, a mint returned 202 and the interface had nothing further to say, so
 * the only honest thing it could show was "submitted" forever.
 *
 * `audit` announces a new confirmed entry in the shared trail. Rather than merging it into
 * the cache by hand — which would mean reimplementing the API's shaping, ordering and
 * pagination in the client, and getting it subtly wrong — it invalidates the query and lets
 * TanStack refetch. The stream says *when*; the API remains the single description of
 * *what*.
 *
 * ## Failure
 *
 * `EventSource` reconnects on its own, with backoff, including across sleep and network
 * changes. That is most of why it was chosen. What it cannot do is tell the difference
 * between "nothing has happened" and "this connection died and I have not noticed" — so
 * `connected` is exposed and the UI says which it is, rather than showing a quiet screen
 * that might be lying.
 */

export type TransactionStatus = "submitted" | "pending" | "confirmed" | "failed" | "dropped";

export interface LiveTransaction {
  network: string;
  transactionHash: string;
  status: TransactionStatus;
  actor: string | null;
  action: string | null;
  submittedAt: number;
  confirmedAt?: number;
  blockNumber?: number;
  detail?: string;
}

export interface LiveChain {
  /** True while the stream is open. */
  connected: boolean;
  /** Transactions this session has taken, newest state, keyed by lowercase hash. */
  transactions: Record<string, LiveTransaction>;
  /** When the server last said anything, including keep-alives. */
  lastMessageAt: number | null;
}

/**
 * Exported so a test can supply a state directly.
 *
 * The alternative is stubbing EventSource, which jsdom does not implement — the tests would
 * then be exercising a hand-written fake of the browser rather than this component's rules
 * about what it may claim, which is the part worth pinning.
 */
export const LiveChainContext = createContext<LiveChain>({
  connected: false,
  transactions: {},
  lastMessageAt: null,
});

export function useLiveChain(): LiveChain {
  return useContext(LiveChainContext);
}

/** The live state of one transaction, or undefined if this session did not submit it. */
export function useTransaction(hash: string | null | undefined): LiveTransaction | undefined {
  const { transactions } = useLiveChain();
  return hash ? transactions[hash.toLowerCase()] : undefined;
}

export function LiveChainProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [transactions, setTransactions] = useState<Record<string, LiveTransaction>>({});
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Cookies carry the session, and the API is a different origin in development, so the
    // request has to be credentialed. The server's CORS allowlist is exact-match, so this
    // cannot be turned into a wildcard by an attacker-chosen Origin.
    const source = new EventSource(`${env.VITE_PUBLIC_API_URL}/stream`, {
      withCredentials: true,
    });
    sourceRef.current = source;

    const touch = () => setLastMessageAt(Date.now());

    source.addEventListener("open", () => {
      setConnected(true);
      touch();
    });

    source.addEventListener("ready", () => {
      setConnected(true);
      touch();
    });

    source.addEventListener("transaction", (message) => {
      touch();
      try {
        const transaction = JSON.parse((message as MessageEvent<string>).data) as LiveTransaction;
        setTransactions((current) => ({
          ...current,
          [transaction.transactionHash.toLowerCase()]: transaction,
        }));

        // A confirmed transaction means the trail has changed. Refetch rather than splice:
        // the audit entry it produced has fields this message does not carry.
        if (transaction.status === "confirmed") {
          void queryClient.invalidateQueries({ queryKey: ["audit"] });
        }
      } catch {
        // A frame we cannot parse is dropped. The next one, or a refetch, recovers.
      }
    });

    source.addEventListener("audit", () => {
      touch();
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.network });
    });

    source.addEventListener("error", () => {
      // EventSource retries by itself; this only records that the link is currently down so
      // the interface can say so instead of implying silence means nothing happened.
      setConnected(false);
    });

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [queryClient]);

  const value = useMemo(
    () => ({ connected, transactions, lastMessageAt }),
    [connected, transactions, lastMessageAt],
  );

  return <LiveChainContext.Provider value={value}>{children}</LiveChainContext.Provider>;
}
