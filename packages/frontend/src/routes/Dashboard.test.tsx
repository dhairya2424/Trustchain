import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "./Dashboard";
import { renderWithProviders } from "@/test/harness";
import type { AuditEntry, Session } from "@/api/queries";

/**
 * The dashboard's contract is mostly negative: it must never show a record it did not
 * read, and it must distinguish "you have none" from "you may not look" from "nothing is
 * available". Those three states look identical in a careless implementation — an empty
 * grid — and mean completely different things to someone relying on the record.
 */

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const SESSION: Session = {
  address: ME,
  did: "did:trustchain:0xabc123",
  roles: ["ADMIN", "AUDITOR"],
};

/**
 * A real `AuditEntryDto`, not an approximation of one.
 *
 * These fixtures previously used invented field names, and every test passed because the
 * mock encoded the same mistake the component made — the whole page would have rendered
 * empty against the real API. The shape here mirrors
 * `packages/backend/src/audit/serializers.ts` exactly, so a drift on either side now fails
 * a test rather than shipping.
 */
function entry(over: Partial<AuditEntry> & { entryId: number; action: string }): AuditEntry {
  return {
    actionCode: 1,
    actor: ME,
    executor: "0x1111111111111111111111111111111111111111",
    didHash: "0xdid",
    refHash: "0xref",
    via: "0x2222222222222222222222222222222222222222",
    blockNumber: 1,
    transactionHash: "0x3333333333333333333333333333333333333333333333333333333333333333", // secrets-scan:allow inert fixture transaction hash, not a key
    occurredAt: new Date().toISOString(),
    ...over,
  };
}

/** Routes fetch by path, so a test can describe the whole API surface it needs. */
function mockApi(routes: Record<string, { status?: number; body?: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const match = Object.keys(routes).find((path) => url.includes(path));

      if (!match) return new Response("{}", { status: 404 });

      const route = routes[match]!;
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard — signed out", () => {
  it("asks for a sign-in rather than showing an empty cockpit", async () => {
    // An empty dashboard would read as "you own nothing", which is a claim about the chain
    // rather than about the session.
    mockApi({ "/auth/session": { status: 401, body: { error: "unauthenticated" } } });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("signin-prompt")).toBeInTheDocument());
    expect(screen.queryByTestId("asset-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
  });
});

describe("Dashboard — identity", () => {
  it("shows the DID read from the session", async () => {
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { body: { entries: [], nextCursor: null } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() =>
      expect(screen.getByTestId("identity-did")).toHaveTextContent("did:trustchain:0xabc123"),
    );
  });

  it("renders a QR of the DID, and none at all when there is no DID", async () => {
    mockApi({
      "/auth/session": { body: { ...SESSION, did: null } },
      "/audit": { body: { entries: [], nextCursor: null } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("identity-no-did")).toBeInTheDocument());
    // A placeholder QR would encode nothing and scan to nothing.
    expect(screen.queryByTestId("identity-qr")).not.toBeInTheDocument();
  });

  it("lists the roles the chain returned", async () => {
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { body: { entries: [], nextCursor: null } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getAllByTestId("identity-role")).toHaveLength(2));
  });

  it("does not tilt when there is no fine pointer to tilt toward", async () => {
    // jsdom's matchMedia stub reports no hover, which is the phone case: a tilt there fires
    // on tap and lurches while you are trying to read.
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { body: { entries: [], nextCursor: null } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("identity-card")).toBeInTheDocument());
    expect(screen.getByTestId("identity-card")).toHaveAttribute("data-tilt", "off");
  });
});

describe("Dashboard — derived panels", () => {
  const entries = [
    entry({ entryId: 1, action: "ASSET_MINTED", refHash: "0xasset1", blockNumber: 10 }),
    entry({ entryId: 2, action: "CREDENTIAL_ISSUED", refHash: "0xcred1", blockNumber: 11 }),
    entry({ entryId: 3, action: "CREDENTIAL_REVOKED", refHash: "0xcred1", blockNumber: 12 }),
    entry({ entryId: 4, action: "DID_REGISTERED", blockNumber: 9 }),
  ];

  beforeEach(() => {
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { body: { entries, nextCursor: null, source: "chain" } },
    });
  });

  it("shows a minted asset derived from the audit trail", async () => {
    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("asset-grid")).toBeInTheDocument());
    expect(screen.getAllByTestId("asset-card")).toHaveLength(1);
  });

  it("never invents artwork for an asset whose metadata it does not have", async () => {
    // The audit entry carries no CID, so there is no image to show. A stock picture here
    // would be a fabricated record on the one screen that must not fabricate.
    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("asset-grid")).toBeInTheDocument());
    expect(screen.getByTestId("asset-artwork-absent")).toBeInTheDocument();
    expect(screen.queryByTestId("asset-image")).not.toBeInTheDocument();
  });

  it("marks a credential revoked when a later event revoked it", async () => {
    // The later fact wins. Showing this as valid because the issuance came first would be
    // the worst bug this screen could have.
    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("credential-badges")).toBeInTheDocument());

    const badge = screen.getByTestId("credential-badge");
    expect(badge).toHaveAttribute("data-revoked", "true");
    expect(within(badge).getByText("Revoked")).toBeInTheDocument();
  });

  it("counts only what the trail actually returned", async () => {
    renderWithProviders(<Dashboard />, { wagmi: true });

    // Waits on the value rather than on the element: the counters render immediately at
    // zero and only become correct once the audit query resolves.
    await waitFor(() =>
      expect(screen.getAllByTestId("stat-counter")[0]).toHaveAttribute("data-value", "1"),
    );

    const counters = screen.getAllByTestId("stat-counter");
    expect(counters[0]).toHaveAttribute("data-value", "1"); // one mint
    expect(counters[1]).toHaveAttribute("data-value", "1"); // one issuance
    expect(counters[2]).toHaveAttribute("data-value", "1"); // one revocation
    expect(counters[3]).toHaveAttribute("data-value", "2"); // two roles
  });

  it("lists every event in the activity feed, not only the derived ones", async () => {
    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeInTheDocument());
    expect(screen.getAllByTestId("activity-row")).toHaveLength(4);
  });
});

describe("Dashboard — the three kinds of nothing", () => {
  it("says 'no assets yet' when the trail is genuinely empty", async () => {
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { body: { entries: [], nextCursor: null } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getAllByTestId("empty-state").length).toBeGreaterThan(0));
    expect(screen.getByText("No assets yet")).toBeInTheDocument();
  });

  it("says a missing permission is a permission problem, not an empty history", async () => {
    // The RBAC working, shown as such. An empty grid here would be a claim about the chain
    // that this account is not entitled to make.
    mockApi({
      "/auth/session": { body: { ...SESSION, roles: ["USER"] } },
      "/audit": { status: 403, body: { error: "forbidden" } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("activity-forbidden")).toBeInTheDocument());
    expect(screen.getByTestId("activity-forbidden")).toHaveTextContent("VIEW_AUDIT");
    expect(screen.queryByText("No assets yet")).not.toBeInTheDocument();
  });

  it("says an unusable chain is unavailable, not empty", async () => {
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { status: 503, body: { error: "no_usable_network" } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("activity-unavailable")).toBeInTheDocument());
  });

  it("blanks the stat counters rather than reporting zero it cannot verify", async () => {
    // A confident "0 assets" when the trail could not be read is a false statement about
    // the chain. An em dash is not.
    mockApi({
      "/auth/session": { body: SESSION },
      "/audit": { status: 403, body: { error: "forbidden" } },
    });

    renderWithProviders(<Dashboard />, { wagmi: true });

    // Waits for the 403 to land — before it does, the counters are legitimately showing a
    // not-yet-known zero rather than an unverifiable one.
    await waitFor(() => expect(screen.getByTestId("activity-forbidden")).toBeInTheDocument());

    const counters = screen.getAllByTestId("stat-counter");
    expect(counters).toHaveLength(4);

    // The three audit-derived figures are blanked; "roles held" comes from the session and
    // is still known, so it keeps its number.
    const blanked = counters.filter((counter) => counter.textContent?.includes("—"));
    expect(blanked).toHaveLength(3);

    // "Roles held" comes from the session rather than the audit trail, so it is still
    // known and keeps its number. That asymmetry is the point: each figure is blanked
    // exactly when *its own* source could not be read.
    expect(counters[3]?.textContent).not.toContain("—");
  });
});
