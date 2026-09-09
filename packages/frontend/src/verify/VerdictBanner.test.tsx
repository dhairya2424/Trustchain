import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VerdictBanner } from "./VerdictBanner";
import { renderWithProviders } from "@/test/harness";
import type { Verdict } from "./verdict";

/**
 * The product's one authored moment.
 *
 * These are not tests of the animation's prettiness — they pin the three decisions that
 * make it meaningful rather than decorative, each of which is easy to undo by accident.
 */

const AUTHENTIC: Verdict = {
  kind: "authentic",
  tone: "verified",
  title: "AUTHENTIC",
  detail: "The chain holds a live, unrevoked record for this hash.",
};

const TAMPERED: Verdict = {
  kind: "tampered",
  tone: "revoked",
  title: "TAMPERED",
  detail: "The signature does not verify over this document.",
};

describe("VerdictBanner — the mark is drawn, not typed", () => {
  it("renders the seal as real geometry rather than a text glyph", () => {
    // It used to be `{positive ? "✓" : "✕"}`. A Unicode tick is whatever face the platform
    // happens to have — a different weight, a different optical size, no relationship to
    // the rest of the icon set, and nothing that can be drawn on.
    const { container } = renderWithProviders(<VerdictBanner verdict={AUTHENTIC} />);

    const seal = screen.getByTestId("verdict-seal");
    expect(seal.tagName.toLowerCase()).toBe("svg");
    expect(seal.querySelector("circle")).not.toBeNull();
    expect(seal.querySelector("path")).not.toBeNull();

    expect(container.textContent).not.toMatch(/[✓✕]/);
  });

  it("hides the seal from assistive technology, since the words carry the verdict", () => {
    renderWithProviders(<VerdictBanner verdict={AUTHENTIC} />);
    expect(screen.getByTestId("verdict-seal")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("VerdictBanner — failure is a different gesture, not a red success", () => {
  it("draws a cross for a failed verdict and a tick for a passing one", () => {
    const pass = renderWithProviders(<VerdictBanner verdict={AUTHENTIC} />);
    const tick = pass.container
      .querySelector('[data-testid="verdict-seal"] path')
      ?.getAttribute("d");
    pass.unmount();

    renderWithProviders(<VerdictBanner verdict={TAMPERED} />);
    const cross = screen.getByTestId("verdict-seal").querySelector("path")?.getAttribute("d");

    expect(tick).toBeTruthy();
    expect(cross).toBeTruthy();
    expect(cross).not.toBe(tick);
    // A cross is two strokes in one path; a tick is one polyline. The shapes differ, so a
    // colour-blind reader gets the answer from form as well as from hue.
    expect(cross).toContain("M");
  });
});

describe("VerdictBanner — reduced motion still delivers the answer", () => {
  it("keeps the verdict, the mark and the explanation", () => {
    // Reduced means instant, not absent. Someone who asked the system to stop moving things
    // still needs to know whether the credential is real.
    renderWithProviders(<VerdictBanner verdict={AUTHENTIC} />, { reduced: true });

    expect(screen.getByTestId("verdict")).toHaveAttribute("data-kind", "authentic");
    expect(screen.getByText("AUTHENTIC")).toBeInTheDocument();
    expect(screen.getByText(/live, unrevoked record/i)).toBeInTheDocument();
    expect(screen.getByTestId("verdict-seal")).toHaveAttribute("data-animated", "false");
  });

  it("announces itself rather than waiting to be noticed", () => {
    renderWithProviders(<VerdictBanner verdict={TAMPERED} />);

    const banner = screen.getByTestId("verdict");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });
});
