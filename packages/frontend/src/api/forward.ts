import { env } from "@/config/env";

/**
 * The signing half of every attributed write.
 *
 * A prepare endpoint returns EIP-712 typed data; the wallet signs it; this posts the signed
 * request to `POST /network/forward`, which verifies the signature and hands it to the
 * relayer. The relayer pays the gas, and the contract still sees the signer as the caller —
 * which is what keeps a role change attributed to the ADMIN who asked for it rather than to
 * the account that submitted it.
 *
 * The numeric fields arrive as decimal strings because JSON has no integers wide enough for
 * uint256, and go back to the API in the same shape. They pass through `BigInt` on the way
 * to the wallet because that is what the signer expects, and a lossy `Number` round-trip on
 * a nonce would produce a signature over a different request than the one submitted.
 */

export interface PreparedTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
}

export interface ForwardResult {
  transactionHash?: string;
  status?: string;
  network?: { id: string; label: string };
  explorerUrl?: string | null;
}

/** Shapes typed data for a viem/wagmi signer. */
export function toSignable(typedData: PreparedTypedData) {
  return {
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      from: typedData.message.from as `0x${string}`,
      to: typedData.message.to as `0x${string}`,
      value: BigInt(typedData.message.value),
      gas: BigInt(typedData.message.gas),
      nonce: BigInt(typedData.message.nonce),
      deadline: typedData.message.deadline,
      data: typedData.message.data as `0x${string}`,
    },
  };
}

export class ForwardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ForwardError";
  }
}

/** Posts an already-signed request. The signature is produced by the caller's wallet. */
export async function forwardSigned(
  typedData: PreparedTypedData,
  signature: string,
): Promise<ForwardResult> {
  const response = await fetch(`${env.VITE_PUBLIC_API_URL}/network/forward`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Re-sent verbatim as strings, exactly as prepared. Reformatting any of these would
      // change the hash the signature covers and the API would — correctly — refuse it.
      request: {
        from: typedData.message.from,
        to: typedData.message.to,
        value: "0",
        gas: typedData.message.gas,
        nonce: typedData.message.nonce,
        deadline: typedData.message.deadline,
        data: typedData.message.data,
      },
      signature,
      forwarder: typedData.domain.verifyingContract,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new ForwardError(response.status, code, describeForwardError(code));
  }

  return body as ForwardResult;
}

/** Turns the API's error codes into something a person can act on. */
function describeForwardError(code: string): string {
  switch (code) {
    case "actor_mismatch":
      return "The signature is for a different account than the one signed in.";
    case "invalid_signature":
      return "The signature did not verify against this request.";
    case "target_not_allowed":
      return "That contract is not on the active network's allowlist.";
    case "request_expired":
      return "The request expired before it was submitted. Try again.";
    case "no_usable_network":
      return "No blockchain network is currently usable, so nothing can be submitted.";
    default:
      return code.replace(/_/g, " ");
  }
}
