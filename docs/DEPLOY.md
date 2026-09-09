# Deployment Runbook — Polygon Amoy

Follow in order. Every step is a script; nothing here asks you to paste an address by
hand, because that is where deployments go wrong.

**A deployment is not finished when the contracts are live. It is finished when no
externally owned account can administer them** — step 7 is the one that proves it.

## Prerequisites

| Item                | Notes                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Funded deployer key | ~0.5 POL on Amoy covers all six contracts plus wiring                                                                                                                                             |
| Alchemy RPC URL     | Amoy endpoint                                                                                                                                                                                     |
| Polygonscan API key | For source verification                                                                                                                                                                           |
| Safe{Wallet} 2-of-3 | **Created and tested before you start.** Send it a transaction and execute it from the Safe UI first — discovering the signers cannot actually sign, after ownership has moved, is unrecoverable. |

Set these in `packages/contracts/.env` (never committed — see `.env.example`):

```
AMOY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/<key>
DEPLOYER_PRIVATE_KEY=<deployer key>
POLYGONSCAN_API_KEY=<key>
SAFE_ADMIN_ADDRESS=0x<your 2-of-3 Safe>
ADMIN_TRANSFER_DELAY_SECONDS=259200
```

The deployer key is read from the environment by `hardhat.config.ts` and never written to
an artifact or a deployment record. For production, prefer a KMS-backed signer behind the
signer over a raw key — the scripts here need only a signer, not a specific kind.

## Step 0 — Preflight

Do not deploy code that has not passed the gates.

```bash
npm test                                              # 127 contract tests
npm run coverage:check --workspace @trustchain/contracts   # >=90%, hard gate
npm run slither      --workspace @trustchain/contracts     # fails on medium+
cd packages/contracts && forge test --fuzz-runs 1000       # 33 fuzz + invariant
```

## Step 1 — Deploy

```bash
npx hardhat run scripts/deploy.ts --network amoy
```

Deploys in dependency order (RoleAccessControl, DIDRegistry, AssetRegistry,
CredentialRegistry, AuditTrail), then wires the audit trail: every writer is allowlisted
**before** any contract is pointed at the trail. The reverse order would leave a window in
which a mutation reverts because its audit write is refused.

Addresses land in `packages/contracts/deployments/amoy.json`. **Commit that file** — it is
how every later script finds the deployment.

## Step 2 — Verify source on Polygonscan

```bash
npx hardhat run scripts/verify.ts --network amoy
```

Reads addresses from the deployment record. Safe to re-run: already-verified contracts are
reported and skipped, not treated as failures.

## Step 3 — Smoke test while you still hold admin

Confirm the system works before handing away the keys.

```bash
npx hardhat run scripts/seed.ts --network amoy   # optional, see P5.3
```

At minimum: register a DID, grant MANAGER to a test account, mint one asset, and confirm
the mint appears in `AuditTrail.entryCount()`. If the audit count does not move, a writer
is not allowlisted — fix that now, not after ownership moves.

## Step 4 — Begin the admin transfer

```bash
TRANSFER_PHASE=begin SAFE_ADMIN_ADDRESS=0x<safe> \
  npx hardhat run scripts/transferAdminToSafe.ts --network amoy
```

Grants the Safe `ADMIN_ROLE` on RoleAccessControl and both admin roles on DIDRegistry, then
**starts** the two-step `DEFAULT_ADMIN` transfer. The deployer keeps access throughout.

The script refuses to run if `SAFE_ADMIN_ADDRESS` has no contract code — a Safe is a
contract, and an address without code is almost certainly a typo that would send ownership
somewhere unrecoverable.

Note the printed `acceptable after` timestamp.

## Step 5 — Accept from the Safe

After that timestamp, from the Safe UI, call on the **RoleAccessControl proxy**:

```
acceptDefaultAdminTransfer()
```

This must be executed by the Safe itself — collect the 2-of-3 signatures and execute. The
delay is deliberate: it gives you a window to cancel with `cancelDefaultAdminTransfer()`
if the pending admin is wrong.

## Step 6 — Finalize

```bash
TRANSFER_PHASE=finalize SAFE_ADMIN_ADDRESS=0x<safe> \
  npx hardhat run scripts/transferAdminToSafe.ts --network amoy
```

Drops the deployer's remaining roles. The script **refuses to run** unless the Safe has
actually accepted — otherwise it would leave the platform with no administrator at all.

## Step 7 — Prove no EOA retains control

```bash
npx hardhat run scripts/verifyOwnership.ts --network amoy
```

Exits non-zero if anything is still administrable by an EOA, or if any audit writer has
been dropped from the allowlist. **This is the step that turns "admin is a multisig" from
a claim into a verified fact.** Run it again periodically — a role granted by mistake
later will show up here.

## Step 8 — Wire the relayer

The API never signs. Transactions go through a self-hosted OpenZeppelin Relayer, whose
signer address must hold the on-chain permissions for whatever it is asked to submit.

```bash
node tools/gen-relayer-secrets.mjs      # passphrase, API key, webhook key — not printed
docker run --rm --env-file infra/relayer/.env   -v "$PWD/infra/relayer:/out" rust:1-slim bash /out/create-key.sh
node tools/gen-relayer-config.mjs       # renders config.json from the template
REDIS_PORT=6380 docker compose up -d redis relayer
```

Then grant the relayer's signer address `MANAGER` (which carries `PERM_MINT_ASSET` and
`PERM_ISSUE_CREDENTIAL`) and fund it with POL. Full detail, including the AWS KMS
migration, is in [RELAYER.md](RELAYER.md).

Note the authorization subtlety that applies from here on: because the relayer signs with
its own key, the contract's permission modifier checks the **relayer's** authority, not the
caller's. The API enforces the caller's own on-chain permission separately, and must — see
[EXIT_CHECK.md](EXIT_CHECK.md) §3.

## Step 9 — Monitoring

**Not yet implemented.** The previous design used OpenZeppelin Defender Monitors, which
were removed along with the rest of Defender when it entered maintenance mode; nothing has
replaced them yet.

What still needs building, and why each matters:

- access-control changes on `RoleAccessControl` (`RoleGranted`, `RoleRevoked`,
  `PermissionUpdated`, `DefaultAdminTransferScheduled`) — a silent role grant is the single
  most dangerous unobserved event in this system
- asset issuance on `AssetRegistry` (`AssetMinted`)
- allowlist changes on `AuditTrail` (`TrustedCallerUpdated`) — removing a writer creates an
  audit blind spot

Every one of these is already an on-chain event, and the audit indexer already reads them,
so the alerting layer can be built on the existing `GET /audit` path rather than on a
vendor. Tracked as Phase 5 work. **An alerting path nobody has ever seen fire is not
monitoring**, so whatever replaces it needs a test event before it counts.

## If something goes wrong

| Situation                                  | Action                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Wrong pending admin, not yet accepted      | `cancelDefaultAdminTransfer()` from the deployer, then redo step 4                                |
| Safe cannot sign after accepting           | Unrecoverable. This is why step 4 verifies contract code and why you test the Safe first.         |
| Deploy failed partway                      | The record only writes on success. Re-run step 1; earlier contracts are orphaned but harmless.    |
| A mutation reverts with `NotTrustedCaller` | A writer lost its allowlist entry. Re-allowlist from the Safe via `AuditTrail.setTrustedCaller`.  |
| Need to pause                              | `pause()` on AssetRegistry / CredentialRegistry / DIDRegistry, from the Safe. Reads keep working. |

## What is intentionally not upgradeable

`AuditTrail` has no proxy. Every other contract is UUPS, upgradeable by `DEFAULT_ADMIN`
(the Safe). An append-only log whose implementation can be swapped is not append-only —
whoever controls the upgrade controls history. If the audit schema must change, deploy a
new trail and allowlist it alongside; do not attempt to migrate history.
