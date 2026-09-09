import { describe, expect, it } from "vitest";

import { humanError } from "./errors";

/**
 * The rule this module exists for: a raw error string never reaches the interface.
 *
 * It went untested, and the gap showed. The connect modal rendered `error.message`
 * directly, so a person without a wallet extension was told "Provider not found. Version:
 * @wagmi/core@3.6.5" — a sentence naming a library, leaking its version, and omitting the
 * only thing they needed to know. These tests pin both halves: that known failures become
 * sentences, and that unknown ones lose their original text rather than passing it through.
 */

describe("humanError — wallet failures become instructions", () => {
  it("explains a missing wallet extension instead of naming the library", () => {
    const result = humanError(new Error("Provider not found. Version: @wagmi/core@3.6.5"));

    expect(result.message).toBe("No wallet extension was found in this browser.");
    expect(result.action).toMatch(/install metamask/i);
    // The failure this replaced.
    expect(JSON.stringify(result)).not.toMatch(/@wagmi|Version:/i);
  });

  it("mentions the verify page, because it needs no wallet at all", () => {
    // Someone who cannot install an extension is not stuck: the whole point of the public
    // verifier is that it works with no account and no wallet.
    const result = humanError(new Error("Provider not found."));
    expect(result.action).toMatch(/verif/i);
  });

  it("treats a declined signature as a choice, not a fault", () => {
    const result = humanError(new Error("User rejected the request."));
    expect(result.message).toMatch(/declined/i);
    expect(result.action).toMatch(/nothing was submitted/i);
  });

  it("says a wallet is already asking, rather than looking stuck", () => {
    const result = humanError(
      new Error("Request of type 'wallet_requestPermissions' already pending"),
    );
    expect(result.message).toMatch(/already showing a request/i);
  });

  it("translates a revert into the permission problem it usually is", () => {
    const result = humanError(new Error("execution reverted: 0x1234abcd"));
    expect(result.message).toBe("The contract refused this transaction.");
    expect(JSON.stringify(result)).not.toContain("0x1234abcd");
  });

  it("explains a network mismatch in terms of what to do", () => {
    const result = humanError(new Error("chain mismatch: expected 80002"));
    expect(result.message).toMatch(/different network/i);
    expect(result.action).toMatch(/switch networks/i);
  });
});

describe("humanError — unrecognised failures lose their text", () => {
  it("does not pass an unknown message through", () => {
    // Deliberately losing information at the boundary: an error we do not recognise is one
    // we cannot promise is safe or meaningful to show.
    const leaky = "TypeError: Cannot read properties of undefined (reading 'chainId') at ...";
    const result = humanError(new Error(leaky));

    expect(result.message).not.toContain("TypeError");
    expect(result.message).not.toContain("chainId");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("handles a non-Error being thrown at it", () => {
    expect(() => humanError(undefined)).not.toThrow();
    expect(() => humanError({ weird: true })).not.toThrow();
    expect(humanError(undefined).message.length).toBeGreaterThan(0);
  });

  it("surfaces a request id separately rather than inside the sentence", () => {
    // The id is what connects a user's report to a log line, so it is kept out of the
    // prose where it would read as noise.
    const result = humanError(new Error("boom"), "req-123");
    expect(result.requestId).toBe("req-123");
    expect(result.message).not.toContain("req-123");
  });
});
