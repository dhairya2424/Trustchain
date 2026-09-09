import { apiBaseUrl } from "@/config/env";
import { humanErrorText } from "./errors";

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
  const response = await fetch(`${apiBaseUrl}/network/forward`, {
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
      // The API names these `verifyingContract` and `chainId`, and its schema is strict —
      // sending a `forwarder` key instead is a 400, which is exactly how this was found.
      verifyingContract: typedData.domain.verifyingContract,
      chainId: typedData.domain.chainId,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    // Through the shared table rather than a local switch, so every surface in the app
    // says the same sentence about the same failure — and so an unrecognised code becomes a
    // plain sentence rather than leaking `actor_mismatch` into the interface.
    throw new ForwardError(response.status, code, humanErrorText(code));
  }

  return body as ForwardResult;
}
