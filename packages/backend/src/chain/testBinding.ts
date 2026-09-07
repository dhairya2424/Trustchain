import { HARDHAT } from "./networks";
import { staticResolver, type ChainBinding, type ChainResolver } from "./binding";
import type { CredentialRelayer } from "../credentials/registry";
import type { TransactionRelayer } from "../assets/relayer";

/**
 * A chain binding for route tests.
 *
 * Route tests care about authorization, validation and the shape of what comes back — not
 * about which addresses a chain happens to use. Collecting the uninteresting parts here
 * keeps each test file stating only what it actually asserts, and means widening the
 * binding again touches one file rather than every harness.
 */

export const TEST_CONTRACTS = {
  RoleAccessControl: "0x00000000000000000000000000000000000000a1",
  DIDRegistry: "0x00000000000000000000000000000000000000a2",
  AssetRegistry: "0x00000000000000000000000000000000000000a3",
  CredentialRegistry: "0x00000000000000000000000000000000000000a4",
  AuditTrail: "0x00000000000000000000000000000000000000a5",
  TrustChainForwarder: "0x00000000000000000000000000000000000000a6",
};

/** Answers the only chain read a prepare step makes: the actor's forwarder nonce. */
export const TEST_CLIENT = { readContract: async () => 0n } as never;

export function testChain(
  relayer: Partial<TransactionRelayer & CredentialRelayer> = {},
): ChainResolver {
  const binding: ChainBinding = {
    network: HARDHAT,
    contracts: TEST_CONTRACTS,
    client: TEST_CLIENT,
    relayer: {
      relayMint: async () => ({ transactionId: "tx-mint", status: "pending" as const }),
      relayIssue: async () => ({ transactionId: "tx-issue", status: "pending" as const }),
      relayRevoke: async () => ({ transactionId: "tx-revoke", status: "pending" as const }),
      ...relayer,
    } as TransactionRelayer & CredentialRelayer,
  };

  return staticResolver(binding);
}
