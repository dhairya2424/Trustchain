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

/**
 * EIP-712 domain name for forwarded requests.
 *
 * Signers must use exactly this string, so it is defined once here and read by the backend
 * from the deployment record rather than retyped — a mismatch would make every signature
 * fail verification for no visible reason.
 */
const FORWARDER_NAME = "TrustChainForwarder";

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

  /*
   * 0 — the forwarder, first, because every implementation below stores its address
   * immutably at construction.
   *
   * That immutability is deliberate rather than incidental: a trusted forwarder that could
   * be swapped later would be a complete takeover of actor attribution, since whoever
   * controlled it could assert any identity for any action. Changing it requires an
   * upgrade, which the Safe governs.
   */
  const forwarder = await (
    await ethers.getContractFactory("TrustChainForwarder")
  ).deploy(FORWARDER_NAME);
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();
  console.log(`TrustChainForwarder ${forwarderAddress}`);

  // The implementations take the forwarder as a constructor argument, which the upgrades
  // plugin has to be told about explicitly — constructor arguments are normally unsafe in
  // an upgradeable contract, and are safe here only because this one is immutable.
  const proxyOptions = {
    kind: "uups" as const,
    constructorArgs: [forwarderAddress],
    unsafeAllow: ["constructor", "state-variable-immutable"] as never,
  };

  // 1 — authorization authority
  const acl = await upgrades.deployProxy(
    await ethers.getContractFactory("RoleAccessControl"),
    [deployer.address, adminDelay],
    proxyOptions,
  );
  await acl.waitForDeployment();
  const aclAddress = await acl.getAddress();
  console.log(`RoleAccessControl   ${aclAddress}`);

  // 2 — identity root
  const did = await upgrades.deployProxy(
    await ethers.getContractFactory("DIDRegistry"),
    [deployer.address],
    proxyOptions,
  );
  await did.waitForDeployment();
  const didAddress = await did.getAddress();
  console.log(`DIDRegistry         ${didAddress}`);

  // 3 — assets
  const assets = await upgrades.deployProxy(
    await ethers.getContractFactory("AssetRegistry"),
    [assetName, assetSymbol, aclAddress, didAddress],
    proxyOptions,
  );
  await assets.waitForDeployment();
  const assetsAddress = await assets.getAddress();
  console.log(`AssetRegistry       ${assetsAddress}`);

  // 4 — credentials
  const credentials = await upgrades.deployProxy(
    await ethers.getContractFactory("CredentialRegistry"),
    [aclAddress, didAddress],
    proxyOptions,
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
      TrustChainForwarder: { address: forwarderAddress, kind: "immutable" },
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
