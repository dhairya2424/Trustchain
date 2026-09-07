import type { Address, Hex, PublicClient } from "viem";

/**
 * Reads credential state from CredentialRegistry.
 *
 * Verification is a chain read and nothing else. There is no cache here, deliberately:
 * the question "is this credential still valid?" is exactly the question whose answer
 * changes without warning, and a verifier acting on a cached "valid" after a revocation
 * is the failure this registry exists to prevent. If the RPC is down, verification fails
 * loudly rather than answering from memory.
 */

/** Mirrors CredentialRegistry.CredentialStatus. */
export const CREDENTIAL_STATUS = ["unknown", "valid", "expired", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUS)[number];

export interface OnChainCredential {
  didHash: string;
  schemaId: string;
  issuer: string;
  issuedAt: number;
  /** 0 means it never expires. */
  expiresAt: number;
  revokedAt: number;
  revocationReason: number;
  revoked: boolean;
}

export interface CredentialSnapshot {
  status: CredentialStatus;
  credential: OnChainCredential | null;
}

export interface CredentialReader {
  statusOf(credentialHash: string): Promise<CredentialSnapshot>;
}

const CREDENTIAL_REGISTRY_ABI = [
  {
    type: "function",
    name: "statusOf",
    stateMutability: "view",
    inputs: [{ name: "credentialHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "credentialOf",
    stateMutability: "view",
    inputs: [{ name: "credentialHash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "didHash", type: "bytes32" },
          { name: "schemaId", type: "bytes32" },
          { name: "issuer", type: "address" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
          { name: "revokedAt", type: "uint64" },
          { name: "revocationReason", type: "uint16" },
          { name: "revoked", type: "bool" },
        ],
      },
    ],
  },
] as const;

interface RawCredential {
  didHash: Hex;
  schemaId: Hex;
  issuer: Address;
  issuedAt: bigint;
  expiresAt: bigint;
  revokedAt: bigint;
  revocationReason: number;
  revoked: boolean;
}

export class OnChainCredentialReader implements CredentialReader {
  constructor(
    private readonly client: PublicClient,
    private readonly address: Address,
  ) {}

  async statusOf(credentialHash: string): Promise<CredentialSnapshot> {
    const code = (await this.client.readContract({
      address: this.address,
      abi: CREDENTIAL_REGISTRY_ABI,
      functionName: "statusOf",
      args: [credentialHash as Hex],
    })) as number;

    const status = CREDENTIAL_STATUS[code] ?? "unknown";

    // `credentialOf` reverts for a hash that was never issued, so it is only called once
    // the status says there is something to fetch.
    if (status === "unknown") return { status, credential: null };

    const raw = (await this.client.readContract({
      address: this.address,
      abi: CREDENTIAL_REGISTRY_ABI,
      functionName: "credentialOf",
      args: [credentialHash as Hex],
    })) as RawCredential;

    return {
      status,
      credential: {
        didHash: raw.didHash,
        schemaId: raw.schemaId,
        issuer: raw.issuer,
        issuedAt: Number(raw.issuedAt),
        expiresAt: Number(raw.expiresAt),
        revokedAt: Number(raw.revokedAt),
        revocationReason: Number(raw.revocationReason),
        revoked: raw.revoked,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Relaying issuance and revocation
// ---------------------------------------------------------------------------

export interface IssueTransaction {
  credentialHash: string;
  didHash: string;
  schemaId: string;
  expiresAt: number;
}

export interface RevokeTransaction {
  credentialHash: string;
  reasonCode: number;
}

export interface RelayedCredentialTx {
  transactionId: string;
  hash?: string;
  status: "pending" | "mined" | "failed";
}

/**
 * Submits credential transactions without holding a key.
 *
 * Same reasoning as the asset relayer: the signing key lives in the relayer's KMS, so a
 * fully compromised API can request transactions the chain will still refuse to authorise,
 * but cannot walk away with a key or sign anything outside these two calls.
 */
export interface CredentialRelayer {
  relayIssue(tx: IssueTransaction): Promise<RelayedCredentialTx>;
  relayRevoke(tx: RevokeTransaction): Promise<RelayedCredentialTx>;
}

export { RelayerError } from "../assets/relayer";
