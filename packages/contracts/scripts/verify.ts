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
  /** Fully qualified source, when bytecode alone is ambiguous. */
  contract?: string;
}

/** Must match `FORWARDER_NAME` in deploy.ts — it is the constructor argument. */
const FORWARDER_NAME = "TrustChainForwarder";

async function main(): Promise<void> {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) {
    throw new Error(`no deployment record at deployments/${network.name}.json`);
  }

  const record = JSON.parse(readFileSync(file, "utf8"));
  const contracts = record.contracts as Record<string, { address: string; kind: string }>;

  /*
   * Constructor arguments, per contract.
   *
   * The subtlety is the UUPS proxies. It is tempting to say a proxy is initialised rather
   * than constructed and pass nothing — but the plugin verifies the *implementation* behind
   * the proxy, and every implementation here derives from ERC2771ContextUpgradeable, whose
   * constructor takes the trusted forwarder. Passing an empty list fails with "has 1
   * parameters but 0 arguments were provided instead".
   *
   * So the rule is about the implementation's constructor, never the proxy's absence of
   * one.
   */
  const forwarder = contracts.TrustChainForwarder?.address ?? "";

  function constructorArgumentsFor(name: string): unknown[] {
    if (name === "TrustChainForwarder") return [FORWARDER_NAME];
    if (name === "AuditTrail") return [contracts.RoleAccessControl?.address ?? ""];
    // Every remaining contract is a UUPS proxy over an ERC-2771 implementation.
    return [forwarder];
  }

  const targets: Target[] = Object.entries(contracts).map(([name, info]) => ({
    name,
    address: info.address,
    constructorArguments: constructorArgumentsFor(name),
    // The forwarder's runtime bytecode also matches OpenZeppelin's own ERC2771Forwarder,
    // so the explorer cannot pick between them without being told which source to use.
    ...(name === "TrustChainForwarder"
      ? { contract: "contracts/forwarder/TrustChainForwarder.sol:TrustChainForwarder" }
      : {}),
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
        ...(target.contract ? { contract: target.contract } : {}),
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
