# Traceability: the problem statement, clause by clause

This document answers one question — _is every point of the problem statement actually in the
system?_ — and it answers it against the code, not against intentions. Every "yes" below names
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

**Implemented.**

`DIDRegistry` (`0xb99f38E7173Ee59CdA504a6a86a0Ca06062276b4`) holds the identifier, its
controller key, a key commitment and an active/inactive status. Authentication is
**Sign-In With Ethereum (EIP-4361)** — `packages/backend/src/auth/siwe.ts`. There is no
password, no server-held credential and nothing the platform could impersonate a user with:
the session exists because a key signed a domain-bound message, and for no other reason.

Identities are created in-product through `POST /identity/register`, which prepares a
`registerDIDFor` call for the administrator to sign. The control lives in the admin console
directly beneath the "no DID is registered for this address" line, because that is where the
problem is discovered. Previously that line was the end of the road inside the product and the
only remedy was an operator running `tools/onboard-wallet.mjs` against the deployer key.

**One thing worth knowing about the gate.** `registerDIDFor` is `onlyRole(ADMIN_ROLE)` against
the **DIDRegistry's own** AccessControl — a grant made at deployment, separate from the
RoleAccessControl matrix that governs everything else. The platform's matrix also grants
`PERM_REGISTER_DID` to MANAGER, and the contract does not consult it. The endpoint therefore
checks the registry's answer rather than the platform's, so a MANAGER is refused _before_
spending relayer gas to be refused on-chain. `PERM_REGISTER_DID` is, for now, a permission
nothing reads. Making the registry consult it is a contract upgrade, deliberately not bundled
with product work on a live deployment.

### 1.2 "Digital assets are represented as NFTs — unique, traceable, permanently recorded"

**Implemented.** `AssetRegistry` (`0xb7f222bbbBc0B6cAc320e8EF6951e0981d47cf7e`) is an
upgradeable ERC-721. Metadata is pinned to IPFS before the mint, so the token URI points at
content-addressed data rather than a mutable platform URL.

### 1.3 "These NFTs are directly allocated to user identities, establishing verifiable ownership"

**Implemented, and this is the clause most implementations quietly skip.** `mint` takes a
`toDID` — a `bytes32` identity hash — not an address. `ownerDIDOf(tokenId)` resolves a token to
the _identity_ that owns it, and `reclaim` exists precisely so that rotating a controller key
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

| Role    | Constant       |
| ------- | -------------- |
| Admin   | `ADMIN_ROLE`   |
| Manager | `MANAGER_ROLE` |
| Auditor | `AUDITOR_ROLE` |
| User    | `USER_ROLE`    |

### 1.6 "…and assign specific access rights to each identity, enforced automatically by smart contracts during all operations"

**Implemented.** Seven permissions in `Permissions.sol` — `REGISTER_DID`, `MINT_ASSET`,
`ASSIGN_ASSET`, `ISSUE_CREDENTIAL`, `REVOKE_CREDENTIAL`, `MANAGE_ROLES`, `VIEW_AUDIT` — held by
roles, and roles granted to **identities** (`grantRoleToDID`) rather than to bare addresses.

### 1.7 "Every activity … immutably recorded on the blockchain"

`AuditTrail` (`0x1A6a0A359119e111E3c33104b38176C1C74e4265`) records twelve action codes.
Mapping the statement's list onto them:

| The statement's activity | Action code                                             | Status                              |
| ------------------------ | ------------------------------------------------------- | ----------------------------------- |
| Identity creation        | `DID_REGISTERED` (1)                                    | Recorded                            |
| NFT creation             | `ASSET_MINTED` (8)                                      | Recorded                            |
| Asset allocation         | `ASSET_MINTED` (8) — allocation _is_ the mint, to a DID | Recorded                            |
| Access-rights assignment | `ROLE_GRANTED` (5), `ROLE_REVOKED` (6)                  | Recorded                            |
| **Ownership transfers**  | `ASSET_TRANSFERRED` (9)                                 | Recorded, and reachable — see below |
| Permission updates       | `PERMISSION_UPDATED` (7)                                | Recorded                            |

Also recorded, beyond the statement's list: `DID_CONTROLLER_ROTATED` (2), `DID_KEY_ROTATED` (3),
`DID_STATUS_CHANGED` (4), `ASSET_RECLAIMED` (10), `CREDENTIAL_ISSUED` (11),
`CREDENTIAL_REVOKED` (12).

**Transfers, now reachable.** `AssetRegistry._update` is a single choke point through which
mint, transfer and reclaim all pass, and it writes `ASSET_TRANSFERRED` with the receiving DID.
The contract was always complete; what did not exist was any way to reach it from TrustChain.

`POST /assets/prepare-transfer` now does, with a transfer control on each owned asset in the
dashboard. Two details are worth stating because they are the whole point of binding assets to
identities rather than to keys:

- The recipient is resolved to their identity's **current controller**. You type an address;
  the asset goes to whatever key controls that identity now. A recipient who rotated their key
  since you last spoke still receives it, instead of it landing on a wallet they abandoned.
- A **stale holder** — a key that no longer controls the owning identity, which is exactly the
  position a stolen key is in — cannot pass the asset to a third party. Its only available move
  is being reclaimed by the real controller. That refusal is the contract's; the API reports it
  as a sentence rather than letting the user watch a revert.

Six conditions can refuse a transfer, and each has its own message
(`packages/backend/src/assets/transfer.ts`). Reporting all six as "transfer failed" would be
true of every one of them and useful for none.

### 1.8 Follow-on ask: "DID and QR-based verification working perfectly — QR is not just for show"

**Implemented and verified against rendered pixels.**

- `/verify` is public. It needs no wallet, no session and no account — which is the point: an
  auditor or a stranger must be able to check a claim without asking the platform for access.
- The QR code on the dashboard encodes `${VITE_PUBLIC_APP_URL}/verify?did=…`, not
  `location.origin`. That distinction is the whole fix: the one situation a QR code exists for
  is a _different device_, and `localhost` is meaningless there.
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

On distinguishing chain data from local data: nearly all of the product's data _is_ chain data,
and where it matters the UI says so out loud — "Roles, read from the chain", "Read from Polygon
Amoy. Anyone can confirm this independently on a block explorer." The one genuinely off-chain
store is the display-name profile (`/profiles/me`), which holds no claim anyone verifies.

### 4. Multi-wallet / multi-user

**Met.** The actor is the SIWE session's address, never a value from the browser. Writes go
through an ERC-2771 forwarder (`0x1CDDbD5EE10503Cba9Ccdb2F3420e8b060768969`), so the _contract_
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

One nuance worth stating: every row in the audit log is confirmed _by construction_, because rows
come from indexed logs — an unconfirmed transaction has no log to index. Pending and failed
states live in `TransactionTrail`, next to the action that produced them, which is where a user is
actually looking while they wait.

_(The requirement list skips number 6 — it runs 5, then 7.)_

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
_network_ → Transaction: 0x… → View on PolygonScan — inside the existing design language. The
application was not redesigned.

### 10. Validation

**Met.** Two suites run live against Polygon Amoy, both driving the HTTP API exactly as the
browser does — prepare, sign with the caller's own key, forward — and both checking the result
against the chain rather than against the API's own report:

- `node tools/e2e-amoy.mjs` — **30 checks, 0 failures.** The acceptance criterion itself.
- `node tools/e2e-gaps.mjs` — **28 checks, 0 failures.** The three gaps this document
  previously listed as missing: identity creation, ownership transfer, credential issuance and
  revocation. It mints the asset it transfers rather than borrowing one, so running it does not
  consume the demo's own assets.

And because an API that works proves nothing about whether a person can use it:

- `node tools/e2e-gaps-browser.mjs` — **13 checks, 0 failures.** Chromium, a wallet injected as
  `window.ethereum`, signing delegated to a real key, and a screenshot of each surface. Console
  errors are collected and asserted on: a page that renders while throwing is not working, and a
  check that only looks at visible text will happily miss it.

Every item requirement 10 lists is covered:

| Required check                      | Result                                                |
| ----------------------------------- | ----------------------------------------------------- |
| chain id = 80002                    | RPC and API both report 80002                         |
| all contracts have bytecode on Amoy | all six verified                                      |
| deployer, relayer, relayer balance  | relayer `0x29da…234a` funded, 1.905 POL               |
| required roles                      | Manager granted on-chain and read back                |
| a real end-to-end transaction       | credential issued by a fresh wallet                   |
| verified on-chain                   | transaction found on Amoy, status success             |
| the emitted event                   | role grant and issuance both emitted                  |
| appears correctly in TrustChain     | served from the index; actor ≠ executor, both correct |
| the PolygonScan link                | resolves to a real transaction                        |
| a second independent wallet         | `0xc2E8…a6F2`, created during the run                 |
| UI updates without manual refresh   | indexer picked the action up unprompted in 12.1s      |

Transactions from those runs, checkable by anyone:

- DID registration, by the operator tool —
  `https://amoy.polygonscan.com/tx/0xa75f239cf3abfad62e68a91a96079489504bf707e7a91722ea1b7d0b625fedb7`
- Credential issuance, by a wallet holding no funds —
  `https://amoy.polygonscan.com/tx/0xbae1ae61d37468b84477572250155780de21eb0d1de7bea30b6026a18696b9ca`
- DID registration, through `POST /identity/register` —
  `https://amoy.polygonscan.com/tx/0xa1fb70cb72d5cf62fd2ad6eea222a11e97d8f923e4e995a569a18edab42bbbf8`
- **Ownership transfer, through `POST /assets/prepare-transfer`** — the clause the product
  could not previously reach —
  `https://amoy.polygonscan.com/tx/0x06675f89a5e78e04e4f2176b59a6ab3efc3cfe05ad59044023cd25aa69c30832`
- Credential issuance, then revocation, through the console's own endpoints —
  `https://amoy.polygonscan.com/tx/0xf1fb8e60ef3fa687aa87f7af53de838e9aabbb895018a180cd13e38727cf428a`
  and
  `https://amoy.polygonscan.com/tx/0x13f1002ea638f0de0c878da922c62bd05130af0ed30adc6a632f1b3d702d7cba`

The acceptance criterion in the requirement — _"any appropriately authorized user can act with
their own wallet, the relayer pays gas, the chain records the real action, TrustChain detects the
confirmed event in near real time, and an auditor can independently verify it on PolygonScan"_ —
is met, with the wallet in question having existed for under a minute and never having held funds.

---

## What is genuinely missing

Stated without hedging, because a traceability document that only lists successes is worthless.

The first three items on this list were the product gaps, and all three are now closed —
`tools/e2e-gaps.mjs` drives each through the HTTP API against live Amoy and checks the result
on-chain rather than trusting the API's own report. What remains is the list below, and none of
it can be finished without something only the operator can supply.

1. **Admin is still a deployer EOA.** The Safe multisig handover (`docs/DEPLOY.md`, steps 4–7)
   has not been performed, so a single key holds `DEFAULT_ADMIN` on the platform and
   `ADMIN_ROLE` on the DIDRegistry. **Needs:** a Safe address to hand over to. Until then the
   platform's root of trust is one private key in one `.env` file.
2. **HTTPS is prepared but unproven.** `trust proxy`, a `requireHttps` guard reading
   `X-Forwarded-Proto`, security headers and an origin allowlist are all in place, and
   `docs/HTTPS.md` covers the nginx termination — but none of it has ever run behind a
   certificate. **Needs:** a domain and a certificate.
3. **Sign-in requires a browser wallet extension.** **Needs:** a WalletConnect project id.
   Without one a phone cannot sign in. A phone can still _verify_, which is the flow QR exists
   for, so this limits administration rather than verification.
4. **`PERM_REGISTER_DID` is a permission nothing reads.** The platform grants it to ADMIN and
   MANAGER; `DIDRegistry.registerDIDFor` checks its own `ADMIN_ROLE` instead. Nothing is broken
   — the endpoint checks the authority that actually decides, so nobody is told yes and then
   refused by the chain — but the two models disagree, and reconciling them means upgrading the
   DIDRegistry proxy. That is a contract change on a live deployment and is deliberately not
   bundled with product work.
5. **Asset metadata is not indexed.** Owned assets show a placeholder frame rather than their
   IPFS image, because the audit entry carries no CID and there is no asset indexer. The cards
   say so rather than showing a stock image.
