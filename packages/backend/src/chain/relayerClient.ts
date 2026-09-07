import { encodeFunctionData, type Address, type Hex } from "viem";

import {
  RelayerError,
  type MintRequest,
  type RelayedTransaction,
  type TransactionRelayer,
} from "../assets/relayer";
import type {
  CredentialRelayer,
  IssueTransaction,
  RelayedCredentialTx,
  RevokeTransaction,
} from "../credentials/registry";

/**
 * Client for a self-hosted OpenZeppelin Relayer (v1.5.x).
 *
 * The service owns the signing key; this process owns an API credential that authorises
 * *requesting* a transaction. A fully compromised API can therefore ask for mints — which
 * RoleAccessControl still has to authorise on-chain — but cannot sign anything else, and
 * cannot walk away with a key, because there is no key here to take.
 *
 * The signer is declared in the relayer's own `config.json`, not here. That is the whole
 * point of the split: moving from the local encrypted keystore to AWS KMS is an edit to
 * that file and a restart of that container. Nothing in this file changes, no interface
 * changes, and no test changes — the application never learns how signing happens.
 *
 * The relayer takes **pre-encoded calldata**, so ABI encoding happens here rather than in
 * the service. That keeps the ABI next to the code that knows what it means, and it means
 * a malformed call fails locally with a type error instead of remotely with a revert.
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

/**
 * The relayer reports a six-state lifecycle; the application only ever needs three.
 *
 * `confirmed` and `mined` both collapse to "mined" — the difference is confirmation depth,
 * which matters to the relayer and not to a route returning 202. Everything still in
 * flight is "pending". Anything terminal-and-unsuccessful is "failed", and an unrecognised
 * status is treated as pending rather than success: a status we do not understand must
 * never be reported as a completed mint.
 */
const STATUS_MAP: Readonly<Record<string, RelayedTransaction["status"]>> = Object.freeze({
  pending: "pending",
  sent: "pending",
  submitted: "pending",
  inmempool: "pending",
  in_mempool: "pending",
  mined: "mined",
  confirmed: "mined",
  failed: "failed",
  canceled: "failed",
  cancelled: "failed",
  expired: "failed",
});

export function mapRelayerStatus(status: unknown): RelayedTransaction["status"] {
  if (typeof status !== "string") return "pending";
  return STATUS_MAP[status.toLowerCase()] ?? "pending";
}

export interface RelayerClientOptions {
  /** Base URL of the relayer service, e.g. http://localhost:8081 */
  baseUrl: string;
  /** Relayer id from the service's config.json. */
  relayerId: string;
  /** Bearer credential. Read from the environment, never hard-coded. */
  apiKey: string;
  assetRegistryAddress: string;
  credentialRegistryAddress: string;
  /** Transaction speed hint the service uses for gas pricing. */
  speed?: "safeLow" | "average" | "fast" | "fastest";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RelayerTransaction {
  id?: string;
  hash?: string;
  status?: string;
  transaction_id?: string;
  transaction_hash?: string;
}

export class OpenZeppelinRelayerClient implements TransactionRelayer, CredentialRelayer {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RelayerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async send(to: string, data: Hex): Promise<RelayedTransaction> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(
        this.url(`/api/v1/relayers/${encodeURIComponent(this.options.relayerId)}/transactions`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            to,
            value: 0,
            data,
            speed: this.options.speed ?? "average",
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new RelayerError(
        `relayer unreachable: ${error instanceof Error ? error.message : "unknown"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body is deliberately not echoed. A relayer error can quote the request that
      // caused it, and that request carried the API credential in its headers.
      throw new RelayerError(
        `relayer rejected the transaction (${response.status})`,
        response.status,
      );
    }

    const body = (await response.json()) as
      RelayerTransaction | { data?: RelayerTransaction; success?: boolean };

    // The service wraps successful reads in `{ success, data }`; tolerate both shapes so a
    // envelope change does not silently produce a transaction with no id.
    const tx: RelayerTransaction =
      "data" in body && body.data ? body.data : (body as RelayerTransaction);

    const transactionId = tx.id ?? tx.transaction_id;
    if (!transactionId) {
      throw new RelayerError("relayer response contained no transaction id");
    }

    const hash = tx.hash ?? tx.transaction_hash;

    return {
      transactionId,
      ...(hash ? { hash } : {}),
      status: mapRelayerStatus(tx.status),
    };
  }

  /** Current state of a previously submitted transaction. */
  async statusOf(transactionId: string): Promise<RelayedTransaction> {
    const response = await this.fetchImpl(
      this.url(
        `/api/v1/relayers/${encodeURIComponent(this.options.relayerId)}` +
          `/transactions/${encodeURIComponent(transactionId)}`,
      ),
      { headers: { authorization: `Bearer ${this.options.apiKey}` } },
    );

    if (!response.ok) {
      throw new RelayerError(`relayer status lookup failed (${response.status})`, response.status);
    }

    const body = (await response.json()) as RelayerTransaction | { data?: RelayerTransaction };
    const tx: RelayerTransaction =
      "data" in body && body.data ? body.data : (body as RelayerTransaction);

    return {
      transactionId,
      ...((tx.hash ?? tx.transaction_hash) ? { hash: tx.hash ?? tx.transaction_hash } : {}),
      status: mapRelayerStatus(tx.status),
    };
  }

  /** The signer's address — what has to hold roles on-chain, and what needs gas. */
  async address(): Promise<Address> {
    const response = await this.fetchImpl(
      this.url(`/api/v1/relayers/${encodeURIComponent(this.options.relayerId)}`),
      { headers: { authorization: `Bearer ${this.options.apiKey}` } },
    );

    if (!response.ok) {
      throw new RelayerError(`relayer lookup failed (${response.status})`, response.status);
    }

    const body = (await response.json()) as { address?: string } | { data?: { address?: string } };
    const address =
      "data" in body && body.data ? body.data.address : (body as { address?: string }).address;

    if (!address) throw new RelayerError("relayer did not report an address");
    return address as Address;
  }

  async relayMint(request: MintRequest): Promise<RelayedTransaction> {
    return this.send(
      this.options.assetRegistryAddress,
      encodeFunctionData({
        abi: ASSET_REGISTRY_ABI,
        functionName: "mint",
        args: [request.toDID as Hex, request.tokenURI, request.soulbound],
      }),
    );
  }

  async relayIssue(tx: IssueTransaction): Promise<RelayedCredentialTx> {
    return this.send(
      this.options.credentialRegistryAddress,
      encodeFunctionData({
        abi: CREDENTIAL_REGISTRY_ABI,
        functionName: "issue",
        args: [
          tx.credentialHash as Hex,
          tx.didHash as Hex,
          tx.schemaId as Hex,
          BigInt(tx.expiresAt),
        ],
      }),
    );
  }

  async relayRevoke(tx: RevokeTransaction): Promise<RelayedCredentialTx> {
    return this.send(
      this.options.credentialRegistryAddress,
      encodeFunctionData({
        abi: CREDENTIAL_REGISTRY_ABI,
        functionName: "revoke",
        args: [tx.credentialHash as Hex, tx.reasonCode],
      }),
    );
  }
}
