import { AnimatePresence, motion as fm } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { env } from "@/config/env";
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
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const detailsValid = name.trim().length > 0 && description.trim().length > 0;

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

  const submit = () => {
    if (!file || !detailsValid || submitting) return;

    setSubmitting(true);
    setProgress(0);

    const toastId = toast.push({
      status: "pending",
      title: "Minting asset",
      detail: "Uploading artwork and submitting the transaction…",
    });

    const body = new FormData();
    body.append("name", name.trim());
    body.append("description", description.trim());
    body.append("file", file);

    // XHR rather than fetch: only XHR reports upload progress, and this is the one request
    // in the app where the user genuinely needs to see it move.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${env.VITE_PUBLIC_API_URL}/assets/mint`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      setSubmitting(false);

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // A non-JSON body is handled by the status check below.
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        toast.resolve(toastId, {
          status: "success",
          title: "Asset minted",
          detail: "The mint is recorded on-chain and attributed to your identity.",
          reference:
            typeof parsed.transactionHash === "string" ? parsed.transactionHash : undefined,
        });

        // The audit trail is the source every other panel reads, so invalidating it is what
        // makes the new entry appear rather than optimistically inserting a row we have not
        // actually read back.
        void queryClient.invalidateQueries({ queryKey: ["audit"] });

        setStep(0);
        setName("");
        setDescription("");
        setFile(null);
        setProgress(0);
        return;
      }

      const code = typeof parsed.error === "string" ? parsed.error : `HTTP ${xhr.status}`;

      toast.resolve(toastId, {
        status: "error",
        title: xhr.status === 403 ? "Not authorized to mint" : "Mint failed",
        detail:
          xhr.status === 403
            ? "Minting needs the MINT_ASSET permission on your own address. The contract would refuse this too."
            : code,
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
                    className="w-full rounded border border-line bg-base px-3 py-2 text-base"
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
                    className="w-full resize-y rounded border border-line bg-base px-3 py-2 text-base"
                    data-testid="mint-description"
                  />
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
