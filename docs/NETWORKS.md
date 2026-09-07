# Networks: Amoy primary, Hardhat fallback

Polygon Amoy is the main blockchain environment. Local Hardhat is a fallback that keeps the
platform fully functional when Amoy cannot carry a transaction — it is never presented as
an equal alternative, and never labelled as Amoy.

|                | Polygon Amoy                           | Local Hardhat                                 |
| -------------- | -------------------------------------- | --------------------------------------------- |
| Role           | **primary**                            | fallback                                      |
| Chain id       | 80002                                  | 31337                                         |
| UI / API label | `POLYGON AMOY`                         | `LOCAL HARDHAT`                               |
| Verifiability  | `Public Testnet / Publicly Verifiable` | `Local Development/Demo / Locally Verifiable` |
| Explorer       | amoy.polygonscan.com                   | none                                          |
| Relayer id     | `trustchain-amoy`                      | `trustchain-hardhat`                          |

**The contracts, DID logic, RBAC matrix, NFT ownership and provenance, and the AuditTrail
are byte-identical on both.** The same Solidity, deployed twice. Nothing branches on which
network is active except the label and the explorer link — a fallback that behaved
differently would be a second system, tested half as much, diverging quietly.

---

## 1. How a network is chosen

Four checks, in order, per network, highest priority first (`chain/networkSelector.ts`):

1. **RPC reachable** — the endpoint answers _and_ reports the chain id we expect. A wrong
   chain id is a hard fail: an endpoint pointed at the wrong network would send
   transactions to addresses that mean nothing there.
2. **Contracts deployed** — a deployment record exists **and** every one of the five
   contracts has real bytecode at its address. The record alone is not trusted: it is a
   file on disk, and it survives `hardhat node` restarting, which wipes the chain.
3. **Relayer available** — the relayer service has a relayer for that network and reports
   its signer address.
4. **Signer funded** — the signer holds at least the network's minimum (0.02 POL on Amoy).
   Amoy being _configured_ is not the same as Amoy being _usable_; an unfunded signer is
   the expected state until someone visits a faucet.

The first network passing all four is used. If Amoy passes, **everything executes on
Amoy**. If it does not, the platform falls back to Hardhat and keeps working.

If neither is usable, the API returns **503 `no_usable_network`** rather than pretending.
There is no third state where writes silently go nowhere.

### Why the checks are in this order

Each corresponds to a way the system could otherwise accept a request and then fail after
it was too late to refuse cleanly. Discovering an unfunded signer _after_ pinning a
credential to IPFS and handing the caller a JWT is precisely the outcome the preflight
exists to prevent.

## 2. Switching happens on its own

Selection is cached for `NETWORK_PROBE_TTL_SECONDS` (default 60). Once the Amoy signer is
funded, the next probe adopts Amoy — **no restart, no config change, no redeploy, no
contract change.** A test asserts exactly this transition.

To switch immediately rather than waiting for the TTL:

```bash
curl -X POST http://localhost:4000/network/refresh
```

## 3. Seeing which network is active

**API** — `GET /network` is public and unauthenticated, because the entire point is that
nobody should have to guess whether a record is publicly verifiable:

```json
{
  "active": {
    "id": "amoy",
    "label": "POLYGON AMOY",
    "chainId": 80002,
    "verifiability": "public",
    "verifiabilityLabel": "Public Testnet / Publicly Verifiable",
    "explorerUrl": "https://amoy.polygonscan.com",
    "isPrimary": true,
    "isFallback": false,
    "signerAddress": "0x…",
    "signerBalance": "0.482915",
    "contracts": { "RoleAccessControl": "0x…", "…": "…" }
  },
  "candidates": [
    { "id": "amoy",    "usable": true,  "checks": [ … ] },
    { "id": "hardhat", "usable": true,  "checks": [ … ] }
  ]
}
```

`candidates` carries every check and its result, so _"why am I on Hardhat?"_ has an answer
in the response rather than requiring a log dive.

**Per transaction** — every mint, issuance and revocation response carries the network it
actually went to, plus an explorer link when one exists:

```json
{
  "status": "mined",
  "transactionId": "…",
  "network": { "id": "amoy", "label": "POLYGON AMOY", "…": "…" },
  "explorerUrl": "https://amoy.polygonscan.com/tx/0x…"
}
```

**UI** — `NetworkBadge` shows the label and verifiability on every screen, and adds an
explicit _"fallback — Polygon Amoy unavailable; records are not publicly verifiable"_ note
when running locally. It never displays a network name it did not receive from the API.

### The structural guarantee

The requirement _never claim a transaction was written to Amoy when it executed locally_ is
enforced by construction, not by discipline. `ChainBinding` carries the network **and** the
relayer as one object (`chain/binding.ts`); routes resolve a binding, submit through
`binding.relayer`, and label the response from `binding.network`. There is no code path
that can label a response with a network it did not submit through, because there is no
second source for either.

## 4. Forcing a specific network

There is deliberately no "use Hardhat" switch — a manual override is how a demo ends up
claiming Amoy while running locally. Selection follows the checks. To influence it, change
what the checks see:

| Goal                | How                                                        |
| ------------------- | ---------------------------------------------------------- |
| Force Hardhat       | unset `POLYGON_AMOY_RPC_URL`; Amoy stops being a candidate |
| Force Amoy          | ensure it passes all four checks — it is already preferred |
| Diagnose a fallback | `GET /network` and read `candidates[0].checks`             |
| Adopt Amoy now      | `POST /network/refresh` after funding                      |

## 5. Running both

```bash
# infrastructure — REDIS_PORT avoids a pre-existing native Redis on 6379
REDIS_PORT=6380 docker compose up -d postgres redis hardhat relayer

# local chain: deploy and seed
npm run deploy:local
npm run seed

# Amoy: deploy, then seed with the relayer address so it holds MANAGER
npm run deploy:amoy
RELAYER_ADDRESS=$(node tools/relayer-address.mjs) npm run seed:amoy

npm run dev --workspace @trustchain/backend
curl -s http://localhost:4000/network | jq .active.label
```

Both networks are served by **one relayer service with two relayer entries sharing one
signer**, so the fallback exercises exactly the same signing path as the primary. A single
`config.template.json` declares both; `tools/gen-relayer-config.mjs` renders it.

## 6. Notes

- The Amoy minimum (0.02 POL) is a floor for _sending_, not an estimate of cost. It has to
  be enough that selecting Amoy does not immediately fail.
- Hardhat's minimum is zero: Hardhat funds its accounts at genesis, so a balance check
  there could only fail if the node were misconfigured — which the RPC check already caught.
- The relayer container reaches Hardhat at `http://hardhat:8545` over the compose network.
  Inside that container `localhost` is the container itself.
- Deployment records are the single source of contract addresses, per network. The backend
  reads them rather than taking addresses from environment variables, so an address cannot
  be pasted into the wrong variable — a mistake that fails silently by targeting an address
  where nothing lives.
