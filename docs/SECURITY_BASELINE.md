# Security Baseline — Dependency & Supply Chain

Status of the supply-chain gate introduced in P0.3. Everything here is enforced
in CI, not aspirational.

## The gate

| Control               | Command                            | Blocking | Enforced in              |
| --------------------- | ---------------------------------- | -------- | ------------------------ |
| Lock/manifest sync    | `npm ci`                           | yes      | CI `supply-chain` job    |
| Lockfile integrity    | `npm run security:lockfile`        | yes      | CI `supply-chain` job    |
| Vulnerability gate    | `npm audit --audit-level=high`     | yes      | CI `supply-chain` job    |
| OSV database scan     | `google/osv-scanner-action@v2.5.1` | advisory | CI `supply-chain` job    |
| Automated updates     | Dependabot, weekly, grouped        | n/a      | `.github/dependabot.yml` |
| Committed credentials | `npm run security:secrets`         | yes      | CI `secrets` job         |
| Frontend bundle leaks | `npm run security:bundle`          | yes      | CI `secrets` job         |

Run everything locally with `npm run security:all`.

### What the lockfile check adds

`npm ci` proves the lockfile matches `package.json`. It does **not** check where
the bytes come from. `tools/check-lockfile.mjs` adds:

1. `lockfileVersion >= 3` — v1 omits integrity hashes for transitive deps.
2. Every resolved dependency comes from `https://registry.npmjs.org/`.
3. Every resolved dependency carries a `sha256/384/512` integrity hash.
4. No dependency resolves from git, a bare tarball URL, or the local filesystem.

Checks 2 and 4 are the substitution defences. A dependency silently repointed at
an attacker-controlled host or a malicious fork is the classic supply-chain
compromise, and **neither `npm audit` nor a vulnerability scanner would flag it**
— the package would simply have no known CVEs.

Current state: **1067 resolved dependencies verified, clean.**

## Audit results at the time this gate landed

Before:

| Severity  | Count  |
| --------- | ------ |
| critical  | 0      |
| high      | 7      |
| moderate  | 23     |
| low       | 20     |
| **total** | **50** |

After:

| Severity  | Count  |
| --------- | ------ |
| critical  | 0      |
| high      | 0      |
| moderate  | 5      |
| low       | 34     |
| **total** | **39** |

`npm audit --audit-level=high` now exits 0.

### What changed, and why it was not `npm audit fix --force`

All 7 high-severity findings were transitive dependencies of the **Hardhat 2
toolchain** — development dependencies that run at build and test time and are
never part of any deployed artefact. npm's own remedy for every one of them was
the same: upgrade to `hardhat@3.15.0`.

Hardhat 3 is a config-format rewrite (ESM, restructured plugins, different
network configuration). Taking that migration mid-build would invalidate
`hardhat.config.ts` and the entire Phase 1 contract plan, to fix vulnerabilities
with no production exposure. That is a bad trade during delivery.

Instead each vulnerable transitive is pinned to a patched release **inside the
major version its dependant expects**, via `overrides` in the root
`package.json`:

| Package                | Was     | Pinned to | Advisory                                             |
| ---------------------- | ------- | --------- | ---------------------------------------------------- |
| `adm-zip`              | 0.4.16  | `^0.6.0`  | 4 GB allocation from a crafted ZIP                   |
| `lodash`               | 4.17.21 | `^4.18.1` | code injection via `_.template`, prototype pollution |
| `serialize-javascript` | 6.0.2   | `^7.1.1`  | RCE via `RegExp.flags`, CPU-exhaustion DoS           |
| `tmp`                  | 0.0.33  | `^0.2.7`  | symlink write, path traversal                        |
| `undici`               | 6.27.0  | `^6.28.1` | request smuggling, response-queue poisoning          |
| `uuid`                 | 8.3.2   | `^11.1.1` | missing buffer bounds check                          |
| `ws`                   | 8.18.0  | `^8.21.3` | uninitialised memory disclosure, DoS                 |
| `qs`                   | 6.15.3  | `^6.16.0` | array-limit bypass, DoS (production, Express)        |

`qs` is the only one on a production path (Express → body-parser → qs).

After pinning, the full pipeline was re-verified: build, lint, typecheck and all
51 tests pass, so the forced versions do not break the toolchain. `npm ls`
reports these as `invalid` against the dependants' declared ranges — that is the
expected and intended consequence of an override, not an error.

### Two operational notes worth knowing

- **Overrides only take effect on a clean resolution.** With `node_modules`
  already present, `npm install` reports "up to date" and silently ignores newly
  added overrides — even after deleting `package-lock.json`. Removing
  `node_modules` first is required. This cost real debugging time; if an
  override appears not to work, this is why.
- **This npm does not record `overrides` in `package-lock.json`.** Do not use the
  absence of `packages[""].overrides` as evidence that overrides were skipped;
  check the resolved versions with `npm ls <package> --all`.

## Accepted risk

39 low/moderate advisories remain, all in the Hardhat 2 build toolchain, none
reachable from a deployed artefact. They are accepted until the Hardhat 3
migration, which is deliberately deferred to after Phase 1.

The production dependency tree (`npm audit --omit=dev`) has **zero** high or
critical findings.

OSV scanning is advisory rather than blocking for the same reason: osv-scanner
fails on findings of _any_ severity, which would leave CI permanently red for
issues already consciously accepted. Promote it to blocking once the toolchain
migration clears the remainder.

## Review triggers

Re-examine this baseline when:

- migrating to Hardhat 3 (tighten OSV to blocking, drop the toolchain overrides)
- adding any production dependency
- Dependabot proposes a major version (they are ignored by default here)
- an override's upstream ships a fix, so the pin can be removed rather than kept
