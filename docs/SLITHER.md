# Static Analysis — Slither

Every finding from `slither .` over `packages/contracts`, what was done about it, and
why. Run it yourself with:

```bash
npm run slither --workspace @trustchain/contracts     # hard gate, fails on medium+
```

Slither 0.11.6, solc 0.8.24, 70 source files, 102 detectors.

## Result

| Severity      | Before | After |
| ------------- | ------ | ----- |
| High          | 0      | **0** |
| Medium        | 27     | **0** |
| Low           | 27     | 10    |
| Informational | 9      | 5     |

CI fails the build on any **High or Medium** finding. That gate is only honest because
nothing is suppressed globally: accepted findings are annotated at the exact line with
`// slither-disable-next-line <detector>` and a comment saying why, so a _new_ finding of
the same class in different code still fails the build.

## Findings fixed

### 1. `reentrancy-no-eth` — 12 findings, Medium

`RoleAccessControl.initialize` → `_seedDefaultPermissions` → `_setPermission` → `_audit`
placed an external call inside the initialisation path, with state written after it
across successive seeding calls.

The audit call was a no-op there — `auditTrail` is necessarily `address(0)` during
`initialize`, since only an admin can set it afterwards — but relying on a runtime
address check to make an initialisation path safe is fragile reasoning.

**Fix:** split the state write out of `_setPermission` into `_writePermission`, which
performs no external call. Seeding now calls `_writePermission` directly, so the external
call is structurally absent from the constructor path rather than merely inactive.

This also removed all 13 `reentrancy-events` findings, which had the same root cause.

### 2. `reentrancy-benign` in `AssetRegistry.mint` — Medium contributor

`_safeMint` hands control to the recipient's `onERC721Received` while the mint is still
in flight, and `_setTokenURI` ran _after_ it.

**Fix:** the token URI is now written before `_safeMint`. Beyond satisfying the detector
this is a real correctness improvement — a receiver hook that inspected the token
mid-mint previously saw it with an empty `tokenURI`.

### 3. Test doubles analysed as production code

`contracts/mocks/` contributed `missing-zero-check`, `unused-return` and
`reentrancy-benign` findings from deliberately unsafe test code.

**Fix:** `slither.config.json` filters `contracts/mocks`. They are never deployed;
analysing them produced noise that would have buried real findings.

### 4. Stale artifacts inflated the report

Slither reused several Hardhat `build-info` files at once and reported the same function
twice at different line numbers, roughly doubling the apparent finding count.

**Fix:** the `slither` script runs `hardhat clean && hardhat compile` first, so exactly
one build-info exists and line numbers are accurate.

## Findings accepted, with justification

Each is suppressed at its own line, not by disabling the detector.

### `unused-return` on `EnumerableSet.add` / `.remove` — 6 sites, Medium

These return whether the set actually changed. At every call site the caller has already
established that fact: `_grantRole`/`_revokeRole` act only when OpenZeppelin's own
`granted`/`revoked` flag is true, and `_writePermission` is only reached after an explicit
no-op check. The return value carries no information we do not already hold.

### `unused-return` on `auditTrail.logAction` — 4 sites, Medium

`logAction` returns the new entry id. Nothing in the calling contracts needs it; the id is
for indexers and dashboards reading events. What _does_ matter is that a refused write
reverts, and that propagates from the call automatically — asserted by a test that
de-allowlists a contract and shows the whole action fail.

### `incorrect-equality` on `credential.issuedAt == 0` — 1 site, Medium

The detector targets equality against `block.timestamp` in arithmetic. Here `issuedAt` is
an existence sentinel: it is either `0` (never issued) or a real block timestamp, which
cannot be `0` on any live chain. No arithmetic depends on it.

### `timestamp` — 8 sites, Low

Credential expiry and rotation deadlines compare against `block.timestamp`. A miner can
nudge that by seconds; these deadlines are hours to years. The comparison _is_ the
feature, and second-level imprecision has no security consequence.

### `calls-loop` — 1 site, Low

`setRolePermissions` audits each permission individually, so a batch makes one external
call per entry. The callee is our own append-only ledger, not an untrusted contract, and
collapsing them into a single entry would cost per-permission granularity in the audit
trail — the opposite of the goal.

### `reentrancy-benign` in `AssetRegistry.mint` — 1 site, Low

The remaining report concerns the event emitted after `_safeMint`. `mint` is
`nonReentrant`, and a test proves the guard is what refuses a re-entrant call by asserting
the captured revert data equals the `ReentrancyGuardReentrantCall` selector.

### `naming-convention` — 5 sites, Informational

`__gap` follows the OpenZeppelin storage-gap convention, and immutables are `SCREAMING_CASE`
per Solidity style. Renaming either to satisfy the detector would break a stronger
convention.

## Review triggers

Re-run and re-triage when:

- a new contract or external call is added
- an existing `slither-disable-next-line` moves or its surrounding logic changes
- Slither is upgraded — new detectors may surface findings this list does not cover
