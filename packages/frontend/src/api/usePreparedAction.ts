import { useCallback } from "react";
import { useSignTypedData } from "wagmi";

import { humanErrorText } from "./errors";
import { forwardSigned, toSignable, type ForwardResult, type PreparedTypedData } from "./forward";
import { apiBaseUrl } from "@/config/env";

/**
 * Every attributed write in this application, in one function.
 *
 * The shape never varies: a prepare endpoint returns EIP-712 typed data describing exactly
 * the call about to be made, the user signs it in their own wallet, and the signed request
 * goes to `POST /network/forward`. The relayer pays the gas; the contract recovers the
 * *signer*, so the action is attributed to the person who asked for it rather than to the
 * account that submitted it.
 *
 * This existed twice, copied, in the mint wizard and the role manager. Three more surfaces
 * needed it — transfers, identity registration, credential issuance — and a fourth and fifth
 * copy of a security-critical sequence is how the copies start to differ. Notably, one of the
 * two already handled a 403 with its own bespoke sentence while the other did not.
 *
 * ## What this deliberately does not do
 *
 * It does not swallow errors, retry, or decide what the interface says about success. Those
 * differ per action and belong at the call site. What it centralises is the part that must
 * never differ: what gets signed, and that what is forwarded is byte-identical to it.
 */

export interface PreparedResponse {
  typedData: PreparedTypedData;
  summary?: { network: string; contract: string; action: string };
  [key: string]: unknown;
}

export interface PreparedActionResult {
  /** Everything the prepare endpoint returned, for callers that need more than the receipt. */
  prepared: PreparedResponse;
  /** What the relayer reported once the signed request was submitted. */
  forwarded: ForwardResult;
}

export class PrepareError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrepareError";
  }
}

export type PrepareErrorMessages = Partial<Record<number | string, string>>;

/**
 * Runs prepare → sign → forward for one action.
 *
 * `messages` lets a caller override the sentence for a particular status or error code —
 * "changing a role needs MANAGE_ROLES" is more useful than the generic forbidden text, and
 * only the call site knows which permission was at stake.
 */
export function usePreparedAction() {
  const { signTypedDataAsync } = useSignTypedData();

  return useCallback(
    async (
      path: string,
      body: unknown,
      messages: PrepareErrorMessages = {},
    ): Promise<PreparedActionResult> => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        const code = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
        throw new PrepareError(
          response.status,
          code,
          messages[code] ?? messages[response.status] ?? humanErrorText(code),
        );
      }

      const prepared = payload as PreparedResponse;
      const signable = toSignable(prepared.typedData);

      // The signature is the whole point. Everything upstream of this line is the server
      // describing an action; this is the user authorising it, with a key the server does
      // not hold and cannot forge.
      const signature = await signTypedDataAsync({
        domain: signable.domain,
        types: signable.types,
        primaryType: signable.primaryType,
        message: signable.message,
      } as never);

      // Forwarded verbatim. Re-deriving or reformatting any field would change the hash the
      // signature covers, and the API would correctly refuse it.
      const forwarded = await forwardSigned(prepared.typedData, signature);

      return { prepared, forwarded };
    },
    [signTypedDataAsync],
  );
}
