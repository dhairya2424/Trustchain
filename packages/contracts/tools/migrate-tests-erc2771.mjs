#!/usr/bin/env node
/**
 * One-shot migration of the contract tests for the ERC-2771 constructor argument.
 *
 *   node tools/migrate-tests-erc2771.mjs
 *
 * Mechanical, and idempotent so it can be re-run and checked rather than trusted:
 *
 *   1. a module-level `proxyOptionsFor(forwarder)` helper
 *   2. each fixture deploys a TrustChainForwarder and returns its address
 *   3. `deployProxy(..., { kind: "uups" })` gains the forwarder as a constructor argument
 *   4. V2 upgrade mocks are constructed with the forwarder
 *   5. direct `logAction(a, b, c)` calls gain the actor argument
 *
 * The assertions are untouched. Their subject has not changed — same authorization rules,
 * same events — only how the contracts are constructed. Coverage that is genuinely new
 * (that the actor is recorded, that a relayer cannot spoof one) is written by hand.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const HELPER = `
/**
 * Deployment options for an ERC-2771 aware implementation.
 *
 * Constructor arguments are normally unsafe in an upgradeable contract. They are safe here
 * because the forwarder address is immutable — which is the property that stops actor
 * attribution from being swappable after deployment.
 */
const proxyOptionsFor = (forwarder: string) =>
  ({
    kind: "uups" as const,
    constructorArgs: [forwarder],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  }) as never;

async function deployForwarder(): Promise<string> {
  const forwarder = await (
    await ethers.getContractFactory("TrustChainForwarder")
  ).deploy("TrustChainForwarder");
  await forwarder.waitForDeployment();
  return forwarder.getAddress();
}
`;

function migrate(file) {
  const full = path.join(root, file);
  let source = readFileSync(full, "utf8");

  if (source.includes("proxyOptionsFor")) {
    console.log(`  ${path.basename(file)}: already migrated`);
    return;
  }

  // 1 — helper, after the imports.
  const lastImportEnd = source.lastIndexOf(
    "\n",
    source.indexOf("\n\n", source.lastIndexOf("import ")),
  );
  source = source.slice(0, lastImportEnd) + "\n" + HELPER + source.slice(lastImportEnd);

  // 2 — every fixture deploys a forwarder first.
  source = source.replace(
    /(async function \w*[Ff]ixture\w*\([^)]*\)\s*\{\n)/g,
    "$1  const forwarderAddress = await deployForwarder();\n",
  );

  // 3 — proxy deployments carry the constructor argument.
  source = source.replace(
    /\{\s*\n?\s*kind: "uups",\s*\n?\s*\}/g,
    "proxyOptionsFor(forwarderAddress)",
  );
  source = source.replace(/\{ kind: "uups" \}/g, "proxyOptionsFor(forwarderAddress)");

  // 4 — upgrade mocks.
  source = source.replace(
    /upgrades\.upgradeProxy\(([^,]+), v2Factory\)/g,
    "upgrades.upgradeProxy($1, v2Factory, proxyOptionsFor(forwarderAddress))",
  );
  source = source.replace(/v2Factory\.deploy\(\)/g, "v2Factory.deploy(forwarderAddress)");

  // 5 — direct audit writes name their actor.
  source = source.replace(/\.logAction\(([^)]*?)\)/g, (match, args) =>
    args.split(",").length === 3 ? `.logAction(${args}, actorAddress)` : match,
  );

  writeFileSync(full, source);
  console.log(`  ${path.basename(file)}: migrated`);
}

console.log("test migration");
for (const file of globSync("test/*.test.ts", { cwd: root })) {
  migrate(path.join("test", path.basename(file)));
}
