import { createWalletClient, http, publicActions, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { MintRequest, RelayedTransaction, TransactionRelayer } from "../assets/relayer";
import type {
  CredentialRelayer,
  IssueTransaction,
  RelayedCredentialTx,
  RevokeTransaction,
} from "../credentials/registry";

/**
 * A relayer that signs locally, for development and the demo only.
 *
 * The production path is OpenZeppelin Defender: the signing key lives in a KMS and never
 * enters this process. That is the whole point of the relayer abstraction, and it is not
 * negotiable in production. But Defender is a hosted service with credentials nobody has
 * on a laptop, and a system that cannot be run end-to-end locally cannot be demonstrated,
 * tested against real contracts, or debugged.
 *
 * So this exists, and it is deliberately fenced:
 *
 *   - the constructor throws when NODE_ENV is "production";
 *   - it lives under `src/dev/`, so its presence in an import graph is visible;
 *   - it takes the key explicitly rather than reading process.env itself, so no
 *     configuration accident can silently arm it.
 *
 * It holds a private key in memory. That is acceptable for a Hardhat account whose key is
 * printed in the node's startup banner and is public knowledge. It is not acceptable for
 * anything else, which is what the guard enforces.
 */

const ASSET_REGISTRY_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "toDID", type: "bytes32" },
      { name: "uri", type: "string" },
      { name: "soulbound", type: "bool" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

const CREDENTIAL_REGISTRY_ABI = [
  {
    type: "function",
    name: "issue",
    stateMutability: "nonpayable",
    inputs: [
      { name: "credentialHash", type: "bytes32" },
      { name: "didHash", type: "bytes32" },
      { name: "schemaId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [
      { name: "credentialHash", type: "bytes32" },
      { name: "reasonCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

export interface LocalRelayerOptions {
  rpcUrl: string;
  /** 0x-prefixed 32-byte key. A Hardhat development account, never a real one. */
  privateKey: string;
  assetRegistryAddress: string;
  credentialRegistryAddress: string;
  /** Defaults to process.env.NODE_ENV; injected so the guard itself is testable. */
  nodeEnv?: string;
}

export class LocalRelayerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRelayerRefused";
  }
}

export class LocalRelayer implements TransactionRelayer, CredentialRelayer {
  private readonly client: ReturnType<typeof createWalletClient> & {
    waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: string }>;
  };
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly options: LocalRelayerOptions) {
    const env = options.nodeEnv ?? process.env.NODE_ENV;
    if (env === "production") {
      throw new LocalRelayerRefused(
        "LocalRelayer holds a signing key in process memory and must never run in " +
          "production; configure DEFENDER_API_KEY, DEFENDER_API_SECRET and " +
          "DEFENDER_RELAYER_URL instead",
      );
    }

    this.account = privateKeyToAccount(options.privateKey as Hex);
    this.client = createWalletClient({
      account: this.account,
      transport: http(options.rpcUrl),
    }).extend(publicActions) as typeof this.client;
  }

  /** The address transactions are sent from — this is the `actor` the audit trail records. */
  get address(): Address {
    return this.account.address;
  }

  private async send(
    address: string,
    abi: typeof ASSET_REGISTRY_ABI | typeof CREDENTIAL_REGISTRY_ABI,
    functionName: string,
    args: readonly unknown[],
  ): Promise<{ hash: string; status: "mined" | "failed" }> {
    const hash = await (
      this.client as unknown as {
        writeContract: (a: Record<string, unknown>) => Promise<Hex>;
      }
    ).writeContract({
      address: address as Address,
      abi,
      functionName,
      args,
      chain: null,
      account: this.account,
    });

    // Waits for the receipt, unlike Defender, which is fire-and-track. Locally a block is
    // mined immediately, and a synchronous result makes the demo and the end-to-end script
    // deterministic — no polling for a transaction that already landed.
    const receipt = await this.client.waitForTransactionReceipt({ hash });

    return { hash, status: receipt.status === "success" ? "mined" : "failed" };
  }

  async relayMint(request: MintRequest): Promise<RelayedTransaction> {
    const { hash, status } = await this.send(
      this.options.assetRegistryAddress,
      ASSET_REGISTRY_ABI,
      "mint",
      [request.toDID as Hex, request.tokenURI, request.soulbound],
    );

    return { transactionId: hash, hash, status };
  }

  async relayIssue(tx: IssueTransaction): Promise<RelayedCredentialTx> {
    const { hash, status } = await this.send(
      this.options.credentialRegistryAddress,
      CREDENTIAL_REGISTRY_ABI,
      "issue",
      [tx.credentialHash as Hex, tx.didHash as Hex, tx.schemaId as Hex, BigInt(tx.expiresAt)],
    );

    return { transactionId: hash, hash, status };
  }

  async relayRevoke(tx: RevokeTransaction): Promise<RelayedCredentialTx> {
    const { hash, status } = await this.send(
      this.options.credentialRegistryAddress,
      CREDENTIAL_REGISTRY_ABI,
      "revoke",
      [tx.credentialHash as Hex, tx.reasonCode],
    );

    return { transactionId: hash, hash, status };
  }
}
