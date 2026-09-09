import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Verify } from "./Verify";
import { renderWithProviders } from "@/test/harness";

/**
 * The public verifier.
 *
 * Two properties matter more than anything cosmetic: it must work with no session at all,
 * and it must never overstate what it checked.
 */

const HASH = `0x${"a".repeat(64)}`;

function verifyResponse(over: Record<string, unknown> = {}) {
  return {
    valid: true,
    status: "valid",
    credentialHash: HASH,
    proof: {
      signatureChecked: true,
      signatureValid: true,
      issuer: "0xissuer",
      issuedAt: "2026-01-01T00:00:00.000Z",
      ...(over.proof as Record<string, unknown>),
    },
    ...over,
  };
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

/**
 * Routes by URL rather than answering every request alike.
 *
 * The page renders a NetworkBadge, which polls `/network`. A mock that returned the verify
 * body for that too would feed it a shape it never receives, and any assertion about "the
 * first fetch call" would be measuring the badge rather than the verification.
 */
function mockVerify(body: unknown, status = 200) {
  // Both parameters are declared so `mock.calls` carries them; an untyped vi.fn() infers a
  // one-element tuple and reading `call[1]` is a compile error.
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/network")) {
      return new Response(JSON.stringify({ active: NETWORK }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Only the calls to /credentials/verify, ignoring the badge's own polling. */
function verifyCalls(fetchMock: ReturnType<typeof mockVerify>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("/credentials/verify"));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("Verify — public access", () => {
  it("renders without a session and asks for no wallet", () => {
    // The requirement, stated directly: a credential only its issuer can check is not
    // verifiable in any useful sense.
    mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: "/verify" });

    expect(screen.getByTestId("verify-input")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-button")).not.toBeInTheDocument();
  });

  it("sends no credentials on the verify request", async () => {
    // Anonymous by construction. Attaching the session cookie would make the public
    // endpoint behave differently for a signed-in visitor than for a stranger.
    const fetchMock = mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: "/verify" });

    fireEvent.change(screen.getByTestId("verify-input"), { target: { value: HASH } });
    fireEvent.click(screen.getByTestId("verify-submit"));

    await waitFor(() => expect(verifyCalls(fetchMock).length).toBe(1));

    const init = verifyCalls(fetchMock)[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBeUndefined();
  });
});

describe("Verify — one click from a shared link", () => {
  it("verifies immediately when the URL carries a hash", async () => {
    // The judge path: open the link, see the verdict, having done nothing.
    mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verdict")).toBeInTheDocument());
    expect(screen.getByTestId("verdict")).toHaveAttribute("data-kind", "authentic");
  });

  it("fires exactly one request for a shared link", async () => {
    const fetchMock = mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verdict")).toBeInTheDocument());
    expect(verifyCalls(fetchMock)).toHaveLength(1);
  });

  it("does nothing on load without a query parameter", () => {
    const fetchMock = mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: "/verify" });

    expect(verifyCalls(fetchMock)).toHaveLength(0);
  });
});

describe("Verify — verdicts", () => {
  it("shows AUTHENTIC for a live, correctly signed credential", async () => {
    mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("AUTHENTIC"));
  });

  it("shows REVOKED — not TAMPERED — for a withdrawn credential", async () => {
    mockVerify(
      verifyResponse({
        valid: false,
        status: "revoked",
        proof: {
          signatureChecked: true,
          signatureValid: true,
          revokedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    );
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() =>
      expect(screen.getByTestId("verdict")).toHaveAttribute("data-kind", "revoked"),
    );
    expect(screen.getByTestId("verdict")).not.toHaveTextContent("TAMPERED");
  });

  it("shows TAMPERED when the signature fails, whatever the chain says", async () => {
    mockVerify(
      verifyResponse({
        valid: false,
        status: "valid",
        proof: { signatureChecked: true, signatureValid: false },
      }),
    );
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() =>
      expect(screen.getByTestId("verdict")).toHaveAttribute("data-kind", "tampered"),
    );
  });

  it("shows UNREGISTERED for a hash the chain does not know", async () => {
    mockVerify(verifyResponse({ valid: false, status: "unknown", proof: {} }));
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() =>
      expect(screen.getByTestId("verdict")).toHaveAttribute("data-kind", "unregistered"),
    );
  });
});

describe("Verify — what it will not claim", () => {
  it("never reports an unreachable registry as a verdict about the credential", async () => {
    // 503 means unknown. Rendering a red "UNREGISTERED" here would be asserting something
    // about the credential from a failure to look.
    mockVerify({ error: "registry_unavailable" }, 503);
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verify-error")).toBeInTheDocument());
    expect(screen.queryByTestId("verdict")).not.toBeInTheDocument();
    expect(screen.getByTestId("verify-error")).toHaveTextContent(
      /not a statement about the credential/i,
    );
  });

  it("explains a rate limit rather than showing a verdict", async () => {
    mockVerify({ error: "rate_limited", retryAfterSeconds: 42 }, 429);
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verify-error")).toHaveTextContent("42"));
    expect(screen.queryByTestId("verdict")).not.toBeInTheDocument();
  });

  it("refuses input that is neither a hash nor a JWT without calling the API", async () => {
    const fetchMock = mockVerify(verifyResponse());
    renderWithProviders(<Verify />, { route: "/verify" });

    fireEvent.change(screen.getByTestId("verify-input"), { target: { value: "not a credential" } });
    fireEvent.click(screen.getByTestId("verify-submit"));

    await waitFor(() => expect(screen.getByTestId("verify-error")).toBeInTheDocument());
    expect(verifyCalls(fetchMock)).toHaveLength(0);
  });

  it("says the signature was not checked when only a hash was supplied", async () => {
    // The distinction the whole page rests on: a hash proves the chain has a live record,
    // not that this document is the one it refers to.
    mockVerify(verifyResponse({ proof: { signatureChecked: false, signatureValid: null } }));
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verdict")).toBeInTheDocument());
    expect(screen.getByTestId("verdict")).toHaveTextContent(/signature was not checked/i);
  });
});

describe("Verify — provenance and sharing", () => {
  it("builds the timeline from the facts the response carried", async () => {
    mockVerify(
      verifyResponse({
        proof: {
          signatureChecked: true,
          signatureValid: true,
          issuedAt: "2026-01-01T00:00:00.000Z",
          issuer: "0xissuer",
        },
      }),
    );
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("provenance-timeline")).toBeInTheDocument());

    const nodes = screen.getAllByTestId("timeline-node");
    expect(nodes.length).toBe(2); // issued + signature, and nothing invented
  });

  it("offers a share link carrying the hash", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockVerify(verifyResponse());

    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verify-share")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("verify-share"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0])).toContain(`hash=${HASH}`);
  });

  it("reports the chain status verbatim in the proof panel", async () => {
    mockVerify(verifyResponse({ status: "valid" }));
    renderWithProviders(<Verify />, { route: `/verify?hash=${HASH}` });

    await waitFor(() => expect(screen.getByTestId("verdict")).toBeInTheDocument());

    const proof = screen.getByText("On-chain status").closest("div");
    expect(within(proof!).getByText("valid")).toBeInTheDocument();
  });
});
