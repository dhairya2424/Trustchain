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

export class RelayerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

export class DefenderCredentialRelayer implements CredentialRelayer {
  constructor(
    private readonly options: {
      apiKey: string;
      apiSecret: string;
      relayerUrl: string;
      credentialRegistryAddress: string;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async send(functionName: string, args: unknown[]): Promise<RelayedCredentialTx> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.relayerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          authorization: `Bearer ${this.options.apiSecret}`,
        },
        body: JSON.stringify({
          to: this.options.credentialRegistryAddress,
          functionName,
          args,
          speed: "fast",
        }),
      });
    } catch (error) {
      throw new RelayerError(
        `relayer unreachable: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    if (!response.ok) {
      // The body is not echoed: a relayer error can quote the request headers, and those
      // carry the API secret.
      throw new RelayerError(
        `relayer rejected the transaction (${response.status})`,
        response.status,
      );
    }

    const result = (await response.json()) as {
      transactionId?: string;
      hash?: string;
      status?: string;
    };

    if (!result.transactionId) {
      throw new RelayerError("relayer response contained no transaction id");
    }

    return {
      transactionId: result.transactionId,
      ...(result.hash ? { hash: result.hash } : {}),
      status:
        result.status === "mined" ? "mined" : result.status === "failed" ? "failed" : "pending",
    };
  }

  async relayIssue(tx: IssueTransaction): Promise<RelayedCredentialTx> {
    return this.send("issue", [tx.credentialHash, tx.didHash, tx.schemaId, tx.expiresAt]);
  }

  async relayRevoke(tx: RevokeTransaction): Promise<RelayedCredentialTx> {
    return this.send("revoke", [tx.credentialHash, tx.reasonCode]);
  }
}
