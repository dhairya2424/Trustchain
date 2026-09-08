# Admin console (P3.3)

Three consoles behind a shared left rail at `/admin`: the audit log, a mint wizard, and
roles. Two of them do real work. The third does not, and says so — which is the part of this
phase worth reading carefully.

## The rail

`/admin` nests its routes, so the rail persists and only the console swaps. The active
indicator is **one element** moved between items with a shared Framer `layoutId`, which is
what makes it slide; a per-item outline could only fade in and out. Under reduced motion the
same element simply appears in place.

The rail is not an authorization boundary and does not pretend to be. Every console
re-checks with the API and the API re-reads the chain. Hiding a link would make an
unauthorised action harder to _find_, never harder to _perform_, and would leave the user
unable to discover that a capability exists at all.

## Audit log — fully real

`GET /audit`, with the filters the API already accepts: actor, action, from, to. Nothing
here is derived or approximated.

- **Virtualized** with `@tanstack/react-virtual`. An audit log is the one table in this
  product with no natural upper bound, and the honest answer to "show me everything" cannot
  be to mount every row.
- **Date inputs are converted to unix seconds**, which is what the API takes. There is a
  test pinning the exact conversion, because an off-by-one-day filter silently returns the
  wrong records rather than failing.
- **The detail panel** slides in from the right on hover or click, and names all three
  addresses separately: `actor` (who requested it), `executor` (who submitted and paid), and
  `via` (the system contract that recorded the entry). Conflating those was a real bug in
  P3.2, fixed in `226896e`.
- **`source` is displayed** — `subgraph` or `chain`. A verifier reading an audit log is
  entitled to know whether the answer came from an indexer that may lag or from the chain
  itself. Concealing a degraded read is how a stale answer gets treated as authoritative.
- **Live mode is off by default.** Polling falls back to `getLogs`, which scans blocks on
  every call; that is not something a console should do to a chain unasked. The pulsing dot
  runs only while live is on, and stops under reduced motion.

Three failure states, distinguished rather than merged into one empty table: `403` is a
missing `VIEW_AUDIT` permission (the RBAC working), `503` is no usable network (unknown, not
empty), anything else reports itself.

## Mint wizard — fully real

Three steps — details, artwork, confirm — posting multipart to `POST /assets/mint`.

That endpoint requires the **caller's own** `MINT_ASSET` permission, read from the chain,
not the relayer's. That check is the fix for the confused-deputy bug the P2.6 exit check
found, and it means a plain USER who reaches this form still cannot mint. The wizard is a
convenience; the contract and the API are the gate.

Upload progress is genuine, taken from `XMLHttpRequest.upload.onprogress`. `fetch` still
cannot report request-body progress, and a ring that merely spins while a 10 MB file uploads
tells the user nothing about whether it is moving. The file size limit is checked before
upload too, so an oversized file gets a sentence rather than a 413 after a long wait.

On success the wizard **invalidates the audit query rather than optimistically inserting a
row**. An optimistic row would be a record the app has not actually read back — precisely
the fabrication this product cannot afford. The new entry appears because the trail is
re-read.

## Roles — deliberately not wired

The build plan asks for inline grant/revoke with animated toggles. **That is not built, and
the reason is the point.**

There is no API for it. The backend exposes no endpoint to grant or revoke a role, and none
to read the roles of an address other than your own. Building the toggles anyway would give
a switch that flips, animates, turns green — and changes nothing on-chain. On the one screen
where a control that lies about authorization is most dangerous, someone would grant "ADMIN"
to a colleague, watch the animation, and believe it happened.

So the console shows what is genuinely known — the four-role model from the contracts, and
your own roles read from the chain at sign-in — and states plainly that the mutation is
unavailable. A test asserts that **no switch, no grant button and no revoke button exists**,
so the honest version cannot regress into a decorative one.

### What wiring it would take

In order, and through the existing two-phase signing flow rather than around it:

1. `encodeGrantRole` / `encodeRevokeRole` beside the existing encoders in
   `packages/backend/src/chain/forwarding.ts`
2. a prepare endpoint returning EIP-712 typed data, matching how mint and credential
   issuance already work, so the ADMIN signs and the relayer merely submits
3. `RoleAccessControl` in the forwarder's target allowlist
4. a read endpoint for another address's roles

Doing it this way is what keeps attribution intact: a role change would be recorded against
the ADMIN who requested it, not the relayer that paid for it. Doing it any other way would
reintroduce the confused deputy the ERC-2771 work exists to close.

## Toasts

Every action reports through a status toast that carries a transaction from submitted to
confirmed or failed. Two rules matter more than the spinner-to-check morph:

- **A pending toast never auto-dismisses.** It resolves when the transaction does. One that
  vanishes on a timer while the write is still in flight leaves the user believing it
  finished.
- **A failed toast never auto-dismisses either.** An error nobody saw is an error they will
  hit again.

Only success expires on its own. The icon keeps the same 20px box in all three states so the
toast does not reflow at the exact moment someone is reading it.

## Known limits

- **Optimistic UI is deliberately absent.** The plan asks for it; this uses query
  invalidation instead. Optimism means rendering a record before the chain has confirmed it,
  and on a ledger product that is the one shortcut that undermines the claim. The toast
  carries the pending state instead, which is what the user actually needs to see.
- Virtualized rows are not asserted in tests: jsdom reports every element as zero-height, so
  the virtualizer renders nothing and a test would be asserting the harness rather than the
  table. The filters, states, live toggle and detail panel are all covered.
- CSV export (`GET /audit/export.csv`, ADMIN only) exists in the API but has no button yet.
