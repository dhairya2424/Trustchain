import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type {
  AssetRegistry,
  AuditTrail,
  CredentialRegistry,
  DIDRegistry,
  RoleAccessControl,
} from "../typechain-types";

const ADMIN_TRANSFER_DELAY = 3n * 24n * 60n * 60n;
const id = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

const MANAGER_ROLE = id("MANAGER_ROLE");
const USER_ROLE = id("USER_ROLE");
const PERM_MINT_ASSET = id("PERM_MINT_ASSET");

const ALICE_DID = id("did:trustchain:alice");
const BOB_DID = id("did:trustchain:bob");
const KEY = id("key-material");
const URI = "ipfs://bafkreiasset/metadata.json";
const VC_HASH = id("vc-payload-hash");
const SCHEMA = id("schema:kyc:v1");

/** Mirrors contracts/libraries/ActionCodes.sol. */
const ACTION = {
  DID_REGISTERED: 1,
  DID_CONTROLLER_ROTATED: 2,
  DID_KEY_ROTATED: 3,
  DID_STATUS_CHANGED: 4,
  ROLE_GRANTED: 5,
  ROLE_REVOKED: 6,
  PERMISSION_UPDATED: 7,
  ASSET_MINTED: 8,
  ASSET_TRANSFERRED: 9,
  ASSET_RECLAIMED: 10,
  CREDENTIAL_ISSUED: 11,
  CREDENTIAL_REVOKED: 12,
} as const;

/** Deploys the whole platform and wires every contract into the audit trail. */
async function wiredSystemFixture() {
  const [owner, manager, alice, bob, newKey] = await ethers.getSigners();
  if (!owner || !manager || !alice || !bob || !newKey) {
    throw new Error("expected at least five funded signers");
  }

  const acl = (await upgrades.deployProxy(
    await ethers.getContractFactory("RoleAccessControl"),
    [owner.address, ADMIN_TRANSFER_DELAY],
    { kind: "uups" },
  )) as unknown as RoleAccessControl;
  await acl.waitForDeployment();

  const did = (await upgrades.deployProxy(
    await ethers.getContractFactory("DIDRegistry"),
    [owner.address],
    { kind: "uups" },
  )) as unknown as DIDRegistry;
  await did.waitForDeployment();

  const assets = (await upgrades.deployProxy(
    await ethers.getContractFactory("AssetRegistry"),
    ["TrustChain Asset", "TCA", await acl.getAddress(), await did.getAddress()],
    { kind: "uups" },
  )) as unknown as AssetRegistry;
  await assets.waitForDeployment();

  const credentials = (await upgrades.deployProxy(
    await ethers.getContractFactory("CredentialRegistry"),
    [await acl.getAddress(), await did.getAddress()],
    { kind: "uups" },
  )) as unknown as CredentialRegistry;
  await credentials.waitForDeployment();

  const trail = (await (
    await ethers.getContractFactory("AuditTrail")
  ).deploy(await acl.getAddress())) as unknown as AuditTrail;
  await trail.waitForDeployment();

  // Allowlist every writer, then point each contract at the trail.
  for (const contract of [acl, did, assets, credentials]) {
    await trail.connect(owner).setTrustedCaller(await contract.getAddress(), true);
  }

  await acl.connect(owner).setDIDRegistry(await did.getAddress());
  await acl.connect(owner).setAuditTrail(await trail.getAddress());
  await did.connect(owner).setAuditTrail(await trail.getAddress());
  await assets.connect(owner).setAuditTrail(await trail.getAddress());
  await credentials.connect(owner).setAuditTrail(await trail.getAddress());

  return { acl, did, assets, credentials, trail, owner, manager, alice, bob, newKey };
}

describe("audit trail integration", () => {
  it("records every critical action across all four system contracts", async () => {
    const { acl, did, assets, credentials, trail, owner, manager, alice, bob, newKey } =
      await loadFixture(wiredSystemFixture);

    const seen: number[] = [];

    /** Runs an action, then records the action code the trail appended. */
    const step = async (label: string, action: () => Promise<unknown>) => {
      const before = await trail.entryCount();
      await action();
      const after = await trail.entryCount();

      expect(after, `${label} recorded nothing in the audit trail`).to.be.greaterThan(before);
      for (let i = before; i < after; i++) {
        seen.push(Number((await trail.entryAt(i)).actionCode));
      }
    };

    await step("grant MANAGER", () => acl.connect(owner).grantRole(MANAGER_ROLE, manager.address));
    await step("grant USER", () => acl.connect(owner).grantRole(USER_ROLE, alice.address));
    await step("register alice DID", () => did.connect(alice).registerDID(ALICE_DID, KEY));
    await step("register bob DID", () => did.connect(bob).registerDID(BOB_DID, KEY));
    await step("re-scope USER", () =>
      acl.connect(owner).setRolePermission(USER_ROLE, PERM_MINT_ASSET, true),
    );
    await step("mint", () => assets.connect(manager).mint(ALICE_DID, URI, false));
    await step("transfer", () =>
      assets.connect(alice).transferFrom(alice.address, bob.address, 1n),
    );
    await step("issue credential", () =>
      credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA, 0),
    );
    await step("revoke credential", () => credentials.connect(manager).revoke(VC_HASH, 1));
    await step("rotate key commitment", () =>
      did.connect(alice).rotateKeyCommitment(ALICE_DID, id("rotated-key")),
    );
    await step("rotate controller", () =>
      did.connect(bob).rotateControllerDirect(BOB_DID, newKey.address),
    );
    await step("reclaim", () => assets.connect(newKey).reclaim(1n));
    await step("suspend DID", () => did.connect(owner).setDIDStatus(ALICE_DID, false));
    await step("revoke MANAGER", () =>
      acl.connect(owner).revokeRole(MANAGER_ROLE, manager.address),
    );

    // Every action code defined in the library was exercised and recorded.
    const recorded = new Set(seen);
    for (const [name, code] of Object.entries(ACTION)) {
      expect(recorded.has(code), `${name} never reached the audit trail`).to.equal(true);
    }
  });

  it("scopes role changes to the holder's identity once a DID exists", async () => {
    const { acl, did, trail, owner, alice } = await loadFixture(wiredSystemFixture);

    await did.connect(alice).registerDID(ALICE_DID, KEY);
    await acl.connect(owner).grantRole(USER_ROLE, alice.address);

    const entry = await trail.entryAt((await trail.entryCount()) - 1n);
    expect(entry.actionCode).to.equal(ACTION.ROLE_GRANTED);
    expect(entry.didHash).to.equal(ALICE_DID);
    expect(entry.refHash).to.equal(USER_ROLE);
    expect(entry.caller).to.equal(await acl.getAddress());
  });

  it("attributes each entry to the contract that produced it", async () => {
    const { acl, did, assets, credentials, trail, owner, manager, alice } =
      await loadFixture(wiredSystemFixture);

    await acl.connect(owner).grantRole(MANAGER_ROLE, manager.address);
    await did.connect(alice).registerDID(ALICE_DID, KEY);
    await assets.connect(manager).mint(ALICE_DID, URI, false);
    await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA, 0);

    const callers = new Set<string>();
    const total = await trail.entryCount();
    for (let i = 0n; i < total; i++) {
      callers.add((await trail.entryAt(i)).caller);
    }

    expect(callers).to.include(await acl.getAddress());
    expect(callers).to.include(await did.getAddress());
    expect(callers).to.include(await assets.getAddress());
    expect(callers).to.include(await credentials.getAddress());
  });

  it("fails the action outright when a wired contract is not allowlisted", async () => {
    const { assets, did, trail, owner, manager, alice } = await loadFixture(wiredSystemFixture);

    await did.connect(alice).registerDID(ALICE_DID, KEY);
    await trail.connect(owner).setTrustedCaller(await assets.getAddress(), false);

    // Minting cannot silently skip the audit trail: the whole mint reverts.
    await expect(assets.connect(owner).mint(ALICE_DID, URI, false)).to.be.revertedWithCustomError(
      trail,
      "NotTrustedCaller",
    );

    expect(await assets.totalMinted()).to.equal(0n);
    expect(await did.connect(manager).exists(ALICE_DID)).to.equal(true);
  });

  it("restricts wiring to administrators on every contract", async () => {
    const { acl, did, assets, credentials, trail, manager } = await loadFixture(wiredSystemFixture);
    const trailAddress = await trail.getAddress();

    await expect(acl.connect(manager).setAuditTrail(trailAddress)).to.be.revertedWithCustomError(
      acl,
      "AccessControlUnauthorizedAccount",
    );

    await expect(did.connect(manager).setAuditTrail(trailAddress)).to.be.revertedWithCustomError(
      did,
      "AccessControlUnauthorizedAccount",
    );

    await expect(assets.connect(manager).setAuditTrail(trailAddress))
      .to.be.revertedWithCustomError(assets, "NotAdmin")
      .withArgs(manager.address);

    await expect(credentials.connect(manager).setAuditTrail(trailAddress))
      .to.be.revertedWithCustomError(credentials, "NotAdmin")
      .withArgs(manager.address);
  });
});
