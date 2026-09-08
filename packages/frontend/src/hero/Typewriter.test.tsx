import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Typewriter } from "./Typewriter";
import { renderWithProviders } from "../test/harness";

const TEXT = "Identity. Authority. Ownership.";

describe("Typewriter", () => {
  it("always exposes the full sentence to assistive technology", async () => {
    // The animated copy is aria-hidden and the full text sits in a visually-hidden span, so
    // a screen reader reads one finished sentence instead of re-announcing every keystroke.
    renderWithProviders(<Typewriter text={TEXT} speed={1} startDelay={0} />);

    expect(screen.getByTestId("typewriter")).toHaveTextContent(TEXT);
  });

  it("types the text out over time", async () => {
    renderWithProviders(<Typewriter text={TEXT} speed={1} startDelay={0} />);

    const node = screen.getByTestId("typewriter");
    expect(node).toHaveAttribute("data-complete", "false");

    await waitFor(() => expect(node).toHaveAttribute("data-complete", "true"), {
      timeout: 4000,
    });
  });

  it("shows a caret while typing and drops it when finished", async () => {
    renderWithProviders(<Typewriter text={TEXT} speed={1} startDelay={0} />);

    expect(screen.getByTestId("typewriter-caret")).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByTestId("typewriter-caret")).not.toBeInTheDocument(), {
      timeout: 4000,
    });
  });

  it("presents the text immediately under reduced motion", () => {
    // Not typed faster — present. And complete on the very first render, with no caret,
    // so there is nothing animating at all.
    renderWithProviders(<Typewriter text={TEXT} speed={50} startDelay={999_999} />, {
      reduced: true,
    });

    const node = screen.getByTestId("typewriter");
    expect(node).toHaveAttribute("data-complete", "true");
    expect(screen.queryByTestId("typewriter-caret")).not.toBeInTheDocument();
    expect(node).toHaveTextContent(TEXT);
  });

  it("does not double the text for a sighted reader", () => {
    // The sentence appears twice in the DOM by design. Only one copy is visible, and the
    // other is the accessible one — if both rendered visibly the tagline would read twice.
    renderWithProviders(<Typewriter text={TEXT} speed={50} startDelay={0} />, {
      reduced: true,
    });

    const hidden = screen.getByTestId("typewriter").querySelector(".sr-only");
    expect(hidden).not.toBeNull();
    expect(hidden).toHaveTextContent(TEXT);
  });
});
