# Running the system end to end

The P2.6 exit check, how to reproduce it, and what it found.

**Result: 68 checks, 68 passed, against live infrastructure** — a real chain with really
deployed contracts, real Redis, real Postgres, real HTTP. Nothing stubbed.

It found one privilege-escalation bug and two robustness bugs that 439 unit tests had
missed. That is the argument for having it.

---

## 1. Reproducing it

```bash
# 1 — infrastructure. REDIS_PORT is overridable because a pre-existing native Redis
#     will otherwise shadow the container (see §4).
REDIS_PORT=6380 docker compose up -d postgres redis

# 2 — a local chain
npm run chain                        # or: docker compose up -d hardhat

# 3 — contracts, and the identities the API needs
npm run deploy:local
npm run seed                         # registers DIDs, grants ADMIN/MANAGER/AUDITOR/USER

# 4 — configuration. Generates every key locally; refuses to overwrite an existing .env.
REDIS_PORT=6380 node tools/gen-dev-env.mjs

# 5 — the API
npm run dev --workspace @trustchain/backend

# 6 — the exit check
node tools/e2e-flow.mjs
```

`tools/e2e-flow.mjs` drives the API over HTTP exactly as a client would: it signs real SIWE
messages with real keys, uploads a real PNG, and reads the audit trail back. It asserts the
negative cases as hard as the positive ones — a gate that never refuses anything is not a
gate.

## 2. What the check covers

| Section                      | What it proves                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Authentication            | nonce → SIWE signature → Turnstile → cookie session; roles come from the chain; the seeded DID binds to the session                                  |
| 2. Auth refusals             | a replayed nonce is refused; a signature not matching the claimed address is refused; a missing Turnstile token is a 403                             |
| 3. Audit authorization       | anonymous is 401; a USER without `PERM_VIEW_AUDIT` is 403; a USER cannot export                                                                      |
| 4. Mint                      | a MANAGER mints through the API and the transaction is mined; **a USER cannot mint**                                                                 |
| 5. Audit shows the mint      | `ASSET_MINTED` appears, attributed to the initiating account, with `via` distinct from `actor`; filtering works; an unknown action name is refused   |
| 6. Credentials               | issue → verify → revoke → verify; the pinned envelope is checked on disk for claim text; a USER cannot issue                                         |
| 7. Audit shows the lifecycle | `CREDENTIAL_ISSUED`, `CREDENTIAL_REVOKED`, `ASSET_MINTED`, `DID_REGISTERED` all present                                                              |
| 8. CSV export                | ADMIN only; correct headers; every field quoted                                                                                                      |
| 9. Security headers          | CSP, nosniff, frame-ancestors, referrer policy, no `X-Powered-By`, request id echoed                                                                 |
| 10. CORS                     | the app origin is admitted with credentials; an unlisted origin and a look-alike suffix origin get no header; a request with no `Origin` still works |
| 11. Rate limiting            | a burst of logins is eventually refused with `Retry-After`                                                                                           |

The audit read reports `source: "chain"` throughout, because no subgraph runs locally —
so the run exercises the `getLogs` fallback rather than the fast path. That is the half
more likely to be wrong, and the half that has to work during an indexer outage.

---

## 3. The bug it found: a confused deputy at `/assets/mint`

**A plain USER could mint assets.** The API returned 202 and an NFT was really created.

The cause is the relayer pattern interacting badly with on-chain authorization. Minting is
submitted through a relayer that signs with **its own key**, so `AssetRegistry.mint`'s
`onlyPermission(MINT_ASSET)` modifier was checking the _relayer's_ authority — which the
relayer must hold, or it could not relay anything at all. From the chain's side the call was
perfectly legitimate. The route authenticated the caller and never asked whether _they_ were
allowed to mint, so every authenticated user inherited the relayer's authority.

This is the classic confused-deputy shape, and it is worth naming precisely because the
system looked correct from both ends: the contract had a permission check, and the API had
an authentication check. Neither was wrong on its own. What was missing was the observation
that **once a privileged relayer sits between the caller and the contract, the contract's
check no longer says anything about the caller** — so the API becomes the only place the
caller's authority can be enforced.

The fix adds `requirePermission({ permission: "MINT_ASSET" })` to the route, reading the
caller's own on-chain permission at request time. `packages/backend/src/assets/routes.test.ts`
is the regression suite; with the gate removed, 6 of its 12 tests fail.

**Why it survived review and 439 tests:** `/assets/mint` had _no route-level test at all_.
`assets.test.ts` covered the upload inspector, the metadata stripper and the provenance
builder thoroughly — every unit beneath the route, and never the route. A unit test cannot
find a missing middleware, because the missing middleware is not in any unit.

The same reasoning applies to `/credentials/issue` and `/credentials/revoke`, which were
built in P2.6 with `requirePermission` from the start and were therefore never vulnerable.
The audit routes likewise.

## 4. The other two findings

**An unhandled Redis error killed the process.** The first run died on `ERR unknown command
'getdel'` — not a caught error, a crashed server. The auth router's async handlers were not
wrapped in `asyncHandler`, so a rejected promise escaped Express 4 entirely. Any Redis
hiccup would have taken the whole API down. Now wrapped, like every other router.

**A stale native Redis shadowed the container.** `GETDEL` needs Redis 6.2+; the container is
7.4.11 and supports it. But an old **Redis 3.0.504** — the abandoned Windows port — was
already listening on 6379 on this machine, so Docker's published port lost and the API
silently talked to a server nine years out of date. `docker-compose.yml` now takes
`POSTGRES_PORT`, `REDIS_PORT` and `HARDHAT_PORT` overrides, and `gen-dev-env.mjs` reads
them, so the conflict is steerable rather than mysterious.

Worth knowing on this machine: **that old Redis is still running and still owns 6379.**
Nothing here changed it — disabling a service is the operator's call, not the build's.

---

## 5. Local substitutes, and how they are fenced

Two hosted services have no local equivalent, and a system that cannot run without a vendor
account cannot be demonstrated or debugged. So:

| Production                         | Local substitute                                           | Guard                                         |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| OpenZeppelin Relayer (self-hosted) | none — the relayer service is now used for local runs too  | the service holds the key; the API never does |
| Pinata / IPFS                      | `src/dev/localPinner.ts` — content-addressed files on disk | throws if `NODE_ENV=production`               |

Both live under `src/dev/` so their presence in an import graph is visible, and both take
their configuration explicitly rather than reading `process.env` themselves, so no
configuration accident can silently arm them.

The local pinner preserves the property that matters for testing — content addressing, via
SHA-256 — but does **not** mint real IPFS CIDs. A real CIDv1 commits to a multicodec, a
multihash prefix and DAG-PB chunking; faking those would produce identifiers that look
authentic and resolve to nothing. Its addresses are prefixed `bafydev` so nobody mistakes
one for a real pin.

## 6. What the run still does not prove

- **This run predates the relayer migration.** It was executed against the since-removed
  in-process local signer. The flow and the controls it proves are unchanged, but the
  signing path is now the self-hosted OpenZeppelin Relayer — see [RELAYER.md](RELAYER.md).
- **No subgraph.** The fast path in `SubgraphAuditSource` is tested only against a fake; the
  run exercises the chain fallback.
- **Postgres is up but barely used.** The profile repository is not wired into `index.ts`,
  so row-level security and field encryption (P2.3) are covered by their own tests, not by
  this run.
- **The asset read routes return honest 404s.** `GET /assets/:id` and `/provenance` are wired
  to sources that report "not found" rather than fabricated data — the asset repository and
  the asset event indexer are not implemented.
- **Nginx is still unexecuted** (carried from P2.5), and **CORS is still not mounted**.
- **The rate limits are raised in the local `.env`** so the check's own breadth does not
  throttle it. Production defaults live in `config/env.ts`; section 10 of the check proves
  the limiter still fires by deliberately exhausting it.
