import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetGrid } from "./AssetGrid";
import { renderWithProviders } from "@/test/harness";
import type { OwnedAssets } from "@/api/queries";

/**
 * Transferring an asset — the gap between what the contract records and what the product
 * could do.
 *
 * `AssetRegistry` has written `ASSET_TRANSFERRED` since the first deployment, through the
 * `_update` choke point that mint, transfer and reclaim all pass through. There was simply
 * no way to reach it: no endpoint, no control. These tests pin the control's behaviour and,
 * more importantly, the refusals a user is most likely to meet.
 */

const REGISTRY = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function owned(overrides: Partial<OwnedAssets> = {}): OwnedAssets {
  return {
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    balance: 2,
    tokens: [
      { tokenId: 1, tokenURI: null, ownerDidHash: null, soulbound: false },
      { tokenId: 2, tokenURI: null, ownerDidHash: null, soulbound: true },
    ],
    truncated: false,
    totalMinted: 2,
    network: "hardhat",
    explorerUrl: null,
    assetRegistry: REGISTRY,
    ...overrides,
  };
}

/** Opens the dialog on the first (transferable) asset. */
async function openDialog() {
  renderWithProviders(<AssetGrid owned={owned()} isLoading={false} />, { wagmi: true });
  fireEvent.click(screen.getAllByTestId("asset-transfer")[0]!);
  return screen.findByTestId("transfer-dialog");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssetGrid — the transfer control", () => {
  it("offers a transfer on each owned asset", () => {
    renderWithProviders(<AssetGrid owned={owned()} isLoading={false} />, { wagmi: true });

    expect(screen.getAllByTestId("asset-transfer")).toHaveLength(2);
  });

  it("disables the control on a soulbound asset and says why", () => {
    // Not hidden. "Why can I move that one and not this one" is a question the interface
    // should answer without being asked, and an absent control answers nothing.
    renderWithProviders(<AssetGrid owned={owned()} isLoading={false} />, { wagmi: true });

    const [transferable, soulbound] = screen.getAllByTestId("asset-transfer");
    expect(transferable).toBeEnabled();
    expect(soulbound).toBeDisabled();
    expect(soulbound).toHaveAttribute("title", expect.stringContaining("Soulbound"));
  });

  it("opens a dialog naming the asset", async () => {
    await openDialog();
    expect(screen.getByText(/Transfer asset #1/)).toBeInTheDocument();
  });
});

describe("TransferDialog — what it refuses to send", () => {
  it("will not submit until the recipient looks like an address", async () => {
    await openDialog();

    const field = screen.getByTestId("transfer-recipient");
    const submit = screen.getByTestId("transfer-submit");

    expect(submit).toBeDisabled();

    fireEvent.change(field, { target: { value: "0xnope" } });
    expect(screen.getByTestId("transfer-malformed")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(field, { target: { value: RECIPIENT } });
    expect(screen.queryByTestId("transfer-malformed")).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it("explains a refusal in the dialog, where the field that caused it still is", async () => {
    // The API's specific reason, not "transfer failed". A recipient with no identity is
    // fixable by the person reading this, and only if they are told which of six conditions
    // they hit.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "recipient_has_no_identity" }), { status: 400 }),
      ),
    );

    await openDialog();
    fireEvent.change(screen.getByTestId("transfer-recipient"), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId("transfer-submit"));

    const error = await waitFor(() => screen.getByTestId("transfer-error"));
    expect(error).toHaveTextContent(/no identity on this platform/i);
    // Still open, with the address still in the field — the fix is usually to that field.
    expect(screen.getByTestId("transfer-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("transfer-recipient")).toHaveValue(RECIPIENT);
  });

  it("names the stale-holder refusal for what it is", async () => {
    // The most important refusal in the set: a key that no longer controls the owning
    // identity cannot pass the asset to a third party. That is a rotated-out key being
    // denied the power a stolen one would want, and the sentence has to say so.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "stale_holder" }), { status: 400 })),
    );

    await openDialog();
    fireEvent.change(screen.getByTestId("transfer-recipient"), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId("transfer-submit"));

    const error = await waitFor(() => screen.getByTestId("transfer-error"));
    expect(error).toHaveTextContent(/no longer controls the identity/i);
  });
});
