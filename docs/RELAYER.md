# Transaction signing: OpenZeppelin Relayer

How transactions reach Polygon Amoy, why the signer is a separate service, and what
changes when the local keystore is replaced by AWS KMS.

```
Frontend
   ↓  session cookie
Backend API                    ← holds an API credential, never a private key
   ↓  POST /api/v1/relayers/{id}/transactions   (Bearer)
OpenZeppelin Relayer v1.5.0    ← separate container
   ↓
Local encrypted keystore       ← declared in config.json, swappable
   ↓
Polygon Amoy (chain id 80002)
```

---

## 1. Why a separate service

The application must never hold a signing key. Not "should not" — the whole authorization
model depends on it: a compromised API can _request_ transactions, which
`RoleAccessControl` still has to authorise on-chain, but it cannot sign anything else and
has nothing to steal.

An earlier iteration ran a signer inside the backend process for local development. That
was removed: two signing paths means the fenced one is the one nobody tests, and the
relayer can point at a local Hardhat node just as easily as at Amoy, so nothing was gained
by keeping it.

**OpenZeppelin Defender was removed entirely.** New sign-ups closed in June 2025 and it is
in maintenance mode, so it is not a path anyone can newly adopt. The adapter that targeted
it had also never run, and was wrong: it sent an ABI function name and arguments, while
the relay API accepts only pre-encoded calldata.

## 2. The seam that makes KMS a config change

The backend depends on two interfaces — `TransactionRelayer` and `CredentialRelayer` — and
nothing else. Routes never see an ABI, a chain client, a key, or an HTTP call.

```
assets/routes.ts ─┐
                  ├─► TransactionRelayer / CredentialRelayer   (interfaces)
credentials/routes.ts ─┘        └── OpenZeppelinRelayerClient  (the only implementation)
```

`OpenZeppelinRelayerClient` knows the relayer's HTTP API. It does **not** know how the
relayer signs. That is declared in the relayer's own `config.json`:

```json
{
  "id": "trustchain-local-signer",
  "type": "local",
  "config": {
    "path": "config/keys/local-signer.json",
    "passphrase": { "type": "env", "value": "KEYSTORE_PASSPHRASE" }
  }
}
```

**Migrating to AWS KMS is an edit to that block** — change `type` to the KMS signer and
give it the key ARN and region — followed by `docker compose up -d relayer`. No backend
code changes, no interface changes, no test changes, and the relayer id the backend talks
to stays the same. The upstream repository ships an `evm-aws-kms-signer` example that
shows the exact shape.

That is the entire answer to "make a future KMS signer a drop-in": put the signer behind a
process boundary the application already treats as opaque, rather than behind another
abstraction inside the application.

## 3. Secrets, and where they are not

| Value                                 | Lives in                                                          | Committed?                  |
| ------------------------------------- | ----------------------------------------------------------------- | --------------------------- |
| Signer private key                    | `infra/relayer/config/keys/local-signer.json` (encrypted)         | no                          |
| Keystore passphrase                   | `infra/relayer/.env`                                              | no                          |
| Relayer API key                       | `infra/relayer/.env`, and `RELAYER_API_KEY` in the backend `.env` | no                          |
| Amoy RPC URL (carries a provider key) | `packages/backend/.env`                                           | no                          |
| Deployer key                          | `packages/contracts/.env`                                         | no                          |
| Relayer `config.json`                 | generated into `infra/relayer/config/`                            | no                          |
| `config.template.json`                | `infra/relayer/`                                                  | **yes — placeholders only** |

The relayer's configuration has **no environment-variable substitution** for RPC URLs, and
an Amoy endpoint from most providers embeds an API key. So the file the service reads is
generated from a committed template and gitignored, rather than committed with a live
credential in it. `tools/gen-relayer-config.mjs` does the substitution and refuses to emit
a file that still contains an unresolved placeholder.

Every generator prints an address or a hostname and never a secret. A key echoed to a
terminal is a key in a scrollback buffer, a shell history, and any recording of the
session.

## 4. Setup

```bash
# 1 — secrets for the relayer service (passphrase, API key, webhook key). Not printed.
node tools/gen-relayer-secrets.mjs

# 2 — the encrypted signer keystore, using the OFFICIAL v1.5.0 tool in a Rust container
#     so no toolchain is needed on the host.
docker run --rm --env-file infra/relayer/.env \
  -v "$PWD/infra/relayer:/out" rust:1-slim bash /out/create-key.sh

# 3 — render config.json from the template, injecting the Amoy RPC URL
node tools/gen-relayer-config.mjs

# 4 — a deployer key for Amoy. Prints the address only.
node tools/gen-deployer-key.mjs

# 5 — start the stack. REDIS_PORT avoids a pre-existing native Redis on 6379.
REDIS_PORT=6380 docker compose up -d redis postgres relayer

# 6 — the relayer's signer address, which needs Amoy POL and the MANAGER role
curl -s -H "Authorization: Bearer $API_KEY" \
  http://localhost:8081/api/v1/relayers/trustchain-amoy
```

Then fund both addresses from the [Polygon faucet](https://faucet.polygon.technology/),
deploy, seed, and point the backend at Amoy.

## 5. What the backend needs

```
RELAYER_URL=http://localhost:8081
RELAYER_ID=trustchain-amoy
RELAYER_API_KEY=<the API_KEY from infra/relayer/.env>
RELAYER_SPEED=average
POLYGON_AMOY_RPC_URL=<your Amoy endpoint>
CHAIN_ID=80002
```

When `RELAYER_URL`, `RELAYER_ID` and `RELAYER_API_KEY` are not all present, the asset and
credential **write** routes are not mounted at all. Mounting them without a relayer would
give an endpoint that authenticates, authorises, signs a credential and then fails at the
last step — having already handed the caller a JWT for a credential that was never
anchored. Read and verification routes are unaffected.

## 6. Pinning is independent

IPFS pinning has nothing to do with signing, and the two are chosen separately. Set
`PINATA_JWT` to a real credential and content pins to Pinata; leave it unset and the local
filesystem stand-in is used. Either combination works with either chain.

An earlier version bundled the two decisions into one "outbound" object, which made it
impossible to use real Pinata with a local chain. That was a bug, not a policy.

## 7. Status mapping

The relayer reports six states; the application understands three.

| Relayer                                     | Application |
| ------------------------------------------- | ----------- |
| `pending`, `sent`, `submitted`, `inmempool` | `pending`   |
| `mined`, `confirmed`                        | `mined`     |
| `failed`, `canceled`, `expired`             | `failed`    |

An **unrecognised** status maps to `pending`, never to `mined`. A status this client does
not understand must not be reported to a caller as a completed mint.

## 8. Operational notes

- The service binds to **127.0.0.1 only**. Its own documentation states it "is not meant to
  be directly exposed to the public internet"; it is backend infrastructure, and its API
  key authorises signing.
- It needs **Redis** for its transaction queue. It shares our container on database 1, so
  its keyspace stays clear of the API's sessions and rate-limit counters.
- Port **8081**, because 8080 is the local IPFS gateway placeholder.
- The config directory is mounted **read-only**: the service reads its configuration and
  key and never rewrites them.
- The image runs as **uid 65532 (nonroot)**, so the keystore is written `0444` rather than
  `0400`. A root-owned `0400` file on a read-only mount is unreadable to that user and the
  service fails to start with an unhelpful error. Readability is not the control here — the
  file is encrypted, and the passphrase lives in a separate gitignored file.
- The image ships **no shell HTTP client** (no curl, no wget), so the compose service
  deliberately has **no healthcheck**: any `test` expressible inside the container would
  fail permanently and report a working service as unhealthy. Readiness is checked from the
  host against `/api/v1/relayers` instead.
- Building the keystore compiles the full relayer crate tree — alloy plus the Solana and
  Stellar signers — which takes tens of minutes on a cold cache. It is a one-time step;
  mount a cargo cache volume if you expect to repeat it.
- Pinned to **v1.5.0**. Releases exist up to v1.8.0, but the documentation labels v1.5.x
  the latest stable line, and that is what this integration was written and verified
  against.
