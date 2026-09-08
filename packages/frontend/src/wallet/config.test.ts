import { describe, expect, it } from "vitest";

import { buildConnectors, SUPPORTED_CHAINS, truncateAddress } from "./config";

describe("buildConnectors", () => {
  it("always offers an injected connector, so a browser wallet works with no configuration", () => {
    expect(buildConnectors("")).toHaveLength(1);
  });

  it("adds WalletConnect when a project id is configured", () => {
    expect(buildConnectors("a-real-project-id")).toHaveLength(2);
  });

  it("omits WalletConnect rather than constructing it with an empty id", () => {
    // Its connector throws during construction on an empty id, and because connectors are
    // built at module import that would be a white screen rather than a missing option. A
    // developer who has not registered a project should still get a working app.
    expect(() => buildConnectors("")).not.toThrow();
  });
});

describe("SUPPORTED_CHAINS", () => {
  it("lists Amoy first, matching the platform's own order of preference", () => {
    expect(SUPPORTED_CHAINS[0].id).toBe(80002);
  });

  it("includes the local Hardhat fallback", () => {
    expect(SUPPORTED_CHAINS.some((chain) => chain.id === 31337)).toBe(true);
  });

  it("contains no mainnet, so a misconfiguration cannot point at real value", () => {
    /*
     * The engagement's standing constraint: testnets only.
     *
     * The list is `as const`, so TypeScript narrows the ids to `80002 | 31337` and would
     * reject `chain.id === 1` outright as a comparison with no overlap — which is a
     * stronger guarantee than this assertion, because it fails at compile time. The widening
     * here is deliberate: it keeps the check meaningful as a runtime assertion if the tuple
     * ever loses its `as const` and the compile-time proof quietly evaporates.
     */
    const ids: readonly number[] = SUPPORTED_CHAINS.map((chain) => chain.id);

    // Ethereum and Polygon mainnet.
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(137);
  });
});

describe("truncateAddress", () => {
  it("keeps the leading and trailing characters that make an address recognisable", () => {
    expect(truncateAddress("0x7D26568Bc78f1e9838C2825eE6F283fa5164779B")).toBe("0x7D26…779B");
  });

  it("leaves a short string alone rather than mangling it", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234");
  });
});
