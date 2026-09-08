import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectModal } from "./ConnectModal";
import { ConnectButton } from "./ConnectButton";
import { renderWithProviders } from "../test/harness";

/**
 * The connect flow.
 *
 * Split between what the brief asks for (staggered options, pulse rings, a drawn checkmark,
 * confetti) and the things that decide whether the modal is usable at all: Escape, focus
 * containment, a labelled dialog and a live region. A modal that traps a keyboard user is
 * broken however well it animates, so both halves are covered here.
 */

describe("ConnectModal — structure", () => {
  it("renders nothing while closed", () => {
    renderWithProviders(<ConnectModal open={false} onClose={() => {}} />, { wagmi: true });
    expect(screen.queryByTestId("connect-modal")).not.toBeInTheDocument();
  });

  it("is a labelled modal dialog when open", () => {
    // aria-modal plus a label is what tells a screen reader this is a dialog and what it
    // is for, rather than an anonymous group of buttons.
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Connect a wallet");
  });

  it("lists the configured connectors as buttons", () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });
    expect(screen.getByTestId("wallet-option-mock")).toBeInTheDocument();
  });

  it("starts in the choosing phase", () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });
    expect(screen.getByTestId("connect-modal")).toHaveAttribute("data-phase", "choosing");
  });
});

describe("ConnectModal — dismissal", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderWithProviders(<ConnectModal open onClose={onClose} />, { wagmi: true });

    fireEvent.keyDown(screen.getByTestId("connect-modal"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a click outside the dialog", () => {
    const onClose = vi.fn();
    renderWithProviders(<ConnectModal open onClose={onClose} />, { wagmi: true });

    fireEvent.click(screen.getByTestId("connect-scrim"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close on a click inside the dialog", () => {
    // Without stopPropagation on the dialog, every click on a wallet option would also hit
    // the scrim and dismiss the modal mid-connection.
    const onClose = vi.fn();
    renderWithProviders(<ConnectModal open onClose={onClose} />, { wagmi: true });

    fireEvent.click(screen.getByTestId("connect-modal"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the explicit close control", () => {
    const onClose = vi.fn();
    renderWithProviders(<ConnectModal open onClose={onClose} />, { wagmi: true });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConnectModal — keyboard containment", () => {
  it("moves focus into the dialog when it opens", async () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("wallet-option-mock")).toHaveFocus());
  });

  it("wraps Tab from the last control back to the first", () => {
    // Otherwise Tab walks out of the dialog into the page behind it, which is still
    // rendered and still focusable.
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });

    const dialog = screen.getByTestId("connect-modal");
    const focusable = dialog.querySelectorAll<HTMLElement>("button");
    const last = focusable[focusable.length - 1]!;
    last.focus();

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });

    const dialog = screen.getByTestId("connect-modal");
    const focusable = dialog.querySelectorAll<HTMLElement>("button");
    const first = focusable[0]!;
    first.focus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(focusable[focusable.length - 1]).toHaveFocus();
  });
});

describe("ConnectModal — connecting and success", () => {
  it("moves to the pending phase and shows the pulse rings", async () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });

    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    await waitFor(() => expect(screen.getByTestId("connect-pending")).toBeInTheDocument());
    expect(screen.getByTestId("pulse-rings")).toBeInTheDocument();
  });

  it("reaches the success phase with a checkmark and confetti", async () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, { wagmi: true });

    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    await waitFor(() => expect(screen.getByTestId("connect-success")).toBeInTheDocument(), {
      timeout: 4000,
    });

    expect(screen.getByTestId("checkmark")).toBeInTheDocument();
    expect(screen.getByTestId("confetti")).toBeInTheDocument();
  });

  it("closes itself once the success state has been seen", async () => {
    const onClose = vi.fn();
    renderWithProviders(<ConnectModal open onClose={onClose} />, { wagmi: true });

    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 5000 });
  });
});

describe("ConnectModal — reduced motion", () => {
  it("omits the confetti entirely, since it carries no meaning to preserve", async () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, {
      wagmi: true,
      reduced: true,
    });

    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    await waitFor(() => expect(screen.getByTestId("connect-success")).toBeInTheDocument(), {
      timeout: 4000,
    });

    expect(screen.queryByTestId("confetti")).not.toBeInTheDocument();
  });

  it("still shows the checkmark, because the shape is the message", async () => {
    // The distinction the component draws: confetti is celebration and can go, a checkmark
    // says "connected" and must stay — just not drawn on.
    renderWithProviders(<ConnectModal open onClose={() => {}} />, {
      wagmi: true,
      reduced: true,
    });

    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    await waitFor(() => expect(screen.getByTestId("checkmark")).toBeInTheDocument(), {
      timeout: 4000,
    });

    expect(screen.getByTestId("checkmark")).toHaveAttribute("data-animated", "false");
  });

  it("shows a static ring instead of expanding pulses while pending", () => {
    renderWithProviders(<ConnectModal open onClose={() => {}} />, {
      wagmi: true,
      reduced: true,
    });

    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    const rings = screen.getByTestId("pulse-rings");
    expect(rings.className).toContain("pulse-rings--static");
  });
});

describe("ConnectButton", () => {
  it("opens the modal", () => {
    renderWithProviders(<ConnectButton />, { wagmi: true });

    expect(screen.queryByTestId("connect-modal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("connect-button"));
    expect(screen.getByTestId("connect-modal")).toBeInTheDocument();
  });

  it("shows a truncated address once connected", async () => {
    renderWithProviders(<ConnectButton />, { wagmi: true });

    fireEvent.click(screen.getByTestId("connect-button"));
    fireEvent.click(screen.getByTestId("wallet-option-mock"));

    await waitFor(() => expect(screen.getByTestId("account-chip")).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Truncated for layout, with the full value still available on hover and to a screen
    // reader through the title.
    expect(screen.getByTestId("account-chip").textContent).toMatch(/^0x[0-9a-fA-F]{4}…/);
    expect(screen.getByTestId("account-chip")).toHaveAttribute(
      "title",
      expect.stringContaining("0x"),
    );
  });
});
