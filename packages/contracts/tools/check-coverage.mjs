#!/usr/bin/env node
// Hard coverage gate for the contracts package.
//
//   npm run coverage:check --workspace @trustchain/contracts
//
// solidity-coverage prints a table but exits 0 no matter how low the numbers are, so on
// its own it is a report, not a gate. This turns it into one.
//
// Two thresholds, deliberately different:
//   - Global: every metric must clear 90%, the figure the build plan fixes.
//   - Per-contract: statements, lines and functions must clear 90% individually, so a
//     well-covered contract cannot mask a poorly covered one in the average. Branches
//     are checked globally only — a single hard-to-reach guard in a small contract
//     swings its branch percentage far more than it reflects real risk.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SUMMARY = path.join("coverage", "coverage-summary.json");

const GLOBAL_THRESHOLD = 90;
const PER_FILE_THRESHOLD = 90;
const PER_FILE_METRICS = ["statements", "lines", "functions"];
const ALL_METRICS = ["statements", "lines", "functions", "branches"];

/** Interfaces and libraries carry no executable branches worth gating. */
const EXCLUDED = /[\\/](interfaces|mocks)[\\/]/;

export function evaluate(summary) {
  const failures = [];

  const total = summary.total;
  for (const metric of ALL_METRICS) {
    const pct = total?.[metric]?.pct ?? 0;
    if (pct < GLOBAL_THRESHOLD) {
      failures.push(`global ${metric} ${pct}% is below ${GLOBAL_THRESHOLD}%`);
    }
  }

  for (const [file, metrics] of Object.entries(summary)) {
    if (file === "total" || EXCLUDED.test(file)) continue;

    for (const metric of PER_FILE_METRICS) {
      const pct = metrics?.[metric]?.pct ?? 0;
      // A file with no statements of its own (a pure library) reports 100 or 0; only
      // gate files that actually have something to cover.
      if ((metrics?.[metric]?.total ?? 0) === 0) continue;
      if (pct < PER_FILE_THRESHOLD) {
        failures.push(`${file}: ${metric} ${pct}% is below ${PER_FILE_THRESHOLD}%`);
      }
    }
  }

  return failures;
}

function main() {
  if (!existsSync(SUMMARY)) {
    console.error(`coverage gate: ${SUMMARY} not found — run the coverage task first`);
    return 1;
  }

  const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
  const failures = evaluate(summary);

  const total = summary.total;
  const line = ALL_METRICS.map((m) => `${m} ${total?.[m]?.pct ?? 0}%`).join("  ");

  if (failures.length === 0) {
    console.log(`coverage gate: pass (${line})`);
    return 0;
  }

  console.error(`coverage gate: FAILED (${line})\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
