/**
 * Turning a verification response into a verdict.
 *
 * Pure, and tested hard, because this is the single claim the whole page exists to make.
 * Everything else on the screen is presentation; this decides what the product asserts
 * about a document someone is relying on.
 *
 * The build plan asks for two outcomes: green "AUTHENTIC" or red "UNREGISTERED / TAMPERED".
 * There are five, and collapsing them would be the exact dishonesty this platform is built
 * against — a revoked credential is *genuine*, correctly signed, and was validly issued; it
 * has simply been withdrawn. Telling its holder it is "tampered" accuses them of forgery.
 * Conversely a tampered document is not merely unregistered, it is evidence of an attempt.
 *
 * The API deliberately reports two independent checks and this preserves that:
 *
 *   - the **signature** says the document is authentic and unaltered
 *   - the **chain** says whether it is still live
 *
 * A failed signature outranks everything. If the bytes do not match what was signed, the
 * on-chain status is describing a different document than the one in your hand, and
 * reporting that status would be answering a question nobody asked.
 */

export type VerdictKind = "authentic" | "revoked" | "expired" | "unregistered" | "tampered";

export interface VerifyProof {
  signatureChecked: boolean;
  signatureValid: boolean | null;
  signatureError?: string | null;
  subject?: string | null;
  type?: string[] | null;
  issuer?: string | null;
  didHash?: string | null;
  schemaId?: string | null;
  issuedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
}

export interface VerifyResponse {
  valid: boolean;
  status: "unknown" | "valid" | "expired" | "revoked";
  credentialHash: string;
  proof: VerifyProof;
}

export interface Verdict {
  kind: VerdictKind;
  /** The headline. Short enough to read across a room. */
  title: string;
  /** One sentence explaining precisely what was and was not established. */
  detail: string;
  /** Maps to the status palette. Only `authentic` is positive. */
  tone: "verified" | "fallback" | "revoked";
}

export function decideVerdict(response: VerifyResponse): Verdict {
  const { proof, status } = response;

  // Checked first, and it outranks the chain. A signature that does not verify means the
  // bytes in hand are not the bytes that were signed, so any on-chain status describes a
  // different document.
  if (proof.signatureChecked && proof.signatureValid === false) {
    return {
      kind: "tampered",
      title: "TAMPERED",
      tone: "revoked",
      detail:
        "The signature does not match this document. It has been altered since it was issued, or it was never issued by the key it claims.",
    };
  }

  if (status === "unknown") {
    return {
      kind: "unregistered",
      title: "UNREGISTERED",
      tone: "revoked",
      detail:
        "No record of this credential exists on-chain. It was never issued by this platform, or it was issued on a different network.",
    };
  }

  if (status === "revoked") {
    return {
      kind: "revoked",
      title: "REVOKED",
      tone: "revoked",
      // Deliberately says the credential was genuine. It is not a forgery.
      detail:
        "This credential was validly issued and has since been revoked by its issuer. It is genuine, and it is no longer valid.",
    };
  }

  if (status === "expired") {
    return {
      kind: "expired",
      title: "EXPIRED",
      tone: "fallback",
      detail:
        "This credential was validly issued and correctly signed, but its expiry date has passed.",
    };
  }

  // status === "valid". What "authentic" is allowed to mean depends on whether a signature
  // was actually checked — verifying by hash alone proves the chain has a live record, not
  // that the document you hold is the one it refers to.
  if (!proof.signatureChecked) {
    return {
      kind: "authentic",
      title: "AUTHENTIC",
      tone: "verified",
      detail:
        "The chain holds a live, unrevoked record for this hash. The document itself was not supplied, so its signature was not checked — paste the credential to verify both.",
    };
  }

  return {
    kind: "authentic",
    title: "AUTHENTIC",
    tone: "verified",
    detail:
      "The signature verifies against the issuer's key, and the chain holds a live, unrevoked record. Both checks passed.",
  };
}

/**
 * The provenance of a credential, as facts rather than a narrative.
 *
 * Only entries the response actually carried appear. There is no inferred "transferred" step
 * and no placeholder node: the timeline is short because the truthful version is short.
 */
export interface TimelineNode {
  id: string;
  label: string;
  value: string;
  at?: string | null;
  tone: "verified" | "fallback" | "revoked" | "neutral";
}

export function buildTimeline(response: VerifyResponse): TimelineNode[] {
  const { proof } = response;
  const nodes: TimelineNode[] = [];

  if (proof.issuedAt) {
    nodes.push({
      id: "issued",
      label: "Issued",
      value: proof.issuer ? `by ${proof.issuer}` : "recorded on-chain",
      at: proof.issuedAt,
      tone: "verified",
    });
  }

  if (proof.signatureChecked) {
    nodes.push({
      id: "signature",
      label: proof.signatureValid ? "Signature verified" : "Signature failed",
      value: proof.signatureValid
        ? "the document matches what the issuer signed"
        : (proof.signatureError ?? "the document does not match its signature"),
      tone: proof.signatureValid ? "verified" : "revoked",
    });
  }

  if (proof.expiresAt) {
    const expired = Date.parse(proof.expiresAt) < Date.now();
    nodes.push({
      id: "expiry",
      label: expired ? "Expired" : "Expires",
      value: expired ? "the validity period has passed" : "valid until this date",
      at: proof.expiresAt,
      tone: expired ? "fallback" : "neutral",
    });
  }

  if (proof.revokedAt) {
    nodes.push({
      id: "revoked",
      label: "Revoked",
      value: proof.revocationReason
        ? `reason code ${proof.revocationReason}`
        : "withdrawn by the issuer",
      at: proof.revokedAt,
      tone: "revoked",
    });
  }

  return nodes;
}

/** Normalises pasted input: a bare hash, or a VC-JWT. */
export function classifyInput(raw: string): { kind: "hash" | "jwt" | "empty" | "unknown" } {
  const value = raw.trim();
  if (!value) return { kind: "empty" };

  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return { kind: "hash" };

  // Three base64url segments separated by dots. Not a full parse — the API is the authority
  // — just enough to send it to the right field.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return { kind: "jwt" };

  return { kind: "unknown" };
}
