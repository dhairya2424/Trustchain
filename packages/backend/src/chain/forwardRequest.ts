import { encodeFunctionData, verifyTypedData, type Address, type Hex } from "viem";

/**
 * EIP-712 forward requests: how an action gets attributed to the person who asked for it.
 *
 * The requester signs a typed description of the action — target, calldata, nonce,
 * deadline. The relayer submits that signature but never produces it, so the actor recorded
 * on-chain is proven rather than asserted. See `contracts/forwarder/TrustChainForwarder.sol`
 * for why an unsigned `actor` parameter would be worthless.
 *
 * This module builds the payload to sign and checks a returned signature. It deliberately
 * does not sign anything: the backend holds no user key, and a backend that could sign on a
 * user's behalf would reintroduce exactly the spoofing this design removes.
 */

/** Matches OpenZeppelin's ERC2771Forwarder. Field order is part of the hash. */
export const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
} as const;

export interface ForwardRequest {
  from: Address;
  to: Address;
  value: bigint;
  gas: bigint;
  nonce: bigint;
  deadline: number;
  data: Hex;
}

export interface ForwardTypedData {
  domain: {
    name: string;
    version: "1";
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof FORWARD_REQUEST_TYPES;
  primaryType: "ForwardRequest";
  message: ForwardRequest;
}

export class ForwardRequestError extends Error {
  constructor(
    message: string,
    readonly code:
      "actor_mismatch" | "bad_signature" | "target_not_allowed" | "expired" | "value_not_zero",
  ) {
    super(message);
    this.name = "ForwardRequestError";
  }
}

export function buildForwardTypedData(options: {
  forwarderName: string;
  forwarderAddress: Address;
  chainId: number;
  request: ForwardRequest;
}): ForwardTypedData {
  return {
    domain: {
      name: options.forwarderName,
      version: "1",
      chainId: options.chainId,
      verifyingContract: options.forwarderAddress,
    },
    types: FORWARD_REQUEST_TYPES,
    primaryType: "ForwardRequest",
    message: options.request,
  };
}

/**
 * Accepts a signed request, or explains precisely why not.
 *
 * Four checks, and each closes a distinct hole:
 *
 *   1. **`from` is the authenticated session's address.** This is the requirement that the
 *      actor is never taken on the frontend's word: the client may propose a request, but
 *      the identity it is attributed to comes from the server's own session, and a request
 *      naming anyone else is refused before it reaches a chain.
 *
 *   2. **The signature verifies for that address.** Proves the actor really authorised
 *      *this* action — not a different one whose signature was reused.
 *
 *   3. **The target is one of ours.** Without it, an authenticated user could have the
 *      platform's funded relayer submit arbitrary calldata to any contract on the network:
 *      an open relay, paid for by us, with our relayer's address on every transaction.
 *      This is the control that keeps the relayer a component rather than a service.
 *
 *   4. **No native value, and not expired.** The relayer holds gas money; a forwarded
 *      request that moves value would be spending it.
 */
export async function verifyForwardRequest(options: {
  typedData: ForwardTypedData;
  signature: Hex;
  /** The address the server authenticated. Not supplied by the client. */
  sessionAddress: string;
  /** Contract addresses this platform is willing to relay to. */
  allowedTargets: readonly string[];
  now?: () => number;
}): Promise<void> {
  const { message } = options.typedData;

  if (message.from.toLowerCase() !== options.sessionAddress.toLowerCase()) {
    throw new ForwardRequestError(
      "the request names an actor other than the authenticated session",
      "actor_mismatch",
    );
  }

  const allowed = options.allowedTargets.map((a) => a.toLowerCase());
  if (!allowed.includes(message.to.toLowerCase())) {
    throw new ForwardRequestError(
      "the request targets a contract this platform does not relay to",
      "target_not_allowed",
    );
  }

  if (message.value !== 0n) {
    throw new ForwardRequestError("a forwarded request may not carry value", "value_not_zero");
  }

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  if (message.deadline <= now) {
    throw new ForwardRequestError("the request has expired", "expired");
  }

  const valid = await verifyTypedData({
    address: message.from,
    domain: options.typedData.domain,
    types: options.typedData.types,
    primaryType: "ForwardRequest",
    message: message as never,
    signature: options.signature,
  });

  if (!valid) {
    throw new ForwardRequestError("signature does not verify for the named actor", "bad_signature");
  }
}

/**
 * Renders typed data as JSON a wallet can consume.
 *
 * `JSON.stringify` throws on a bigint, so `value`, `gas` and `nonce` are emitted as decimal
 * strings. Wallets accept that — EIP-712 numeric fields are canonicalised before hashing —
 * and the alternative, silently narrowing to a JavaScript number, would corrupt a nonce or
 * a gas limit above 2^53 without any error at all.
 */
export function serializeTypedData(typedData: ForwardTypedData) {
  return {
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      from: typedData.message.from,
      to: typedData.message.to,
      value: typedData.message.value.toString(),
      gas: typedData.message.gas.toString(),
      nonce: typedData.message.nonce.toString(),
      deadline: typedData.message.deadline,
      data: typedData.message.data,
    },
  };
}

const FORWARDER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "gas", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "data", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * Calldata for `forwarder.execute(request)`.
 *
 * The nonce is signed but not resubmitted — the forwarder reads it from its own storage,
 * which is what makes a replay fail rather than merely be detected.
 */
export function encodeForwardExecution(request: ForwardRequest, signature: Hex): Hex {
  return encodeFunctionData({
    abi: FORWARDER_ABI,
    functionName: "execute",
    args: [
      {
        from: request.from,
        to: request.to,
        value: request.value,
        gas: request.gas,
        deadline: request.deadline,
        data: request.data,
        signature,
      },
    ],
  });
}
