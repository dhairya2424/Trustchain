# Phase-by-Phase Build Plan — INDUSTRY GRADE
# Copy-Paste Prompts for Claude / Higher-Level AI Models

**How to use:** Feed the AI one prompt at a time, in order. Paste the **Global Context** block first in every new session. Run & verify each prompt's output before moving to the next. Small scoped prompts = accurate, debuggable AI output.

---

## Global Context (paste once per session)

```
Project: SIH-26 — blockchain platform combining Decentralized Identity (DID),
on-chain Role-Based Access Control (RBAC), and NFT-based asset ownership.

Stack (industry-grade):
- Contracts : Solidity ^0.8.x, Hardhat, OpenZeppelin v5, ethers v6, Foundry (fuzz),
              Slither (static analysis), solidity-coverage, hardhat-gas-reporter
- Chain ops : Alchemy RPC (Sepolia/Polygon Amoy), OpenZeppelin Defender (relayer +
              monitor), Safe{Wallet} multisig for admin keys, block explorer (Etherscan)
- Indexing  : The Graph subgraph -> GraphQL for assets/audit; fallback: ethers getLogs
- Backend   : Node.js + Express + TypeScript, zod validation, pino logging, JWT
              (RS256) + SIWE, BullMQ job queue (Redis), pg (parameterized) + RLS,
              Nginx reverse proxy (TLS), Helmet, rate-limiter-flexible, Cloudflare
              Turnstile (bot protection), Fernet/AES-256-GCM field encryption
- Storage   : PostgreSQL 16 (RLS enabled), Redis 7, IPFS via Pinata (dedicated gateway)
- Frontend  : React + Vite + TS, wagmi + viem + WalletConnect v2, shadcn/ui + Tailwind,
              Framer Motion + GSAP + Lottie animations, TanStack Query, Sentry
- DevOps    : Turborepo monorepo, GitHub Actions CI/CD, ESLint+Prettier+Husky,
              Dependabot, Snyk/npm-audit gate, Docker, Terraform (optional)

Roles (exactly per problem statement): ADMIN, MANAGER, AUDITOR, USER
  - ADMIN   : defines roles, assigns access rights, governs the platform
  - MANAGER : creates (mints) NFTs and allocates/assigns them to identities
  - AUDITOR : read-only verification of ownership, authenticity, access history
  - USER    : holds a DID, owns NFT assets, authenticates with crypto proofs
Hard rules:
  1. Only on-chain roles authorize contract mutations.
  2. NEVER store PII on-chain — hashes/commitments only.
  3. NFT metadata on IPFS (Pinata) only.
  4. Every critical action emits an event (indexed by the subgraph).
  5. No secrets in code or git history — env vars + .env.example only.
  6. Production-grade: typed, tested, minimal. Read existing files before editing.
```

---

## PHASE 0 — Scaffolding, Tooling & Secret Hygiene

### P0.1 — Monorepo skeleton
```
Convert the repo to a Turborepo monorepo: packages/contracts, packages/backend,
packages/frontend, root turbo.json pipelines (build/test/lint), shared tsconfig.
docker-compose.yml: postgres:16, redis:7, local hardhat node. Also add GitHub Actions
workflow: on PR -> install, lint, typecheck, unit tests for all 3 packages.
Do NOT write business logic.
```

### P0.2 — Secret management & key hygiene *(covers: hide API keys, use public DB keys)*
```
Set up secret hygiene: (1) root .env.example listing every var with dummy values —
backend/.env, frontend/.env split; (2) .gitignore all .env* except examples;
(3) backend loads env via dotenv + zod schema that FAILS FAST if a required var is
missing; (4) frontend must read ONLY vars prefixed VITE_PUBLIC_ (publishable/anon
keys) — write a CI check that fails if any non-public key string appears in the
frontend bundle output; (5) add `git secrets` regex scan script. Prove with a test:
build frontend, grep dist/ for the server private key — must be absent.
```

### P0.3 — Dependency & supply-chain gate *(covers: scan dependencies)*
```
Add: npm audit in CI with --audit-level=high failing the build; Dependabot config
(weekly, grouped); Snyk or osv-scanner step; package-lock.json integrity check.
Add a `docs/SECURITY_BASELINE.md` noting this gate. Run the audit, fix/pin any
high-severity issues, report what changed.
```

**Exit check:** CI green on a test PR; `docker compose up -d` healthy; env validation rejects missing vars.

---

## PHASE 1 — Smart Contracts (audited-grade trust core)

### P1.1 — DID Registry
```
Write packages/contracts/contracts/identity/DIDRegistry.sol (OpenZeppelin v5,
Pausable): registerDID, didHash -> {controller, keyCommitment, createdAt},
rotateController with nonce to prevent replay. Every mutation emits an event.
UUPS-upgradeable. Foundry fuzz tests + Hardhat unit tests: registration, duplicate
rejection, rotation, rotation replay attack must revert, pause blocks mutations.
```

### P1.2 — RBAC
```
packages/contracts/contracts/access/RoleAccessControl.sol extending OZ AccessControl
+ AccessControlDefaultAdminRules (2-step admin transfer, delay). Roles exactly as
the problem statement: ADMIN, MANAGER, AUDITOR, USER. ADMIN defines roles and
assigns access rights. All grants/revokes/permission updates emit events for the
subgraph + audit trail. Tests: non-admin grant reverts, MANAGER can mint but NOT
grant roles, AUDITOR reverts on every write, revoking stops the role instantly,
DEFAULT_ADMIN renounce requires delay, role enumeration works.
```

### P1.3 — Asset NFT Registry
```
AssetRegistry.sol: ERC721 + ERC721URIStorage + Pausable + AccessControl + Reentrancy-
Guard. mint(toDID, uri) restricted to ADMIN/MANAGER only; tokenId -> ownerDID mapping;
transfers update ownerDID and emit AssetTransferred(tokenId, fromDID, toDID).
Soulbound option flag per token (non-transferable credentials). Tests: unauthorized
mint reverts, reentrancy probe fails, DID binding stays correct after transfer,
timezone/pause edge cases.
```

### P1.4 — Credentials + AuditTrail
```
CredentialRegistry.sol: issue/revoke credential HASHES (keccak of VC payload, no PII)
bound to DID, callable by ADMIN/MANAGER only, revocation registry with reason codes.
AuditTrail.sol: append-only logAction(did, actionCode, refHash) — callable ONLY by
the sibling system contracts via a trusted-caller allowlist; NO update/delete
functions exist by design. Property test (Foundry invariant): audit count is
monotonically increasing.
```

### P1.5 — Static analysis + coverage gate
```
Run the contract security pipeline: slither . (fix all HIGH/MEDIUM findings),
forge test --fuzz-runs 1000, solidity-coverage >= 90% (wire into CI as a hard gate),
hardhat-gas-reporter output committed to docs/GAS.md. List every finding you fixed
and every accepted-risk finding with justification.
```

### P1.6 — Industry deploy: testnet + Defender + multisig
```
Deploy flow upgrade: (1) hardhat deploy to Polygon Amoy via Alchemy RPC using a
KMS-style env key (never hardcoded); (2) verify all contracts on Polygonscan via
hardhat-verify; (3) transfer DEFAULT_ADMIN to a 2-of-3 Safe{Wallet} multisig —
write scripts transferAdminToSafe.ts + a step-by-step runbook in docs/DEPLOY.md;
(4) register contracts in OpenZeppelin Defender with an autotask + Sentinel alert
on AssetMinted/RoleGranted; (5) store deployed addresses per-network in
packages/contracts/deployments/{network}.json.
```

**Exit check:** CI gate green (coverage/slither); contracts verified on Amoy Polygonscan; admin owned by multisig, NOT an EOA.

---

## PHASE 2 — Backend API (bulletproof)

### P2.1 — SIWE auth, hardened *(covers: enforce server-side auth, secure session cookies, rate limit login, bot protection)*
```
Build auth module: GET /auth/nonce (crypto-random nonce in Redis, 5-min TTL,
single-use) -> POST /auth/verify: verify SIWE signature server-side with viem,
read role ON-CHAIN (not from JWT claims alone), issue short-lived JWT (RS256,
15-min) in an httpOnly + Secure + SameSite=Strict cookie — never localStorage;
refresh token rotation with reuse-detection (revokes family on replay).
Login hardening: rate-limit /auth/* to 5 req/min/IP (rate-limiter-flexible +
Redis), Cloudflare Turnstile token REQUIRED on verify (bot protection), exponential
backoff + IP blocklist after 10 failures. Tests with supertest for happy path,
replay, expired nonce, forged signature, rate-limit, missing turnstile -> 429/403.
```

### P2.2 — Input validation & query safety *(covers: validate all inputs, parameterize queries, block field tampering)*
```
Every request DTO validated with zod schemas (shared /packages/shared/zod). All SQL
via parameterized pg queries or a typed query builder — grep audit: zero string-
concatenated SQL. Mass-assignment defense: every update endpoint uses an explicit
allowlist of mutable fields; attempt to PATCH {role:"ADMIN"} must be stripped + logged
as a security event. Add middleware that logs validation failures with request-id.
```

### P2.3 — Database: RLS + encryption *(covers: enable row-level security, encrypt sensitive data, lock record access, use public DB keys)*
```
Postgres hardening: (1) enable Row-Level Security on users, assets, credentials,
audit tables — roles: app_service (full), app_anon (read-only public rows only,
this is the key the frontend could ever see); write RLS policies + pgTAP-style
tests proving user A cannot select/update user B's rows via app_anon;
(2) field-level encryption AES-256-GCM (pgsodium or app-layer crypto lib) for any
sensitive off-chain fields (e.g., kyc_ref, email); (3) TLS-required connections;
(4) DB user with LEAST privileges — no SUPERUSER at runtime. Prove each control
with a failing->passing test.
```

### P2.4 — Assets, IPFS & file uploads *(covers: restrict file uploads, trim API responses)*
```
Asset endpoints: POST /assets/mint (multipart -> strict upload handling: mime
allowlist [png,jpg,webp,pdf], max 5MB, magic-byte sniffing, random storage filename,
malware scan hook (ClamAV), strip EXIF) -> pin to Pinata (dedicated gateway CID) ->
relay mint via Defender relayer (keys never in app). GET endpoints return DTO-
projected responses ONLY (explicit serializers — no SELECT * leaks). GET
/assets/:id/provenance walks subgraph/Transfer events -> ordered timeline.
```

### P2.5 — XSS, headers, TLS, logging *(covers: escape user content, force HTTPS)*
```
Output safety: (1) any user-provided string rendered through the API is sanitized
(DOMPurify-equivalent server-side) — document that React escapes by default and
audit every dangerouslySetInnerHTML (must be zero or justified); (2) CSP headers via
Helmet (script-src 'self' + strict), HSTS max-age=31536000 preload, X-Content-Type-
Options nosniff; (3) Nginx config: redirect :80 -> :443, TLS 1.2+ only, modern
cipher suite, cert via Let's Encrypt/Cloudflare; (4) pino structured logs with
request-id, redact Authorization/cookie fields, ship to stdout for log aggregator.
```

### P2.6 — Audit & credentials API
```
GET /audit: paginated (cursor), filters actor/action/from/to, backed by the subgraph
(indexed events) with on-chain getLogs fallback, CSV export stream (ADMIN only,
export itself audited). Credentials: POST /credentials/issue (ISSUER, builds VC-JWT,
pins payload, stores only hash on-chain), POST /credentials/verify (public, no auth
needed, returns valid/revoked + proof details), POST /credentials/revoke.
```

**Exit check:** Full curl/Postman flow: nonce -> verify (with Turnstile) -> cookie session -> mint -> audit shows mint; every security control above proven by a failing->passing test.

---

## PHASE 3 — Frontend: Extraordinary, Animated, Judge-Magnet

Design north star: **"a centralized IAM dashboard feels like paperwork — ours feels like a sci-fi command deck."** Dark theme, neon-cyan/violet accents, glassmorphism cards, every state change animated.

### P3.1 — App shell + animated wallet connect
```
React app shell (wagmi v2 + viem + WalletConnect v2): routes /, /dashboard, /admin,
/verify. Landing hero: animated WebGL/three.js particle network (or CSS-canvas
fallback for low power) forming a chain-link pattern, GSAP scroll-driven sections,
typewriter tagline. Wallet connect: Framer Motion modal, staggered wallet options,
connecting state = animated pulse rings, success = checkmark draw-on SVG + confetti
micro-burst. Mobile responsive, prefers-reduced-motion respected everywhere.
```

### P3.2 — Dashboard (user cockpit)
```
User dashboard: animated DID identity card (3D tilt-on-hover, QR code with animated
generation), "My Assets" NFT grid — cards fade-up stagger in, hover = lift + glow,
image skeleton shimmer while IPFS loads; "My Credentials" badges with verified
pulse animation; live activity feed (TanStack Query + subgraph polling) where new
events slide in from the right; stat counters (assets owned, verifications) animate
count-up on view. Empty states: Lottie illustration + helpful CTA.
```

### P3.3 — Admin console (mission control)
```
Admin console: left rail nav with animated active-indicator slide; Mint flow as a
3-step wizard (details -> upload with drag-drop file zone + upload progress ring ->
confirm) with step-transition animations and Guardian-style summary; Role Manager
table with inline grant/revoke — toggle switches animate, revoked rows flash red
then settle; Audit Log: filterable virtualized table, row hover reveals detail
panel sliding from right, live mode toggle with pulsing "LIVE" dot. EVERY action:
optimistic UI + tx-status toast (pending spinner -> success morph).
```

### P3.4 — Verifier portal (the show-stopper demo page)
```
/verify: input or QR scan -> cinematic verification sequence: scanning beam
animation over the asset card -> provenance timeline builds node-by-node (mint ->
transfers -> current owner) with connecting lines drawing themselves via SVG
stroke animation -> finale: full-screen verdict — green "AUTHENTIC ✓" with radial
pulse + particle burst, or red "UNREGISTERED / TAMPERED" glitch effect. Add a
"share verification" button generating a public, read-only proof link. Judges must
be able to do this in one click.
```

### P3.5 — UX polish, a11y & E2E
```
Polish pass: (1) page transitions (Framer Motion AnimatePresence), route prefetch
on hover, all fetches cached via TanStack Query; (2) error states are human ("That
signature expired — try again") not raw RPC errors; (3) skeleton loaders everywhere
— zero layout shift; (4) keyboard navigation + aria labels on all interactive
elements, axe-core scan = 0 violations; (5) Playwright E2E suite: connect wallet
(mocked) -> dashboard loads -> admin mints -> verifier shows AUTHENTIC — runs in CI.
```

**Exit check:** Lighthouse ≥ 90 performance/accessibility on all routes; Playwright suite green; a first-time user completes connect-to-verified in < 60s.

---

## PHASE 4 — Security Hardening Sprint (checklist closure)

### P4.1 — Automated pentest pass
```
Run an automated offensive pass: OWASP ZAP baseline scan against the API + frontend
(fix every High/Medium), test JWT forgery (alg=none, kid injection), cookie theft
scenarios (XSS attempt in every user-input field -> must render inert), IDOR tests
(user A requests user B's asset IDs -> 403), replay captured SIWE message -> rejected,
upload disguised .exe as .png -> rejected, SQLi strings in every query param ->
no effect. Produce docs/SECURITY_TEST_RESULTS.md with each attack, expected, actual.
```

### P4.2 — Secrets sweep & response trimming audit *(covers: hide api keys, trim api responses)*
```
Final hygiene: gitleaks/trufflehog scan over FULL git history (if anything found:
rotate the credential + document), verify .env never committed, confirm via built-
bundle grep that backend-only keys never ship to frontend, audit every API response
handler against its DTO schema (response validation middleware in dev mode throws on
extra fields). Ship `npm run security:all` script running every check at once.
```

**Exit check:** `npm run security:all` exits 0; ZAP report clean; every checklist item below has a named proof artifact.

### Checklist → Proof map

| # | Control | Where implemented | Proof artifact |
|---|---|---|---|
| 1 | Hide API keys | P0.2, P4.2 | bundle grep, gitleaks clean |
| 2 | Public DB keys only (anon) | P2.3 | app_anon role + RLS tests |
| 3 | Row-level security | P2.3 | pgTAP/RLS tests |
| 4 | Encrypt sensitive data | P2.3 | AES-GCM field tests |
| 5 | Server-side auth | P2.1 | supertest auth suite |
| 6 | Lock record access | P2.3 + P4.1 | IDOR tests |
| 7 | Block field tampering | P2.2 | mass-assignment tests |
| 8 | Secure session cookies | P2.1 | httpOnly/SameSite/Secure flags test |
| 9 | Hash passwords (any password flow) | P2.1 | argon2id for any password use; primary auth is SIWE (no passwords to store) |
| 10 | Rate-limit login | P2.1 | 429 tests |
| 11 | Bot protection | P2.1 | Turnstile verify tests |
| 12 | Parameterized queries | P2.2 | SQL grep audit |
| 13 | Validate all inputs | P2.2 | zod schema coverage |
| 14 | Escape user content | P2.5 + P4.1 | XSS payload tests |
| 15 | Restrict file uploads | P2.4 | mime/magic-byte tests |
| 16 | Trim API responses | P2.4 + P4.2 | DTO/serializer tests |
| 17 | Force HTTPS | P2.5 | HSTS + redirect config |
| 18 | Scan dependencies | P0.3 | CI audit gate |

---

## PHASE 5 — Observability, Reliability & Demo Polish

### P5.1 — Monitoring stack
```
Wire observability: Sentry (backend + frontend, DSN via env, release tagging),
Prometheus metrics endpoint (/metrics: http latency, BullMQ queue depth, relayer
balance alert threshold), Grafana dashboard JSON committed to infra/grafana/,
UptimeRobot/Healthchecks ping on /health (which checks DB + Redis + RPC + subgraph).
Defender Sentinel alert -> Slack/webhook on failed mint or role grant.
```

### P5.2 — Resilience
```
Chaos+resilience pass: kill Redis (queue -> graceful degrade + retry), kill Postgres
(API -> 503 with Retry-After, not stack traces), RPC provider failover (Alchemy ->
Ankr fallback), IPFS gateway failover (Pinata -> ipfs.io), BullMQ retries with
dead-letter queue + re-drive script. Document RTO/RPO in docs/RUNBOOK.md with an
incident-response checklist.
```

### P5.3 — Seed, demo script, pitch
```
Seed script (idempotent): Safe admin setup, 1 ISSUER, 2 USERs, 3 minted assets, 1
transferred, 1 credential issued + 1 revoked, all with realistic metadata + images.
docs/DEMO.md: exact click-path (<3 min) including the live unauthorized-mint revert
and the audit-export moment. docs/PITCH.md: 60-sec speaker script mapping each demo
beat to a problem-statement bullet. Record a backup demo video (Loom) in case of
live-demo failure.
```

**Exit check:** Fresh machine: `docker compose up` + `npm run dev` + seed -> full demo < 3 min; killing any single infra piece degrades gracefully; Grafana shows live traffic.

---

## Quick Reference — Phase → Deliverable

| Phase | Deliverable | Depends on |
|---|---|---|
| 0 | Turborepo + CI/CD + secret hygiene + dep scanning | — |
| 1 | Audited-grade contracts, verified, multisig-owned, Defender-monitored | 0 |
| 2 | Bulletproof API (auth, RLS, encryption, uploads, audit export) | 1 |
| 3 | Award-worthy animated frontend + E2E tests | 2 |
| 4 | Full security checklist closed with proof artifacts | 3 |
| 5 | Monitoring, resilience, seed data, demo + pitch | 4 |

**Golden rules:**
1. One prompt = one verifiable unit. Run it, test it, then move on.
2. Never paste two phases at once.
3. If the AI skips a test or proof artifact, reply: *"Where is the failing->passing test for that control?"*
