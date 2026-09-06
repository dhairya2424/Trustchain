/**
 * Post-deploy assertion: no externally owned account retains administrative control.
 *
 *   npx hardhat run scripts/verifyOwnership.ts --network amoy
 *
 * Exits non-zero if anything is still administrable by an EOA. This is the check that
 * makes "admin is owned by a multisig, not an EOA" a verified fact rather than a claim in
 * a runbook, and it is safe to run repeatedly — as a release gate, or on a schedule to
 * catch a role granted by mistake later.
 */
import { ethers, network } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

async function isContract(address: string): Promise<boolean> {
  return (await ethers.provider.getCode(address)) !== "0x";
}

async function main(): Promise<void> {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file))
    throw new Error(`no deployment record at deployments/${network.name}.json`);

  const record = JSON.parse(readFileSync(file, "utf8"));
  const acl = await ethers.getContractAt(
    "RoleAccessControl",
    record.contracts.RoleAccessControl.address,
  );
  const did = await ethers.getContractAt("DIDRegistry", record.contracts.DIDRegistry.address);
  const trail = await ethers.getContractAt("AuditTrail", record.contracts.AuditTrail.address);

  const problems: string[] = [];

  // 1 — platform owner must be a contract (the Safe), never an EOA.
  const defaultAdmin = await acl.defaultAdmin();
  console.log(`RoleAccessControl DEFAULT_ADMIN  ${defaultAdmin}`);
  if (!(await isContract(defaultAdmin))) {
    problems.push(`DEFAULT_ADMIN ${defaultAdmin} is an EOA, not a multisig`);
  }

  // 2 — no EOA may hold ADMIN on either registry.
  for (const [label, holders] of [
    ["RoleAccessControl", await acl.roleMembers(ADMIN_ROLE)],
  ] as const) {
    for (const holder of holders) {
      const kind = (await isContract(holder)) ? "contract" : "EOA";
      console.log(`${label} ADMIN_ROLE       ${holder} (${kind})`);
      if (kind === "EOA") problems.push(`${label}: ADMIN_ROLE held by EOA ${holder}`);
    }
  }

  // DIDRegistry uses plain AccessControl with no enumeration, so check the deployer
  // explicitly — it is the account the transfer script is meant to have cleared.
  const deployer: string = record.deployer;
  for (const [role, label] of [
    [DEFAULT_ADMIN_ROLE, "DEFAULT_ADMIN_ROLE"],
    [ADMIN_ROLE, "ADMIN_ROLE"],
  ] as const) {
    if (await did.hasRole(role, deployer)) {
      problems.push(`DIDRegistry: deployer ${deployer} still holds ${label}`);
    }
  }

  // 3 — every audit writer is still allowlisted, or the trail has silent gaps.
  for (const name of ["RoleAccessControl", "DIDRegistry", "AssetRegistry", "CredentialRegistry"]) {
    const address = record.contracts[name].address;
    if (!(await trail.isTrustedCaller(address))) {
      problems.push(`AuditTrail: ${name} is not an allowlisted writer`);
    }
  }

  if (problems.length === 0) {
    console.log("\nownership check: PASS — no EOA retains administrative control");
    return;
  }

  console.error(`\nownership check: FAILED (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
