import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MotionProvider, useMotion } from "./MotionProvider";
import { installMatchMedia, setReducedMotion } from "../test/harness";

function Probe() {
  const motion = useMotion();
  return (
    <span data-testid="probe" data-reduced={String(motion.reduced)}>
      {motion.duration("base")}
    </span>
  );
}

describe("useReducedMotion", () => {
  beforeEach(() => {
    installMatchMedia(false);
  });

  it("reports no preference by default", () => {
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );

    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "false");
  });

  it("reports the preference when the media query matches", () => {
    installMatchMedia(true);

    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );

    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "true");
    expect(screen.getByTestId("probe")).toHaveTextContent("0");
  });

  it("follows a change made while the page is open", () => {
    // Both macOS and Windows apply this setting live. A value read once at import time
    // would leave the app animating at someone who just asked it to stop.
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );

    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "false");

    act(() => setReducedMotion(true));

    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "true");
  });

  it("follows a change back to full motion", () => {
    installMatchMedia(true);

    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );

    act(() => setReducedMotion(false));

    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "false");
  });

  it("survives an environment with no matchMedia at all", () => {
    // jsdom ships none by default, and neither do some embedded webviews. Throwing during
    // render would take down the entire app over a decorative concern.
    Reflect.deleteProperty(window, "matchMedia");

    expect(() =>
      render(
        <MotionProvider>
          <Probe />
        </MotionProvider>,
      ),
    ).not.toThrow();

    expect(screen.getByTestId("probe")).toHaveAttribute("data-reduced", "false");
  });
});

describe("useMotion outside its provider", () => {
  /*
   * eslint-disable no-console -- This test deliberately triggers a render-time throw, and
   * React writes the error to console.error before rethrowing it. Silencing that one
   * expected line keeps a passing run free of alarming output; the assertion afterwards
   * proves the real console.error is put back, so a genuine error in a later test is not
   * swallowed.
   */
  /* eslint-disable no-console */
  it("throws rather than quietly animating", () => {
    // The dangerous alternative is returning an un-reduced scheme, which would animate at
    // exactly the people who asked it not to — and silently.
    //
    // React logs the thrown error to console.error before rethrowing it, so this silences
    // an expected, deliberately-triggered error rather than hiding a real one.
    const original = console.error;
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<Probe />)).toThrow(/MotionProvider/);

    vi.mocked(console.error).mockRestore();
    expect(console.error).toBe(original);
  });
  /* eslint-enable no-console */
});
