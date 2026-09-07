import { encodeFunctionData, type Address, type Hex } from "viem";

import type { ChainBinding } from "./binding";
import {
  buildForwardTypedData,
  encodeForwardExecution,
  verifyForwardRequest,
  type ForwardRequest,
  type ForwardTypedData,
} from "./forwardRequest";
import type { NetworkSelector } from "./networkSelector";

/**
 * The two halves of an attributed action.
 *
 * **Prepare** validates the request, does any irreversible off-chain work (pinning), and
 * returns an EIP-712 payload describing exactly the call that will be made. **Forward**
 * takes the signature back, checks it belongs to the authenticated session, and relays.
 *
 * The split exists because attribution that a relayer cannot forge requires a signature
 * only the requester can produce, and a server cannot produce one on their behalf. There is
 * no way to have both unforgeable attribution and a single server-side call — so the shape
 * of the API follows from the security property rather than the other way round.
 */

const FORWARDER_ABI = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** How long a prepared request stays signable. Long enough to read, short enough to matter. */
export const FORWARD_REQUEST_TTL_SECONDS = 600;

/** Gas ceiling for a forwarded call. Generous for a mint, far below a block limit. */
const FORWARD_GAS_LIMIT = 1_500_000n;

export const FORWARDER_DOMAIN_NAME = "TrustChainForwarder";

export interface PreparedAction {
  typedData: ForwardTypedData;
  /** Echoed so a client can show what it is about to authorise. */
  summary: { network: string; contract: string; action: string };
}

/**
 * Builds the payload the requester signs.
 *
 * The nonce is read from the forwarder at prepare time. Two prepares without an intervening
 * submission therefore produce the same nonce, and only one of them can ever execute — which
 * is the correct behaviour: they describe alternative versions of the same next action, not
 * two actions.
 */
export async function prepareForwardedCall(options: {
  chain: ChainBinding;
  chainId: number;
  actor: string;
  target: string;
  data: Hex;
  action: string;
  now?: () => number;
}): Promise<PreparedAction> {
  const forwarder = options.chain.contracts.TrustChainForwarder as Address;

  const nonce = (await options.chain.client.readContract({
    address: forwarder,
    abi: FORWARDER_ABI,
    functionName: "nonces",
    args: [options.actor as Address],
  })) as bigint;

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);

  const request: ForwardRequest = {
    from: options.actor as Address,
    to: options.target as Address,
    value: 0n,
    gas: FORWARD_GAS_LIMIT,
    nonce,
    deadline: now + FORWARD_REQUEST_TTL_SECONDS,
    data: options.data,
  };

  return {
    typedData: buildForwardTypedData({
      forwarderName: FORWARDER_DOMAIN_NAME,
      forwarderAddress: forwarder,
      chainId: options.chainId,
      request,
    }),
    summary: {
      network: options.chain.network.label,
      contract: options.target,
      action: options.action,
    },
  };
}

export interface ForwardResult {
  transactionId: string;
  hash?: string;
  status: "pending" | "mined" | "failed";
}

/**
 * Verifies a signed request and relays it.
 *
 * The allowlist passed to the verifier is the active network's own contracts. Anything else
 * — including a contract on a different network of ours — is refused, so the platform's
 * funded relayer can only ever be pointed at the system it belongs to.
 */
export async function forwardSignedRequest(options: {
  selector: NetworkSelector;
  typedData: ForwardTypedData;
  signature: Hex;
  sessionAddress: string;
  now?: () => number;
}): Promise<ForwardResult> {
  const active = await options.selector.active();

  const allowedTargets = [
    active.contracts.RoleAccessControl,
    active.contracts.DIDRegistry,
    active.contracts.AssetRegistry,
    active.contracts.CredentialRegistry,
  ];

  await verifyForwardRequest({
    typedData: options.typedData,
    signature: options.signature,
    sessionAddress: options.sessionAddress,
    allowedTargets,
    ...(options.now ? { now: options.now } : {}),
  });

  // The forwarder itself must be the one this network deployed, or a signature valid for a
  // different domain could be replayed against a forwarder we do not control.
  const expected = active.contracts.TrustChainForwarder.toLowerCase();
  if (options.typedData.domain.verifyingContract.toLowerCase() !== expected) {
    throw new Error("the request was signed for a different forwarder");
  }

  return active.relayer.relayRaw(
    active.contracts.TrustChainForwarder,
    encodeForwardExecution(options.typedData.message, options.signature),
  );
}

/** ABI-encodes a mint, so prepare and the eventual on-chain call describe the same action. */
export function encodeMint(toDID: string, tokenURI: string, soulbound: boolean): Hex {
  return encodeFunctionData({
    abi: [
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
    ] as const,
    functionName: "mint",
    args: [toDID as Hex, tokenURI, soulbound],
  });
}

export function encodeIssueCredential(
  credentialHash: string,
  didHash: string,
  schemaId: string,
  expiresAt: number,
): Hex {
  return encodeFunctionData({
    abi: [
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
    ] as const,
    functionName: "issue",
    args: [credentialHash as Hex, didHash as Hex, schemaId as Hex, BigInt(expiresAt)],
  });
}

export function encodeRevokeCredential(credentialHash: string, reasonCode: number): Hex {
  return encodeFunctionData({
    abi: [
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
    ] as const,
    functionName: "revoke",
    args: [credentialHash as Hex, reasonCode],
  });
}
