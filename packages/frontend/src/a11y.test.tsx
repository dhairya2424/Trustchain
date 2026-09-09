import { fireEvent, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { renderWithProviders } from "./test/harness";

/**
 * Accessibility, checked by axe rather than by eye.
 *
 * The rule is zero violations on every route and on the interactive states a keyboard user
 * actually lands in. Running axe against the *rendered* tree catches the things review
 * misses — a control with no accessible name, a heading level skipped, a landmark nested
 * where it changes meaning — and it catches them as a build failure rather than as feedback
 * from someone who could not use the product.
 *
 * Two limits worth stating rather than leaving implied:
 *
 *   - **Colour contrast is not asserted here.** jsdom computes no layout and resolves no
 *     CSS custom properties, so axe's contrast rule cannot run and would report a false
 *     pass. The palette is fixed in `theme.css` and checked there; a browser-based check
 *     belongs with the Playwright suite.
 *   - **These are static snapshots.** axe cannot tell whether focus *moves* correctly, so
 *     the focus-order behaviour is asserted separately in the component tests that drive it.
 */

/** axe rules that cannot produce a meaningful result under jsdom. */
const DISABLED_RULES = {
  // No layout, no resolved custom properties — see above.
  "color-contrast": { enabled: false },
};

async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: DISABLED_RULES,
    resultTypes: ["violations"],
  });

  // Named in the failure message so a regression says *what* broke rather than "1 !== 0".
  const summary = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n  ${violation.nodes
        .map((node) => node.html)
        .slice(0, 3)
        .join("\n  ")}`,
  );

  expect(summary).toEqual([]);
}

const NETWORK = {
  id: "hardhat",
  label: "LOCAL HARDHAT",
  chainId: 31337,
  verifiability: "local",
  verifiabilityLabel: "Local Development/Demo / Locally Verifiable",
  explorerUrl: null,
  isPrimary: false,
  isFallback: true,
};

const SESSION = {
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  did: "did:trustchain:0xabc",
  roles: ["ADMIN"],
};

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      const body = url.includes("/network")
        ? { active: NETWORK }
        : url.includes("/auth/session")
          ? SESSION
          : url.includes("/audit")
            ? { entries: [], nextCursor: null, source: "chain" }
            : {};

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mockApi();
});

afterEach(() => vi.unstubAllGlobals());

describe("axe — every route", () => {
  const routes = ["/", "/dashboard", "/admin", "/admin/mint", "/admin/roles", "/verify", "/nope"];

  for (const route of routes) {
    it(`has no violations on ${route}`, async () => {
      const { container } = renderWithProviders(<App />, { wagmi: true, route });

      // Let the first queries settle, so the scan sees the loaded page rather than only
      // its skeletons.
      await waitFor(() => expect(screen.getAllByTestId("network-badge").length).toBeGreaterThan(0));

      await expectNoViolations(container);
    }, 30_000);
  }
});

describe("axe — interactive states", () => {
  it("has no violations with the wallet modal open", async () => {
    // A dialog is where accessibility most often breaks: no accessible name, no modal
    // semantics, or a close control that is an icon with no label.
    const { baseElement } = renderWithProviders(<App />, { wagmi: true, route: "/" });

    fireEvent.click(screen.getAllByTestId("connect-button")[0]!);
    await waitFor(() => expect(screen.getByTestId("connect-modal")).toBeInTheDocument());

    // The dialog renders in a portal outside `container`, so the whole document is scanned.
    await expectNoViolations(baseElement as HTMLElement);
  }, 30_000);

  it("has no violations on the mint wizard's later steps", async () => {
    const { container } = renderWithProviders(<App />, { wagmi: true, route: "/admin/mint" });

    await waitFor(() => expect(screen.getByTestId("mint-name")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("mint-name"), { target: { value: "Turbine 4" } });
    fireEvent.change(screen.getByTestId("mint-description"), { target: { value: "Gearbox" } });
    fireEvent.click(screen.getByTestId("wizard-next"));

    await waitFor(() => expect(screen.getByTestId("wizard-upload")).toBeInTheDocument());

    await expectNoViolations(container);
  }, 30_000);

  it("has no violations once a verdict is on screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes("/network")) {
          return new Response(JSON.stringify({ active: NETWORK }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            valid: true,
            status: "valid",
            credentialHash: `0x${"a".repeat(64)}`,
            proof: {
              signatureChecked: true,
              signatureValid: true,
              issuer: "0xissuer",
              issuedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const { container } = renderWithProviders(<App />, {
      wagmi: true,
      route: `/verify?hash=0x${"a".repeat(64)}`,
    });

    await waitFor(() => expect(screen.getByTestId("verdict")).toBeInTheDocument());

    await expectNoViolations(container);
  }, 30_000);
});

describe("keyboard reachability", () => {
  it("puts the skip link first, before the navigation", () => {
    // A keyboard user should not tab the whole nav on every route to reach the content.
    const { container } = renderWithProviders(<App />, { wagmi: true, route: "/" });

    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );

    expect(focusable[0]?.textContent).toContain("Skip to content");
  });

  it("gives every interactive element an accessible name", () => {
    // The single most common a11y defect: an icon-only control that a screen reader
    // announces as "button".
    const { container } = renderWithProviders(<App />, { wagmi: true, route: "/verify" });

    const controls = container.querySelectorAll<HTMLElement>("button, a[href]");

    const unnamed = [...controls].filter((element) => {
      const name =
        element.getAttribute("aria-label") ??
        element.getAttribute("title") ??
        element.textContent?.trim();
      return !name;
    });

    expect(unnamed.map((element) => element.outerHTML.slice(0, 120))).toEqual([]);
  });

  it("marks the current route for assistive technology, not only visually", () => {
    const { container } = renderWithProviders(<App />, { wagmi: true, route: "/verify" });

    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain("Verify");
  });
});
