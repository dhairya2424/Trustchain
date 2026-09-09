import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MintWizard } from "./MintWizard";
import { renderWithProviders } from "@/test/harness";

/**
 * Two faults that made minting impossible, and one that made it lie about it.
 *
 * The form sent `name`, `description` and `file`. The endpoint's schema is strict and requires
 * `toDID`, so **every mint answered 400** — an asset is allocated to an identity, and there
 * was nowhere to say which.
 *
 * Then it reported success anyway. `POST /assets/mint` answers 200 with EIP-712 typed data to
 * sign; it pins the metadata and submits nothing. Treating any 2xx as "handed to the relayer"
 * meant that fixing the missing field alone would have produced a wizard that announced mints
 * which did not exist — a worse bug than the one it replaced, and a harder one to notice.
 *
 * Both are pinned here, because both are the kind of thing a refactor re-introduces quietly.
 */

const OWN_DID = `0x${"ab".repeat(32)}`;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const OTHER_DID = `0x${"cd".repeat(32)}`;

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useSignTypedData: () => ({ signTypedDataAsync: async () => `0x${"7".repeat(130)}` }),
  };
});

const TYPED_DATA = {
  domain: { name: "TrustChainForwarder", chainId: 31337, verifyingContract: `0x${"1".repeat(40)}` },
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
};

/**
 * A fake XMLHttpRequest, because the wizard uses XHR for real upload progress.
 *
 * Records the FormData it was sent so the assertions can look at what actually left the
 * browser — which is the only way to catch a field that is simply absent.
 */
let lastSentForm: FormData | null = null;
let mintStatus = 200;
let mintBody: unknown = { typedData: TYPED_DATA, tokenURI: "ipfs://x" };

class FakeXhr {
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = "";
  withCredentials = false;

  open() {}

  send(body: FormData) {
    lastSentForm = body;
    queueMicrotask(() => {
      this.status = mintStatus;
      this.responseText = JSON.stringify(mintBody);
      this.onload?.();
    });
  }
}

function fillDetails({ recipient }: { recipient?: string } = {}) {
  fireEvent.change(screen.getByTestId("mint-name"), { target: { value: "A thing" } });
  fireEvent.change(screen.getByTestId("mint-description"), { target: { value: "Description" } });
  if (recipient !== undefined) {
    fireEvent.change(screen.getByTestId("mint-recipient"), { target: { value: recipient } });
  }
}

/**
 * Walks details → artwork → confirm, then submits.
 *
 * Each step is awaited: the panels cross-fade through `AnimatePresence`, so the next one is
 * not in the DOM synchronously after the click.
 */
async function advanceTo(testId: string) {
  fireEvent.click(screen.getByTestId("wizard-next"));
  await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
}

async function mint({ recipient }: { recipient?: string } = {}) {
  fillDetails(recipient === undefined ? {} : { recipient });
  await advanceTo("wizard-upload");

  const file = new File([new Uint8Array([1, 2, 3])], "art.png", { type: "image/png" });
  fireEvent.change(screen.getByTestId("file-input"), { target: { files: [file] } });

  await advanceTo("wizard-confirm");
  fireEvent.click(screen.getByTestId("wizard-submit"));
}

beforeEach(() => {
  lastSentForm = null;
  mintStatus = 200;
  mintBody = { typedData: TYPED_DATA, tokenURI: "ipfs://x" };

  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/auth/session")) {
        return new Response(
          JSON.stringify({ address: `0x${"9".repeat(40)}`, did: OWN_DID, roles: ["ADMIN"] }),
          { status: 200 },
        );
      }
      if (url.includes(`/roles/${OTHER}`)) {
        return new Response(JSON.stringify({ address: OTHER, did: OTHER_DID, roles: [] }), {
          status: 200,
        });
      }
      if (url.includes("/roles/")) {
        return new Response(JSON.stringify({ address: OTHER, did: null, roles: [] }), {
          status: 200,
        });
      }
      if (url.includes("/network/forward")) {
        return new Response(JSON.stringify({ transactionHash: `0x${"5".repeat(64)}` }), {
          status: 202,
        });
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MintWizard — the recipient the API requires", () => {
  it("sends toDID, without which every mint was a 400", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint();

    await waitFor(() => expect(lastSentForm).not.toBeNull());
    expect(lastSentForm!.get("toDID")).toBe(OWN_DID);
    expect(lastSentForm!.get("name")).toBe("A thing");
    expect(lastSentForm!.get("file")).toBeInstanceOf(File);
  });

  it("defaults to the signed-in identity, so the common case needs no typing", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint();

    await waitFor(() => expect(lastSentForm).not.toBeNull());
    expect(lastSentForm!.get("toDID")).toBe(OWN_DID);
  });

  it("resolves a typed address to the identity behind it", async () => {
    // Assets belong to identities, not to keys. An address is a way of naming one.
    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint({ recipient: OTHER });

    await waitFor(() => expect(lastSentForm).not.toBeNull());
    expect(lastSentForm!.get("toDID")).toBe(OTHER_DID);
  });

  it("refuses an address with no identity, and says where to fix it", async () => {
    const stranger = "0x1111111111111111111111111111111111111111";
    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint({ recipient: stranger });

    expect(await screen.findByText(/no identity yet/i)).toBeInTheDocument();
    // Nothing was uploaded: there was nothing valid to upload it for.
    expect(lastSentForm).toBeNull();
  });

  it("will not advance past details with a malformed recipient", () => {
    renderWithProviders(<MintWizard />, { wagmi: true });
    fillDetails({ recipient: "not-an-address" });

    expect(screen.getByTestId("wizard-next")).toBeDisabled();
  });
});

describe("MintWizard — it signs what the API prepared", () => {
  it("forwards a signed request rather than calling the prepare a success", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint();

    // The 200 from /assets/mint means "pinned and prepared", not "minted". The wizard used to
    // stop here and announce a mint whose transaction did not exist.
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([url]) => String(url).includes("/network/forward"))).toBe(true);
    });
  });

  it("reports submitted, not minted", async () => {
    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint();

    // The relayer has broadcast it; the chain has not necessarily included it. On a platform
    // whose whole claim is verifiability, that distinction is the one not to blur.
    expect(await screen.findByText(/Mint submitted/i)).toBeInTheDocument();
  });
});

describe("MintWizard — when the API refuses", () => {
  it("shows which field was wrong instead of a bare code", async () => {
    // This is how a mint failing on a missing toDID stayed invisible for as long as it did:
    // the server said exactly what was wrong and the interface rendered "invalid_request".
    mintStatus = 400;
    mintBody = { error: "invalid_request", issues: ["toDID: Required"] };

    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint();

    expect(await screen.findByText(/toDID: Required/)).toBeInTheDocument();
  });

  it("stops saying it is minting after a refusal", async () => {
    mintStatus = 403;
    mintBody = { error: "forbidden" };

    renderWithProviders(<MintWizard />, { wagmi: true });
    await mint();

    // The failure path used to leave the button stuck on "Minting…" forever, because only the
    // success path cleared the flag.
    await waitFor(() =>
      expect(screen.getByTestId("wizard-submit")).toHaveTextContent(/Mint asset/i),
    );
    expect(screen.getByTestId("wizard-submit")).toBeEnabled();
  });
});
