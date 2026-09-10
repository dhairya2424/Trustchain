# Security test results — P4.1 offensive pass

This is the record of an automated offensive pass against a running TrustChain deployment.
Every result below was produced by driving the live system and observing what it did, not by
reading the source: each row states the **attack**, the **expected** outcome, and the
**actual** one. The harnesses that produce these results are committed, so the pass is
repeatable rather than a one-off screenshot.

## How to reproduce

With the stack running (`docker compose up`, backend on `:4000`, frontend on `:5173`, the API
bound to Polygon Amoy):

```bash
node tools/security-pentest.mjs      --json out/pentest.json    # HTTP attacks
node tools/security-xss-dom.mjs      --json out/xss.json        # XSS-inert, in a browser
node tools/security-passive-scan.mjs --json out/passive.json    # ZAP-baseline-equivalent
```

## Environment for this run

- Backend `http://localhost:4000`, active network **Polygon Amoy (chain 80002)**.
- Frontend `http://localhost:5173` (Vite dev server).
- Authenticated cases signed in with the deployer wallet over the real SIWE flow.
- Date of run: recorded in the JSON artefacts alongside this document.

## Result in one line

**21 attacks driven, 0 findings.** One case (SQL injection through the profile write path)
could not be exercised live because the profiles feature is not mounted on this
Postgres-less Amoy backend; its defense is proven at the unit layer instead, and that is
called out honestly below rather than counted as a pass.

---

## 1. JWT forgery

The API issues **RS256** (asymmetric) session tokens and verifies them with
`jwtVerify(token, publicKey, { algorithms: ["RS256"], issuer, audience })`. Pinning the
algorithm list is the structural defense against every forgery below; the oracle for each
case is `GET /auth/session`, which returns the session when a token is accepted and `401`
when it is not.

| Attack                                                                                   | Expected       | Actual                               |
| ---------------------------------------------------------------------------------------- | -------------- | ------------------------------------ |
| `alg=none` token carrying `roles:["ADMIN"]`, signature stripped                          | rejected (401) | **401 `unauthenticated`**            |
| `HS256` token signed with an RSA **public** key as the HMAC secret (algorithm confusion) | rejected (401) | **401 `unauthenticated`**            |
| `kid` header injection (`../../dev/null' OR '1'='1`), signed with an attacker RSA key    | rejected (401) | **401 `unauthenticated`**            |
| A **real** session token whose payload was edited to add a role, original signature kept | rejected (401) | **401 `unauthenticated`**            |
| _Control:_ the untampered session token from the same sign-in                            | accepted (200) | **200**, `roles=["ADMIN","MANAGER"]` |

The control matters: it proves the oracle actually distinguishes a good token from a bad one,
so the four rejections are meaningful rather than a blanket 401.

**Why kid injection is a non-event here:** the verifying key comes from configuration, and
`kid` is never dereferenced — there is no key-by-kid lookup, no JWKS fetch, nothing that a
crafted `kid` could point at. The value is ignored.

---

## 2. SIWE replay

Sign-in nonces are single-use: `NonceService.consume` deletes the nonce the first time it is
presented, so a captured login message — still perfectly valid as a signature — is worthless
on a second submission.

| Attack                                                                       | Expected                        | Actual                                               |
| ---------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| Re-submit a captured, still-valid SIWE message + signature to `/auth/verify` | first accepted, replay rejected | **first 200, replay 401 `invalid_or_expired_nonce`** |

---

## 3. IDOR — acting on data that is not yours

The design principle is that the actor is always the authenticated session, never an
identifier taken from the request. There is no `?address=` or body field that redirects a
read or a write to another user; the scope is structural.

| Attack                                                                         | Expected                                                      | Actual                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /assets/owned?address=<someone else>`                                     | the parameter is ignored; answers only for the session wallet | **200**, `owner=0x7D26…779B` (the session), spoofed param had no effect |
| `POST /assets/prepare-transfer` for token **#999999** the caller does not hold | refused, never prepared                                       | **404 `asset_not_found`**                                               |
| `GET /assets/owned` with **no session**                                        | rejected (401)                                                | **401 `unauthenticated`**                                               |
| `POST /network/forward` with `from` = a **different** wallet than the session  | refused                                                       | **403 `actor_mismatch`**                                                |

The last row is the core of the platform's meta-transaction model: the relayer pays gas, but
the forwarder verifies the signature belongs to the session, so a caller cannot forward a
transaction "as" anyone else.

---

## 4. XSS — every payload renders inert

Driven in a real browser (`tools/security-xss-dom.mjs`) with a trap installed before any app
code runs: each payload attempts to execute through a different sink (`onerror`, `onload`, an
inline `<script>`, an `alert`) and sets a flag if it succeeds. After the payload is typed into
a field and the view renders, the flag is read and the payload's literal text is confirmed
present as data — so the field displayed what was typed, inertly.

| Attack                                               | Expected                                    | Actual                                                                           |
| ---------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `document.cookie` read after signing in              | session + refresh cookies absent (HttpOnly) | **`document.cookie` is `""`** — no token visible to script                       |
| `<img src=x onerror=…>` in the mint name/description | no execution; shown as literal text         | **did not execute**, shown as text                                               |
| `"><svg onload=…>` in the mint name/description      | no execution; shown as literal text         | **did not execute**, shown as text                                               |
| `<script>…</script>` in the mint name/description    | no execution; shown as literal text         | **did not execute**, shown as text                                               |
| `'"><body onload=…>` in the mint name/description    | no execution; shown as literal text         | **did not execute**, shown as text                                               |
| `<img onerror>` in the identities lookup field       | no execution                                | **did not execute** (rejected as a non-address)                                  |
| `<script>` submitted to the public verifier          | no execution                                | **did not execute** (held as a value, sent to the API, never rendered as markup) |

React escapes interpolated content by default, so every reflected payload becomes a text
node. The HttpOnly result is the important pairing: even if a payload ever did execute, it
could not read the session token, which turns an XSS into a request-forgery problem rather
than an account takeover — and the CSP in §6 closes that too.

---

## 5. SQL injection

The API's one SQL-backed surface is the profile store. Its SQL is
**parameterized by construction** (`packages/backend/src/db/sql.ts`): interpolated values
become `$1, $2` placeholders and column names come from a compile-time allowlist, so an
injection cannot be written even by accident. Every query parameter that reaches a filter is
additionally validated by a Zod schema first.

| Attack                                                             | Expected                                    | Actual                        |
| ------------------------------------------------------------------ | ------------------------------------------- | ----------------------------- |
| `GET /audit?actor=' OR '1'='1`                                     | rejected (400) — `actor` must be an address | **400 `invalid_request`**     |
| `GET /audit?actor='; DROP TABLE profiles;--`                       | rejected (400)                              | **400 `invalid_request`**     |
| `GET /audit?action=CREDENTIAL_ISSUED'--`                           | rejected (400) — fails the identifier regex | **400 `invalid_request`**     |
| `PATCH /profiles/me displayName = Alice'); DROP TABLE profiles;--` | stored as a literal, no side effect         | **not exercised — see below** |

**The profile write, honestly:** the profiles feature is only mounted when the backend is
wired with Postgres. This Amoy dev backend runs without it, so `/profiles/me` is absent (a
bare `404` for every verb). Firing a payload at a route that does not exist and calling the
resulting 404 a "defense" would be theatre, so the case is **skipped** and its defense is
established directly at the layer that matters:

- `packages/backend/src/db/sql.test.ts` — the payload `'; DROP TABLE users; --` compiles to
  `… WHERE display_name = $1`; the generated SQL text **contains no `DROP`**, and the payload
  lands in the bound-values array.
- `packages/backend/src/db/connection.test.ts` — a `0x'; SET ROLE postgres; --` value is
  bound as a parameter, never concatenated into the statement.
- `packages/backend/src/db/rls.test.ts` — Postgres row-level security is proven end to end:
  one identity cannot read or write another's rows even with a valid session.

---

## 6. Passive scan — the ZAP baseline, and why it was run manually

An OWASP ZAP **baseline** scan is a passive pass: it spiders a target and inspects responses
for missing or weak security headers, unsafe cookie flags, permissive CORS, and technology
disclosure. It does not attack.

**The full ZAP container was not run in this session, and this is a deliberate, stated
choice rather than a skipped step.** The machine had ~2.7 GB free with Docker's WSL VM already
resident, and the low-memory watchdog had already killed the dev servers twice during the
session. Pulling a ~1.6 GB scanner image and starting a JVM against that headroom risked
killing the backend mid-scan and producing corrupt results. The honest alternative was to run
the exact passive inspection ZAP baseline performs, directly, and label it as such
(`tools/security-passive-scan.mjs`). When memory allows (close other apps, or stop the compose
stack when the chain is not needed), the real scan is one command:

```bash
docker run --rm -t --add-host=host.docker.internal:host-gateway \
  ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t http://host.docker.internal:5173 -I
```

### What the passive inspection found (API, `:4000`)

| Check                                            | Grade    | Observed                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content-Security-Policy                          | **PASS** | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; upgrade-insecure-requests` |
| X-Content-Type-Options                           | **PASS** | `nosniff`                                                                                                                                                                                                                 |
| Clickjacking (X-Frame-Options / frame-ancestors) | **PASS** | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`                                                                                                                                                                    |
| Referrer-Policy                                  | **PASS** | `no-referrer`                                                                                                                                                                                                             |
| Technology disclosure                            | **PASS** | no `X-Powered-By`, no `Server` header                                                                                                                                                                                     |
| CORS reflection                                  | **PASS** | an attacker `Origin` is **not** echoed into `Access-Control-Allow-Origin`                                                                                                                                                 |
| HSTS                                             | **INFO** | absent over plain-http dev, as expected; applied by the TLS ingress in production (see `docs/HTTPS.md`)                                                                                                                   |

### Session cookie flags (observed on a real `/auth/verify`)

```
trustchain_session=…; Max-Age=900;    Path=/;     HttpOnly; SameSite=Strict
trustchain_refresh=…; Max-Age=604800; Path=/auth; HttpOnly; SameSite=Strict
```

- **HttpOnly** on both — confirmed again at runtime in §4 (`document.cookie` is empty).
- **SameSite=Strict** on both — the cookie does not ride a cross-site request, closing CSRF.
- The refresh token is scoped to **`Path=/auth`**, so it is sent only to the refresh endpoint,
  never to the rest of the API — defence in depth if the access token path were ever exposed.
- **Secure** is off on the plain-http dev origin (`secureCookies=false`) and set by the
  production configuration; over TLS it is present.

### Frontend (`:5173`)

The Vite dev server serves without the production header set; the CSP, frame options and HSTS
for the SPA are applied by the Nginx ingress described in `docs/HTTPS.md`. This is noted as
**INFO**, not failed, because it is a dev-vs-production distinction rather than a gap in the
application.

---

## P4.2 — secrets sweep & response trimming

The hygiene pass. One command runs all of it: `npm run security:all`.

### Full git-history secret sweep — `node tools/scan-history.mjs`

Every line ever _added_ across all branches is run through the same secret patterns the
working-tree scanner uses — the check the working-tree scan cannot make, because a credential
deleted in a later commit still sits in history for anyone who clones. Result: **CLEAN, no
untriaged secret in any commit.**

Three shape-based false positives were flagged, investigated, and triaged (the git-history
equivalent of a `.gitleaksignore`, keyed by commit + file + pattern, so a genuinely new secret
still fails):

| Commit     | File                        | Flagged as            | Verdict                                                                                                  |
| ---------- | --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `bb3566f`  | `tools/e2e-verify-page.mjs` | evm-private-key       | a **`didHash`** — keccak256 of a public DID string, not a key                                            |
| `226896e0` | `Dashboard.test.tsx`        | evm-private-key       | an inert fixture **transaction hash** (`0x3333…3333`)                                                    |
| `eac8cdd9` | `config/env.test.ts`        | credential-assignment | the fixture string `"super-secret-value-that-must-not-leak"`, asserting the parser never echoes a secret |

`gitleaks` is run as an independent second opinion when present. It is **deliberately skipped
in this worktree**: a linked worktree's `.git` is a file pointing at the parent repo, so a
Docker-mounted gitleaks sees 0 commits and would falsely report "clean". The built-in sweep,
which uses the real git, is authoritative here; run gitleaks on the main checkout for the
second opinion. Nothing found means nothing to rotate.

### `.env` never committed, and cannot be

- No real dotenv file appears anywhere in history — only `.env.example`-style templates.
- `.gitignore` ignores `.env`, `packages/backend/.env`, `packages/contracts/.env`, so a stray
  secret file cannot be staged by accident.

### Backend-only keys never ship to the frontend — `security:bundle`

The frontend is built and the output (including sourcemaps) grepped for every server-only
variable **name** and current **value**, for `process.env` access, and for generic credential
patterns. Result: **clean, 20 built files scanned.** The bundle carries no `JWT_PRIVATE_KEY`,
`DATABASE_URL`, `PINATA_JWT`, `DEPLOYER_PRIVATE_KEY`, `AMOY_RPC_URL`, or any other backend
secret.

### Response trimming — the dev-mode contract guard

`http/responseValidation.ts` wraps `res.json` in development and test (a pass-through in
production, so it can never fail a live response) and enforces two things:

- **A strict DTO contract** on the read endpoints assembled from internal records — session,
  nonce, owned assets, audit page, identity. The schemas are `.strict()`, so an **extra field
  the DTO does not name throws**. This is the "trim API responses" enforcement: a handler that
  spreads one field too many out of a token payload or a chain read is caught the first time it
  runs. The contracts are allowlists of field _names_ — loose on value types on purpose, so a
  mistyped value can never fail a correct response.
- **A forbidden-key denylist** beneath every response, contracted or not: no body at any depth
  may carry a field whose name is server-only material (`privateKey`, `secret`, `mnemonic`,
  `password`, an encryption `iv`/`salt`). The SIWE `nonce` is explicitly allowed, being the
  public payload it is.

Proven both ways: the guard is active across all **622 backend unit tests** and the two live
Amoy suites (**30/30** and **28/28**), where no endpoint ever violates its contract; and
`responseValidation.test.ts` (7 cases, run by `security:responses`) proves it _throws_ on an
extra field and on a server-only key, and does not misfire on `active` (whose name contains
the short token `iv`).

### `npm run security:all`

Runs, in one command: working-tree secrets → full history → SQL → XSS → response contracts →
dependency audit → frontend-bundle leak grep → tool tests. **Exit 0.**

---

## Findings and follow-ups

- **No High or Medium findings.** Every attack driven against the live system was defended, and
  the one un-exercisable case is covered by unit tests.
- **The dependency audit reports 42 advisories (34 low, 8 moderate, 0 high/critical)** in
  transitive dev dependencies; `security:deps` passes because its threshold blocks only
  high/critical. Worth clearing when convenient, not a release blocker.
- **Run the full ZAP baseline on a machine with headroom** to convert the §6 passive results
  from "manual equivalent" to "tool-confirmed". The command is above; expected new findings:
  none, since the header and cookie posture it inspects is already locked down.
- **Exercise the SQL-injection case live** by running the pentest harness against a
  Postgres-wired backend (`DATABASE_URL` set, profiles mounted); the harness auto-detects the
  route and runs the payload when the feature is present.
- Two items remain open from the traceability audit and are unrelated to this pass:
  admin is still a deployer EOA (Safe multisig handover pending), and HTTPS is prepared but
  unproven without a domain and certificate.
