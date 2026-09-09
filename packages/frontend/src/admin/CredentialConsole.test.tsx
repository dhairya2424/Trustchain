import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialConsole } from "./CredentialConsole";
import { renderWithProviders } from "@/test/harness";

/**
 * The credentials console.
 *
 * The API implemented issuance and revocation from the start — permissions, EIP-712
 * attribution, audit records, sealed envelopes — and none of it was reachable from the
 * interface. Only verification was, which meant the platform could prove a credential and
 * not make one.
 *
 * The test that matters most here is the disclosure. `POST /credentials/issue` returns the
 * signed JWT and the content key exactly once and stores neither, because the credential is
 * sealed before it is pinned and IPFS is public and permanent. If that panel can be dismissed
 * without a deliberate act, somebody loses a credential — so the acknowledgement gate is
 * pinned by a test rather than left as a styling decision.
 */

/*
 * A signer that always signs.
 *
 * The mock connector in the harness is configured but not connected, so `signTypedDataAsync`
 * rejects — which is correct behaviour and exactly what the transfer tests assert against.
 * Here it would only stand between the test and the thing under test: what the console does
 * with a *successful* issuance. The prepare call, the forward call and the disclosure are all
 * still the real implementations.
 */
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useSignTypedData: () => ({ signTypedDataAsync: async () => `0x${"7".repeat(130)}` }),
  };
});

const DID = `0x${"ab".repeat(32)}`;
const CREDENTIAL_HASH = `0x${"cd".repeat(32)}`;

/** A prepare response shaped like the real one, followed by a successful forward. */
function stubIssueThenForward() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith("/credentials/issue")) {
      return new Response(
        JSON.stringify({
          credentialHash: CREDENTIAL_HASH,
          schemaId: `0x${"ef".repeat(32)}`,
          jwt: "eyJhbGciOiJFZERTQSJ9.payload.signature",
          contentKey: "cGxhaW4tdGV4dC1rZXktbWF0ZXJpYWw=",
          envelopeUri: "ipfs://bafyEnvelope",
          expiresAt: 0,
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
              from: `0x${"2".repeat(40)}`,
              to: `0x${"3".repeat(40)}`,
              value: "0",
              gas: "1500000",
              nonce: "0",
              deadline: 9_999_999_999,
              data: "0xdeadbeef",
            },
          },
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/network/forward")) {
      return new Response(JSON.stringify({ transactionHash: `0x${"9".repeat(64)}` }), {
        status: 200,
      });
    }

    return new Response("{}", { status: 200 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fillIssueForm() {
  fireEvent.change(screen.getByTestId("credential-did"), { target: { value: DID } });
  fireEvent.change(screen.getByTestId("credential-type"), {
    target: { value: "EmploymentCredential" },
  });
  fireEvent.change(screen.getAllByTestId("claim-key")[0]!, { target: { value: "role" } });
  fireEvent.change(screen.getAllByTestId("claim-value")[0]!, {
    target: { value: "Senior Engineer" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CredentialConsole — issuing", () => {
  it("will not submit an incomplete credential", () => {
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    expect(screen.getByTestId("credential-issue-submit")).toBeDisabled();
  });

  it("rejects a type name the chain could not turn into a schema id", () => {
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    fireEvent.change(screen.getByTestId("credential-type"), {
      target: { value: "employment credential!" },
    });

    // The type becomes a JSON-LD type and an on-chain schema id, so it is an identifier and
    // not free text. Caught here rather than as a 400 after a round trip.
    expect(screen.getByText(/must be alphanumeric and start with a letter/i)).toBeInTheDocument();
    expect(screen.getByTestId("credential-issue-submit")).toBeDisabled();
  });

  it("enables submission once the subject, type and one claim are present", () => {
    renderWithProviders(<CredentialConsole />, { wagmi: true });
    fillIssueForm();

    expect(screen.getByTestId("credential-issue-submit")).toBeEnabled();
  });

  it("adds and removes claim rows, but never removes the last one", () => {
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    expect(screen.getAllByTestId("claim-key")).toHaveLength(1);
    // The only row's remove control is disabled: a credential with no claims asserts
    // nothing, and an empty form with no way to type into it is a dead end.
    expect(screen.getByRole("button", { name: /Remove claim 1/i })).toBeDisabled();

    fireEvent.click(screen.getByTestId("claim-add"));
    expect(screen.getAllByTestId("claim-key")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Remove claim 2/i }));
    expect(screen.getAllByTestId("claim-key")).toHaveLength(1);
  });
});

describe("CredentialConsole — the one-time disclosure", () => {
  it("shows the JWT and content key after a successful issuance", async () => {
    stubIssueThenForward();
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    fillIssueForm();
    fireEvent.click(screen.getByTestId("credential-issue-submit"));

    const panel = await waitFor(() => screen.getByTestId("credential-disclosure"));

    expect(panel).toHaveTextContent("eyJhbGciOiJFZERTQSJ9.payload.signature");
    expect(panel).toHaveTextContent("cGxhaW4tdGV4dC1rZXktbWF0ZXJpYWw=");
    expect(panel).toHaveTextContent(CREDENTIAL_HASH);
  });

  it("cannot be dismissed until the user says they have saved it", async () => {
    // The whole point of the panel. The platform stores neither value, so a close control
    // that works on the first click is a design that eventually loses somebody's credential.
    stubIssueThenForward();
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    fillIssueForm();
    fireEvent.click(screen.getByTestId("credential-issue-submit"));
    await waitFor(() => screen.getByTestId("credential-disclosure"));

    expect(screen.getByTestId("disclosure-dismiss")).toBeDisabled();

    fireEvent.click(screen.getByTestId("disclosure-acknowledge"));
    expect(screen.getByTestId("disclosure-dismiss")).toBeEnabled();

    fireEvent.click(screen.getByTestId("disclosure-dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("credential-disclosure")).not.toBeInTheDocument(),
    );
  });

  it("announces itself, since it holds something unrecoverable", async () => {
    stubIssueThenForward();
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    fillIssueForm();
    fireEvent.click(screen.getByTestId("credential-issue-submit"));

    const panel = await waitFor(() => screen.getByTestId("credential-disclosure"));
    expect(panel).toHaveAttribute("role", "alert");
  });
});

describe("CredentialConsole — revoking", () => {
  it("will not submit without a credential hash", () => {
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    expect(screen.getByTestId("credential-revoke-submit")).toBeDisabled();

    fireEvent.change(screen.getByTestId("revoke-hash"), { target: { value: "0xshort" } });
    expect(screen.getByTestId("credential-revoke-submit")).toBeDisabled();

    fireEvent.change(screen.getByTestId("revoke-hash"), { target: { value: CREDENTIAL_HASH } });
    expect(screen.getByTestId("credential-revoke-submit")).toBeEnabled();
  });

  it("carries a reason, because a verifier needs to know which one", () => {
    // "Withdrawn at the holder's request" and "the key was compromised" mean very different
    // things to somebody deciding whether to trust the holder.
    renderWithProviders(<CredentialConsole />, { wagmi: true });

    const reason = screen.getByTestId("revoke-reason");
    expect(reason).toHaveValue("1");

    fireEvent.change(reason, { target: { value: "6" } });
    expect(screen.getByText(/holder asked for it to be withdrawn/i)).toBeInTheDocument();
  });

  it("reports an already-revoked credential as such", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "already_revoked" }), { status: 409 }),
      ),
    );

    renderWithProviders(<CredentialConsole />, { wagmi: true });
    fireEvent.change(screen.getByTestId("revoke-hash"), { target: { value: CREDENTIAL_HASH } });
    fireEvent.click(screen.getByTestId("credential-revoke-submit"));

    const error = await waitFor(() => screen.getByTestId("credential-revoke-error"));
    expect(error).toHaveTextContent(/already been revoked/i);
  });
});
