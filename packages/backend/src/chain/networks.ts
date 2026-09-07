/**
 * Network identity and the contract addresses that go with it.
 *
 * The same contracts, DID logic, RBAC matrix, NFT provenance and AuditTrail run on every
 * network here — nothing in this file changes behaviour, only where it happens. That is
 * deliberate: a fallback that behaves differently from the primary is not a fallback, it
 * is a second system that has to be tested twice and will diverge.
 */

export const NETWORK_IDS = ["amoy", "hardhat"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export interface NetworkContracts {
  RoleAccessControl: string;
  DIDRegistry: string;
  AssetRegistry: string;
  CredentialRegistry: string;
  AuditTrail: string;
}

export const CONTRACT_NAMES: ReadonlyArray<keyof NetworkContracts> = [
  "RoleAccessControl",
  "DIDRegistry",
  "AssetRegistry",
  "CredentialRegistry",
  "AuditTrail",
];

export interface NetworkDescriptor {
  id: NetworkId;
  chainId: number;
  /** Shown verbatim in the UI and the API. */
  label: string;
  /**
   * What a third party can actually do with a transaction on this network.
   *
   * The distinction is the whole point of the fallback being visible: on a public testnet
   * anyone can verify the record independently, on a local chain they must trust the
   * operator. Reporting them identically would be a false claim about verifiability.
   */
  verifiability: "public" | "local";
  verifiabilityLabel: string;
  /** Block explorer base URL, or null when there is none. */
  explorerUrl: string | null;
  /** Priority order — lower wins. Amoy is the primary target. */
  priority: number;
  /** Minimum native balance, in wei, before the network is considered usable. */
  minBalanceWei: bigint;
  /** Deployment record filename under the deployments directory. */
  deploymentFile: string;
  /** Relayer id declared in the relayer service's config.json. */
  relayerId: string;
}

/**
 * Polygon Amoy is the primary network.
 *
 * `minBalanceWei` is a floor rather than an exact cost: it has to be enough for the
 * relayer to actually send a mint, or the system would select Amoy, accept a request and
 * then fail at the last step — which is worse than falling back cleanly. 0.02 POL covers
 * several transactions at Amoy gas prices with room to spare.
 */
export const AMOY: NetworkDescriptor = {
  id: "amoy",
  chainId: 80002,
  label: "POLYGON AMOY",
  verifiability: "public",
  verifiabilityLabel: "Public Testnet / Publicly Verifiable",
  explorerUrl: "https://amoy.polygonscan.com",
  priority: 0,
  minBalanceWei: 20_000_000_000_000_000n, // 0.02 POL
  deploymentFile: "amoy.json",
  relayerId: "trustchain-amoy",
};

/**
 * Local Hardhat is the fallback, and is labelled as such everywhere it surfaces.
 *
 * Its balance floor is zero because Hardhat funds its accounts with 10000 ETH at genesis;
 * a balance check there would only ever fail if the node were misconfigured, in which case
 * the RPC probe has already failed.
 */
export const HARDHAT: NetworkDescriptor = {
  id: "hardhat",
  chainId: 31337,
  label: "LOCAL HARDHAT",
  verifiability: "local",
  verifiabilityLabel: "Local Development/Demo / Locally Verifiable",
  explorerUrl: null,
  priority: 1,
  minBalanceWei: 0n,
  deploymentFile: "localhost.json",
  relayerId: "trustchain-hardhat",
};

export const NETWORKS: Readonly<Record<NetworkId, NetworkDescriptor>> = Object.freeze({
  amoy: AMOY,
  hardhat: HARDHAT,
});

/** Primary first. */
export const NETWORKS_BY_PRIORITY: ReadonlyArray<NetworkDescriptor> = [AMOY, HARDHAT];

/** A transaction or explorer link for this network, or null when it cannot be linked. */
export function explorerTxUrl(network: NetworkDescriptor, hash: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : null;
}

export function explorerAddressUrl(network: NetworkDescriptor, address: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl}/address/${address}` : null;
}
