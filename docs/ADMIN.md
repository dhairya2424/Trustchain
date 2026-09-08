# Admin console (P3.3)

Three consoles behind a shared left rail at `/admin`: the audit log, a mint wizard, and
roles. All three now do real work — roles was wired after the initial P3.3 pass, and the
shape of that wiring is the part worth reading carefully.

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

## Roles — wired, two-phase

Grant and revoke are real. They are **not** a POST that asks the API to make the change:
that would require the relayer to hold authority to grant any role to anyone, which is
exactly the confused deputy the ERC-2771 work exists to close.

Instead, the same two-phase flow as minting and credential issuance:

1. `POST /roles/prepare-grant` (or `prepare-revoke`) returns EIP-712 typed data
2. the ADMIN signs it in their own wallet
3. `POST /network/forward` relays it

The relayer pays the gas; the contract still sees the ADMIN as the caller. A role change is
therefore recorded against the person who asked for it.

### Roles attach to a DID, not an address

The contract's entry points are `grantRoleToDID(bytes32 didHash, bytes32 role)` and
`revokeRoleFromDID`. It resolves that identity's _active controller_ at execution time, so a
key rotation carries the role with it instead of stranding it on an old wallet — which is
the problem statement's model: rights belong to a verified identity.

The console therefore takes an address only as a way to find the identity behind it, and
refuses to act when there is none. A test covers that case.

### What the API will not encode

`role` is a **name** from the four the platform defines, never a raw `bytes32`. Accepting a
hash would let a caller prepare a grant for any role identifier the contract recognises,
including `DEFAULT_ADMIN_ROLE` — the one that administers every other role. Constraining the
input means such a call cannot be _constructed_ here, rather than relying on the contract to
refuse it afterwards. There is a test for exactly that request.

The schema is `.strict()`, so an unknown field is a 400 rather than something a later
refactor might start reading. And `actor` always comes from the session, never the body: a
caller cannot prepare a role change attributed to somebody else.

### Three layers of authorization

| Layer    | Check                                                | Why it exists                                                                                                                              |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Console  | `canManage` disables the switch                      | Courtesy only. Shown rather than hidden, so a denied capability is discoverable.                                                           |
| API      | `requirePermission("MANAGE_ROLES")`, read from chain | Avoids spending relayer gas discovering what it could have known, and gives a 403 that explains itself.                                    |
| Contract | `grantRole` against the recovered signer             | **The control that matters.** A forged request from someone without the permission is refused on-chain even if it passes everything above. |

`GET /roles/:address` requires a session but no particular role. The data is public — anyone
can call `rolesOf` against the chain directly — so gating it on ADMIN would inconvenience
only the honest. The session requirement exists because the endpoint makes the platform do a
chain read on request, and an unauthenticated amplifier is worth avoiding.

### Self-lockout

Revoking your own ADMIN is the one change with no recovery path if it was the last one. The
console warns before it, and does not block it: an administrator who means to step down is
entitled to, and a UI that silently refuses would be worse than one that explains.

The switch also does **not** flip optimistically. The chain is the authority on who holds a
role, and moving the control before the transaction confirms would assert something nobody
has verified yet; it re-reads instead.

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
