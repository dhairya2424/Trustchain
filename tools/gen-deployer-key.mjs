#!/usr/bin/env node
/**
 * Generates the Amoy deployer key into `packages/contracts/.env`.
 *
 *   node tools/gen-deployer-key.mjs
 *
 * The key is generated on this machine, written to a gitignored file, and **only the
 * address is printed**. Nobody — including whoever runs this — needs to see the private
 * key, and a key that is never displayed cannot be pasted into a chat window, a ticket, or
 * a screen share by accident.
 *
 * A testnet deployer key is still a real key: it will hold DEFAULT_ADMIN on the deployed
 * contracts until admin is transferred to a Safe, so treat it as production material even
 * though the funds are worthless.
 *
 * Refuses to overwrite an existing file, and never touches AMOY_RPC_URL or
 * POLYGONSCAN_API_KEY if they are already configured.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const envPath = path.join(repoRoot, "packages", "contracts", ".env");

function main() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, "utf8");
    const configured = /^DEPLOYER_PRIVATE_KEY=0x[0-9a-fA-F]{64}$/m.test(existing);

    if (configured) {
      // Report the address of the key already present rather than replacing it — a
      // deployer key that is overwritten after deployment locks out the admin.
      const match = /^DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m.exec(existing);
      const current = privateKeyToAccount(match[1]);
      console.log("packages/contracts/.env already has a deployer key; leaving it alone");
      console.log(`  deployer address: ${current.address}`);
      return;
    }

    const updated = existing.replace(
      /^DEPLOYER_PRIVATE_KEY=.*$/m,
      `DEPLOYER_PRIVATE_KEY=${privateKey}`,
    );
    writeFileSync(envPath, updated, { mode: 0o600 });
  } else {
    const lines = [
      "# Contracts — DEPLOY KEYS. Generated locally by tools/gen-deployer-key.mjs.",
      "# Gitignored. A testnet key is still a real key: it holds DEFAULT_ADMIN until admin",
      "# is transferred to a Safe.",
      "",
      "AMOY_RPC_URL=replace-me-with-your-amoy-endpoint",
      `DEPLOYER_PRIVATE_KEY=${privateKey}`,
      "POLYGONSCAN_API_KEY=replace-me-with-polygonscan-key",
      "SAFE_ADMIN_ADDRESS=0x0000000000000000000000000000000000000000",
      "REPORT_GAS=false",
      "",
    ];
    writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  }

  console.log("wrote packages/contracts/.env");
  console.log(`  deployer address: ${account.address}`);
  console.log("  private key: generated and written to the gitignored file, not printed");
}

main();
