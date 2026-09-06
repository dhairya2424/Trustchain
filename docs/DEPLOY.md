# Deployment Runbook — Polygon Amoy

Follow in order. Every step is a script; nothing here asks you to paste an address by
hand, because that is where deployments go wrong.

**A deployment is not finished when the contracts are live. It is finished when no
externally owned account can administer them** — step 7 is the one that proves it.

## Prerequisites

| Item                | Notes                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Funded deployer key | ~0.5 POL on Amoy covers all five contracts plus wiring                                                                                                                                            |
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
an artifact or a deployment record. For production, prefer a Defender Relayer or a KMS
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

## Step 8 — Monitoring

```bash
npx hardhat run scripts/defenderRegister.ts --network amoy
```

Renders `infra/defender/generated/amoy.monitors.json` with real addresses substituted, and
refuses to emit anything containing an unresolved placeholder — a monitor pointed at a
placeholder watches nothing and stays silent forever.

Then, in Defender:

1. **Create an Action** from `infra/defender/action-alert.js`.
2. Add the secret `ALERT_WEBHOOK_URL` to that Action. The code throws if it is missing,
   rather than silently dropping an alert about a role change.
3. **Create the Monitors** from the generated file, each notifying that Action:
   - access-control changes on RoleAccessControl (`RoleGranted`, `RoleRevoked`,
     `PermissionUpdated`, `DefaultAdminTransferScheduled`)
   - asset issuance on AssetRegistry (`AssetMinted`)
   - allowlist changes on AuditTrail (`TrustedCallerUpdated`) — removing a writer creates
     an audit blind spot
4. **Fire a test event and confirm the alert arrives.** An alerting path nobody has ever
   seen fire is not monitoring.

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
