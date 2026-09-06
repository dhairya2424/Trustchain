/**
 * Moves platform ownership from the deployer EOA to a 2-of-3 Safe{Wallet} multisig.
 *
 *   TRANSFER_PHASE=begin    npx hardhat run scripts/transferAdminToSafe.ts --network amoy
 *   ... Safe accepts, after the on-chain delay ...
 *   TRANSFER_PHASE=finalize npx hardhat run scripts/transferAdminToSafe.ts --network amoy
 *
 * Deliberately two phases. A single script that granted the Safe control and renounced
 * the deployer's roles in one transaction would be irreversible the moment any step was
 * wrong — a mistyped address, a Safe that cannot actually sign, a delay not yet elapsed —
 * and would leave the platform permanently unadministrable. So:
 *
 *   begin     grants the Safe everything it needs and STARTS the two-step
 *             DEFAULT_ADMIN transfer. The deployer keeps access throughout.
 *   finalize  refuses to run until the Safe has actually accepted, then drops the
 *             deployer's remaining roles.
 *
 * The two registries need different handling: RoleAccessControl uses
 * AccessControlDefaultAdminRules (two-step with an enforced delay), while DIDRegistry
 * uses plain AccessControl (grant, then renounce).
 */
import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

type Phase = "begin" | "finalize";

function deploymentFile(): string {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!existsSync(file)) {
    throw new Error(`no deployment record at deployments/${network.name}.json — deploy first`);
  }
  return file;
}

async function main(): Promise<void> {
  const phase = (process.env.TRANSFER_PHASE ?? "") as Phase;
  if (phase !== "begin" && phase !== "finalize") {
    throw new Error('set TRANSFER_PHASE to "begin" or "finalize"');
  }

  const safe = process.env.SAFE_ADMIN_ADDRESS;
  if (!safe || !ethers.isAddress(safe)) {
    throw new Error("SAFE_ADMIN_ADDRESS is missing or not a valid address");
  }

  // A Safe is a contract. If this address has no code it is an EOA — very likely a typo,
  // and handing platform ownership to it would be unrecoverable.
  if ((await ethers.provider.getCode(safe)) === "0x") {
    throw new Error(
      `SAFE_ADMIN_ADDRESS ${safe} has no contract code. A Safe multisig is a contract; ` +
        `refusing to hand ownership to what looks like an EOA.`,
    );
  }

  const file = deploymentFile();
  const record = JSON.parse(readFileSync(file, "utf8"));
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error("no signer available");

  const acl = await ethers.getContractAt(
    "RoleAccessControl",
    record.contracts.RoleAccessControl.address,
  );
  const did = await ethers.getContractAt("DIDRegistry", record.contracts.DIDRegistry.address);

  console.log(`network   ${network.name}`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`safe      ${safe}`);
  console.log(`phase     ${phase}\n`);

  if (phase === "begin") {
    // Grant first, renounce later. The deployer must never be without a path back in
    // until the Safe has demonstrably taken over.
    if (!(await did.hasRole(DEFAULT_ADMIN_ROLE, safe))) {
      await (await did.grantRole(DEFAULT_ADMIN_ROLE, safe)).wait();
      console.log("DIDRegistry        granted DEFAULT_ADMIN_ROLE to Safe");
    }
    if (!(await did.hasRole(ADMIN_ROLE, safe))) {
      await (await did.grantRole(ADMIN_ROLE, safe)).wait();
      console.log("DIDRegistry        granted ADMIN_ROLE to Safe");
    }
    if (!(await acl.hasRole(ADMIN_ROLE, safe))) {
      await (await acl.grantRole(ADMIN_ROLE, safe)).wait();
      console.log("RoleAccessControl  granted ADMIN_ROLE to Safe");
    }

    await (await acl.beginDefaultAdminTransfer(safe)).wait();
    const [pending, schedule] = await acl.pendingDefaultAdmin();

    console.log(`RoleAccessControl  DEFAULT_ADMIN transfer scheduled`);
    console.log(`  pending admin    ${pending}`);
    console.log(`  acceptable after ${new Date(Number(schedule) * 1000).toISOString()}\n`);
    console.log(
      "Next: from the Safe, call acceptDefaultAdminTransfer() on RoleAccessControl\n" +
        "AFTER the timestamp above, then re-run this script with TRANSFER_PHASE=finalize.",
    );
    return;
  }

  // finalize
  const currentAdmin = await acl.defaultAdmin();
  if (currentAdmin.toLowerCase() !== safe.toLowerCase()) {
    throw new Error(
      `RoleAccessControl DEFAULT_ADMIN is still ${currentAdmin}. The Safe has not accepted ` +
        `the transfer yet — refusing to drop the deployer's roles and orphan the platform.`,
    );
  }

  if (await acl.hasRole(ADMIN_ROLE, deployer.address)) {
    await (await acl.renounceRole(ADMIN_ROLE, deployer.address)).wait();
    console.log("RoleAccessControl  deployer renounced ADMIN_ROLE");
  }
  if (await did.hasRole(ADMIN_ROLE, deployer.address)) {
    await (await did.renounceRole(ADMIN_ROLE, deployer.address)).wait();
    console.log("DIDRegistry        deployer renounced ADMIN_ROLE");
  }
  if (await did.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)) {
    await (await did.renounceRole(DEFAULT_ADMIN_ROLE, deployer.address)).wait();
    console.log("DIDRegistry        deployer renounced DEFAULT_ADMIN_ROLE");
  }

  record.defaultAdmin = safe;
  record.adminTransferredAt = new Date().toISOString();
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\nOwnership now rests with the Safe. deployments/${network.name}.json updated.`);
  console.log("Verify with: npx hardhat run scripts/verifyOwnership.ts --network " + network.name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
