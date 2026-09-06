#!/usr/bin/env node
// package-lock.json integrity gate.
//
//   node tools/check-lockfile.mjs [path-to-lockfile]
//
// npm ci already proves the lockfile agrees with package.json. This checks the
// properties npm ci does not:
//   1. lockfileVersion is 3+ (v1 omits integrity for transitive deps)
//   2. every resolved dependency comes from the public npm registry over HTTPS
//   3. every resolved dependency carries a subresource-integrity hash
//   4. no dependency is pulled from git, a tarball URL, or the local filesystem
//
// (2) and (4) are the substitution defences: a dependency silently repointed at
// an attacker-controlled host or fork is the classic supply-chain compromise,
// and neither npm audit nor a vulnerability scanner would flag it.

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_LOCKFILE = "package-lock.json";
const ALLOWED_REGISTRY = "https://registry.npmjs.org/";
const ACCEPTABLE_INTEGRITY = /^sha(?:256|384|512)-/;
const MIN_LOCKFILE_VERSION = 3;

const FORBIDDEN_SOURCES = [
  { pattern: /^git(\+|:)/i, reason: "resolved from a git repository" },
  { pattern: /^file:/i, reason: "resolved from the local filesystem" },
  { pattern: /^http:\/\//i, reason: "resolved over plaintext HTTP" },
];

export function checkLockfileData(lock) {
  const findings = [];

  if (typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < MIN_LOCKFILE_VERSION) {
    findings.push({
      check: "lockfile-version",
      target: "lockfileVersion",
      detail: `expected >= ${MIN_LOCKFILE_VERSION}, found ${lock.lockfileVersion}`,
    });
  }

  const packages = lock.packages ?? {};
  let inspected = 0;

  for (const [path, entry] of Object.entries(packages)) {
    // Only installed dependencies are downloaded artefacts, and those always sit
    // under a node_modules/ segment. Everything else is the root project or a
    // workspace source directory, which is local code, not a fetched tarball.
    if (!path.includes("node_modules/")) continue;
    if (entry.link === true) continue;

    const { resolved, integrity } = entry;

    if (resolved === undefined) {
      // Bundled dependencies legitimately carry no resolved URL.
      if (entry.inBundle === true) continue;
      findings.push({ check: "missing-resolved", target: path, detail: "no resolved URL" });
      continue;
    }

    inspected += 1;

    const forbidden = FORBIDDEN_SOURCES.find((source) => source.pattern.test(resolved));
    if (forbidden) {
      findings.push({ check: "forbidden-source", target: path, detail: forbidden.reason });
      continue;
    }

    if (!resolved.startsWith(ALLOWED_REGISTRY)) {
      findings.push({
        check: "untrusted-registry",
        target: path,
        detail: `resolved from ${new URL(resolved).origin}, expected ${ALLOWED_REGISTRY}`,
      });
    }

    if (typeof integrity !== "string" || !ACCEPTABLE_INTEGRITY.test(integrity)) {
      findings.push({
        check: "missing-integrity",
        target: path,
        detail: "no usable subresource-integrity hash",
      });
    }
  }

  return { ok: findings.length === 0, findings, inspected, total: Object.keys(packages).length };
}

export function checkLockfile(lockfilePath = DEFAULT_LOCKFILE) {
  if (!existsSync(lockfilePath)) {
    return {
      ok: false,
      inspected: 0,
      total: 0,
      findings: [
        {
          check: "lockfile-missing",
          target: lockfilePath,
          detail: "no lockfile — builds would not be reproducible",
        },
      ],
    };
  }

  return checkLockfileData(JSON.parse(readFileSync(lockfilePath, "utf8")));
}

function main() {
  const result = checkLockfile(process.argv[2] ?? DEFAULT_LOCKFILE);

  if (result.ok) {
    console.log(`lockfile integrity: clean (${result.inspected} resolved dependencies verified)`);
    return 0;
  }

  console.error(`lockfile integrity: ${result.findings.length} finding(s)\n`);
  for (const finding of result.findings) {
    console.error(`  [${finding.check}] ${finding.target}`);
    console.error(`    ${finding.detail}`);
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
