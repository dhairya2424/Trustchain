# PRD — Decentralized Identity, Access Control & NFT Asset Ownership Platform

**Project:** SIH-26 ("TrustChain" working title)
**Version:** 1.0
**Date:** 2026-09-04
**Status:** Hackathon Build Spec
**Tagline:** *"Verify without revealing. Trust without compromise."*

---

## 1. Executive Summary

A blockchain-based platform that unifies **Decentralized Identity (DID)**, **Role-Based Access Control (RBAC)**, and **NFT-based digital asset ownership** into one trustless system. Every user gets a self-sovereign, cryptographically verifiable DID. Every digital/physical asset is minted (by authorized admins only) as an NFT bound to a DID. Every role, permission, mint, transfer, and revocation is an immutable on-chain event — giving organizations tamper-proof auditability and eliminating single points of failure in traditional IAM systems.

---

## 2. Problem Statement

- Organizations rely on **centralized IAM systems** vulnerable to cyber-attacks, identity theft, credential breaches, and single points of failure.
- Digital & physical **asset ownership** is tracked in disconnected/semi-centralized silos — authenticity, access rights, and ownership history are hard to verify and easy to forge.
- Audits are painful: logs can be altered, provenance is murky, and compliance evidence is expensive to produce.

**Goal:** Replace trust-in-institutions with trust-in-cryptography — verifiable identity, immutable ownership, and programmable access control.

---

## 3. Goals & Success Criteria

| # | Goal | Success Metric (hackathon demo) |
|---|------|-------------------------------|
| G1 | Self-sovereign identity via DIDs | User registers DID, authenticates via wallet signature (SIWE) in < 30s |
| G2 | Controlled NFT asset issuance | Only admin can mint; mint event visible on-chain; mint-as-user attempt fails |
| G3 | On-chain RBAC | Admin grants/revokes roles; unauthorized API + contract calls revert |
| G4 | Immutable audit trail | Every action queryable in audit dashboard; log cannot be edited/deleted |
| G5 | Working end-to-end demo | Live flow: register DID → KYC credential → mint NFT → transfer → verify |

### Non-Goals (v1)
- Mainnet deployment / real regulatory KYC providers
- Mobile app
- Cross-chain bridging

---

## 4. Target Users & Personas

1. **Org Administrator** — mints NFTs, assigns them to DIDs, defines roles/permissions, reviews audit logs.
2. **Asset Issuer (Issuer role)** — delegated authority to issue credentials/NFTs for a department.
3. **End User / Employee** — owns a DID, holds asset NFTs, authenticates with wallet, requests access.
4. **Verifier / Auditor** — checks asset authenticity & credential validity without needing private data.

---

## 5. Market Analysis

### 5.1 Market Size & Drivers
- **Identity & Access Management (IAM):** ~$16B (2024) → projected **$34B+ by 2030** (CAGR ~13%).
- **Blockchain identity market:** ~$1.3B (2024) → **$100B+ by 2032** (explosive CAGR > 75%) driven by data-breach costs (avg breach cost **$4.88M**, IBM 2024) and regulations (DPDP Act India, GDPR, eIDAS 2.0 in EU mandating digital identity wallets by 2026).
- **Tokenization of real-world assets (RWA):** Boston Consulting Group projects **$16T in tokenized assets by 2030**.
- **Government push (India context):** Digital India, DPDP Act 2023, Aadhaar verifiable credentials pilots — strong tailwind for DID-based citizen/enterprise identity.

### 5.2 Competitive Landscape

| Competitor | What they do | Where they fall short |
|---|---|---|
| **Polygon ID / iden3** | ZK-based DID & credential infra | Identity-only; no built-in asset NFT ownership or enterprise RBAC console |
| **Okta / Azure AD** | Enterprise IAM | Fully centralized; breach = total compromise; no asset tokenization |
| **OpenSea-style NFT platforms** | Asset minting/trading | Public marketplace focus; no identity binding, no RBAC, no compliance audit layer |
| **dock.io / cheqd** | DID + verifiable credentials | No integrated asset-ownership NFT registry tied to access control |
| **Hyperledger Indy/Aries** | DID frameworks | Heavy infrastructure, poor DX, no turnkey NFT-asset + RBAC layer |

### 5.3 Our Differentiators (Why We Win)

1. **Unified triangle:** DID + RBAC + NFT ownership in ONE stack — competitors offer only one or two legs.
2. **Ownership bound to identity, not just wallets:** NFTs are linked to a DID, enabling revocation, recovery, and enterprise-grade lifecycle management (not possible with raw wallet ownership).
3. **Admin-gated minting with on-chain enforcement:** Mint authorization lives in the smart contract, not in the backend — backend compromise cannot forge assets.
4. **Compliance-grade audit trail:** Every identity, asset, and access event is permanently on-chain and exportable — built for auditors, not just developers.
5. **Privacy-first KYC:** Verifiable Credentials + selective disclosure ("over 18?" → yes/no proof, no documents leaked).
6. **Self-sovereign recovery:** DID key rotation / recovery designed in — centralized systems have no equivalent.

---

## 6. Feature Set

### 6.1 Core (MVP — demo critical)
- **F1 DID Registry:** register DIDs, resolve DID → wallet, key rotation.
- **F2 Wallet Auth (SIWE):** Sign-In-With-Ethereum → JWT session; no passwords.
- **F3 RBAC on-chain:** roles = `ADMIN`, `MANAGER`, `AUDITOR`, `USER`; grant/revoke; enforced both on-chain (contract modifiers) and off-chain (API middleware).

  > **Corrected during P2.6.** This line previously read `ADMIN, ISSUER, VERIFIER, USER`, which
  > contradicted the binding role set and the deployed `TrustChainRoles` library. There is no
  > `ISSUER` or `VERIFIER` role on-chain, so an API gate naming either would be a check that
  > can never pass. The mapping applied throughout is:
  >
  > | Planning name | Actual authority | Why |
  > |---|---|---|
  > | ISSUER | `MANAGER`, via `PERM_ISSUE_CREDENTIAL` | The permission ADMIN and MANAGER hold in the contract's default matrix. |
  > | VERIFIER | *no role* | `POST /credentials/verify` is public by design — a credential only checkable by an account holder is not verifiable. `AUDITOR` instead holds `PERM_VIEW_AUDIT` for reading the audit trail. |
  >
  > Roles say *who someone is*; permissions say *what that role may do*, and an ADMIN can
  > re-scope permissions at runtime. API gates therefore name the permission
  > (`PERM_ISSUE_CREDENTIAL`, `PERM_VIEW_AUDIT`), not the role, so re-scoping on-chain takes
  > effect without redeploying the API.
- **F4 Asset NFT Registry (ERC-721):** admin/issuer-only mint; metadata on IPFS; NFT → DID binding; transfer tracked.
- **F5 Audit Trail:** all critical ops emitted as events + indexed; admin dashboard with filters (actor, action, asset, time).
- **F6 Admin Console UI:** mint asset, assign to DID, manage roles, view audit log.
- **F7 User Dashboard UI:** my DID, my credentials, my assets, request access.

### 6.2 Differentiator Features (demo wow-factor)
- **F8 Verifiable Credentials (KYC):** issuer signs VC; user presents selective disclosure; verifier checks on-chain.
- **F9 Asset authenticity scanner:** paste token ID / scan QR → instant provenance chain (mint → every transfer → current DID owner).
- **F10 Revocation & key recovery:** compromised key → rotate controller, NFTs stay bound to DID (not the lost key).
- **F11 Compliance report export:** one-click PDF/JSON audit report for a user/asset/time-range.

### 6.3 Stretch (if time permits)
- F12 Soulbound (non-transferable) credential NFTs
- F13 Multi-sig admin approval for minting high-value assets
- F14 Zero-knowledge proof login (prove role without revealing wallet)

---

## 7. Higher-Level Architecture

*(Built fast using AI-assisted development — Claude generates modules, dev integrates.)*

```
┌────────────────────────────────────────────────────────────┐
│  PRESENTATION — React + Vite + Tailwind (frontend/)        │
│  User dashboard | Admin console | Verifier portal | QR scan │
└──────────────────────────┬─────────────────────────────────┘
                           │ REST + ethers.js
┌──────────────────────────▼─────────────────────────────────┐
│  API GATEWAY — Node.js + Express + TS (backend/)           │
│  SIWE auth → JWT | RBAC middleware | IPFS pinning | Audit   │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│  BLOCKCHAIN — Solidity (contracts/) Hardhat + local node    │
│  DIDRegistry · RoleAccessControl · AssetRegistry (ERC721)   │
│  CredentialRegistry · AuditTrail                            │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│  DATA — PostgreSQL (indexes/sessions) · Redis (cache) ·     │
│  IPFS (NFT metadata only — NO PII on-chain)                 │
└─────────────────────────────────────────────────────────────┘
```

**Key design rules**
- On-chain = truth for identity roots, roles, ownership, audit events.
- Off-chain = sessions, caching, metadata, UX.
- Never store PII on-chain; only hashes/commitments.
- Contract is the ultimate authority — backend can propose, never override.

---

## 8. Security & Compliance Requirements

- All admin/issuer mutations require contract Role check (`onlyRole`); admin key owned by a Safe 2-of-3 multisig — never an EOA.
- Reentrancy guards, pausable contracts (UUPS upgradeable), Slither + Foundry fuzzing + ≥90% coverage as CI gates.
- API: RS256 JWTs in httpOnly/SameSite=Strict cookies, SIWE nonces single-use, rate-limited auth (5 req/min), Turnstile bot protection, zod-validated inputs, parameterized SQL only, mass-assignment allowlists.
- DB: Postgres Row-Level Security on all tables, field-level AES-256-GCM encryption for off-chain PII, least-privilege DB roles.
- HTTP: TLS 1.2+ enforced with HSTS, CSP via Helmet, DOMPurify sanitization, DTO-trimmed responses.
- Supply chain: Dependabot + npm audit gate in CI; gitleaks secret scanning over git history.
- Audit trail is append-only and exportable; Defender Sentinels alert on role grants and mints.

See `PHASE_BUILD_PLAN.md` for the full control → proof-artifact mapping.

---

## 9. Success Metrics (KPIs)

| Metric | Target |
|---|---|
| Demo: full flow DID→mint→transfer→verify | < 3 min live |
| Contract unit-test coverage | ≥ 90% |
| Unauthorized-call attempts blocked (demo) | 100% |
| Judge-facing differentiators shown | F8, F9, F10 |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Hackathon time pressure | Strict MVP scope (6.1), differentiators timeboxed |
| Wallet UX friction for demo | Pre-funded accounts, scripted demo path, seed in .env |
| Contract bugs | Tests first; OpenZeppelin base contracts; no custom crypto |
| Judges unfamiliar with DID | 60-sec "old vs new" comparison slide + live QR verify |

---

## 11. Roadmap (post-hackathon)

1. **P1:** Testnet deploy (Polygon Amoy), real IPFS pinning (Pinata), SIWE hardening.
2. **P2:** Soulbound credentials, multi-sig admin, DPDP-compliance report templates.
3. **P3:** Mobile verifier app, org onboarding SaaS portal, SDK for third parties.
