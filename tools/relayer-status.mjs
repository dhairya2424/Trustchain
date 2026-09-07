#!/usr/bin/env node
/**
 * Reports what the running relayer says about itself.
 *
 *   node tools/relayer-status.mjs
 *
 * Useful as a readiness check — the published image ships no shell HTTP client, so the
 * compose service has no healthcheck and this is the check from the host instead. It also
 * confirms the signer address the service resolved, which should match
 * `tools/relayer-address.mjs`; a mismatch means the service loaded a different keystore
 * than the one you funded.
 *
 * Reads the API key from infra/relayer/.env and never prints it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const relayerEnv = path.join(repoRoot, "infra", "relayer", ".env");

function envValue(key) {
  if (process.env[key]) return process.env[key];
  if (!existsSync(relayerEnv)) return undefined;
  return new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(relayerEnv, "utf8"))?.[1]?.trim();
}

async function main() {
  const apiKey = envValue("API_KEY");
  if (!apiKey) {
    console.error("API_KEY not found in infra/relayer/.env");
    process.exitCode = 1;
    return;
  }

  const base = process.env.RELAYER_URL ?? "http://localhost:8081";
  const id = process.env.RELAYER_ID ?? "trustchain-amoy";

  let response;
  try {
    response = await fetch(`${base}/api/v1/relayers/${id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    console.error(`relayer unreachable at ${base}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(`relayer responded ${response.status}`);
    process.exitCode = 1;
    return;
  }

  const body = await response.json();
  const data = body?.data ?? body;

  for (const key of [
    "id",
    "name",
    "network",
    "network_type",
    "address",
    "paused",
    "system_disabled",
  ]) {
    if (data?.[key] !== undefined) console.log(`${key.padEnd(16)} ${data[key]}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
