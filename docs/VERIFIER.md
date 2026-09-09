# Public verifier (P3.4)

`/verify` is the only page in the product that requires nothing: no wallet, no account, no
session. That is a requirement rather than an oversight — a credential whose validity can
only be checked by someone with an account on the issuing platform is not verifiable in any
useful sense. A test asserts the request carries no credentials, so the endpoint behaves
identically for a stranger and for the issuer.

## One click

A `?hash=` or `?jwt=` in the URL verifies immediately on load. That is what makes the share
button a genuine proof link: the recipient opens it and sees the verdict having done
nothing.

The link is public and read-only by construction — it carries a credential hash to an
unauthenticated endpoint that only reads. Sharing it grants no ability to change anything,
and it carries the _question_ rather than the answer: opening it re-runs the check against
the chain rather than replaying a stored result.

## Five verdicts, not two

The build plan asks for green "AUTHENTIC" or red "UNREGISTERED / TAMPERED". There are five,
and collapsing them would be the exact dishonesty this platform is built against.

| Verdict          | When                                | Why it is its own outcome                                                                                                             |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **AUTHENTIC**    | chain says live, signature verifies |                                                                                                                                       |
| **TAMPERED**     | signature does not verify           | Evidence of an attempt, not merely an absence                                                                                         |
| **REVOKED**      | chain says revoked                  | The credential is **genuine** — validly issued, correctly signed, since withdrawn. Calling it tampered accuses its holder of forgery. |
| **EXPIRED**      | chain says expired                  | A validity period ending is not a failure                                                                                             |
| **UNREGISTERED** | chain has no record                 | Never issued here, or issued on another network                                                                                       |

`decideVerdict` in `src/verify/verdict.ts` is pure and carries the heaviest test file on the
page, because this is the single claim the product makes to a stranger.

### A failed signature outranks the chain

If the bytes do not match what was signed, the on-chain record describes a _different_
document, so reporting its status would answer a question nobody asked — and would show
"AUTHENTIC" over a forgery. Three tests pin this: a bad signature reports TAMPERED whether
the chain says valid, revoked or unknown.

### The page never claims more than it checked

Verifying by hash proves the chain holds a live record. It does **not** prove the document
in your hand is the one that record refers to. So a hash-only verification says so in the
verdict text, and only a full credential earns "both checks passed".

## Two independent checks

The API deliberately reports the signature and the chain status separately, and the page
preserves that separation:

- the **signature** says the document is authentic and unaltered
- the **chain** says whether it is still live

Collapsing them into one boolean would hide the difference between a forgery and a genuine
credential revoked this morning — and those call for very different responses from whoever
is relying on it.

## Provenance

The timeline is built node by node from facts the response actually carried — issued,
signature checked, expires, revoked — with the connector drawn by an SVG `pathLength`
animation so it draws rather than fades.

The plan describes a "mint → transfers → current owner" chain. That shape belongs to
**assets**, and the asset event indexer does not exist yet. Inventing transfer nodes would
be fabricating provenance on the one page whose entire purpose is proving provenance, so
the timeline is short because the truthful version is short. A test asserts an empty
response produces an empty timeline rather than a placeholder chain.

## QR scanning

Uses the browser's own `BarcodeDetector` — no dependency. A QR decoding library is
40–200 kB that most visitors never use, and Chrome and Edge ship a detector already. Where
it is missing (Safari, Firefox at time of writing) the button is hidden and the paste field
does the same job.

Decoding happens on the device; only the decoded value is sent. The camera stream is
stopped on unmount and on a successful read, so the indicator light goes out when scanning
ends rather than when the tab does.

## What it will not do

- **Report an unreachable registry as a verdict.** A 503 means _unknown_; rendering a red
  "UNREGISTERED" from a failure to look would be asserting something about the credential.
- **Show a verdict for a rate-limited request.** The endpoint is public and rate limited per
  IP; that is explained, not disguised as a result.
- **Call the API for input that is neither a hash nor a JWT.** Rejected client-side with a
  sentence naming both accepted shapes.

## Verified live

`node tools/e2e-verify-page.mjs` — 18 assertions. Issues a real credential, anchors it
on-chain, then verifies it **with no cookie**, covering unregistered, hash-only, full-JWT
and tampered. The tampered case flips one character of the payload and checks that the
signature fails _and_ that the altered document hashes differently, so the chain has no
record of it either.

Run it before `tools/e2e-flow.mjs`, which exhausts the per-IP auth limiter as its last step.
