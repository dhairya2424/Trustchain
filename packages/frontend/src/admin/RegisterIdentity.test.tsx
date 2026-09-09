import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoleManager } from "./RoleManager";
import { renderWithProviders } from "@/test/harness";

/**
 * The way out of "no DID is registered for this address".
 *
 * That line used to be the end of the road inside the product. An administrator could look
 * an address up, be told it could not hold a role, and have no way forward that did not
 * involve somebody opening a terminal and running `tools/onboard-wallet.mjs` against the
 * deployer key. The registration control appears exactly there, on the screen where the
 * problem is discovered.
 *
 * The other case worth pinning is the refusal. `registerDIDFor` is gated on ADMIN_ROLE held
 * on the DIDRegistry contract — a separate grant from the platform's role matrix — so an
 * account can hold the platform's ADMIN role, see this control, and still be refused. If that
 * sentence is wrong, an administrator is left staring at their own role badge.
 */

const ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useSignTypedData: () => ({ signTypedDataAsync: async () => `0x${"7".repeat(130)}` }),
  };
});

/** Answers the session and role lookups; `register` decides what /identity/register says. */
function stubApi(register: { status: number; body: unknown }) {
  // `init` is declared even though the stub ignores it, so the assertion below can read the
  // request body back off the recorded call.
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);

    if (url.includes("/auth/session")) {
      return new Response(
        JSON.stringify({ address: `0x${"1".repeat(40)}`, didHash: null, roles: ["ADMIN"] }),
        { status: 200 },
      );
    }

    if (url.includes("/roles/")) {
      // The address exists as a wallet and has no identity — the dead end this fixes.
      return new Response(JSON.stringify({ address: ADDRESS, did: null, roles: [] }), {
        status: 200,
      });
    }

    if (url.includes("/identity/register")) {
      return new Response(JSON.stringify(register.body), { status: register.status });
    }

    if (url.includes("/network/forward")) {
      return new Response(JSON.stringify({ transactionHash: `0x${"9".repeat(64)}` }), {
        status: 200,
      });
    }

    return new Response("{}", { status: 200 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const PREPARED = {
  didHash: `0x${"ab".repeat(32)}`,
  controller: ADDRESS,
  network: { id: "hardhat", label: "LOCAL HARDHAT", chainId: 31337 },
  typedData: {
    domain: {
      name: "TrustChainForwarder",
      chainId: 31337,
      verifyingContract: `0x${"1".repeat(40)}`,
    },
    types: { ForwardRequest: [{ name: "from", type: "address" }] },
    primaryType: "ForwardRequest",
    message: {
      from: `0x${"1".repeat(40)}`,
      to: `0x${"3".repeat(40)}`,
      value: "0",
      gas: "1500000",
      nonce: "0",
      deadline: 9_999_999_999,
      data: "0xdeadbeef",
    },
  },
};

/** Looks the address up, so the subject panel renders. */
async function lookUp() {
  renderWithProviders(<RoleManager />, { wagmi: true });

  fireEvent.change(screen.getByTestId("role-lookup-input"), { target: { value: ADDRESS } });
  fireEvent.click(screen.getByTestId("role-lookup"));

  return screen.findByTestId("role-subject");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoleManager — registering an identity", () => {
  it("offers registration exactly where the dead end was", async () => {
    stubApi({ status: 200, body: PREPARED });
    await lookUp();

    expect(await screen.findByTestId("subject-no-did")).toBeInTheDocument();
    expect(screen.getByTestId("register-identity")).toBeInTheDocument();
    expect(screen.getByTestId("register-identity-submit")).toBeEnabled();
  });

  it("says the identity is the subject's own, not the administrator's", async () => {
    // An administrator creating an identity is not acquiring one. The record names the
    // subject as controller, and the copy has to make that unambiguous before somebody
    // hesitates to click it.
    stubApi({ status: 200, body: PREPARED });
    await lookUp();

    expect(await screen.findByTestId("register-identity")).toHaveTextContent(
      /names the address as its own controller/i,
    );
  });

  it("posts the looked-up address and nothing else", async () => {
    const fetchMock = stubApi({ status: 200, body: PREPARED });
    await lookUp();

    fireEvent.click(await screen.findByTestId("register-identity-submit"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/identity/register"));
      expect(call).toBeDefined();
      // The DID hash is the server's to derive. A client that could name it could register
      // an address under an identity that already means something else.
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ address: ADDRESS });
    });
  });
});

describe("RoleManager — when the registry refuses", () => {
  it("distinguishes the DIDRegistry's admin role from the platform's", async () => {
    stubApi({ status: 403, body: { error: "forbidden" } });
    await lookUp();

    fireEvent.click(await screen.findByTestId("register-identity-submit"));

    const error = await waitFor(() => screen.getByTestId("register-error"));
    // The caller holds the platform's ADMIN role — the session stub says so. Telling them
    // simply "forbidden" would be true and useless.
    expect(error).toHaveTextContent(/ADMIN_ROLE on the DIDRegistry contract/i);
    expect(error).toHaveTextContent(/separate grant/i);
  });

  it("reports an address that already has an identity", async () => {
    stubApi({ status: 409, body: { error: "address_already_has_identity" } });
    await lookUp();

    fireEvent.click(await screen.findByTestId("register-identity-submit"));

    const error = await waitFor(() => screen.getByTestId("register-error"));
    expect(error).toHaveTextContent(/already controls a different identity/i);
  });
});
