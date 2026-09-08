import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminLayout } from "./AdminLayout";
import { AuditLog } from "./AuditLog";
import { MintWizard } from "./MintWizard";
import { RoleManager } from "./RoleManager";
import { renderWithProviders } from "@/test/harness";
import type { AuditEntry, Session } from "@/api/queries";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const SESSION: Session = { address: ME, did: "did:trustchain:0xabc", roles: ["ADMIN"] };

function entry(over: Partial<AuditEntry> & { entryId: number }): AuditEntry {
  return {
    action: "ASSET_MINTED",
    actionCode: 1,
    actor: ME,
    executor: "0x1111111111111111111111111111111111111111",
    didHash: "0xdid",
    refHash: "0xref",
    via: "0x2222222222222222222222222222222222222222",
    blockNumber: 10,
    transactionHash: "0x3333333333333333333333333333333333333333333333333333333333333333", // secrets-scan:allow inert fixture transaction hash, not a key
    occurredAt: new Date().toISOString(),
    ...over,
  };
}

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

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("AdminLayout", () => {
  it("asks for a sign-in before showing any console", async () => {
    mockApi({ "/auth/session": { status: 401, body: { error: "unauthenticated" } } });

    renderWithProviders(<AdminLayout />, { wagmi: true, route: "/admin" });

    await waitFor(() => expect(screen.getByTestId("admin-signin")).toBeInTheDocument());
    expect(screen.queryByTestId("admin-rail")).not.toBeInTheDocument();
  });

  it("shows the rail and the roles the chain returned", async () => {
    mockApi({ "/auth/session": { body: SESSION } });

    renderWithProviders(<AdminLayout />, { wagmi: true, route: "/admin" });

    // The rail renders before the session resolves, so wait for the role itself.
    await waitFor(() => expect(screen.getByTestId("admin-role")).toHaveTextContent("ADMIN"));
    expect(screen.getByTestId("admin-rail")).toBeInTheDocument();
  });

  it("marks the current section with more than colour", async () => {
    // The indicator is a background block plus a weight change, so "current" survives for
    // a reader who cannot separate the hues.
    mockApi({ "/auth/session": { body: SESSION } });

    renderWithProviders(<AdminLayout />, { wagmi: true, route: "/admin" });

    await waitFor(() => expect(screen.getByTestId("admin-rail")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Audit log/ })).toHaveAttribute("aria-current", "page");
  });
});

describe("AuditLog", () => {
  it("reports a missing permission as permission rather than emptiness", async () => {
    mockApi({ "/audit": { status: 403, body: { error: "forbidden" } } });

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("audit-error")).toBeInTheDocument());
    expect(screen.getByTestId("audit-error")).toHaveTextContent("VIEW_AUDIT");
  });

  it("reports an unusable chain as unavailable rather than empty", async () => {
    mockApi({ "/audit": { status: 503, body: { error: "no_usable_network" } } });

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("audit-error")).toBeInTheDocument());
    expect(screen.getByTestId("audit-error")).toHaveTextContent("availability problem");
  });

  it("says nothing matched when the filter returns an empty page", async () => {
    mockApi({ "/audit": { body: { entries: [], nextCursor: null, source: "chain" } } });

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(screen.getByText("No entries match")).toBeInTheDocument());
  });

  it("reports which source answered, rather than hiding a degraded read", async () => {
    // A verifier is entitled to know whether the answer came from an indexer that may lag
    // or from the chain itself.
    mockApi({
      "/audit": { body: { entries: [entry({ entryId: 1 })], nextCursor: null, source: "chain" } },
    });

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("audit-source")).toHaveTextContent("chain"));
  });

  it("sends the filters the API actually accepts", async () => {
    // Typed with the input parameter so `mock.calls` carries it; an untyped vi.fn() infers
    // a zero-length tuple and indexing it is a compile error.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ entries: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("filter-actor"), { target: { value: ME } });
    fireEvent.change(screen.getByTestId("filter-action"), { target: { value: "ASSET_MINTED" } });
    fireEvent.click(screen.getByTestId("filter-apply"));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes(`actor=${ME}`))).toBe(true);
      expect(urls.some((url) => url.includes("action=ASSET_MINTED"))).toBe(true);
    });
  });

  it("converts a date filter to the unix seconds the API expects", async () => {
    // Typed with the input parameter so `mock.calls` carries it; an untyped vi.fn() infers
    // a zero-length tuple and indexing it is a compile error.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ entries: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AuditLog />, { wagmi: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("filter-from"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByTestId("filter-apply"));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      // 2026-01-01T00:00:00Z
      expect(urls.some((url) => url.includes("from=1767225600"))).toBe(true);
    });
  });

  it("leaves live mode off until it is asked for", async () => {
    // Polling falls back to getLogs, which scans blocks on every call. That is not
    // something a console should do to a chain unasked.
    mockApi({ "/audit": { body: { entries: [], nextCursor: null } } });

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("live-toggle")).toBeInTheDocument());
    expect(screen.getByTestId("live-toggle")).toHaveAttribute("data-live", "off");
    expect(screen.getByTestId("live-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("turns live mode on when toggled", async () => {
    mockApi({ "/audit": { body: { entries: [], nextCursor: null } } });

    renderWithProviders(<AuditLog />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("live-toggle")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("live-toggle"));

    expect(screen.getByTestId("live-toggle")).toHaveAttribute("data-live", "on");
  });
});

describe("MintWizard", () => {
  beforeEach(() => {
    mockApi({ "/auth/session": { body: SESSION } });
  });

  /**
   * Advances a step and waits for the new panel.
   *
   * `AnimatePresence mode="wait"` holds the incoming step until the outgoing one has
   * finished exiting, so the next panel is not in the DOM synchronously after the click.
   */
  async function advanceTo(testId: string) {
    fireEvent.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
  }

  async function fillDetails(name = "Turbine 4", description = "Gearbox assembly") {
    fireEvent.change(screen.getByTestId("mint-name"), { target: { value: name } });
    fireEvent.change(screen.getByTestId("mint-description"), { target: { value: description } });
    await advanceTo("wizard-upload");
  }

  it("will not advance past details until both fields are filled", () => {
    renderWithProviders(<MintWizard />, { wagmi: true });

    expect(screen.getByTestId("wizard-next")).toBeDisabled();

    fireEvent.change(screen.getByTestId("mint-name"), { target: { value: "Turbine 4" } });
    expect(screen.getByTestId("wizard-next")).toBeDisabled();

    fireEvent.change(screen.getByTestId("mint-description"), {
      target: { value: "Gearbox assembly" },
    });
    expect(screen.getByTestId("wizard-next")).toBeEnabled();
  });

  it("will not advance past upload without a file", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });

    await fillDetails();

    expect(screen.getByTestId("wizard-next")).toBeDisabled();
  });

  it("refuses a file over the server's limit before uploading it", async () => {
    // Rejecting here saves a doomed 20MB upload and gives a better message than a 413.
    renderWithProviders(<MintWizard />, { wagmi: true });

    await fillDetails();

    const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [big] } });

    expect(screen.getByTestId("file-error")).toHaveTextContent("limit is 10 MB");
    expect(screen.getByTestId("wizard-next")).toBeDisabled();
  });

  it("accepts a file within the limit and reaches confirm", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });

    await fillDetails();

    const small = new File(["x"], "art.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [small] } });
    await advanceTo("wizard-confirm");

    expect(screen.getByTestId("wizard-confirm")).toHaveTextContent("Turbine 4");
    expect(screen.getByTestId("wizard-confirm")).toHaveTextContent("art.png");
  });

  it("warns on the confirm step that a mint is permanent", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });

    await fillDetails();
    fireEvent.change(screen.getByTestId("file-input"), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    await advanceTo("wizard-confirm");

    expect(screen.getByTestId("wizard-confirm")).toHaveTextContent("cannot be undone");
  });

  it("shows the drop zone reacting to a drag", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });

    await fillDetails();

    const zone = screen.getByTestId("drop-zone");
    expect(zone).toHaveAttribute("data-dragging", "false");

    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute("data-dragging", "true");
  });
});

describe("RoleManager", () => {
  beforeEach(() => {
    mockApi({ "/auth/session": { body: SESSION } });
  });

  it("lists exactly the four roles the platform defines", async () => {
    renderWithProviders(<RoleManager />, { wagmi: true });

    await waitFor(() => expect(screen.getAllByTestId("role-row")).toHaveLength(4));

    const ids = screen.getAllByTestId("role-row").map((row) => row.getAttribute("data-role"));
    expect(ids).toEqual(["ADMIN", "MANAGER", "AUDITOR", "USER"]);
  });

  it("marks which roles the signed-in identity actually holds", async () => {
    renderWithProviders(<RoleManager />, { wagmi: true });

    await waitFor(() =>
      expect(screen.getAllByTestId("role-row")[0]).toHaveAttribute("data-held", "true"),
    );

    const rows = screen.getAllByTestId("role-row");
    expect(within(rows[0]!).getByText("Held")).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute("data-held", "false");
  });

  /**
   * The important one.
   *
   * A toggle that flips, animates and changes nothing on-chain would be worse than no
   * toggle: someone would grant "ADMIN" to a colleague, see it turn green, and believe it.
   * So the console renders no role-mutating control at all while the API has no endpoint
   * for it, and says so.
   */
  it("ships no grant or revoke control while the API has none", async () => {
    renderWithProviders(<RoleManager />, { wagmi: true });

    await waitFor(() => expect(screen.getByTestId("roles-not-wired")).toBeInTheDocument());

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /grant/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("explains that the absence is a missing endpoint, not a disabled feature", async () => {
    renderWithProviders(<RoleManager />, { wagmi: true });

    await waitFor(() =>
      expect(screen.getByTestId("roles-not-wired")).toHaveTextContent(
        "no endpoint to change a role",
      ),
    );
  });
});
