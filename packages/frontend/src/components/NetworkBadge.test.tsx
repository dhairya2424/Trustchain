import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/harness";

import { NetworkBadge } from "./NetworkBadge";

/**
 * The badge is a correctness feature: it is what stops a locally-executed record from
 * looking publicly verifiable. These tests exist mainly to assert that it never invents a
 * network name and never presents the fallback as the primary.
 */

const AMOY = {
  id: "amoy",
  label: "POLYGON AMOY",
  chainId: 80002,
  verifiability: "public",
  verifiabilityLabel: "Public Testnet / Publicly Verifiable",
  explorerUrl: "https://amoy.polygonscan.com",
  isPrimary: true,
  isFallback: false,
};

const HARDHAT = {
  id: "hardhat",
  label: "LOCAL HARDHAT",
  chainId: 31337,
  verifiability: "local",
  verifiabilityLabel: "Local Development/Demo / Locally Verifiable",
  explorerUrl: null,
  isPrimary: false,
  isFallback: true,
};

/**
 * A real Response, not a duck-typed stub.
 *
 * The badge reads through the shared API client now, which checks `response.ok` and parses
 * JSON the normal way — a hand-rolled object that happens to have those fields drifts from
 * what fetch actually returns.
 */
function mockNetwork(active: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ active }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NetworkBadge", () => {
  it("shows the Amoy label and its verifiability when Amoy is active", async () => {
    mockNetwork(AMOY);
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() =>
      expect(screen.getByTestId("network-badge")).toHaveAttribute("data-network", "amoy"),
    );
    expect(screen.getByText("POLYGON AMOY")).toBeInTheDocument();
    expect(screen.getByTestId("network-badge")).toHaveTextContent(
      "Public Testnet / Publicly Verifiable",
    );
  });

  it("does not show a fallback notice when running on the primary", async () => {
    mockNetwork(AMOY);
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() => expect(screen.getByTestId("network-badge")).toBeInTheDocument());
    expect(screen.queryByTestId("fallback-notice")).not.toBeInTheDocument();
  });

  it("shows the Hardhat label when the fallback is active", async () => {
    mockNetwork(HARDHAT);
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() =>
      expect(screen.getByTestId("network-badge")).toHaveAttribute("data-network", "hardhat"),
    );
    expect(screen.getByText("LOCAL HARDHAT")).toBeInTheDocument();
    expect(screen.getByTestId("network-badge")).toHaveTextContent(
      "Local Development/Demo / Locally Verifiable",
    );
  });

  /** The requirement, stated directly: never imply Amoy when running locally. */
  it("never shows the Amoy label while the fallback is active", async () => {
    mockNetwork(HARDHAT);
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() => expect(screen.getByTestId("network-badge")).toBeInTheDocument());
    expect(screen.getByTestId("network-badge")).not.toHaveTextContent("POLYGON AMOY");
  });

  it("says plainly that a fallback record is not publicly verifiable", async () => {
    mockNetwork(HARDHAT);
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() => expect(screen.getByTestId("fallback-notice")).toBeInTheDocument());
    expect(screen.getByTestId("fallback-notice")).toHaveTextContent("not publicly verifiable");
  });

  it("reports that no network is available rather than guessing, on 503", async () => {
    mockNetwork(null, 503);
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() =>
      expect(screen.getByTestId("network-badge")).toHaveAttribute("data-network", "unavailable"),
    );
    expect(screen.getByTestId("network-badge")).toHaveTextContent(
      "No blockchain network is currently available",
    );
  });

  it("reports an unreachable API rather than showing a stale network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    renderWithProviders(<NetworkBadge variant="full" />);

    await waitFor(() =>
      expect(screen.getByTestId("network-badge")).toHaveAttribute("data-network", "unavailable"),
    );
  });
});
