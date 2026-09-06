# System Architecture — TrustChain (SIH-26)

Layered block diagram. Each numbered band is one layer; arrows show what talks
to what.

```mermaid
flowchart TD

    subgraph L1["1 - ACTORS"]
        ADM["ADMIN<br/>defines roles<br/>assigns access rights"]
        MGR["MANAGER<br/>mints NFTs<br/>allocates to identities"]
        AUD["AUDITOR<br/>read-only verification"]
        USR["USER<br/>holds DID, owns assets"]
        PUB["PUBLIC VERIFIER<br/>no account needed"]
    end

    subgraph L2["2 - FRONTEND — React + Vite + TypeScript"]
        ADMC["Admin Console<br/>/admin"]
        DASH["User Dashboard<br/>/dashboard"]
        VERP["Verifier Portal<br/>/verify"]
        WAL["Wallet Layer<br/>wagmi + viem + WalletConnect<br/>public env only: VITE_PUBLIC_"]
    end

    subgraph L3["3 - BACKEND API — Node + Express + TypeScript"]
        EDGE["Edge Guards<br/>TLS/HSTS, Helmet + CSP,<br/>rate limit, Turnstile"]
        AUTHN["SIWE Auth<br/>nonce, verify,<br/>RS256 JWT httpOnly cookie"]
        AUTHZ["RBAC Middleware<br/>reads roles ON-CHAIN"]
        SVC["Services<br/>assets, credentials, audit export<br/>zod validation, DTO serializers<br/>BullMQ workers"]
    end

    subgraph L4["4 - OFF-CHAIN DATA"]
        PG[("PostgreSQL 16<br/>RLS + AES-256-GCM")]
        RD[("Redis 7<br/>nonces, sessions, queue")]
        IP[("IPFS via Pinata<br/>NFT metadata only")]
    end

    subgraph L5["5 - INDEXING"]
        SUB["The Graph Subgraph<br/>GraphQL<br/>ethers getLogs fallback"]
    end

    subgraph L6["6 - CHAIN OPS"]
        RPC["Alchemy RPC<br/>Polygon Amoy / local Hardhat"]
        REL["Defender Relayer<br/>keys never in app"]
        SAFE["Safe 2-of-3 Multisig<br/>owns DEFAULT_ADMIN"]
        SEN["Defender Sentinel<br/>alerts on mint / role grant"]
    end

    subgraph L7["7 - SMART CONTRACTS — Solidity 0.8.24, OpenZeppelin v5"]
        RAC["RoleAccessControl<br/>ADMIN MANAGER AUDITOR USER<br/>+ permission matrix"]
        DIDR["DIDRegistry<br/>controller, key commitment,<br/>rotation nonce"]
        AST["AssetRegistry ERC-721<br/>tokenId to ownerDID<br/>soulbound flag"]
        CRG["CredentialRegistry<br/>hashes only + revocation"]
        ATR["AuditTrail<br/>append-only<br/>no update or delete"]
    end

    subgraph L8["8 - PLATFORM AND DEVOPS"]
        CI["GitHub Actions CI<br/>lint, typecheck, build, test"]
        SEC["security:all<br/>secret scan + bundle leak gate"]
        DOCK["Docker Compose<br/>postgres, redis, hardhat node"]
        OBS["Sentry, Prometheus,<br/>Grafana, health checks"]
    end

    ADM --> ADMC
    MGR --> ADMC
    AUD --> VERP
    USR --> DASH
    PUB --> VERP

    ADMC --> WAL
    DASH --> WAL
    VERP --> WAL

    L2 -->|"REST over HTTPS"| EDGE
    EDGE --> AUTHN
    AUTHN --> AUTHZ
    AUTHZ --> SVC

    SVC --> PG
    SVC --> RD
    SVC --> IP

    SUB --> SVC
    AUTHZ -->|"authoritative role read"| RPC
    SVC -->|"relay mint / issue tx"| REL
    WAL -->|"sign + direct reads"| RPC
    REL --> RPC
    RPC --> RAC

    RAC -->|"authorizes every mutation"| DIDR
    RAC --> AST
    RAC --> CRG
    DIDR -->|"resolve owner identity"| AST
    DIDR --> CRG

    RAC --> ATR
    DIDR --> ATR
    AST --> ATR
    CRG --> ATR

    ATR -->|"events"| SUB
    L7 --> SEN
    SAFE -->|"holds admin key"| RAC

    CI --> SEC
```

## Block reference

| Block                | Where it lives                 | Notes                                         |
| -------------------- | ------------------------------ | --------------------------------------------- |
| Frontend             | `packages/frontend`            | Public env only, enforced by Vite `envPrefix` |
| Backend API          | `packages/backend`             | Fail-fast zod env, on-chain role reads        |
| Contracts            | `packages/contracts/contracts` | Five contracts, roles per problem statement   |
| Local infrastructure | `docker-compose.yml`           | postgres:16, redis:7, Hardhat node            |
| CI + security gates  | `.github/workflows`, `tools/`  | Secret scan, bundle leak check, full test run |

## Design rules the diagram encodes

1. **The contract is the authority.** The backend can propose a transaction; it can never override an on-chain role check. A fully compromised API still cannot mint.
2. **Roles are read on-chain at authentication**, never trusted from a JWT claim.
3. **No PII on-chain** — identities are hashes and key commitments; credentials are hashes only.
4. **The audit trail is append-only** and exposes no update or delete function.
5. **Secrets never cross into the browser** — the frontend only ever sees `VITE_PUBLIC_*`.
6. **Admin keys live in a multisig**, not an EOA.
