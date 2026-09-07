/**
 * Seeds a local chain with the identities and roles the API needs to be exercised.
 *
 *   npx hardhat run scripts/seed.ts --network localhost
 *
 * Idempotent: every step checks current state first, so re-running after a partial
 * failure completes the remainder rather than reverting on "already registered".
 *
 * LOCAL ONLY. It refuses to run against any network but localhost/hardhat, because it
 * grants privileged roles to well-known development keys whose private keys are printed
 * in every Hardhat banner. Running this against a real network would hand MANAGER to an
 * account the whole internet can sign for.
 */
import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCAL_NETWORKS = new Set(["localhost", "hardhat"]);

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
const AUDITOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AUDITOR_ROLE"));
const USER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("USER_ROLE"));

const PERM_MINT_ASSET = ethers.keccak256(ethers.toUtf8Bytes("PERM_MINT_ASSET"));
const PERM_ISSUE_CREDENTIAL = ethers.keccak256(ethers.toUtf8Bytes("PERM_ISSUE_CREDENTIAL"));
const PERM_VIEW_AUDIT = ethers.keccak256(ethers.toUtf8Bytes("PERM_VIEW_AUDIT"));

interface SeededIdentity {
  label: string;
  address: string;
  didHash: string;
  roles: string[];
}

function didHashFor(address: string): string {
  // A DID hash is an opaque identifier; deriving it from the address keeps the seed
  // deterministic and re-runnable. Production DIDs are not derived this way.
  return ethers.keccak256(ethers.toUtf8Bytes(`did:trustchain:local:${address.toLowerCase()}`));
}

async function main(): Promise<void> {
  if (!LOCAL_NETWORKS.has(network.name)) {
    throw new Error(
      `refusing to seed network "${network.name}": this script grants roles to well-known ` +
        `development keys and is only safe on localhost`,
    );
  }

  const deploymentPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
    contracts: Record<string, { address: string }>;
  };

  const acl = await ethers.getContractAt(
    "RoleAccessControl",
    deployment.contracts.RoleAccessControl!.address,
  );
  const dids = await ethers.getContractAt("DIDRegistry", deployment.contracts.DIDRegistry!.address);

  const signers = await ethers.getSigners();
  const [admin, manager, auditor, user] = signers;

  const plan: { signer: (typeof signers)[number]; label: string; role: string }[] = [
    { signer: admin!, label: "admin", role: ADMIN_ROLE },
    { signer: manager!, label: "manager", role: MANAGER_ROLE },
    { signer: auditor!, label: "auditor", role: AUDITOR_ROLE },
    { signer: user!, label: "user", role: USER_ROLE },
  ];

  console.log(`network        ${network.name}`);
  console.log(`admin          ${admin!.address}\n`);

  const seeded: SeededIdentity[] = [];

  for (const { signer, label, role } of plan) {
    const didHash = didHashFor(signer.address);

    // 1 — register the DID, if it is not already registered.
    const existingController = await dids.controllerOf(didHash);
    if (existingController === ethers.ZeroAddress) {
      const keyCommitment = ethers.keccak256(ethers.toUtf8Bytes(`key:${signer.address}`));
      await (await dids.connect(signer).registerDID(didHash, keyCommitment)).wait();
      console.log(`  registered DID for ${label.padEnd(8)} ${signer.address}`);
    } else {
      console.log(`  DID already present for ${label}`);
    }

    // 2 — grant the role, if not already held.
    if (!(await acl.hasRole(role, signer.address))) {
      await (await acl.connect(admin!).grantRoleToDID(didHash, role)).wait();
      console.log(`  granted ${label.toUpperCase()} role`);
    } else {
      console.log(`  ${label.toUpperCase()} role already held`);
    }

    const roles = await acl.rolesOf(signer.address);
    seeded.push({ label, address: signer.address, didHash, roles: [...roles] });
  }

  // 3 — assert the permissions the API actually gates on. A seed that "succeeded" but
  // left the manager unable to mint would send the failure downstream into the API,
  // where it is far harder to diagnose.
  const checks: [string, string, string][] = [
    ["manager", manager!.address, PERM_MINT_ASSET],
    ["manager", manager!.address, PERM_ISSUE_CREDENTIAL],
    ["auditor", auditor!.address, PERM_VIEW_AUDIT],
    ["admin", admin!.address, PERM_VIEW_AUDIT],
  ];

  console.log("\npermission checks");
  for (const [label, address, permission] of checks) {
    const held = await acl.hasPermission(address, permission);
    const name =
      permission === PERM_MINT_ASSET
        ? "PERM_MINT_ASSET"
        : permission === PERM_ISSUE_CREDENTIAL
          ? "PERM_ISSUE_CREDENTIAL"
          : "PERM_VIEW_AUDIT";
    console.log(`  ${held ? "ok  " : "FAIL"} ${label.padEnd(8)} ${name}`);
    if (!held) {
      throw new Error(`${label} does not hold ${name}; the default permission matrix is wrong`);
    }
  }

  const outPath = path.join(__dirname, "..", "deployments", `${network.name}.seed.json`);
  writeFileSync(outPath, `${JSON.stringify({ network: network.name, seeded }, null, 2)}\n`);
  console.log(`\nidentities written to deployments/${network.name}.seed.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
