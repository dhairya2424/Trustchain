import { motion as fm } from "framer-motion";
import { Check, Image as ImageIcon, Link2, QrCode } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { NetworkBadge } from "@/components/NetworkBadge";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { apiBaseUrl } from "@/config/env";
import { apiGet } from "@/api/client";
import { humanError, humanErrorText } from "@/api/errors";
import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";
import { ProvenanceTimeline } from "@/verify/ProvenanceTimeline";
import { QrScanner, decodeImageFile, isQrSupported } from "@/verify/QrScanner";
import { ScanBeam } from "@/verify/ScanBeam";
import { IdentityVerdict, type ResolvedIdentity } from "@/verify/IdentityVerdict";
import { VerdictBanner } from "@/verify/VerdictBanner";
import { buildTimeline, classifyInput, decideVerdict, type VerifyResponse } from "@/verify/verdict";

/**
 * The public verifier.
 *
 * No wallet, no account, no session — that is a requirement rather than an oversight. A
 * credential whose validity can only be checked by someone with an account on the issuing
 * platform is not verifiable in any useful sense; the whole claim is that a stranger can
 * check it.
 *
 * A `?hash=` or `?jwt=` in the URL verifies immediately on load, which is what makes the
 * share link a one-click proof: the recipient opens it and sees the verdict, having done
 * nothing. That link is also genuinely public and read-only — it carries a credential hash
 * to an unauthenticated endpoint that only reads, so sharing it grants no ability to change
 * anything.
 *
 * One thing this page deliberately does not do is claim more than it checked. Verifying by
 * hash proves the chain holds a live record; it does not prove the document in your hand is
 * the one that record refers to. The verdict says which of the two happened.
 */

type Phase = "idle" | "verifying" | "done" | "error";

const SHELL = "shell shell-reading";

/**
 * Pulls a DID out of a scanned value, or returns null.
 *
 * Accepts the verification URL the identity card encodes, and a bare DID hash for anyone
 * who pastes one directly. Deliberately strict about shape: a 32-byte hex value is also
 * what a credential hash looks like, so only the `did` parameter — or an explicit
 * `did:` prefix — is treated as an identity. Guessing wrong would answer the wrong question
 * with full confidence.
 */
export function didFromScan(value: string): string | null {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    const did = url.searchParams.get("did");
    if (did && /^0x[0-9a-fA-F]{64}$/.test(did)) return did;
  } catch {
    // Not a URL. Fall through to the prefixed form.
  }

  if (/^did:/i.test(trimmed)) {
    const tail = trimmed.split(":").pop() ?? "";
    if (/^0x[0-9a-fA-F]{64}$/.test(tail)) return tail;
  }

  return null;
}

export function Verify() {
  const motion = useMotion();
  const [params, setParams] = useSearchParams();

  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [response, setResponse] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // A scanned identity QR resolves here rather than at the credential endpoint.
  const [identity, setIdentity] = useState<ResolvedIdentity | null>(null);
  const [copied, setCopied] = useState(false);
  // Decoding a photograph takes a moment; the control says so rather than appearing inert.
  const [decodingImage, setDecodingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // Guards the auto-verify so a re-render cannot fire a second request for the same link.
  const autoRan = useRef(false);

  const verify = useCallback(async (raw: string) => {
    const classified = classifyInput(raw);

    if (classified.kind === "empty") return;

    if (classified.kind === "unknown") {
      setPhase("error");
      setError("That is neither a credential hash (0x… 64 hex characters) nor a credential JWT.");
      return;
    }

    setPhase("verifying");
    setError(null);
    setResponse(null);

    const body = classified.kind === "hash" ? { credentialHash: raw.trim() } : { jwt: raw.trim() };

    try {
      const res = await fetch(`${apiBaseUrl}/credentials/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retry = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
        setPhase("error");
        setError(
          `Too many checks from this address. Try again in ${retry.retryAfterSeconds ?? 60} seconds.`,
        );
        return;
      }

      if (res.status === 503) {
        // Never reported as "invalid". An unreachable registry means unknown, and unknown
        // must not be shown as a verdict about the credential.
        setPhase("error");
        setError(
          "The credential registry is unreachable, so this cannot be checked right now. That is not a statement about the credential.",
        );
        return;
      }

      if (!res.ok) {
        const parsed = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase("error");
        setError(humanErrorText(parsed.error ?? `http_${res.status}`));
        return;
      }

      setResponse((await res.json()) as VerifyResponse);
      setPhase("done");
    } catch (caught) {
      setPhase("error");
      setError(humanErrorText(caught));
    }
  }, []);

  // One-click from a shared link, for either kind of subject.
  useEffect(() => {
    if (autoRan.current) return;

    /*
     * A DID link resolves an identity; a hash or JWT verifies a credential.
     *
     * These are genuinely different questions — "is this person who they claim" versus "is
     * this document real" — and collapsing them into one endpoint would mean answering one
     * while appearing to answer the other.
     */
    const did = params.get("did");
    if (did) {
      autoRan.current = true;
      setPhase("verifying");
      setError(null);

      void (async () => {
        try {
          const resolved = await apiGet<ResolvedIdentity>(`/identity/${did}`);
          setIdentity(resolved);
          setPhase("done");
        } catch (caught) {
          setIdentity(null);
          setPhase("idle");
          setError(humanError(caught).message);
        }
      })();
      return;
    }

    const fromLink = params.get("hash") ?? params.get("jwt");
    if (!fromLink) return;

    autoRan.current = true;
    setInput(fromLink);
    void verify(fromLink);
  }, [params, verify]);

  /**
   * What a scanned code turns out to be.
   *
   * Identity QRs carry a full verification URL, not a bare identifier — that is what makes
   * them scannable by an ordinary phone camera rather than only by this page. So a scan can
   * produce a URL, and feeding that to the credential verifier would report "neither a
   * credential hash nor a JWT" about something perfectly valid.
   *
   * The DID is taken from the link's query string rather than by pattern-matching the whole
   * string, so a URL that merely happens to contain hex is not mistaken for an identity.
   */
  const handleScanned = useCallback(
    async (value: string) => {
      const did = didFromScan(value);
      if (did) {
        setResponse(null);
        setPhase("verifying");
        setError(null);
        try {
          setIdentity(await apiGet<ResolvedIdentity>(`/identity/${did}`));
          setPhase("done");
        } catch (caught) {
          setIdentity(null);
          setPhase("error");
          setError(humanError(caught).message);
        }
        return;
      }

      setIdentity(null);
      setInput(value);
      await verify(value);
    },
    [verify],
  );

  /**
   * A QR read out of a picture, then treated exactly like one read from the camera.
   *
   * The decode runs entirely in the browser: the image is never uploaded, which matters
   * because the thing being photographed is frequently somebody's credential. A file that
   * holds no code is reported as such rather than passed on to the verifier, where it would
   * come back as "that is neither a hash nor a JWT" and blame the wrong thing.
   */
  const handleImageFile = useCallback(
    async (file: File) => {
      setDecodingImage(true);
      setError(null);

      try {
        const value = await decodeImageFile(file);

        if (!value) {
          setPhase("error");
          setIdentity(null);
          setResponse(null);
          setError(
            "No QR code was found in that image. A tighter crop, or a sharper photo, is usually enough — the code needs to be fully in frame.",
          );
          return;
        }

        setScanning(false);
        await handleScanned(value);
      } catch {
        setPhase("error");
        setError("That file could not be read as an image.");
      } finally {
        setDecodingImage(false);
      }
    },
    [handleScanned],
  );

  const verdict = useMemo(() => (response ? decideVerdict(response) : null), [response]);
  const timeline = useMemo(() => (response ? buildTimeline(response) : []), [response]);

  const shareUrl = response
    ? `${globalThis.location?.origin ?? ""}/verify?hash=${response.credentialHash}`
    : null;

  const share = async () => {
    if (!shareUrl) return;

    // Keeps the address bar in step with what is on screen, so a reload or a bookmark
    // reproduces this exact verification.
    setParams({ hash: response!.credentialHash }, { replace: true });

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard can be refused; the URL is in the address bar either way.
      setCopied(false);
    }
  };

  return (
    <section className={`${SHELL} py-12`} aria-labelledby="verify-title">
      <header className="border-b border-line pb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-mono eyebrow">Public verifier</p>
            <h1 id="verify-title" className="mt-2 text-title">
              Verify a credential
            </h1>
          </div>
          <NetworkBadge variant="full" />
        </div>

        <p className="mt-4 max-w-[68ch] text-base leading-relaxed text-fg-muted">
          No account, no wallet, no sign-in. A credential that only its issuer can check is not
          verifiable in any useful sense — so this page is open to anyone, and the result comes from
          the chain rather than from us.
        </p>
      </header>

      <form
        className="mt-8"
        onSubmit={(event) => {
          event.preventDefault();
          void verify(input);
        }}
      >
        <label className="block">
          <span className="mb-2 block eyebrow">Credential hash or JWT</span>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="0x… or eyJhbGciOi…"
            className="w-full resize-y rounded border border-line bg-canvas px-3 py-2.5 font-mono text-sm leading-relaxed"
            data-testid="verify-input"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={!input.trim() || phase === "verifying"}
            data-testid="verify-submit"
          >
            {phase === "verifying" ? "Verifying…" : "Verify"}
          </Button>

          {isQrSupported() && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setScanning((current) => !current)}
              data-testid="verify-scan"
            >
              <QrCode className="size-4" aria-hidden="true" />
              {scanning ? "Stop scanning" : "Scan QR"}
            </Button>
          )}

          {/*
            A QR from a file, not only from a camera.

            Credentials arrive as pictures far more often than as things to point a webcam
            at: a screenshot in a chat, a photo of a printed badge, a saved PNG. This needs no
            camera and no permission prompt, so it is offered unconditionally — including on
            the desktops where `getUserMedia` is unavailable and the scan button is not.
          */}
          <Button
            type="button"
            variant="outline"
            onClick={() => imageInputRef.current?.click()}
            disabled={decodingImage}
            data-testid="verify-upload"
          >
            <ImageIcon className="size-4" aria-hidden="true" />
            {decodingImage ? "Reading image…" : "Verify from an image"}
          </Button>

          {/*
            Named, and out of the tab order.

            The visible button is the control; this input is the mechanism behind it. Left
            unnamed it is a critical axe violation — a screen reader announces "file upload
            button" and nothing else — and left tabbable it is a second, invisible stop for
            the same action. So it carries a label for anyone who reaches it programmatically,
            and `tabIndex={-1}` so nobody reaches it by tabbing.
          */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="Choose an image containing a QR code to verify"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file twice fires a change event both times.
              event.target.value = "";
              if (file) void handleImageFile(file);
            }}
            data-testid="verify-image-input"
          />

          <span className="text-xs text-fg-faint">
            Pasting the full credential checks its signature too; a hash alone checks only the
            chain.
          </span>
        </div>
      </form>

      {scanning && (
        <div className="mt-4">
          <QrScanner
            onResult={(value) => {
              setScanning(false);
              void handleScanned(value);
            }}
            onClose={() => setScanning(false)}
          />
        </div>
      )}

      {phase === "error" && error && (
        <div className="mt-6 panel px-5 py-6" data-testid="verify-error" role="status">
          <Status tone="fallback">Could not check</Status>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-fg-muted">{error}</p>
        </div>
      )}

      {phase === "verifying" && (
        <div className="relative mt-8 panel px-6 py-14 text-center" data-testid="verify-scanning">
          <ScanBeam active />
          <p className="relative text-base text-fg-muted">Checking the signature and the chain…</p>
        </div>
      )}

      {/*
        An identity, resolved from a scanned QR or a shared ?did= link.

        Rendered instead of the credential verdict, not alongside it: a page answering two
        different questions at once would leave the reader unsure which one the big word at
        the top refers to.
      */}
      {phase === "done" && identity && <IdentityVerdict identity={identity} />}

      {phase === "done" && verdict && response && (
        <fm.div
          className="mt-8 space-y-6"
          initial={motion.reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motion.transition("base")}
        >
          <VerdictBanner verdict={verdict} />

          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <div className="panel p-6">
              <h3 className="section-label">Provenance</h3>
              <div className="mt-5">
                <ProvenanceTimeline nodes={timeline} />
              </div>
            </div>

            <div className="panel p-6">
              <h3 className="section-label">Proof</h3>

              <dl className="mt-5 space-y-3.5 text-xs">
                <Fact term="Credential hash" mono>
                  {response.credentialHash}
                </Fact>
                <Fact term="On-chain status" mono>
                  {response.status}
                </Fact>
                <Fact term="Signature">
                  {response.proof.signatureChecked
                    ? response.proof.signatureValid
                      ? "verified against the issuer's key"
                      : "did not verify"
                    : "not checked — only a hash was supplied"}
                </Fact>
                {response.proof.issuer && (
                  <Fact term="Issuer" mono>
                    {response.proof.issuer}
                  </Fact>
                )}
                {response.proof.subject && (
                  <Fact term="Subject" mono>
                    {response.proof.subject}
                  </Fact>
                )}
                {response.proof.type?.length ? (
                  <Fact term="Type">{response.proof.type.join(", ")}</Fact>
                ) : null}
              </dl>

              <div className="mt-6 border-t border-line pt-5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void share()}
                  className="w-full"
                  data-testid="verify-share"
                >
                  {copied ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Link2 className="size-3.5" aria-hidden="true" />
                  )}
                  {copied ? "Link copied" : "Share verification"}
                </Button>
                <p className="mt-2 text-2xs leading-snug text-fg-faint">
                  A public, read-only link. Opening it re-runs this check against the chain — it
                  carries the result of nothing, only the question.
                </p>
              </div>
            </div>
          </div>
        </fm.div>
      )}
    </section>
  );
}

function Fact({
  term,
  children,
  mono,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="eyebrow">{term}</dt>
      <dd
        className={cn("mt-1 text-fg-muted [overflow-wrap:anywhere]", mono && "font-mono text-xs")}
      >
        {children}
      </dd>
    </div>
  );
}
