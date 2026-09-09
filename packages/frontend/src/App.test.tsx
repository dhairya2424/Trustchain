import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "./App";
import { renderWithProviders } from "./test/harness";

/**
 * The four routes the shell has to serve, plus the parts of the shell that persist across
 * all of them.
 *
 * The placeholder routes are asserted on deliberately: they must say what they will contain
 * and must not present invented records. On a platform whose claim is that its records are
 * verifiable, a mocked-up audit row is the one placeholder that would undermine the product.
 */

const options = { wagmi: true } as const;

describe("App routing", () => {
  it("serves the landing page at /", () => {
    renderWithProviders(<App />, { ...options, route: "/" });
    expect(screen.getByRole("heading", { level: 1, name: /TrustChain/ })).toBeInTheDocument();
  });

  it("serves the dashboard", () => {
    // With no API stubbed, the session query never resolves, so this lands on the loading
    // state — which is the right thing to assert here: the route resolves to the dashboard
    // and reserves its layout while waiting. Its loaded states are covered in
    // routes/Dashboard.test.tsx.
    renderWithProviders(<App />, { ...options, route: "/dashboard" });
    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
  });

  it("serves the admin console", () => {
    // /admin is a real console now, not a scaffold — its own behaviour is covered in
    // admin/admin.test.tsx. Here we only assert the route resolves to it.
    renderWithProviders(<App />, { ...options, route: "/admin" });
    expect(screen.getByRole("heading", { level: 1, name: "Admin console" })).toBeInTheDocument();
  });

  it("serves the public verify route", () => {
    renderWithProviders(<App />, { ...options, route: "/verify" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Verify a credential" }),
    ).toBeInTheDocument();
  });

  it("answers an unknown path honestly instead of redirecting home", () => {
    // Silently sending someone to the landing page hides the fact that their link was
    // wrong, which is worse than a plain 'not found'.
    renderWithProviders(<App />, { ...options, route: "/nope" });
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});

describe("App shell", () => {
  it("offers a skip link as the first focusable element", () => {
    renderWithProviders(<App />, { ...options, route: "/" });
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
  });

  it("labels its primary navigation", () => {
    renderWithProviders(<App />, { ...options, route: "/" });
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("marks the current route as active for assistive technology", () => {
    renderWithProviders(<App />, { ...options, route: "/admin" });
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the network badge on every route, not only the landing page", () => {
    // Which chain a record landed on decides whether anyone else can verify it. That is
    // not something to make a user go looking for in a settings screen.
    renderWithProviders(<App />, { ...options, route: "/admin" });
    expect(screen.getAllByTestId("network-badge").length).toBeGreaterThan(0);
  });

  it("offers a connect control in the header and in the hero", () => {
    // Two on the landing page by design: the persistent header control, and the hero's
    // primary call to action.
    renderWithProviders(<App />, { ...options, route: "/" });
    expect(screen.getAllByTestId("connect-button")).toHaveLength(2);
  });

  it("offers exactly one connect control on an inner route", () => {
    renderWithProviders(<App />, { ...options, route: "/verify" });
    expect(screen.getAllByTestId("connect-button")).toHaveLength(1);
  });
});

/*
 * The "Planned contents" scaffolds are gone: every route now reads real data or says why it
 * cannot. The rule they existed to enforce — never render an invented record — is asserted
 * where the real data now lives, in Dashboard.test.tsx, admin/admin.test.tsx and
 * routes/Verify.test.tsx.
 */
describe("Public routes", () => {
  it("does not gate the verify route behind a wallet", () => {
    // Verification is public by design — no wallet, no account, no sign-in. A credential
    // only its issuer can check is not verifiable in any useful sense.
    renderWithProviders(<App />, { ...options, route: "/verify" });

    expect(screen.queryByTestId("wallet-gate")).not.toBeInTheDocument();
    expect(screen.getByTestId("verify-input")).toBeInTheDocument();
  });
});

describe("Landing page content", () => {
  it("names the three guarantees from the problem statement", () => {
    renderWithProviders(<App />, { ...options, route: "/" });

    expect(screen.getByText("Decentralized Identity")).toBeInTheDocument();
    expect(screen.getByText("On-Chain RBAC")).toBeInTheDocument();
    expect(screen.getByText("NFT Asset Ownership")).toBeInTheDocument();
  });

  it("lists exactly the four roles the platform defines", () => {
    // ADMIN, MANAGER, AUDITOR, USER — the fixed set. A fifth appearing in copy would be
    // the first sign of drift between the marketing surface and the contracts.
    renderWithProviders(<App />, { ...options, route: "/" });
    expect(screen.getByText(/ADMIN, MANAGER, AUDITOR, USER/)).toBeInTheDocument();
  });

  it("renders the hero field as decoration hidden from assistive technology", () => {
    const { container } = renderWithProviders(<App />, { ...options, route: "/" });

    const field = container.querySelector(".hero-field");
    expect(field).not.toBeNull();
    expect(field).toHaveAttribute("aria-hidden", "true");
  });

  it("uses the still hero for a reduced-motion visitor", () => {
    // No canvas and no animation loop at all — the static tier from selectRenderer.
    const { container } = renderWithProviders(<App />, {
      ...options,
      route: "/",
      reduced: true,
    });

    expect(container.querySelector('[data-renderer="static"]')).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });
});
