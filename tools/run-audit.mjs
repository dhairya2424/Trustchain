#!/usr/bin/env node
// Runs `npm audit --audit-level=high` and propagates its exit code.
//
// Why this wrapper exists: a user-level `allow-scripts` npm config (set by some
// global installers) is exported to child processes as npm_config_allow_scripts.
// A nested `npm audit` then aborts with EALLOWSCRIPTS — "--allow-scripts is not
// allowed in project-scoped installs" — so the audit never runs and the gate
// reports a failure unrelated to any vulnerability. Stripping the inherited
// config makes the audit behave the same on a developer machine as in CI.

import { spawnSync } from "node:child_process";

// Threshold is overridable so the gate's failure path can be exercised:
//   node tools/run-audit.mjs low   -> must exit non-zero while low findings exist
const level = process.argv[2] ?? "high";
const AUDIT_ARGS = ["audit", `--audit-level=${level}`];

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"),
);

// npm_execpath points at npm-cli.js when invoked through an npm script; running
// it with node avoids spawning npm.cmd, which modern Node refuses without a shell.
const npmCli = process.env.npm_execpath;

const result =
  npmCli && npmCli.endsWith(".js")
    ? spawnSync(process.execPath, [npmCli, ...AUDIT_ARGS], { stdio: "inherit", env })
    : spawnSync("npm", AUDIT_ARGS, { stdio: "inherit", env, shell: true });

process.exit(result.status ?? 1);
