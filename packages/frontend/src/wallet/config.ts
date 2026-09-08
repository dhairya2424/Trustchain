import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { polygonAmoy, hardhat } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import type { Chain } from "viem";

import { env } from "../config/env";

/**
 * wagmi configuration.
 *
 * Two chains, in the platform's order of preference: Polygon Amoy is the primary target and
 * local Hardhat is the fallback, matching what the backend's network selector does. The
 * frontend never decides which chain a write lands on — the backend does, and reports it
 * through /network — so this list exists to let a wallet connect and sign, not to pick a
 * network on the user's behalf.
 *
 * WalletConnect is registered only when a project id is configured. Its connector throws
 * during construction on an empty id, which would take down the whole app at import time;
 * a local developer who has not registered a project should get MetaMask and a working app
 * rather than a white screen.
 */

export const SUPPORTED_CHAINS = [polygonAmoy, hardhat] as const satisfies readonly Chain[];

export function buildConnectors(projectId: string): CreateConnectorFn[] {
  const connectors: CreateConnectorFn[] = [
    // Covers MetaMask, Rabby, Brave and every other EIP-1193 extension. wagmi also
    // surfaces these individually through EIP-6963 discovery.
    injected({ shimDisconnect: true }),
  ];

  if (projectId) {
    connectors.push(
      walletConnect({
        projectId,
        showQrModal: true,
        metadata: {
          name: "TrustChain",
          description: "Decentralized identity, on-chain RBAC and NFT-based asset ownership.",
          url: globalThis.location?.origin ?? "http://localhost:5173",
          icons: [],
        },
      }),
    );
  }

  return connectors;
}

export function buildWagmiConfig() {
  return createConfig({
    chains: SUPPORTED_CHAINS,
    connectors: buildConnectors(env.VITE_PUBLIC_WALLETCONNECT_PROJECT_ID),
    transports: {
      [polygonAmoy.id]: http(),
      // The local node's URL is configurable because it is not always 127.0.0.1 — in the
      // Docker compose stack it is a service name.
      [hardhat.id]: http(env.VITE_PUBLIC_CHAIN_RPC_URL),
    },
    // The connection survives a reload; the API session is a separate httpOnly cookie with
    // its own lifetime, and the two are deliberately independent.
    ssr: false,
  });
}

/** Shortens an address for display: 0x1234…cdef. Never used where the full value matters. */
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
