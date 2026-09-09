import { describe, expect, it } from "vitest";

import { buildTimeline, classifyInput, decideVerdict, type VerifyResponse } from "./verdict";

/**
 * The verdict is the single claim this product makes to a stranger, so these tests are
 * mostly about the distinctions a careless implementation would collapse.
 */

function response(
  over: Partial<VerifyResponse> & { status: VerifyResponse["status"] },
): VerifyResponse {
  return {
    valid: over.status === "valid",
    credentialHash: "0xabc",
    proof: {
      signatureChecked: false,
      signatureValid: null,
      ...over.proof,
    },
    ...over,
  };
}

describe("decideVerdict — the positive case", () => {
  it("calls a live, correctly signed credential authentic", () => {
    const verdict = decideVerdict(
      response({ status: "valid", proof: { signatureChecked: true, signatureValid: true } }),
    );

    expect(verdict.kind).toBe("authentic");
    expect(verdict.tone).toBe("verified");
  });

  it("says explicitly when only the chain was checked", () => {
    // Verifying by hash proves the chain holds a live record. It does not prove the
    // document in your hand is the one that record refers to, and the wording must not
    // let a reader assume otherwise.
    const verdict = decideVerdict(response({ status: "valid" }));

    expect(verdict.kind).toBe("authentic");
    expect(verdict.detail).toMatch(/signature was not checked/i);
  });

  it("claims both checks only when both ran", () => {
    const verdict = decideVerdict(
      response({ status: "valid", proof: { signatureChecked: true, signatureValid: true } }),
    );

    expect(verdict.detail).toMatch(/Both checks passed/i);
  });
});

describe("decideVerdict — distinctions that must not collapse", () => {
  it("does not call a revoked credential tampered", () => {
    // The build plan lumps these into one red verdict. A revoked credential was validly
    // issued and correctly signed; calling it tampered accuses its holder of forgery.
    const verdict = decideVerdict(
      response({ status: "revoked", proof: { signatureChecked: true, signatureValid: true } }),
    );

    expect(verdict.kind).toBe("revoked");
    expect(verdict.title).toBe("REVOKED");
    expect(verdict.detail).toMatch(/genuine/i);
  });

  it("does not call an unregistered credential tampered either", () => {
    const verdict = decideVerdict(response({ status: "unknown" }));

    expect(verdict.kind).toBe("unregistered");
    expect(verdict.detail).toMatch(/never issued|different network/i);
  });

  it("treats expiry as its own outcome, not a failure", () => {
    const verdict = decideVerdict(
      response({ status: "expired", proof: { signatureChecked: true, signatureValid: true } }),
    );

    expect(verdict.kind).toBe("expired");
    expect(verdict.tone).toBe("fallback");
  });

  it("reports a broken signature as tampered", () => {
    const verdict = decideVerdict(
      response({ status: "valid", proof: { signatureChecked: true, signatureValid: false } }),
    );

    expect(verdict.kind).toBe("tampered");
  });
});

describe("decideVerdict — a failed signature outranks the chain", () => {
  it("says tampered even when the chain says valid", () => {
    // The decisive rule. If the bytes do not match what was signed, the on-chain record
    // describes a different document, so reporting its status would answer a question
    // nobody asked — and would show "AUTHENTIC" over a forgery.
    const verdict = decideVerdict(
      response({ status: "valid", proof: { signatureChecked: true, signatureValid: false } }),
    );

    expect(verdict.kind).toBe("tampered");
    expect(verdict.tone).toBe("revoked");
  });

  it("says tampered rather than revoked when both are wrong", () => {
    const verdict = decideVerdict(
      response({ status: "revoked", proof: { signatureChecked: true, signatureValid: false } }),
    );

    expect(verdict.kind).toBe("tampered");
  });

  it("says tampered rather than unregistered when both are wrong", () => {
    const verdict = decideVerdict(
      response({ status: "unknown", proof: { signatureChecked: true, signatureValid: false } }),
    );

    expect(verdict.kind).toBe("tampered");
  });

  it("never returns a verified tone for anything but authentic", () => {
    const kinds: VerifyResponse[] = [
      response({ status: "unknown" }),
      response({ status: "revoked" }),
      response({ status: "expired" }),
      response({ status: "valid", proof: { signatureChecked: true, signatureValid: false } }),
    ];

    for (const input of kinds) {
      expect(decideVerdict(input).tone).not.toBe("verified");
    }
  });
});

describe("buildTimeline", () => {
  it("includes only events the response actually carried", () => {
    // No inferred transfer nodes. The asset event indexer does not exist, and padding a
    // provenance chain on the page that exists to prove provenance would be the worst
    // possible fabrication.
    const nodes = buildTimeline(response({ status: "valid" }));
    expect(nodes).toEqual([]);
  });

  it("records issuance when the chain reported it", () => {
    const nodes = buildTimeline(
      response({
        status: "valid",
        proof: {
          signatureChecked: false,
          signatureValid: null,
          issuedAt: "2026-01-01T00:00:00.000Z",
          issuer: "0xissuer",
        },
      }),
    );

    expect(nodes.map((n) => n.id)).toEqual(["issued"]);
    expect(nodes[0]?.tone).toBe("verified");
  });

  it("marks a failed signature node as a failure", () => {
    const nodes = buildTimeline(
      response({
        status: "valid",
        proof: { signatureChecked: true, signatureValid: false, signatureError: "bad_signature" },
      }),
    );

    const signature = nodes.find((n) => n.id === "signature");
    expect(signature?.tone).toBe("revoked");
    expect(signature?.label).toMatch(/failed/i);
  });

  it("orders issuance before revocation", () => {
    const nodes = buildTimeline(
      response({
        status: "revoked",
        proof: {
          signatureChecked: true,
          signatureValid: true,
          issuedAt: "2026-01-01T00:00:00.000Z",
          revokedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    );

    const ids = nodes.map((n) => n.id);
    expect(ids.indexOf("issued")).toBeLessThan(ids.indexOf("revoked"));
  });

  it("distinguishes a future expiry from a past one", () => {
    const future = buildTimeline(
      response({
        status: "valid",
        proof: {
          signatureChecked: false,
          signatureValid: null,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      }),
    );
    const past = buildTimeline(
      response({
        status: "expired",
        proof: {
          signatureChecked: false,
          signatureValid: null,
          expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      }),
    );

    expect(future.find((n) => n.id === "expiry")?.label).toBe("Expires");
    expect(past.find((n) => n.id === "expiry")?.label).toBe("Expired");
  });
});

describe("classifyInput", () => {
  it("recognises a credential hash", () => {
    expect(classifyInput(`0x${"a".repeat(64)}`).kind).toBe("hash");
  });

  it("recognises a JWT", () => {
    expect(classifyInput("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln").kind).toBe("jwt");
  });

  it("tolerates surrounding whitespace, which a paste usually brings", () => {
    expect(classifyInput(`  0x${"b".repeat(64)}\n`).kind).toBe("hash");
  });

  it("treats an empty field as empty rather than invalid", () => {
    expect(classifyInput("   ").kind).toBe("empty");
  });

  it("rejects a hash of the wrong length instead of sending it", () => {
    expect(classifyInput(`0x${"a".repeat(63)}`).kind).toBe("unknown");
  });

  it("rejects arbitrary text", () => {
    expect(classifyInput("hello world").kind).toBe("unknown");
  });
});
