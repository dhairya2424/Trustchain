# SIH-26 — TrustChain

Blockchain platform combining **Decentralized Identity (DID)**, **on-chain Role-Based Access
Control (RBAC)** and **NFT-based asset ownership**.

## Layout

```
packages/contracts   Solidity (Hardhat, OpenZeppelin v5, ethers v6)
packages/backend     Node.js + Express + TypeScript API
packages/frontend    React + Vite + TypeScript
infra/               Container + local-chain assets
docs/                Architecture, security and operational docs
```

## Roles

Fixed by the problem statement:

| Role      | Responsibility                                                    |
| --------- | ----------------------------------------------------------------- |
| `ADMIN`   | Defines roles, assigns access rights, governs the platform        |
| `MANAGER` | Creates (mints) NFTs and allocates them to identities             |
| `AUDITOR` | Read-only verification of ownership, authenticity, access history |
| `USER`    | Holds a DID, owns NFT assets, authenticates with crypto proofs    |

## Prerequisites

- Node.js `20.18.1` (see `.nvmrc`)
- Docker + Docker Compose

## Getting started

```bash
npm install                # install all workspaces
docker compose up -d       # postgres:16, redis:7, local hardhat node
npm run build              # build every package
npm test                   # unit tests across every package
```

Useful scripts:

| Command             | Effect                           |
| ------------------- | -------------------------------- |
| `npm run dev`       | Run all packages in watch mode   |
| `npm run lint`      | ESLint (TS) + solhint (Solidity) |
| `npm run typecheck` | TypeScript, no emit              |
| `npm run format`    | Prettier write                   |
| `npm run chain`     | Local Hardhat node on `:8545`    |

## Services

| Service       | Port   |
| ------------- | ------ |
| Hardhat chain | `8545` |
| PostgreSQL 16 | `5432` |
| Redis 7       | `6379` |
| Backend API   | `4000` |
| Frontend      | `5173` |

## Build phases

Delivery follows `new phase/PHASE_BUILD_PLAN.md`. This commit completes **P0.1 — monorepo
skeleton**; no business logic is present yet.
