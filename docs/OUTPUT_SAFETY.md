# Output Safety — XSS, Headers, TLS and Logging

What P2.5 landed, what it deliberately does not do, and the reasoning behind each choice.

---

## 1. Why React alone is not the answer

React escapes every interpolated value. `{user.displayName}` is set through `textContent`,
not parsed as HTML, so a display name of `<script>alert(1)</script>` renders as those
characters on the page and executes nothing. That is the default and it holds for every
value the UI renders.

It stops holding at exactly four places, and they are enumerable:

| Opt-out                                          | Why it is dangerous                  |
| ------------------------------------------------ | ------------------------------------ |
| `dangerouslySetInnerHTML`                        | Parses the string as HTML by design  |
| `innerHTML` / `outerHTML` / `insertAdjacentHTML` | Same, via the DOM directly           |
| `eval`, `new Function`, `setTimeout("…")`        | Executes the string as code          |
| `javascript:` in `href`/`src`, and `srcdoc`      | Executes on interaction or on render |

Because the list is short and closed, it can be enforced rather than reviewed.
`tools/check-xss.mjs` scans both the frontend and the backend for every entry and fails the
build on any hit. It runs in `npm run security:xss`, in `security:all`, and as its own CI
step.

**Current audit result: zero `dangerouslySetInnerHTML`, zero of any other sink, zero
justified exceptions.** `tools/__tests__/check-xss.test.mjs` asserts that count is zero, so
adding one is a test failure that has to be argued in review rather than a change nobody
notices.

The escape hatch exists but has a price: an `xss-audit:allow <reason>` marker on the line or
the line above it. The reason is mandatory and the tool prints every marker it finds on each
run, so exceptions accumulate visibly instead of quietly.

### Why sanitise on the server at all, then?

React protects React. It does not protect a CSV export opened in Excel, a PDF receipt, a
Slack notification, an email, a log line read in a terminal, or the next client someone
writes against this API. Escaping is a property of a renderer; the API has many and will
have more. Storing clean data is the property that survives them all.

---

## 2. The sanitiser

`packages/backend/src/http/sanitize.ts`.

**It uses DOMPurify rather than a hand-rolled parser, on purpose.** Every other check in
this repository is written from scratch — the EXIF stripper, the secret scanner, the SQL
auditor. This one is not, because recognising markup means implementing the HTML parsing
algorithm, and the history of XSS is very largely the history of bespoke parsers that were
almost right: mutation XSS, namespace confusion, `noscript` re-parsing. DOMPurify is the
reference implementation, is adversarially tested by people who do this full time, and runs
against a real DOM through jsdom. Writing our own here would be a liability wearing the
costume of craftsmanship.

### Two halves, and why neither is sufficient

|                  | Where                                        | What it catches           |
| ---------------- | -------------------------------------------- | ------------------------- |
| **Store-clean**  | `sanitizeInput` middleware, after `validate` | Dirty data on the way in  |
| **Render-clean** | `sanitizeResponses`, wrapping `res.json`     | Dirty data already stored |

Input sanitisation alone fails because **the API is not the only writer**. Chain events,
the IPFS pinning provider, a migration, a DBA at a psql prompt, and every row written before
this middleware existed all reach a renderer through the same response path.

Output sanitisation alone fails because it cannot stop the dirty row being written, and a
row that is only cleaned on the way out is still wrong in every report, export and backup.

**Ordering matters: `validate` runs before `sanitizeInput`.** Sanitising first would let a
payload that fails the schema be quietly repaired into one that passes — 400 characters of
markup collapsing to 40 characters of text slips straight past a length rule the schema
author meant to enforce on what the user actually sent. There is a test for this exact
ordering.

### What it removes beyond markup

Markup is the obvious half. The rest matters more than it looks:

- **Bidi overrides** (U+202A–U+202E, U+2066–U+2069). U+202E reverses the rendering of
  everything after it, so a string can be _stored_ one way and _shown to a reviewer_
  another. For a system whose entire product is an audit trail, entries that do not read
  the way they were written are a direct attack on the thing being sold.
- **Zero-width characters** (U+200B–U+200D, U+2060, U+FEFF). Two visually identical display
  names that are different strings — the basis of impersonation and of duplicate-detection
  bypasses.
- **C0/C1 control characters**, including NUL, which truncates strings in C-backed
  consumers and terminates them early in some Postgres client paths.
- **Newlines, in single-line fields.** This is the log-forging defence: without it,
  a display name containing a newline and a plausible JSON object writes a fake entry into
  the log stream.
- **NFC normalisation**, applied first, so two spellings of one name compare equal — and
  applied before stripping, so it cannot re-form a character that was just removed.

The character classes are declared as **numeric code point ranges, not regex literals**. A
regex literal would have to contain the characters themselves, and a literal U+202E in the
source would reorder the file in every editor and code-review tool that renders it. A test
asserts the source file contains no invisible characters.

### The property that makes the output logging useful

The sanitiser only ever alters a string containing markup, a control character, a bidi
override or a zero-width character. **None of those appear in an Ethereum address, a CID, a
JWT, a hex hash or an ISO timestamp** — so nothing legitimate is ever touched, and any
alteration on the output path means dirty data is already in the store. That is why
`security.output_sanitized` is logged at `warn`: the rewrite is the fix, the log line is the
finding.

Both log lines record **field paths and finding names only, never the value.** Copying the
offending payload into a log would move the injection from the database into the log
aggregator, which is itself frequently rendered as HTML. There are tests asserting the
payload never appears in the log records.

`sanitizeRichText` exists but is used by nothing. It is there so the first field that
genuinely needs formatting arrives with an allowlist — including `ALLOWED_URI_REGEXP`,
without which an allowed `<a>` survives carrying a `javascript:` href.

---

## 3. Headers

`packages/backend/src/http/securityHeaders.ts` for the API,
`infra/nginx/snippets/security-headers.conf` for the SPA. They are **different policies on
purpose**, and each header has exactly one owner — two places setting one header is how one
of them silently goes stale.

### The API: `default-src 'none'`

Not `'self'`. This origin serves JSON; there is no legitimate script, style, image or font
for it to load, so the correct policy permits nothing at all. It matters despite `nosniff`:
if an API response is ever rendered as a document — an old browser, a plugin, a
`Content-Type` mistake — it has no capability whatsoever under this policy.

Applied **before any route, error handler or 404**, because a response that skips the rest
of the stack must still carry its headers. There is a test asserting the headers are present
on a 404, which is where they are most commonly lost.

### The SPA: `script-src 'self'`

No `'unsafe-inline'`, no `'unsafe-eval'`, no nonce needed — Vite emits no inline scripts.
This is the control that turns an HTML injection into a defaced page rather than a session
theft: an injected `<script>` has no source the browser will run, and an injected `onclick`
will not fire.

`'unsafe-inline'` appears once, in `style-src`. That is the one relaxation, it is
style-only, and an inline style cannot execute script.

`connect-src` names the API origin and the IPFS gateway **explicitly instead of `'self'`**,
so a script that does somehow execute still cannot post what it reads to an arbitrary host.

A test reads the Nginx snippet from disk and asserts it matches the policy the TypeScript
declares, so the two cannot drift apart.

### The rest

| Header                       | Value                                                        | Why                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security`  | `max-age=31536000; includeSubDomains; preload`               | One year is the minimum for the preload list                                                                                                         |
| `X-Content-Type-Options`     | `nosniff`                                                    | Without it, content-type confusion turns a file upload into stored XSS                                                                               |
| `X-Frame-Options`            | `DENY`                                                       | Legacy counterpart to `frame-ancestors 'none'`, which is the enforced control                                                                        |
| `Referrer-Policy`            | `no-referrer` (API), `strict-origin-when-cross-origin` (SPA) | Paths contain token ids and DID hashes                                                                                                               |
| `Permissions-Policy`         | camera, microphone, geolocation, payment, USB … all `()`     | Shrinks what an injection can reach. Helmet does not set this; it is added by hand                                                                   |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                | Severs the opener reference                                                                                                                          |
| `X-XSS-Protection`           | `0`                                                          | Not a typo. The legacy auditor is removed from modern browsers and its IE/Edge implementation introduced vulnerabilities of its own. CSP replaced it |

> **Before submitting to hstspreload.org**: `preload` is a commitment. Every subdomain, now
> and in future, must be HTTPS-capable, and removal takes months. Ship `max-age` first,
> confirm it, then submit.

---

## 4. TLS and Nginx

`infra/nginx/`. Nginx terminates TLS and is the only public listener; the Node process binds
to loopback and is never reachable directly. That is what makes a plain-HTTP request at the
app layer an anomaly worth refusing rather than a normal local condition.

- **Port 80 returns `301` to HTTPS** — permanent, so the browser caches it and the second
  visit never leaves in the clear at all. HSTS then covers everything after the first.
- **`/.well-known/acme-challenge/` is the one exception to the redirect.** Let's Encrypt
  validates over plain HTTP; redirecting it to a certificate that has not been issued yet is
  the classic chicken-and-egg failure, on first issuance and on every renewal after it.
- **TLS 1.2 and 1.3 only.** 1.0 and 1.1 are deprecated by RFC 8996 and fail a PCI scan.
- **ECDHE + AEAD suites only.** Forward secrecy on every session; no RSA key exchange, no
  CBC (so no BEAST or Lucky13), no 3DES, no SHA-1.
- **`ssl_prefer_server_ciphers off`** — every suite in the list is acceptable, so letting a
  phone without AES hardware pick ChaCha20 makes it faster at no cost to security.
- **Session tickets off.** The ticket key rotates only on reload, so a key compromise would
  retroactively decrypt captured sessions — defeating the forward secrecy the ECDHE suites
  exist to provide.
- **0-RTT off.** Early data is replayable by design, and a replayed mint or role change is
  not acceptable for one saved round trip.
- **OCSP stapling on**, so revocation checking does not leak each visitor to the CA.
- **No gzip on API responses** (BREACH: compressing a response mixing a secret with
  attacker-controlled input leaks the secret through its length). The static bundle is
  compressed; it contains no secrets.
- **Slowloris caps**: `client_body_timeout`, `client_header_timeout`, `send_timeout`.
- **`server_tokens off`** — the version string tells a scanner which CVEs to try first.

### App-layer HTTPS enforcement

`requireHttps` is belt and braces with the Nginx redirect. Its interesting decision is that
a plain-HTTP **POST is refused with 403, not redirected**. Redirecting would ask the client
to resend a body it has already transmitted in the clear. The credential in that first
request is already compromised — it needs rotating, not replaying over TLS — so the response
says so. Safe methods still get a 308 so a bare hostname lands somewhere useful, and the
`Host` header is shape-checked before being used in the redirect, because redirecting to an
unvalidated `Host` is an open redirect.

---

## 5. Logging

`packages/backend/src/http/pinoLogger.ts`, behind the `Logger` interface that already
existed — which is why swapping the transport touched no call site. `ConsoleLogger` remains
for tests and scripts.

- **Newline-delimited JSON to stdout, nothing written to a file and nothing rotated.** In a
  container the process is the wrong thing to be managing retention: the platform collects
  stdout, and a process that also writes files ends up with two copies, one of which nobody
  ships and nobody deletes.
- **`requestId` is the join key.** `genReqId` reuses the id `requestId()` already assigned,
  and `customProps` promotes it to the top level under exactly the name the application
  logger uses. pino-http would otherwise nest it as `req.id`, and no aggregator query can
  join `req.id` on one line against `requestId` on the next.
- **Redaction is doubled on purpose.** `redact()` walks by key name at any depth and catches
  an `authorization` field wherever it appears in an application record; pino's path-based
  redaction catches the HTTP serialisers' output, which `redact()` never sees because
  pino-http builds it internally. Neither covers the other.
- **The request serialiser is an allowlist, not a denylist.** pino-http's default logs every
  request header, and the set of headers that turn out to carry a secret is not fixed —
  today `authorization` and `cf-turnstile-response`, tomorrow whatever a new integration
  adds. Naming what to keep fails closed; naming what to drop fails open.
- **Query strings are dropped**; only the path is logged. Identifiers and tokens end up in
  query strings.
- **Stack traces are omitted in production** — they reveal absolute paths and dependency
  versions — and kept everywhere else, where they are the fastest way to understand a
  failure.
- **Nginx logs JSON to stdout in the same shape**, so one aggregator query spans both tiers.
  Note the absence of `$http_authorization`, `$http_cookie` and `$args` from the log format:
  an access log capturing those would undo the app's redaction. `/health` is excluded
  entirely, or a liveness probe every few seconds would be most of the log volume and would
  push real traffic out of any retention window.

---

## 6. Verification

```
npm run security:xss          # zero unjustified sinks, or the build fails
npm run test:tools            # 65 tests, including proof the gate exits 1
npm test --workspace @trustchain/backend
```

The XSS gate is tested against a directory containing a real `dangerouslySetInnerHTML` and
asserted to exit `1` — not merely asserted to pass on a clean tree. Two gates earlier in
this build were silently green while scanning nothing, and that is the check which would
have caught them.

## 7. What P2.5 does not do

- **No CORS policy yet.** `CORS_ORIGIN` is in the environment schema but no CORS middleware
  is mounted, so the API currently accepts no cross-origin browser requests at all — which
  is the safe default, and which the SPA will need loosened deliberately in Phase 3.
- **No Subresource Integrity**, because the SPA loads no third-party scripts. If one is ever
  added, SRI is required alongside it.
- **`report-uri` / `report-to` is not configured.** A CSP report endpoint is worth adding
  once there is somewhere to send reports; without a consumer it is only a header.
- **The Nginx config has never been executed — not even `nginx -t`.** There is no Nginx
  binary on this machine and Docker Desktop will not start here, so nothing has validated
  the syntax. The domains are placeholders (`app.example.com`, `api.example.com`) and the
  certificate paths point at a Let's Encrypt layout that does not exist yet. Treat it as a
  reviewed configuration, not a tested one: run `nginx -t` against it before first deploy.
  The one part that _is_ tested is the CSP string, which a backend test reads from the
  snippet on disk and compares against the policy the TypeScript declares.

### Dependencies added

`helmet`, `pino`, `pino-http`, `dompurify` and `jsdom` — 58 packages, **0 vulnerabilities**
reported by `npm audit` at install time. The workspace total is unchanged at 39 (34 low, 5
moderate, 0 high), all from the Hardhat 2 toolchain and documented in
[SECURITY_BASELINE.md](./SECURITY_BASELINE.md).

`jsdom` is the heaviest of these and is worth naming explicitly: it is a devDependency-sized
library running in production, pulled in because DOMPurify needs a real DOM. That cost is
accepted for the reason in §2 — the alternative is a hand-rolled HTML parser on the security
boundary.
