#!/usr/bin/env node
/**
 * Renders `infra/relayer/config/config.json` from the committed template.
 *
 *   node tools/gen-relayer-config.mjs
 *
 * The relayer's configuration has no environment-variable substitution, and a Polygon Amoy
 * endpoint carries an API key with most providers — so the file the service actually reads
 * is generated here and gitignored, while the template with placeholders is what lives in
 * git. That keeps requirement "no secrets in source" true without giving up a real RPC.
 *
 * The RPC URL is read from `packages/backend/.env`, so it is configured in exactly one
 * place. It is never printed: the host is shown, the key is not.
 *
 * Refuses to emit a file with an unresolved placeholder — a relayer that starts with a
 * literal `${AMOY_RPC_URL}` would fail at the first transaction, far from the cause.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const templatePath = path.join(repoRoot, "infra", "relayer", "config.template.json");
const outPath = path.join(repoRoot, "infra", "relayer", "config", "config.json");
const backendEnv = path.join(repoRoot, "packages", "backend", ".env");

function readEnvValue(file, key) {
  if (!existsSync(file)) return undefined;
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(file, "utf8"));
  const value = match?.[1]?.trim();
  return value && !value.includes("replace-me") ? value : undefined;
}

function main() {
  const rpcUrl = process.env.AMOY_RPC_URL ?? readEnvValue(backendEnv, "POLYGON_AMOY_RPC_URL");

  if (!rpcUrl) {
    console.error(
      "no Amoy RPC URL found.\n" +
        "set POLYGON_AMOY_RPC_URL in packages/backend/.env, or pass AMOY_RPC_URL in the environment",
    );
    process.exitCode = 1;
    return;
  }

  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  // The commentary belongs to the template, not to the runtime configuration.
  delete template._comment;

  const rendered = JSON.stringify(template).replace(/\$\{AMOY_RPC_URL\}/g, rpcUrl);

  const unresolved = rendered.match(/\$\{[A-Z_]+\}/g);
  if (unresolved) {
    console.error(`template has unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(outPath, `${JSON.stringify(JSON.parse(rendered), null, 2)}\n`, { mode: 0o600 });

  let host = "(unparseable)";
  try {
    host = new URL(rpcUrl).host;
  } catch {
    /* reported as unparseable */
  }

  console.log(`wrote ${path.relative(repoRoot, outPath)}`);
  console.log(`  network: amoy (chain id 80002)`);
  console.log(`  rpc host: ${host} — path and key not shown`);
  console.log(`  signer: trustchain-local-signer (local encrypted keystore)`);
}

main();
