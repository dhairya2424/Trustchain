/**
 * Deploys the full TrustChain contract system and wires it together.
 *
 *   npx hardhat run scripts/deploy.ts --network amoy
 *
 * The deployer key is read from DEPLOYER_PRIVATE_KEY by hardhat.config.ts and is never
 * written to disk or into an artifact. Nothing in this script hardcodes a key, an RPC
 * URL or an address.
 *
 * Deployment order is forced by the dependency graph:
 *   RoleAccessControl   depends on nothing
 *   DIDRegistry         depends on nothing
 *   AssetRegistry       needs the ACL and the DID registry
 *   CredentialRegistry  needs the ACL and the DID registry
 *   AuditTrail          needs the ACL, and every writer must then be allowlisted on it
 *
 * The trail is deployed last, which is exactly why every sibling treats an unset trail
 * as "do not log" rather than an error.
 */
import { ethers, network, upgrades } from "hardhat";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ADMIN_DELAY_SECONDS = 3 * 24 * 60 * 60; // 3 days

interface DeployedContract {
  address: string;
  implementation?: string;
  kind: "uups-proxy" | "immutable";
}

interface DeploymentRecord {
  network: string;
  chainId: string;
  deployer: string;
  deployedAt: string;
  blockNumber: number;
  adminTransferDelaySeconds: number;
  contracts: Record<string, DeployedContract>;
  /** Set to the Safe address once scripts/transferAdminToSafe.ts has completed. */
  defaultAdmin: string;
}

async function implementationOf(proxy: string): Promise<string> {
  return upgrades.erc1967.getImplementationAddress(proxy);
}

async function main(): Promise<void> {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error("no signer available — is DEPLOYER_PRIVATE_KEY set?");

  const chain = await ethers.provider.getNetwork();
  const adminDelay = Number(
    process.env.ADMIN_TRANSFER_DELAY_SECONDS ?? DEFAULT_ADMIN_DELAY_SECONDS,
  );
  const assetName = process.env.ASSET_TOKEN_NAME ?? "TrustChain Asset";
  const assetSymbol = process.env.ASSET_TOKEN_SYMBOL ?? "TCA";

  console.log(`network        ${network.name} (chainId ${chain.chainId})`);
  console.log(`deployer       ${deployer.address}`);
  console.log(
    `balance        ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`,
  );
  console.log(`admin delay    ${adminDelay}s\n`);

  // 1 — authorization authority
  const acl = await upgrades.deployProxy(
    await ethers.getContractFactory("RoleAccessControl"),
    [deployer.address, adminDelay],
    { kind: "uups" },
  );
  await acl.waitForDeployment();
  const aclAddress = await acl.getAddress();
  console.log(`RoleAccessControl   ${aclAddress}`);

  // 2 — identity root
  const did = await upgrades.deployProxy(
    await ethers.getContractFactory("DIDRegistry"),
    [deployer.address],
    { kind: "uups" },
  );
  await did.waitForDeployment();
  const didAddress = await did.getAddress();
  console.log(`DIDRegistry         ${didAddress}`);

  // 3 — assets
  const assets = await upgrades.deployProxy(
    await ethers.getContractFactory("AssetRegistry"),
    [assetName, assetSymbol, aclAddress, didAddress],
    { kind: "uups" },
  );
  await assets.waitForDeployment();
  const assetsAddress = await assets.getAddress();
  console.log(`AssetRegistry       ${assetsAddress}`);

  // 4 — credentials
  const credentials = await upgrades.deployProxy(
    await ethers.getContractFactory("CredentialRegistry"),
    [aclAddress, didAddress],
    { kind: "uups" },
  );
  await credentials.waitForDeployment();
  const credentialsAddress = await credentials.getAddress();
  console.log(`CredentialRegistry  ${credentialsAddress}`);

  // 5 — audit ledger, deliberately not upgradeable
  const trail = await (await ethers.getContractFactory("AuditTrail")).deploy(aclAddress);
  await trail.waitForDeployment();
  const trailAddress = await trail.getAddress();
  console.log(`AuditTrail          ${trailAddress}\n`);

  // Wiring. Allowlist every writer BEFORE pointing contracts at the trail: the reverse
  // order would leave a window in which a mutation reverts because its audit write is
  // refused.
  console.log("wiring…");
  for (const [label, address] of [
    ["RoleAccessControl", aclAddress],
    ["DIDRegistry", didAddress],
    ["AssetRegistry", assetsAddress],
    ["CredentialRegistry", credentialsAddress],
  ] as const) {
    await (await trail.setTrustedCaller(address, true)).wait();
    console.log(`  allowlisted ${label}`);
  }

  await (await acl.setDIDRegistry(didAddress)).wait();
  await (await acl.setAuditTrail(trailAddress)).wait();
  await (await did.setAuditTrail(trailAddress)).wait();
  await (await assets.setAuditTrail(trailAddress)).wait();
  await (await credentials.setAuditTrail(trailAddress)).wait();
  console.log("  audit trail wired into all four\n");

  const record: DeploymentRecord = {
    network: network.name,
    chainId: chain.chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
    adminTransferDelaySeconds: adminDelay,
    defaultAdmin: deployer.address,
    contracts: {
      RoleAccessControl: {
        address: aclAddress,
        implementation: await implementationOf(aclAddress),
        kind: "uups-proxy",
      },
      DIDRegistry: {
        address: didAddress,
        implementation: await implementationOf(didAddress),
        kind: "uups-proxy",
      },
      AssetRegistry: {
        address: assetsAddress,
        implementation: await implementationOf(assetsAddress),
        kind: "uups-proxy",
      },
      CredentialRegistry: {
        address: credentialsAddress,
        implementation: await implementationOf(credentialsAddress),
        kind: "uups-proxy",
      },
      AuditTrail: { address: trailAddress, kind: "immutable" },
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`addresses written to deployments/${network.name}.json`);
  console.log(
    "\nDEFAULT_ADMIN is still the deployer EOA. Run scripts/transferAdminToSafe.ts next —" +
      "\nsee docs/DEPLOY.md. A deployment is not finished until admin sits in the Safe.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
