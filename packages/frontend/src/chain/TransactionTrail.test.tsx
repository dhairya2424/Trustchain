import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TransactionTrail } from "./TransactionTrail";
import { LiveChainContextForTests } from "./testing";
import { renderWithProviders } from "@/test/harness";
import type { LiveTransaction } from "./LiveChainProvider";

/**
 * What this component may claim, and when.
 *
 * The failure it exists to prevent is a confident one: telling somebody their action is on
 * the chain at the moment it was handed to a relayer. Everything below pins the boundary
 * between "we sent it" and "the chain accepted it", because that boundary is the product.
 */

const HASH = `0x${"ab".repeat(32)}`; // secrets-scan:allow inert fixture transaction hash
const AMOY = "https://amoy.polygonscan.com";

function transaction(over: Partial<LiveTransaction> = {}): LiveTransaction {
  return {
    network: "amoy",
    transactionHash: HASH,
    status: "pending",
    actor: "0xabc",
    action: null,
    submittedAt: Date.now(),
    ...over,
  };
}

function render(tx: LiveTransaction | undefined, props: Record<string, unknown> = {}) {
  return renderWithProviders(
    <LiveChainContextForTests
      value={{
        connected: true,
        lastMessageAt: Date.now(),
        transactions: tx ? { [HASH.toLowerCase()]: tx } : {},
      }}
    >
      <TransactionTrail hash={HASH} explorerUrl={AMOY} networkLabel="POLYGON AMOY" {...props} />
    </LiveChainContextForTests>,
  );
}

describe("TransactionTrail — what it may claim", () => {
  it("does not offer an explorer link before the chain has confirmed", async () => {
    // A link to a hash the chain has not recorded is a broken promise: the explorer would
    // show "not found" and the person would reasonably conclude the platform lied.
    render(transaction({ status: "pending" }));

    expect(screen.getByTestId("transaction-trail")).toHaveAttribute("data-status", "pending");
    expect(screen.queryByRole("link", { name: /PolygonScan/i })).not.toBeInTheDocument();
  });

  it("offers the explorer link once confirmed", async () => {
    render(transaction({ status: "confirmed", blockNumber: 47_140_285 }));

    const link = screen.getByRole("link", { name: /PolygonScan/i });
    expect(link).toHaveAttribute("href", `${AMOY}/tx/${HASH}`);
    // Opening an external site must not navigate the app away from itself.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("says which block and which network, rather than just 'done'", async () => {
    render(transaction({ status: "confirmed", blockNumber: 47_140_285 }));
    expect(screen.getByText(/block 47140285 on POLYGON AMOY/i)).toBeInTheDocument();
  });

  it("admits a local chain has nowhere to link to, instead of inventing one", async () => {
    render(transaction({ status: "confirmed", blockNumber: 42 }), { explorerUrl: null });

    expect(screen.queryByRole("link", { name: /PolygonScan/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no public explorer/i)).toBeInTheDocument();
  });

  it("reports a reverted transaction as failed, not confirmed", async () => {
    render(transaction({ status: "failed", detail: "the transaction was mined but reverted" }));

    expect(screen.getByTestId("transaction-trail")).toHaveAttribute("data-status", "failed");
    expect(screen.getByText(/reverted/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /PolygonScan/i })).not.toBeInTheDocument();
  });

  it("says a transaction was never mined rather than leaving it pending forever", async () => {
    render(transaction({ status: "dropped", detail: "no receipt after 11 minutes" }));

    expect(screen.getByText("Never mined")).toBeInTheDocument();
  });

  it("does not pretend to know anything before the first update arrives", async () => {
    render(undefined);

    expect(screen.getByTestId("transaction-trail")).toHaveAttribute("data-status", "submitted");
    expect(screen.getByText(/Waiting for the relayer/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /PolygonScan/i })).not.toBeInTheDocument();
  });

  it("renders nothing at all without a hash", async () => {
    const { container } = renderWithProviders(<TransactionTrail hash={null} explorerUrl={AMOY} />);
    expect(container.querySelector('[data-testid="transaction-trail"]')).toBeNull();
  });
});
