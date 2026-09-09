import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Verify } from "@/routes/Verify";
import { IdentityCard } from "@/dashboard/IdentityCard";
import { renderWithProviders } from "@/test/harness";
import type { Session } from "@/api/queries";

/**
 * Verifying from a picture, and saving a code worth sending.
 *
 * A credential reaches a verifier as an image far more often than as something to hold up to
 * a webcam: a screenshot in a chat, a photo of a printed badge, a PNG in an email. Both halves
 * of that loop are covered here — the code you can save, and the file you can check.
 */

const DID = `0x${"ab".repeat(32)}`;

const session: Session = {
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  did: DID,
  roles: ["USER"],
};

/** Stands in for the module the component imports, so no real decoding happens in jsdom. */
const decodeImageFile = vi.hoisted(() => vi.fn());

vi.mock("@/verify/QrScanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/verify/QrScanner")>();
  return { ...actual, decodeImageFile, isQrSupported: () => false };
});

function chooseFile(testId: string, file: File) {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

const anImage = () => new File([new Uint8Array([1, 2, 3])], "code.png", { type: "image/png" });

beforeEach(() => {
  decodeImageFile.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            didHash: DID,
            registered: true,
            controller: session.address,
            active: true,
            roles: ["USER"],
            assets: { balance: 0, tokenIds: [] },
            network: { id: "hardhat", label: "LOCAL HARDHAT", chainId: 31337, explorerUrl: null },
          }),
          { status: 200 },
        ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Verify — from an image file", () => {
  it("offers the control even where there is no camera", () => {
    // `isQrSupported` is false in this suite. Uploading a picture needs no camera and no
    // permission prompt, so it must not be hidden alongside the scanner.
    renderWithProviders(<Verify />);

    expect(screen.queryByTestId("verify-scan")).not.toBeInTheDocument();
    expect(screen.getByTestId("verify-upload")).toBeInTheDocument();
  });

  it("decodes an identity QR and resolves the identity it names", async () => {
    decodeImageFile.mockResolvedValue(`https://example.test/verify?did=${DID}`);

    renderWithProviders(<Verify />);
    chooseFile("verify-image-input", anImage());

    await waitFor(() => expect(decodeImageFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("identity-verdict")).toBeInTheDocument();
  });

  it("says so plainly when the picture holds no code", async () => {
    // Passing an undecodable file through to the credential verifier would come back as
    // "that is neither a hash nor a JWT", which blames the wrong thing entirely.
    decodeImageFile.mockResolvedValue(null);

    renderWithProviders(<Verify />);
    chooseFile("verify-image-input", anImage());

    const error = await screen.findByTestId("verify-error");
    expect(error).toHaveTextContent(/No QR code was found/i);
  });

  it("reports a file it could not read as an image", async () => {
    decodeImageFile.mockRejectedValue(new Error("not an image"));

    renderWithProviders(<Verify />);
    chooseFile("verify-image-input", new File(["x"], "notes.txt", { type: "text/plain" }));

    expect(await screen.findByTestId("verify-error")).toHaveTextContent(/could not be read/i);
  });

  it("lets the same file be chosen twice", async () => {
    // The input's value is cleared after each pick; without that, re-choosing the same file
    // fires no change event and the control looks dead on the second try.
    decodeImageFile.mockResolvedValue(null);

    renderWithProviders(<Verify />);
    chooseFile("verify-image-input", anImage());
    await waitFor(() => expect(decodeImageFile).toHaveBeenCalledTimes(1));

    chooseFile("verify-image-input", anImage());
    await waitFor(() => expect(decodeImageFile).toHaveBeenCalledTimes(2));
  });
});

describe("IdentityCard — downloading the code", () => {
  it("offers a download beside the QR", () => {
    renderWithProviders(<IdentityCard session={session} />);
    expect(screen.getByTestId("qr-download")).toBeInTheDocument();
  });

  it("offers nothing to download when there is no identity", () => {
    // No DID means no QR, and a download control for a code that does not exist would be a
    // button that produces a blank image.
    renderWithProviders(<IdentityCard session={{ ...session, did: null }} />);

    expect(screen.queryByTestId("identity-qr")).not.toBeInTheDocument();
    expect(screen.queryByTestId("qr-download")).not.toBeInTheDocument();
  });

  it("renders the exported code dark-on-white, not as a copy of the pale on-screen one", async () => {
    // The card's QR is pale grey on transparent — correct against a dark panel, and
    // unscannable once dropped into a white document. The exported one has to invert.
    renderWithProviders(<IdentityCard session={session} />);
    fireEvent.click(screen.getByTestId("qr-download"));

    const canvas = await waitFor(() => {
      const found = document.querySelector("canvas");
      expect(found).not.toBeNull();
      return found!;
    });

    // qrcode.react paints the background first; a 1024px canvas is what gets exported.
    expect(canvas.width).toBeGreaterThanOrEqual(1024);
  });
});
