import { useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { usePreparedAction } from "@/api/usePreparedAction";
import { useSession } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";

/**
 * Issuing and revoking credentials.
 *
 * The API has implemented both since the credentials phase — with permissions, EIP-712
 * attribution and on-chain audit records — and neither was reachable from the interface. Only
 * verification was. So the platform could prove a credential and not make one, which meant
 * every demo credential came from a script.
 *
 * ## The one screen where the interface holds something it can never show again
 *
 * `POST /credentials/issue` returns the signed JWT and the content key exactly once. Neither
 * is stored by the service: the credential is sealed before it is pinned, because IPFS is
 * public and permanent and a credential pinned in the clear is personal data published
 * irrevocably. The key that opens it exists in this response and nowhere else.
 *
 * That makes the disclosure panel below the most consequential thing on the page. It is not a
 * toast, it does not auto-dismiss, and it stays until explicitly closed — because a
 * disappearing notification holding the only copy of an unrecoverable secret is a design that
 * loses people's credentials.
 *
 * ## Order of operations, and what a declined signature leaves behind
 *
 * The credential is built, signed, sealed and pinned *before* the anchoring transaction is
 * prepared. Anchoring last means a failure anywhere earlier leaves nothing on-chain. But it
 * also means declining the wallet prompt leaves a pinned credential that was never anchored —
 * harmless, and unverifiable, and the interface says so rather than implying the issuance
 * simply did not happen.
 */

const REVOCATION_REASONS = [
  { code: 1, label: "Key compromised", detail: "The subject's key material is no longer safe." },
  { code: 2, label: "Superseded", detail: "A newer credential replaces this one." },
  {
    code: 3,
    label: "Subject terminated",
    detail: "The relationship the credential attested has ended.",
  },
  { code: 4, label: "Issued in error", detail: "It should never have been issued." },
  {
    code: 5,
    label: "Policy violation",
    detail: "The subject breached the terms it was issued under.",
  },
  { code: 6, label: "Subject requested", detail: "The holder asked for it to be withdrawn." },
  { code: 7, label: "Issuer decommissioned", detail: "The issuing authority no longer operates." },
] as const;

interface Claim {
  key: string;
  value: string;
}

interface Disclosure {
  credentialHash: string;
  jwt: string;
  contentKey: string;
  envelopeUri: string;
  anchored: boolean;
  transactionHash?: string | undefined;
}

export function CredentialConsole() {
  const session = useSession();
  const roles = session.data?.roles ?? [];
  const canIssue = roles.includes("ADMIN") || roles.includes("MANAGER");

  return (
    <div className="min-w-0">
      <h2 className="text-base font-semibold">Credentials</h2>
      <p className="mt-1 max-w-[64ch] text-sm leading-relaxed text-fg-muted">
        A credential is a signed statement about an identity, sealed before it is pinned and
        anchored to the chain by its hash. The chain holds the hash and the status; the document
        itself never touches it, so revoking one is a public act and reading one is not.
      </p>

      {!canIssue && (
        <p className="mt-4 max-w-[64ch] text-sm text-fg-faint" data-testid="credentials-readonly">
          Issuing needs the ISSUE_CREDENTIAL permission and revoking needs REVOKE_CREDENTIAL. The
          controls are shown rather than hidden, because a console that quietly omits what you
          cannot do teaches you less than one that shows you and refuses.
        </p>
      )}

      <IssuePanel />
      <RevokePanel />
    </div>
  );
}

function IssuePanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const run = usePreparedAction();

  const [didHash, setDidHash] = useState("");
  const [credentialType, setCredentialType] = useState("");
  const [claims, setClaims] = useState<Claim[]>([{ key: "", value: "" }]);
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);

  const validDid = /^0x[0-9a-fA-F]{64}$/.test(didHash.trim());
  const validType = /^[A-Za-z][A-Za-z0-9]*$/.test(credentialType.trim());
  const filled = claims.filter((claim) => claim.key.trim() !== "");
  const ready = validDid && validType && filled.length > 0 && !busy;

  const setClaim = (index: number, patch: Partial<Claim>) =>
    setClaims((current) =>
      current.map((claim, i) => (i === index ? { ...claim, ...patch } : claim)),
    );

  const issue = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;

    setBusy(true);
    setError(null);

    // Seconds, and 0 means "no expiry" — the contract's own convention, so an empty field
    // is not silently turned into an expiry a year out that nobody asked for.
    const expiresAt = expiry ? Math.floor(new Date(expiry).getTime() / 1000) : 0;

    const toastId = toast.push({
      status: "pending",
      title: `Issuing ${credentialType.trim()}`,
      detail: "The credential is sealed and pinned first, then anchored once you sign.",
    });

    try {
      const { prepared, forwarded } = await run(
        "/credentials/issue",
        {
          didHash: didHash.trim(),
          credentialType: credentialType.trim(),
          claims: Object.fromEntries(filled.map((claim) => [claim.key.trim(), claim.value])),
          expiresAt,
        },
        {
          403: "Issuing a credential needs the ISSUE_CREDENTIAL permission on your own identity.",
          expiry_in_the_past: "That expiry has already passed.",
        },
      );

      setDisclosure({
        credentialHash: String(prepared.credentialHash),
        jwt: String(prepared.jwt),
        contentKey: String(prepared.contentKey),
        envelopeUri: String(prepared.envelopeUri),
        anchored: true,
        transactionHash: forwarded.transactionHash,
      });

      toast.resolve(toastId, {
        status: "success",
        title: "Credential issued and anchored",
        detail: "Save the document and its key now — neither is stored by the platform.",
        reference: forwarded.transactionHash,
      });

      setClaims([{ key: "", value: "" }]);
      setCredentialType("");
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Issuance failed.";
      setError(message);
      toast.resolve(toastId, { status: "error", title: "Credential not issued", detail: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8" data-testid="credential-issue">
      <h3 className="text-sm font-semibold">Issue</h3>

      <form className="mt-4 space-y-4" onSubmit={issue}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block eyebrow">Subject identity (DID hash)</span>
            <input
              value={didHash}
              onChange={(event) => setDidHash(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              disabled={busy}
              className="w-full rounded border border-line bg-canvas px-3 py-2 font-mono text-sm"
              data-testid="credential-did"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block eyebrow">Type</span>
            <input
              value={credentialType}
              onChange={(event) => setCredentialType(event.target.value)}
              placeholder="EmploymentCredential"
              spellCheck={false}
              disabled={busy}
              className="w-full rounded border border-line bg-canvas px-3 py-2 text-sm"
              data-testid="credential-type"
            />
            {credentialType.trim() !== "" && !validType && (
              <span className="mt-1.5 block text-xs text-fallback">
                A type name becomes a JSON-LD type and an on-chain schema id, so it must be
                alphanumeric and start with a letter.
              </span>
            )}
          </label>
        </div>

        <div>
          <span className="mb-1.5 block eyebrow">Claims</span>
          <div className="space-y-2">
            {claims.map((claim, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  value={claim.key}
                  onChange={(event) => setClaim(index, { key: event.target.value })}
                  placeholder="role"
                  spellCheck={false}
                  disabled={busy}
                  className="w-1/3 min-w-0 rounded border border-line bg-canvas px-3 py-2 text-sm"
                  data-testid="claim-key"
                />
                <input
                  value={claim.value}
                  onChange={(event) => setClaim(index, { value: event.target.value })}
                  placeholder="Senior Engineer"
                  disabled={busy}
                  className="min-w-0 flex-1 rounded border border-line bg-canvas px-3 py-2 text-sm"
                  data-testid="claim-value"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy || claims.length === 1}
                  onClick={() => setClaims((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove claim ${index + 1}`}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-2"
            disabled={busy || claims.length >= 32}
            onClick={() => setClaims((current) => [...current, { key: "", value: "" }])}
            data-testid="claim-add"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add a claim
          </Button>

          <p className="mt-2 max-w-[64ch] text-xs leading-relaxed text-fg-faint">
            A credential is signed, pinned and effectively permanent, so claims are bounded: at most
            32, values up to 512 characters. Nothing here reaches the chain — only a hash does.
          </p>
        </div>

        <label className="block max-w-xs">
          <span className="mb-1.5 block eyebrow">Expires (optional)</span>
          <input
            type="date"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            disabled={busy}
            className="w-full rounded border border-line bg-canvas px-3 py-2 text-sm"
            data-testid="credential-expiry"
          />
          <span className="mt-1.5 block text-xs text-fg-faint">
            Left empty, the credential does not expire.
          </span>
        </label>

        {error && (
          <p
            className="max-w-[64ch] text-sm leading-relaxed text-revoked"
            data-testid="credential-issue-error"
          >
            {error}
          </p>
        )}

        <Button type="submit" size="sm" disabled={!ready} data-testid="credential-issue-submit">
          {busy ? "Awaiting signature…" : "Issue credential"}
        </Button>
      </form>

      {disclosure && (
        <DisclosurePanel disclosure={disclosure} onDismiss={() => setDisclosure(null)} />
      )}
    </section>
  );
}

/**
 * The one-time disclosure.
 *
 * Deliberately heavy: a bordered panel that persists until dismissed, with an explicit
 * confirmation rather than an X in a corner. The JWT and the content key are returned once
 * and stored nowhere, so this is the only moment they exist outside the holder's own records.
 * Every cheaper affordance — a toast, an auto-dismissing banner, a copy button alone — loses
 * somebody their credential eventually.
 */
function DisclosurePanel({
  disclosure,
  onDismiss,
}: {
  disclosure: Disclosure;
  onDismiss: () => void;
}) {
  const toast = useToast();
  const [acknowledged, setAcknowledged] = useState(false);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.push({ status: "success", title: `${label} copied` });
    } catch {
      // Clipboard access is refused in plenty of ordinary situations — an insecure origin,
      // a permissions policy, a browser that wants a user gesture it did not see. The value
      // is on screen and selectable regardless, so this says what to do rather than failing.
      toast.push({
        status: "error",
        title: `Could not copy the ${label.toLowerCase()}`,
        detail: "Select the text and copy it manually — it is shown in full above.",
      });
    }
  };

  return (
    <div
      className="mt-6 rounded-lg border border-fallback/50 bg-fallback/8 p-5"
      data-testid="credential-disclosure"
      role="alert"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-fallback">Shown once. Save these now.</h4>
        <Status tone={disclosure.anchored ? "verified" : "fallback"}>
          {disclosure.anchored ? "Anchored on-chain" : "Pinned, not anchored"}
        </Status>
      </div>

      <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-fg-muted">
        The platform does not store the credential document or the key that decrypts it. If this
        panel closes without them being saved, the credential remains anchored and verifiable by
        hash — but nobody will be able to read it again, including you.
      </p>

      <dl className="mt-4 space-y-3">
        <Secret label="Credential JWT" value={disclosure.jwt} onCopy={copy} />
        <Secret label="Content key" value={disclosure.contentKey} onCopy={copy} />
        <div>
          <dt className="eyebrow">Credential hash</dt>
          <dd className="mt-1 break-all font-mono text-2xs text-fg-muted">
            {disclosure.credentialHash}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Sealed envelope</dt>
          <dd className="mt-1 break-all font-mono text-2xs text-fg-muted">
            {disclosure.envelopeUri}
          </dd>
        </div>
      </dl>

      <label className="mt-5 flex items-start gap-2.5 text-sm text-fg">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5"
          data-testid="disclosure-acknowledge"
        />
        <span>I have saved the credential and its content key.</span>
      </label>

      <Button
        size="sm"
        className="mt-4"
        disabled={!acknowledged}
        onClick={onDismiss}
        data-testid="disclosure-dismiss"
      >
        Close
      </Button>
    </div>
  );
}

function Secret({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div>
      <dt className="flex items-center justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onCopy(label, value)}>
          <Copy className="size-3.5" aria-hidden="true" />
          Copy
        </Button>
      </dt>
      <dd className="mt-1 max-h-28 overflow-auto break-all rounded border border-line bg-canvas p-2.5 font-mono text-2xs text-fg-muted">
        {value}
      </dd>
    </div>
  );
}

function RevokePanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const run = usePreparedAction();

  const [hash, setHash] = useState("");
  const [reason, setReason] = useState<number>(REVOCATION_REASONS[0].code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validHash = /^0x[0-9a-fA-F]{64}$/.test(hash.trim());

  const revoke = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validHash || busy) return;

    setBusy(true);
    setError(null);

    const toastId = toast.push({
      status: "pending",
      title: "Revoking credential",
      detail: "Revocation is public and permanent — sign to record it.",
    });

    try {
      const { forwarded } = await run(
        "/credentials/revoke",
        { credentialHash: hash.trim(), reasonCode: reason },
        {
          403: "Revoking a credential needs the REVOKE_CREDENTIAL permission on your own identity.",
          credential_not_found: "No credential with that hash is anchored on this network.",
          already_revoked: "That credential has already been revoked.",
        },
      );

      toast.resolve(toastId, {
        status: "success",
        title: "Credential revoked",
        detail: "Any verifier checking it from now on will be told, with the reason.",
        reference: forwarded.transactionHash,
      });

      setHash("");
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Revocation failed.";
      setError(message);
      toast.resolve(toastId, { status: "error", title: "Not revoked", detail: message });
    } finally {
      setBusy(false);
    }
  };

  const chosen = REVOCATION_REASONS.find((entry) => entry.code === reason);

  return (
    <section className="mt-10 border-t border-line pt-8" data-testid="credential-revoke">
      <h3 className="text-sm font-semibold">Revoke</h3>
      <p className="mt-1 max-w-[64ch] text-sm leading-relaxed text-fg-muted">
        Revocation is a public statement, not a deletion. The credential stays anchored and its
        history stays readable; what changes is that every verifier from this block onward is told
        it no longer stands, and why.
      </p>

      <form className="mt-4 space-y-4" onSubmit={revoke}>
        <label className="block">
          <span className="mb-1.5 block eyebrow">Credential hash</span>
          <input
            value={hash}
            onChange={(event) => {
              setHash(event.target.value);
              setError(null);
            }}
            placeholder="0x…"
            spellCheck={false}
            disabled={busy}
            className="w-full rounded border border-line bg-canvas px-3 py-2 font-mono text-sm"
            data-testid="revoke-hash"
          />
        </label>

        <label className="block max-w-sm">
          <span className="mb-1.5 block eyebrow">Reason</span>
          <select
            value={reason}
            onChange={(event) => setReason(Number(event.target.value))}
            disabled={busy}
            className="w-full rounded border border-line bg-canvas px-3 py-2 text-sm"
            data-testid="revoke-reason"
          >
            {REVOCATION_REASONS.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </select>
          {chosen && <span className="mt-1.5 block text-xs text-fg-faint">{chosen.detail}</span>}
        </label>

        <p className="max-w-[64ch] text-xs leading-relaxed text-fg-faint">
          The reason code is recorded on-chain alongside the revocation. It is the difference
          between a verifier learning that a credential was withdrawn at the holder&rsquo;s request
          and learning that its key was compromised.
        </p>

        {error && (
          <p
            className="max-w-[64ch] text-sm leading-relaxed text-revoked"
            data-testid="credential-revoke-error"
          >
            {error}
          </p>
        )}

        <Button
          type="submit"
          size="sm"
          disabled={!validHash || busy}
          data-testid="credential-revoke-submit"
        >
          {busy ? "Awaiting signature…" : "Revoke credential"}
        </Button>
      </form>
    </section>
  );
}
