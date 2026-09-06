import { recoverMessageAddress, type Address, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage, type SiweMessage } from "viem/siwe";

export type SiweFailure =
  "malformed_message" | "field_validation_failed" | "address_mismatch" | "invalid_signature";

export type SiweResult =
  { ok: true; fields: Partial<SiweMessage>; address: Address } | { ok: false; reason: SiweFailure };

/** Verifies an ERC-1271 signature for a contract wallet. Injected so tests need no chain. */
export type Erc1271Checker = (
  address: Address,
  message: string,
  signature: Hex,
) => Promise<boolean>;

/**
 * Server-side Sign-In With Ethereum verification.
 *
 * Signature recovery happens locally rather than through viem's chain-backed
 * `verifySiweMessage`. For an externally owned account the maths needs no chain at all,
 * and requiring one would make the single most security-critical path in the API
 * dependent on an RPC endpoint being reachable — and effectively untestable without one.
 *
 * Contract wallets genuinely cannot be checked locally, so an ERC-1271 checker is
 * injected and consulted only when local recovery fails to match.
 */
export class SiweVerifier {
  constructor(
    private readonly options: {
      domain: string;
      erc1271?: Erc1271Checker;
      /** Overridable for deterministic expiry tests. */
      now?: () => Date;
    },
  ) {}

  async verify(message: string, signature: Hex): Promise<SiweResult> {
    let fields: Partial<SiweMessage>;
    try {
      fields = parseSiweMessage(message);
    } catch {
      return { ok: false, reason: "malformed_message" };
    }

    if (!fields.address || !fields.nonce) {
      return { ok: false, reason: "malformed_message" };
    }

    // Checks domain binding plus expirationTime / notBefore. Domain binding is what stops
    // a signature farmed by a phishing site from working here.
    const fieldsValid = validateSiweMessage({
      message: fields,
      domain: this.options.domain,
      time: this.options.now?.(),
    });
    if (!fieldsValid) {
      return { ok: false, reason: "field_validation_failed" };
    }

    const claimed = fields.address as Address;

    let recovered: Address | undefined;
    try {
      recovered = await recoverMessageAddress({ message, signature });
    } catch {
      recovered = undefined;
    }

    if (recovered && recovered.toLowerCase() === claimed.toLowerCase()) {
      return { ok: true, fields, address: claimed };
    }

    // A contract wallet produces a signature no EOA recovery can match, so fall through
    // to ERC-1271 rather than rejecting it.
    if (this.options.erc1271) {
      try {
        if (await this.options.erc1271(claimed, message, signature)) {
          return { ok: true, fields, address: claimed };
        }
      } catch {
        // Treated as a failed check, not as a pass.
      }
    }

    return { ok: false, reason: recovered ? "address_mismatch" : "invalid_signature" };
  }
}
