/**
 * Seeds a deployed system with the identities and roles the API needs.
 *
 *   npx hardhat run scripts/seed.ts --network localhost
 *   RELAYER_ADDRESS=0x... npx hardhat run scripts/seed.ts --network amoy
 *
 * Idempotent: every step checks current state first, so re-running after a partial failure
 * completes the remainder rather than reverting on "already registered".
 *
 * The two networks are seeded differently, and the difference is a safety property rather
 * than a convenience:
 *
 *   localhost — grants ADMIN/MANAGER/AUDITOR/USER to the first four Hardhat accounts, whose
 *               private keys are printed in every node banner and are therefore public
 *               knowledge. Fine on a throwaway chain, catastrophic anywhere else.
 *
 *   amoy      — grants ADMIN to the deployer and MANAGER to the RELAYER_ADDRESS only. No
 *               well-known key is ever granted anything. The relayer needs MANAGER because
 *               it is the account that actually submits mints and credential issuance, and
 *               the contract checks the permission of whoever signs.
 *
 * The script refuses outright on any network that is not one of those two, so it cannot be
 * pointed at mainnet.
 */
import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCAL_NETWORKS = new Set(["localhost", "hardhat"]);
const TESTNETS = new Set(["amoy"]);

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
const AUDITOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("AUDITOR_ROLE"));
const USER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("USER_ROLE"));

const PERM_MINT_ASSET = ethers.keccak256(ethers.toUtf8Bytes("PERM_MINT_ASSET"));
const PERM_ISSUE_CREDENTIAL = ethers.keccak256(ethers.toUtf8Bytes("PERM_ISSUE_CREDENTIAL"));
const PERM_VIEW_AUDIT = ethers.keccak256(ethers.toUtf8Bytes("PERM_VIEW_AUDIT"));

const PERMISSION_NAMES: Record<string, string> = {
  [PERM_MINT_ASSET]: "PERM_MINT_ASSET",
  [PERM_ISSUE_CREDENTIAL]: "PERM_ISSUE_CREDENTIAL",
  [PERM_VIEW_AUDIT]: "PERM_VIEW_AUDIT",
};

interface SeededIdentity {
  label: string;
  address: string;
  didHash: string;
  roles: string[];
}

function didHashFor(address: string): string {
  // Deterministic so the seed is re-runnable and the API can derive the same value.
  // Production DIDs are not derived from an address.
  const scope = network.name === "amoy" ? "amoy" : "local";
  return ethers.keccak256(ethers.toUtf8Bytes(`did:trustchain:${scope}:${address.toLowerCase()}`));
}

async function main(): Promise<void> {
  const isLocal = LOCAL_NETWORKS.has(network.name);
  const isTestnet = TESTNETS.has(network.name);

  if (!isLocal && !isTestnet) {
    throw new Error(
      `refusing to seed network "${network.name}". This script grants privileged roles and ` +
        `is only permitted on localhost or amoy.`,
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
  const admin = signers[0]!;

  console.log(`network        ${network.name}`);
  console.log(`admin          ${admin.address}\n`);

  const seeded: SeededIdentity[] = [];

  /**
   * Registers a DID and grants a role.
   *
   * `signer` is present only when that account can transact for itself — on a testnet only
   * the deployer can, so every other identity is registered on its behalf by the admin.
   */
  const ensure = async (
    label: string,
    address: string,
    role: string,
    signer?: (typeof signers)[number],
  ) => {
    const didHash = didHashFor(address);

    if ((await dids.controllerOf(didHash)) === ethers.ZeroAddress) {
      const keyCommitment = ethers.keccak256(ethers.toUtf8Bytes(`key:${address}`));
      if (signer) {
        await (await dids.connect(signer).registerDID(didHash, keyCommitment)).wait();
      } else {
        await (await dids.connect(admin).registerDIDFor(didHash, address, keyCommitment)).wait();
      }
      console.log(`  registered DID for ${label.padEnd(8)} ${address}`);
    } else {
      console.log(`  DID already present for ${label}`);
    }

    if (!(await acl.hasRole(role, address))) {
      await (await acl.connect(admin).grantRoleToDID(didHash, role)).wait();
      console.log(`  granted ${label.toUpperCase()} role`);
    } else {
      console.log(`  ${label.toUpperCase()} role already held`);
    }

    seeded.push({ label, address, didHash, roles: [...(await acl.rolesOf(address))] });
  };

  const checks: [string, string, string][] = [];

  if (isLocal) {
    const [, manager, auditor, user] = signers;
    await ensure("admin", admin.address, ADMIN_ROLE, admin);
    await ensure("manager", manager!.address, MANAGER_ROLE, manager);
    await ensure("auditor", auditor!.address, AUDITOR_ROLE, auditor);
    await ensure("user", user!.address, USER_ROLE, user);

    checks.push(
      ["manager", manager!.address, PERM_MINT_ASSET],
      ["manager", manager!.address, PERM_ISSUE_CREDENTIAL],
      ["auditor", auditor!.address, PERM_VIEW_AUDIT],
      ["admin", admin.address, PERM_VIEW_AUDIT],
    );
  } else {
    const relayerAddress = process.env.RELAYER_ADDRESS;
    if (!relayerAddress || !ethers.isAddress(relayerAddress)) {
      throw new Error(
        "RELAYER_ADDRESS must be set to the relayer's signer address when seeding a testnet.\n" +
          "Get it from: curl -H 'Authorization: Bearer $API_KEY' " +
          "http://localhost:8081/api/v1/relayers/trustchain-amoy",
      );
    }

    if (relayerAddress.toLowerCase() === admin.address.toLowerCase()) {
      // Separate accounts keep the blast radius of a relayer compromise away from admin.
      throw new Error("RELAYER_ADDRESS must not be the deployer/admin account");
    }

    await ensure("admin", admin.address, ADMIN_ROLE, admin);
    await ensure("relayer", relayerAddress, MANAGER_ROLE);

    checks.push(
      ["relayer", relayerAddress, PERM_MINT_ASSET],
      ["relayer", relayerAddress, PERM_ISSUE_CREDENTIAL],
      ["admin", admin.address, PERM_VIEW_AUDIT],
    );
  }

  // A seed that "succeeded" but left the relayer unable to mint would send the failure
  // downstream into the API, where it is far harder to diagnose.
  console.log("\npermission checks");
  for (const [label, address, permission] of checks) {
    const held = await acl.hasPermission(address, permission);
    const name = PERMISSION_NAMES[permission] ?? permission;
    console.log(`  ${held ? "ok  " : "FAIL"} ${label.padEnd(8)} ${name}`);
    if (!held) throw new Error(`${label} does not hold ${name}; the permission matrix is wrong`);
  }

  const outPath = path.join(__dirname, "..", "deployments", `${network.name}.seed.json`);
  writeFileSync(outPath, `${JSON.stringify({ network: network.name, seeded }, null, 2)}\n`);
  console.log(`\nidentities written to deployments/${network.name}.seed.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
