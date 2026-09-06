/**
 * Verifies every deployed contract on the block explorer.
 *
 *   npx hardhat run scripts/verify.ts --network amoy
 *
 * Reads addresses from deployments/{network}.json, so it can be re-run at any time and
 * never needs addresses pasted by hand. Already-verified contracts are reported and
 * skipped rather than treated as failures — verification is frequently retried after a
 * partial run, and a re-run should be safe.
 */
import { network, run } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

interface Target {
  name: string;
  address: string;
  constructorArguments: unknown[];
}

async function main(): Promise<void> {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) {
    throw new Error(`no deployment record at deployments/${network.name}.json`);
  }

  const record = JSON.parse(readFileSync(file, "utf8"));
  const contracts = record.contracts as Record<string, { address: string; kind: string }>;

  const targets: Target[] = Object.entries(contracts).map(([name, info]) => ({
    name,
    address: info.address,
    // Only AuditTrail takes constructor arguments; the proxies are initialised, not
    // constructed, so their constructor argument list is empty.
    constructorArguments: name === "AuditTrail" ? [contracts.RoleAccessControl?.address ?? ""] : [],
  }));

  let verified = 0;
  let alreadyDone = 0;
  const failures: string[] = [];

  for (const target of targets) {
    process.stdout.write(`${target.name.padEnd(20)} ${target.address} … `);

    try {
      await run("verify:verify", {
        address: target.address,
        constructorArguments: target.constructorArguments,
      });
      console.log("verified");
      verified += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/already verified/i.test(message)) {
        console.log("already verified");
        alreadyDone += 1;
        continue;
      }

      console.log("FAILED");
      failures.push(`${target.name} (${target.address}): ${message.split("\n")[0]}`);
    }
  }

  console.log(`\nverified ${verified}, already verified ${alreadyDone}, failed ${failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
