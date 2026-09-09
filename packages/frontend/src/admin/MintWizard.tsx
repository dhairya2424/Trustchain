import { AnimatePresence, motion as fm } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { useSignTypedData } from "wagmi";

import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { apiBaseUrl } from "@/config/env";
import { TransactionTrail } from "@/chain/TransactionTrail";
import { queryKeys, useNetwork, useSession } from "@/api/queries";
import { forwardSigned, toSignable, type PreparedTypedData } from "@/api/forward";
import { humanErrorText } from "@/api/errors";
import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";

/**
 * Mint an asset, in three steps.
 *
 * Posts multipart to `POST /assets/mint`, which requires the caller's own `MINT_ASSET`
 * permission read from the chain — not the relayer's. That check is the fix for the
 * confused-deputy bug found during the P2.6 exit check, and it means a plain USER reaching
 * this form still cannot mint: the wizard is a convenience, never the gate.
 *
 * Upload progress is real. It comes from `XMLHttpRequest.upload.onprogress`, because
 * `fetch` still cannot report request-body progress — a spinner that merely spins while a
 * 20 MB file uploads tells the user nothing about whether it is moving.
 *
 * ## Two faults this form had, and what they teach
 *
 * It sent `name`, `description` and `file`, and no `toDID`. The endpoint's schema is strict
 * and requires one, so **every mint failed with a 400** — an asset is allocated to an
 * identity, and there was nowhere to say which.
 *
 * Worse, it then reported success. `POST /assets/mint` answers **200 with EIP-712 typed data
 * to sign**; it pins the metadata and prepares a call, and submits nothing. The wizard treated
 * any 2xx as "handed to the relayer" — so had the first fault been fixed alone, the interface
 * would have announced a mint that did not exist. That is precisely the overclaim this
 * codebase refuses everywhere else, and it survived here because the endpoint changed shape
 * after the wizard was written and nothing forced the wizard to keep up.
 *
 * So the flow now finishes the sentence: upload, sign what came back, forward it, and report
 * only what the relayer actually accepted.
 */

type Step = 0 | 1 | 2;

const STEPS = ["Details", "Artwork", "Confirm"] as const;

/** Mirrors the server's own limit; rejecting here saves a doomed upload. */
const MAX_BYTES = 10 * 1024 * 1024;

export function MintWizard() {
  const motion = useMotion();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /**
   * Who receives the asset.
   *
   * Empty means the signed-in identity, which is the overwhelmingly common case and the one
   * that should need no typing. Anything else is an address or a DID hash; an address is
   * resolved to its identity before the mint, because the registry allocates to identities.
   */
  const [recipient, setRecipient] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // The hash of the most recent mint, so its confirmation can be followed after the wizard
  // resets. Cleared when a new mint starts, never carried between two.
  const [lastHash, setLastHash] = useState<string | null>(null);
  // For the explorer link: which chain this landed on, and whether it has an explorer.
  const network = useNetwork();
  const session = useSession();
  const { signTypedDataAsync } = useSignTypedData();
  const [fileError, setFileError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const trimmedRecipient = recipient.trim();
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(trimmedRecipient);
  const isDidHash = /^0x[0-9a-fA-F]{64}$/.test(trimmedRecipient);
  const recipientValid = trimmedRecipient === "" || isAddress || isDidHash;

  const detailsValid = name.trim().length > 0 && description.trim().length > 0 && recipientValid;

  const acceptFile = (candidate: File | undefined) => {
    if (!candidate) return;

    if (candidate.size > MAX_BYTES) {
      setFileError(
        `That file is ${(candidate.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
      );
      return;
    }

    setFileError(null);
    setFile(candidate);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  /**
   * Turns whatever was typed into the DID the registry wants.
   *
   * Empty is the signed-in identity. A DID hash is already one. An address is resolved
   * through `GET /roles/:address`, which answers with the identity behind it — and null when
   * there is none, which is a real answer worth a real sentence: an address without an
   * identity cannot hold an asset, and the fix is one screen away.
   */
  const resolveRecipientDID = async (): Promise<string> => {
    if (trimmedRecipient === "") {
      const own = session.data?.did;
      if (!own) {
        throw new Error(
          "Your session has no identity on this network, so there is nothing to mint to. Register one first.",
        );
      }
      return own;
    }

    if (isDidHash) return trimmedRecipient;

    const response = await fetch(`${apiBaseUrl}/roles/${trimmedRecipient}`, {
      credentials: "include",
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(
        humanErrorText(typeof body.error === "string" ? body.error : "invalid_request"),
      );
    }

    if (typeof body.did !== "string" || body.did.length === 0) {
      throw new Error(
        "That address has no identity yet, so it cannot hold an asset. Register one for it under Identities, then mint.",
      );
    }

    return body.did;
  };

  const submit = async () => {
    if (!file || !detailsValid || submitting) return;

    setSubmitting(true);
    setProgress(0);
    setLastHash(null);

    const toastId = toast.push({
      status: "pending",
      title: "Minting asset",
      detail: "Pinning artwork, then asking you to sign the mint.",
    });

    let toDID: string;
    try {
      toDID = await resolveRecipientDID();
    } catch (error) {
      setSubmitting(false);
      toast.resolve(toastId, {
        status: "error",
        title: "Mint not started",
        detail: error instanceof Error ? error.message : "The recipient could not be resolved.",
      });
      return;
    }

    const body = new FormData();
    body.append("name", name.trim());
    body.append("description", description.trim());
    body.append("file", file);
    // The field whose absence made every mint a 400. An asset is allocated to an identity;
    // there is no such thing as minting to nobody.
    body.append("toDID", toDID);

    // XHR rather than fetch: only XHR reports upload progress, and this is the one request
    // in the app where the user genuinely needs to see it move.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBaseUrl}/assets/mint`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(event.loaded / event.total);
    };

    xhr.onload = async () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // A non-JSON body is handled by the status check below.
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        /*
         * The upload succeeded, and nothing has been minted yet.
         *
         * A 200 here means the metadata is pinned and a call has been *prepared*. The mint
         * happens when the administrator signs that call and it is relayed — which is what
         * attributes it to them rather than to the relayer that pays. Reporting success at
         * this point was the bug: it announced a mint whose transaction did not exist.
         */
        try {
          const typedData = parsed.typedData as PreparedTypedData | undefined;
          if (!typedData) throw new Error("The API did not return a request to sign.");

          const signable = toSignable(typedData);

          toast.resolve(toastId, {
            status: "pending",
            title: "Sign the mint",
            detail: "Artwork is pinned. Approve the request in your wallet to record it.",
          });

          const signature = await signTypedDataAsync({
            domain: signable.domain,
            types: signable.types,
            primaryType: signable.primaryType,
            message: signable.message,
          } as never);

          const relayed = await forwardSigned(typedData, signature);

          /*
           * "Submitted", not "minted".
           *
           * The relayer has accepted and broadcast it; the chain has not necessarily included
           * it. Claiming it was "recorded on-chain" here asserts something nobody has verified
           * yet, and on a platform whose whole claim is verifiability that is the one thing
           * not to say loosely. The transaction trail below reports what actually happened.
           */
          const hash = relayed.transactionHash ?? null;
          setLastHash(hash);
          setSubmitting(false);

          toast.resolve(toastId, {
            status: "success",
            title: "Mint submitted",
            detail: "Signed by you and handed to the relayer. Watch below for confirmation.",
            reference: hash ?? undefined,
          });
        } catch (error) {
          setSubmitting(false);
          toast.resolve(toastId, {
            status: "error",
            title: "Mint not submitted",
            detail:
              error instanceof Error
                ? error.message
                : "The prepared mint could not be signed or relayed.",
          });
          // Deliberately no reset: the details and the file are still correct, and making
          // somebody re-enter them after declining a wallet prompt would be its own bug.
          return;
        }

        // The audit trail is the source every other panel reads, so invalidating it is what
        // makes the new entry appear rather than optimistically inserting a row we have not
        // actually read back.
        void queryClient.invalidateQueries({ queryKey: ["audit"] });

        void queryClient.invalidateQueries({ queryKey: queryKeys.ownedAssets });

        setStep(0);
        setName("");
        setDescription("");
        setRecipient("");
        setFile(null);
        setProgress(0);
        return;
      }

      // Without this the form stayed "Minting…" forever after a rejection — the failure path
      // relied on a reset that only the success path performed.
      setSubmitting(false);

      const code = typeof parsed.error === "string" ? parsed.error : `HTTP ${xhr.status}`;

      /*
       * The validation detail, not just the code.
       *
       * The API answers a malformed mint with `invalid_request` and an `issues` array naming
       * the offending field. This used to render the bare code, which is how a mint that was
       * failing on a missing `toDID` could look like a generic "Mint failed" for as long as
       * it did. If the server has taken the trouble to say which field, show it.
       */
      const issues = Array.isArray(parsed.issues)
        ? (parsed.issues as unknown[]).filter((i): i is string => typeof i === "string")
        : [];

      toast.resolve(toastId, {
        status: "error",
        title: xhr.status === 403 ? "Not authorized to mint" : "Mint failed",
        detail:
          xhr.status === 403
            ? "Minting needs the MINT_ASSET permission on your own address. The contract would refuse this too."
            : issues.length > 0
              ? issues.join("; ")
              : humanErrorText(code),
      });
    };

    xhr.onerror = () => {
      setSubmitting(false);
      toast.resolve(toastId, {
        status: "error",
        title: "Mint failed",
        detail: "The request never reached the API.",
      });
    };

    xhr.send(body);
  };

  return (
    <div className="min-w-0">
      <h2 className="text-base font-semibold">Mint an asset</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Artwork is pinned to IPFS; the chain stores the pointer and the provenance.
      </p>

      <ol className="mt-6 flex items-center gap-2" data-testid="wizard-steps">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors",
                index === step
                  ? "border-fg text-fg"
                  : index < step
                    ? "border-verified/45 text-verified"
                    : "border-line text-fg-faint",
              )}
              data-testid="wizard-step"
              data-state={index === step ? "current" : index < step ? "done" : "todo"}
            >
              <span className="font-mono text-2xs">{index + 1}</span>
              {label}
            </span>
            {index < STEPS.length - 1 && <span className="h-px w-6 bg-line" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      <div className="mt-6 panel p-6">
        <AnimatePresence mode="wait">
          <fm.div
            key={step}
            initial={motion.reduced ? { opacity: 0 } : { opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={motion.reduced ? { opacity: 0 } : { opacity: 0, x: -18 }}
            transition={motion.transition("quick")}
          >
            {step === 0 && (
              <div className="grid gap-4" data-testid="wizard-details">
                <label className="block">
                  <span className="mb-1.5 block eyebrow">Name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={120}
                    className="w-full rounded border border-line bg-canvas px-3 py-2 text-base"
                    data-testid="mint-name"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block eyebrow">Description</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    maxLength={2000}
                    className="w-full resize-y rounded border border-line bg-canvas px-3 py-2 text-base"
                    data-testid="mint-description"
                  />
                </label>

                {/*
                  The recipient — the field whose absence made every mint fail.

                  Optional, because minting to yourself is the common case and should need no
                  typing. An asset belongs to an identity, so an address entered here is
                  resolved to the identity behind it before anything is signed.
                */}
                <label className="block">
                  <span className="mb-1.5 block eyebrow">Recipient</span>
                  <input
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value)}
                    placeholder={session.data?.did ? "Your own identity" : "0x…"}
                    spellCheck={false}
                    className="w-full rounded border border-line bg-canvas px-3 py-2 font-mono text-sm"
                    data-testid="mint-recipient"
                  />
                  <span className="mt-1.5 block text-xs leading-relaxed text-fg-faint">
                    {trimmedRecipient === ""
                      ? "Left empty, the asset is minted to your own identity."
                      : isAddress
                        ? "An address. It will be resolved to the identity that controls it."
                        : isDidHash
                          ? "A DID hash — the identity that will own the asset."
                          : "Enter an address (40 hex characters) or a DID hash (64), or leave it empty."}
                  </span>
                </label>
              </div>
            )}

            {step === 1 && (
              <div data-testid="wizard-upload">
                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  className={cn(
                    "grid place-items-center rounded-lg border border-dashed px-6 py-12 text-center transition-colors",
                    dragging ? "border-fg bg-hover" : "border-line-strong",
                  )}
                  data-testid="drop-zone"
                  data-dragging={dragging ? "true" : "false"}
                >
                  {file ? (
                    <div className="space-y-2">
                      <Status tone="verified">File ready</Status>
                      <p className="font-mono text-xs text-fg">{file.name}</p>
                      <p className="text-xs text-fg-faint">
                        {(file.size / 1024).toFixed(0)} KB · {file.type || "unknown type"}
                      </p>
                      <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                        Choose another
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <UploadCloud className="mx-auto size-7 text-fg-faint" aria-hidden="true" />
                      <p className="text-sm text-fg-muted">Drop an image here, or</p>
                      <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                        Browse files
                      </Button>
                      <p className="text-2xs text-fg-faint">
                        Up to 10 MB. The server checks the actual content, not the filename.
                      </p>
                    </div>
                  )}

                  {/*
                    Visually hidden but still focusable, so it needs its own accessible name
                    — axe flags this as a critical "label" violation, and in practice a
                    screen-reader user tabbing here would hear nothing at all. The visible
                    Browse button drives the same input via a click.
                  */}
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/*"
                    aria-label="Choose an image file for this asset"
                    className="sr-only"
                    onChange={(event) => acceptFile(event.target.files?.[0])}
                    data-testid="file-input"
                  />
                </div>

                {fileError && (
                  <p className="mt-3 text-sm text-revoked" data-testid="file-error">
                    {fileError}
                  </p>
                )}
              </div>
            )}

            {step === 2 && (
              <div
                className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)]"
                data-testid="wizard-confirm"
              >
                <ProgressRing value={progress} active={submitting} />

                <div>
                  <h3 className="text-base font-semibold">Confirm</h3>
                  <p className="mt-1 max-w-[52ch] text-sm leading-relaxed text-fg-muted">
                    This mint will be signed for by the relayer but attributed on-chain to your
                    identity. It cannot be undone — a mint is a permanent record.
                  </p>

                  <dl className="mt-4 space-y-2 text-sm">
                    <Summary term="Name">{name}</Summary>
                    <Summary term="Description">{description}</Summary>
                    <Summary term="Recipient">
                      {trimmedRecipient === "" ? "Your own identity" : trimmedRecipient}
                    </Summary>
                    <Summary term="File">
                      {file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)` : "—"}
                    </Summary>
                  </dl>
                </div>
              </div>
            )}
          </fm.div>
        </AnimatePresence>

        <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep((current) => Math.max(0, current - 1) as Step)}
            disabled={step === 0 || submitting}
          >
            Back
          </Button>

          {step < 2 ? (
            <Button
              size="sm"
              onClick={() => setStep((current) => Math.min(2, current + 1) as Step)}
              disabled={(step === 0 && !detailsValid) || (step === 1 && !file)}
              data-testid="wizard-next"
            >
              Continue
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={submitting} data-testid="wizard-submit">
              {submitting ? "Minting…" : "Mint asset"}
            </Button>
          )}
        </div>
      </div>

      {/*
       * Outside the wizard's own card, and deliberately after the reset.
       *
       * The wizard clears itself on success so another asset can be minted, but the
       * transaction it just started is still in flight. Keeping this outside that state
       * means the person can start the next mint without losing sight of the last one.
       */}
      {lastHash && (
        <TransactionTrail
          hash={lastHash}
          explorerUrl={network.data?.active?.explorerUrl ?? null}
          networkLabel={network.data?.active?.label}
          className="mt-4"
        />
      )}
    </div>
  );
}

function Summary({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
      <dt className="eyebrow">{term}</dt>
      <dd className="text-fg-muted [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Upload progress as a ring. Shows real bytes sent, never a fake crawl. */
function ProgressRing({ value, active }: { value: number; active: boolean }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(Math.max(value, 0), 1);

  return (
    <div className="grid size-24 place-items-center" data-testid="progress-ring">
      <svg viewBox="0 0 80 80" className="size-24 -rotate-90">
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="text-line"
        />
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          className={active ? "text-fg" : "text-line-strong"}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          style={{ transition: "stroke-dashoffset 200ms linear" }}
        />
      </svg>
      <span className="absolute font-mono text-sm tabular text-fg-muted">
        {active ? `${Math.round(clamped * 100)}%` : "ready"}
      </span>
    </div>
  );
}
