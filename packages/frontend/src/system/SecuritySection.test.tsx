import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecuritySection } from "./SecuritySection";
import { renderWithProviders } from "@/test/harness";

/**
 * The security section makes exactly one claim that depends on live state: whether a
 * stranger can verify these records without trusting us. It is true on a public testnet and
 * false on a local chain, and getting it backwards would be the most misleading sentence on
 * the page — it would tell a visitor the records are independently checkable when they are
 * not. Everything else here describes mechanisms and cannot drift.
 *
 * These moved with the component from the dashboard. The dashboard was the wrong audience:
 * somebody signed in and reading their own credentials has already accepted the premise.
 */

function mockNetwork(over: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        active: {
          id: "hardhat",
          label: "LOCAL HARDHAT",
          chainId: 31337,
          verifiability: "local",
          verifiabilityLabel: "Local Development/Demo / Locally Verifiable",
          explorerUrl: null,
          isPrimary: false,
          isFallback: true,
          ...over,
        },
      }),
    ),
  );
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("SecuritySection — telling the truth about verifiability", () => {
  it("claims independent verifiability only on a public network", async () => {
    mockNetwork({
      id: "amoy",
      label: "POLYGON AMOY",
      chainId: 80002,
      verifiability: "public",
      explorerUrl: "https://amoy.polygonscan.com",
      isPrimary: true,
      isFallback: false,
    });

    renderWithProviders(<SecuritySection />);

    await waitFor(() => expect(screen.getByText("Independently verifiable")).toBeInTheDocument());
    expect(screen.getByText(/without this platform's help/i)).toBeInTheDocument();
  });

  it("does not claim public verifiability on the local fallback", async () => {
    mockNetwork({});

    renderWithProviders(<SecuritySection />);

    await waitFor(() => expect(screen.getByText("Verifiable locally")).toBeInTheDocument());

    // The weaker claim must actually be made, not merely the stronger one omitted: a
    // visitor on the fallback needs to know an outsider still has to trust the operator.
    expect(screen.getByText(/still has to trust whoever runs it/i)).toBeInTheDocument();
    expect(screen.queryByText("Independently verifiable")).not.toBeInTheDocument();
  });

  it("explains that paying for a transaction is not permission to make it", async () => {
    // The confused-deputy property is the subtlest guarantee in the system and the one a
    // judge is most likely to probe. If this disappears, the page stops explaining why a
    // relayer holding the gas is not a relayer holding authority.
    mockNetwork({});

    renderWithProviders(<SecuritySection />);

    await waitFor(() =>
      expect(screen.getByText(/Paying for an action is not permission/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/no power to act as you/i)).toBeInTheDocument();
  });

  it("does not assert a verifiability level before the network is known", async () => {
    // `isPublic` is false both when the chain is local and when nothing has loaded, so
    // branching on it alone would claim "verifiable locally" while ignorant of the chain.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    renderWithProviders(<SecuritySection />);

    expect(await screen.findByText("Checking network")).toBeInTheDocument();
    expect(screen.queryByText("Independently verifiable")).not.toBeInTheDocument();
    expect(screen.queryByText("Verifiable locally")).not.toBeInTheDocument();
  });
});
