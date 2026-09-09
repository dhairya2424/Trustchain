# Traceability: the problem statement, clause by clause

This document answers one question — *is every point of the problem statement actually in the
system?* — and it answers it against the code, not against intentions. Every "yes" below names
the file or the on-chain artefact that makes it true. Every gap is stated as a gap, in the same
voice, without softening.

Two documents are traced:

1. **The problem statement** (Background / Detailed Description / Expected Solution), plus the
   three follow-on asks attached to it.
2. **The ten deployment requirements** for taking the system to Polygon Amoy.

Deployed contracts on **Polygon Amoy (chain 80002)** are recorded in
[`packages/contracts/deployments/amoy.json`](../packages/contracts/deployments/amoy.json).

---

## Part 1 — The Detailed Description and Expected Solution

### 1.1 "Each user is assigned a decentralized identifier … independent of centralized authorities, authenticated using cryptographic proofs"

**Implemented, with a gap in how an identity is created.**

`DIDRegistry` (`0xb99f38E7173Ee59CdA504a6a86a0Ca06062276b4`) holds the identifier, its
controller key, a key commitment and an active/inactive status. Authentication is
**Sign-In With Ethereum (EIP-4361)** — `packages/backend/src/auth/siwe.ts`. There is no
password, no server-held credential and nothing the platform could impersonate a user with:
the session exists because a key signed a domain-bound message, and for no other reason.

**The gap:** there is no in-product way to *create* an identity. No `POST /identity`, no
registration screen. Onboarding runs through `tools/onboard-wallet.mjs`, an operator-run CLI
that calls `registerDIDFor` and `grantRoleToDID` directly. The action is fully on-chain and
audited either way (`DID_REGISTERED`), but a new user cannot self-serve, and an admin cannot do
it from the admin console. This is the largest hole in the product surface.

### 1.2 "Digital assets are represented as NFTs — unique, traceable, permanently recorded"

**Implemented.** `AssetRegistry` (`0xb7f222bbbBc0B6cAc320e8EF6951e0981d47cf7e`) is an
upgradeable ERC-721. Metadata is pinned to IPFS before the mint, so the token URI points at
content-addressed data rather than a mutable platform URL.

### 1.3 "These NFTs are directly allocated to user identities, establishing verifiable ownership"

**Implemented, and this is the clause most implementations quietly skip.** `mint` takes a
`toDID` — a `bytes32` identity hash — not an address. `ownerDIDOf(tokenId)` resolves a token to
the *identity* that owns it, and `reclaim` exists precisely so that rotating a controller key
does not orphan the assets: same identity, new key, ownership intact. Ownership is bound to who
you are, not to which key you currently hold.

### 1.4 "Smart contracts govern all operations; only authorized administrators can mint and assign"

**Implemented, and enforced at the contract, not the API.** `mint` requires
`PERM_MINT_ASSET`, checked against `RoleAccessControl`
(`0x2C07f6c5602a87e0486Fd20FaE1fC8F6626104a4`). The backend checks the same permission first —
but only so the user gets a sentence instead of a revert. Removing the backend check would
change the error message, not the security boundary.

### 1.5 "RBAC where administrators define roles such as Admin, Manager, Auditor and User"

**Implemented, exactly those four.**
`packages/contracts/contracts/libraries/TrustChainRoles.sol`:

| Role | Constant |
|---|---|
| Admin | `ADMIN_ROLE` |
| Manager | `MANAGER_ROLE` |
| Auditor | `AUDITOR_ROLE` |
| User | `USER_ROLE` |

### 1.6 "…and assign specific access rights to each identity, enforced automatically by smart contracts during all operations"

**Implemented.** Seven permissions in `Permissions.sol` — `REGISTER_DID`, `MINT_ASSET`,
`ASSIGN_ASSET`, `ISSUE_CREDENTIAL`, `REVOKE_CREDENTIAL`, `MANAGE_ROLES`, `VIEW_AUDIT` — held by
roles, and roles granted to **identities** (`grantRoleToDID`) rather than to bare addresses.

### 1.7 "Every activity … immutably recorded on the blockchain"

`AuditTrail` (`0x1A6a0A359119e111E3c33104b38176C1C74e4265`) records twelve action codes.
Mapping the statement's list onto them:

| The statement's activity | Action code | Status |
|---|---|---|
| Identity creation | `DID_REGISTERED` (1) | Recorded |
| NFT creation | `ASSET_MINTED` (8) | Recorded |
| Asset allocation | `ASSET_MINTED` (8) — allocation *is* the mint, to a DID | Recorded |
| Access-rights assignment | `ROLE_GRANTED` (5), `ROLE_REVOKED` (6) | Recorded |
| **Ownership transfers** | `ASSET_TRANSFERRED` (9) | **Recorded on-chain, but unreachable from the product — see below** |
| Permission updates | `PERMISSION_UPDATED` (7) | Recorded |

Also recorded, beyond the statement's list: `DID_CONTROLLER_ROTATED` (2), `DID_KEY_ROTATED` (3),
`DID_STATUS_CHANGED` (4), `ASSET_RECLAIMED` (10), `CREDENTIAL_ISSUED` (11),
`CREDENTIAL_REVOKED` (12).

**The transfer gap, stated plainly.** `AssetRegistry._update` is a single choke point through
which mint, transfer and reclaim all pass, and it writes `ASSET_TRANSFERRED` with the receiving
DID. The contract is complete and tested. What does not exist is any way to *reach* it from
TrustChain: there is no `POST /assets/transfer` and no transfer UI. A transfer today requires
either a direct contract call, or hand-built calldata pushed through the generic
`POST /network/forward` relay. So the audit trail would faithfully record a transfer — but the
product cannot initiate one.

### 1.8 Follow-on ask: "DID and QR-based verification working perfectly — QR is not just for show"

**Implemented and verified against rendered pixels.**

- `/verify` is public. It needs no wallet, no session and no account — which is the point: an
  auditor or a stranger must be able to check a claim without asking the platform for access.
- The QR code on the dashboard encodes `${VITE_PUBLIC_APP_URL}/verify?did=…`, not
  `location.origin`. That distinction is the whole fix: the one situation a QR code exists for
  is a *different device*, and `localhost` is meaningless there.
- The scanner (`packages/frontend/src/verify/QrScanner.tsx`) uses the native `BarcodeDetector`
  where it exists and lazily loads `jsQR` where it does not — Windows Chrome, notably, has no
  `BarcodeDetector`, so without the fallback the feature would have been decorative on the most
  likely demo machine.
- `tools/e2e-qr.mjs` proves it end to end by decoding the **actually rendered** QR pixels and
  following the URL they contain.

Verification returns five distinct verdicts, not two: authentic, revoked, tampered, unknown, and
registry-unavailable. "We could not reach the chain" is never reported as "not genuine".

### 1.9 Follow-on ask: "show all the recent transactions of the wallet"

**Implemented.** `GET /assets/owned` enumerates the connected identity's tokens (by
`totalMinted()` plus a `balanceOf` early stop, since the registry is not ERC-721 Enumerable),
and `ActivityFeed` lists that identity's on-chain audit entries newest-first — each showing the
actor, the executor, and a link to the explorer.

### 1.10 Follow-on ask: "admin page is showing a black screen"

**Fixed.** The console requested `limit=200` against an API that caps the page at 100, so every
request 400'd and the page rendered nothing. Fixed, with a regression test, and `ApiError.issues`
is now surfaced so a validation failure says which field was wrong instead of going blank.

---

## Part 2 — The ten deployment requirements

### 1. Polygon Amoy only

**Met.** Chain 80002 throughout; explorer `https://amoy.polygonscan.com`. Nothing has been
deployed to Polygon Mainnet, and no mainnet network is configured in `hardhat.config.ts`.

### 2. HTTPS

**Prepared, not deployed.** `app.set("trust proxy", 1)` and a `requireHttps` guard that reads
`X-Forwarded-Proto`; security headers; CORS driven by an explicit origin allowlist;
`docs/HTTPS.md` covers the nginx termination. Localhost development is untouched — the guard is
off unless enabled.

**Honest limit:** this has never actually run behind a certificate, because there is no domain.
It is prepared, and it is unproven.

### 3. Real-time blockchain tracking

**Met.** No simulation and no invented hashes anywhere in the system. A submitted transaction
moves **submitted → pending → confirmed → indexed**; `ChainIndexer` reads real logs, and the UI
receives the change over SSE (`GET /stream`) without a refresh. `TransactionTrail` shows Pending,
Confirmed, Failed and Dropped as distinct states, and only renders a PolygonScan link once there
is genuinely something to look at.

On distinguishing chain data from local data: nearly all of the product's data *is* chain data,
and where it matters the UI says so out loud — "Roles, read from the chain", "Read from Polygon
Amoy. Anyone can confirm this independently on a block explorer." The one genuinely off-chain
store is the display-name profile (`/profiles/me`), which holds no claim anyone verifies.

### 4. Multi-wallet / multi-user

**Met.** The actor is the SIWE session's address, never a value from the browser. Writes go
through an ERC-2771 forwarder (`0x1CDDbD5EE10503Cba9Ccdb2F3420e8b060768969`), so the *contract*
recovers the signer from the signature: the relayer pays gas and is recorded as the executor,
and paying is not permission. `POST /network/forward` rejects `actor_mismatch` when the signed
request's `from` differs from the session, and logs the attempt as a security event. Deployer and
relayer are infrastructure accounts and are not special-cased as users.

The acceptance run below proves this with a wallet generated seconds earlier, which signs in as
itself, acts as a Manager, and finishes holding zero POL.

### 5. On-chain traceability

**Met.** Every action in the requirement's list emits a real on-chain event. The audit detail
panel shows: actor ("who requested it"), executor ("who submitted it"), the recording contract,
subject DID, reference hash, block number, transaction hash, timestamp, and the PolygonScan link.

One nuance worth stating: every row in the audit log is confirmed *by construction*, because rows
come from indexed logs — an unconfirmed transaction has no log to index. Pending and failed
states live in `TransactionTrail`, next to the action that produced them, which is where a user is
actually looking while they wait.

*(The requirement list skips number 6 — it runs 5, then 7.)*

### 7. Event monitoring

**Met.** A checkpointed indexer with an overlap re-read, reading only to `head - confirmations`;
an adaptive `eth_getLogs` window that backs off when the provider rejects the range (Alchemy's
free tier caps it at 10 blocks); exponential backoff on RPC failure; and dedupe decided by Redis
(`HSET` returning 1 for a genuinely new key), so a reconnect, a restart or a duplicate log cannot
produce a duplicate audit record. Dropped and failed transactions are reconciled rather than left
pending forever.

### 8. Security

**Met.** Secrets live only in gitignored `.env` files; `.env.example` holds placeholders.
`tools/scan-secrets.mjs` runs as a gate. No private key reaches frontend code. RBAC and the
authentication boundary are unchanged — nothing was loosened to make a demo easier.

**One outstanding action for you:** the Polygonscan API key you pasted into chat should be
**rotated**. It was exposed by being typed into a transcript, not by anything in the repository.

### 9. UI

**Met.** `TransactionTrail` renders exactly the requested progression — Pending → Confirmed on
*network* → Transaction: 0x… → View on PolygonScan — inside the existing design language. The
application was not redesigned.

### 10. Validation

**Met — 30 checks, 0 failures, run live against Polygon Amoy** (`node tools/e2e-amoy.mjs`).
Every item the requirement lists is covered:

| Required check | Result |
|---|---|
| chain id = 80002 | RPC and API both report 80002 |
| all contracts have bytecode on Amoy | all six verified |
| deployer, relayer, relayer balance | relayer `0x29da…234a` funded, 1.905 POL |
| required roles | Manager granted on-chain and read back |
| a real end-to-end transaction | credential issued by a fresh wallet |
| verified on-chain | transaction found on Amoy, status success |
| the emitted event | role grant and issuance both emitted |
| appears correctly in TrustChain | served from the index; actor ≠ executor, both correct |
| the PolygonScan link | resolves to a real transaction |
| a second independent wallet | `0xc2E8…a6F2`, created during the run |
| UI updates without manual refresh | indexer picked the action up unprompted in 12.1s |

Two transactions from that run, checkable by anyone:

- DID registration —
  `https://amoy.polygonscan.com/tx/0xa75f239cf3abfad62e68a91a96079489504bf707e7a91722ea1b7d0b625fedb7`
- Credential issuance —
  `https://amoy.polygonscan.com/tx/0xbae1ae61d37468b84477572250155780de21eb0d1de7bea30b6026a18696b9ca`

The acceptance criterion in the requirement — *"any appropriately authorized user can act with
their own wallet, the relayer pays gas, the chain records the real action, TrustChain detects the
confirmed event in near real time, and an auditor can independently verify it on PolygonScan"* —
is met, with the wallet in question having existed for under a minute and never having held funds.

---

## What is genuinely missing

Stated without hedging, because a traceability document that only lists successes is worthless.

1. **No UI or API for NFT ownership transfer.** The contract supports it, records it, and is
   tested. The product cannot initiate one. This is a direct miss against the statement's
   "ownership transfers" and against requirement 5's "NFT creation, allocation, **transfer**".
2. **No in-product identity creation.** Onboarding is an operator CLI. There is no registration
   screen and no admin control for issuing a DID.
3. **No UI for credential issuance or revocation.** The API implements both, with permissions and
   audit records; only verification is reachable from the interface.
4. **Admin is still a deployer EOA.** The Safe multisig handover (`docs/DEPLOY.md`, steps 4–7)
   has not been performed, so a single key holds `DEFAULT_ADMIN`.
5. **HTTPS is prepared but unproven.** No domain, no certificate, never run behind TLS.
6. **Sign-in requires a browser wallet extension.** There is no WalletConnect project id, so a
   phone cannot sign in — a phone can still *verify*, which is the flow QR exists for.
