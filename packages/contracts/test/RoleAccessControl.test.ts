import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { DIDRegistry, PermissionedConsumerMock, RoleAccessControl } from "../typechain-types";

const ZERO_ADDRESS = ethers.ZeroAddress;
const ADMIN_TRANSFER_DELAY = 3n * 24n * 60n * 60n; // 3 days

const id = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

/**
 * ethers v6 returns a frozen `Result` for array returns, and chai's `.members`
 * assertion splices its argument. Copy into a plain array first.
 */
const list = <T>(result: readonly T[]): T[] => Array.from(result);

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ADMIN_ROLE = id("ADMIN_ROLE");
const MANAGER_ROLE = id("MANAGER_ROLE");
const AUDITOR_ROLE = id("AUDITOR_ROLE");
const USER_ROLE = id("USER_ROLE");

const PERM_MINT_ASSET = id("PERM_MINT_ASSET");
const PERM_MANAGE_ROLES = id("PERM_MANAGE_ROLES");
const PERM_VIEW_AUDIT = id("PERM_VIEW_AUDIT");
const PERM_ISSUE_CREDENTIAL = id("PERM_ISSUE_CREDENTIAL");
const PERM_REGISTER_DID = id("PERM_REGISTER_DID");

const ALICE_DID = id("did:trustchain:alice");
const KEY_COMMITMENT = id("key-material");

async function deployFixture() {
  const [owner, admin, manager, auditor, user, outsider] = await ethers.getSigners();
  if (!owner || !admin || !manager || !auditor || !user || !outsider) {
    throw new Error("expected at least six funded signers");
  }

  const aclFactory = await ethers.getContractFactory("RoleAccessControl");
  const acl = (await upgrades.deployProxy(aclFactory, [owner.address, ADMIN_TRANSFER_DELAY], {
    kind: "uups",
  })) as unknown as RoleAccessControl;
  await acl.waitForDeployment();

  // owner holds DEFAULT_ADMIN + ADMIN from initialize; it staffs the other roles.
  await acl.connect(owner).grantRole(ADMIN_ROLE, admin.address);
  await acl.connect(admin).grantRole(MANAGER_ROLE, manager.address);
  await acl.connect(admin).grantRole(AUDITOR_ROLE, auditor.address);
  await acl.connect(admin).grantRole(USER_ROLE, user.address);

  const consumerFactory = await ethers.getContractFactory("PermissionedConsumerMock");
  const consumer = (await consumerFactory.deploy(
    await acl.getAddress(),
  )) as unknown as PermissionedConsumerMock;
  await consumer.waitForDeployment();

  return { acl, consumer, owner, admin, manager, auditor, user, outsider };
}

async function withDIDRegistry(acl: RoleAccessControl, ownerAddress: string) {
  const didFactory = await ethers.getContractFactory("DIDRegistry");
  const registry = (await upgrades.deployProxy(didFactory, [ownerAddress], {
    kind: "uups",
  })) as unknown as DIDRegistry;
  await registry.waitForDeployment();

  await acl.setDIDRegistry(await registry.getAddress());
  return registry;
}

describe("RoleAccessControl", () => {
  describe("initialisation", () => {
    it("establishes the four problem-statement roles and the admin hierarchy", async () => {
      const { acl, owner } = await loadFixture(deployFixture);

      expect(await acl.ADMIN_ROLE()).to.equal(ADMIN_ROLE);
      expect(await acl.MANAGER_ROLE()).to.equal(MANAGER_ROLE);
      expect(await acl.AUDITOR_ROLE()).to.equal(AUDITOR_ROLE);
      expect(await acl.USER_ROLE()).to.equal(USER_ROLE);

      // ADMIN is administered by DEFAULT_ADMIN; operational roles by ADMIN.
      expect(await acl.getRoleAdmin(ADMIN_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await acl.getRoleAdmin(MANAGER_ROLE)).to.equal(ADMIN_ROLE);
      expect(await acl.getRoleAdmin(AUDITOR_ROLE)).to.equal(ADMIN_ROLE);
      expect(await acl.getRoleAdmin(USER_ROLE)).to.equal(ADMIN_ROLE);

      expect(await acl.defaultAdmin()).to.equal(owner.address);
      expect(await acl.defaultAdminDelay()).to.equal(ADMIN_TRANSFER_DELAY);
    });

    it("seeds the default permission matrix", async () => {
      const { acl } = await loadFixture(deployFixture);

      expect(await acl.roleHasPermission(ADMIN_ROLE, PERM_MANAGE_ROLES)).to.equal(true);
      expect(await acl.roleHasPermission(MANAGER_ROLE, PERM_MINT_ASSET)).to.equal(true);
      expect(await acl.roleHasPermission(AUDITOR_ROLE, PERM_VIEW_AUDIT)).to.equal(true);

      // The separations that matter.
      expect(await acl.roleHasPermission(MANAGER_ROLE, PERM_MANAGE_ROLES)).to.equal(false);
      expect(await acl.roleHasPermission(AUDITOR_ROLE, PERM_MINT_ASSET)).to.equal(false);
      expect(await acl.permissionsOf(USER_ROLE)).to.deep.equal([]);
    });

    it("rejects a zero default admin", async () => {
      const factory = await ethers.getContractFactory("RoleAccessControl");

      await expect(
        upgrades.deployProxy(factory, [ZERO_ADDRESS, ADMIN_TRANSFER_DELAY], { kind: "uups" }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("granting roles", () => {
    it("a non-admin cannot grant any role", async () => {
      const { acl, outsider, user } = await loadFixture(deployFixture);

      await expect(acl.connect(outsider).grantRole(MANAGER_ROLE, user.address))
        .to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, ADMIN_ROLE);
    });

    it("a MANAGER cannot grant roles", async () => {
      const { acl, manager, outsider } = await loadFixture(deployFixture);

      await expect(acl.connect(manager).grantRole(USER_ROLE, outsider.address))
        .to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount")
        .withArgs(manager.address, ADMIN_ROLE);
    });

    it("an AUDITOR cannot grant roles", async () => {
      const { acl, auditor, outsider } = await loadFixture(deployFixture);

      await expect(
        acl.connect(auditor).grantRole(USER_ROLE, outsider.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");
    });

    it("an ADMIN cannot promote itself to platform owner", async () => {
      const { acl, admin } = await loadFixture(deployFixture);

      // DEFAULT_ADMIN_ROLE cannot be granted at all under the two-step rules.
      await expect(
        acl.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, admin.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlEnforcedDefaultAdminRules");
    });

    it("emits RoleGranted for the subgraph and audit trail", async () => {
      const { acl, admin, outsider } = await loadFixture(deployFixture);

      await expect(acl.connect(admin).grantRole(MANAGER_ROLE, outsider.address))
        .to.emit(acl, "RoleGranted")
        .withArgs(MANAGER_ROLE, outsider.address, admin.address);
    });
  });

  describe("MANAGER can mint but not grant roles", () => {
    it("permits minting through a consuming contract", async () => {
      const { acl, consumer, manager } = await loadFixture(deployFixture);

      expect(await acl.hasPermission(manager.address, PERM_MINT_ASSET)).to.equal(true);

      await consumer.connect(manager).mint();
      expect(await consumer.mintCount()).to.equal(1n);
    });

    it("denies role management to the same account", async () => {
      const { acl, manager, outsider } = await loadFixture(deployFixture);

      expect(await acl.hasPermission(manager.address, PERM_MANAGE_ROLES)).to.equal(false);

      await expect(
        acl.connect(manager).grantRole(AUDITOR_ROLE, outsider.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      await expect(
        acl.connect(manager).setRolePermission(USER_ROLE, PERM_MINT_ASSET, true),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");
    });
  });

  describe("AUDITOR is read-only", () => {
    it("can read but reverts on every write path", async () => {
      const { acl, consumer, auditor, outsider } = await loadFixture(deployFixture);

      // Reads succeed.
      expect(await acl.hasPermission(auditor.address, PERM_VIEW_AUDIT)).to.equal(true);
      expect(await acl.rolesOf(auditor.address)).to.deep.equal([AUDITOR_ROLE]);

      // Every write is refused.
      await expect(
        acl.connect(auditor).grantRole(USER_ROLE, outsider.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      await expect(
        acl.connect(auditor).revokeRole(USER_ROLE, outsider.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      await expect(
        acl.connect(auditor).setRolePermission(AUDITOR_ROLE, PERM_MINT_ASSET, true),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      await expect(
        acl.connect(auditor).setRolePermissions(AUDITOR_ROLE, [PERM_MINT_ASSET], true),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      await expect(
        acl.connect(auditor).setDIDRegistry(outsider.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      // And no permission-gated action in a sibling contract.
      await expect(consumer.connect(auditor).mint())
        .to.be.revertedWithCustomError(consumer, "NotPermitted")
        .withArgs(auditor.address, PERM_MINT_ASSET);

      await expect(consumer.connect(auditor).issueCredential())
        .to.be.revertedWithCustomError(consumer, "NotPermitted")
        .withArgs(auditor.address, PERM_ISSUE_CREDENTIAL);
    });
  });

  describe("revocation takes effect immediately", () => {
    it("a revoked MANAGER loses minting in the very next call", async () => {
      const { acl, consumer, admin, manager } = await loadFixture(deployFixture);

      await consumer.connect(manager).mint();
      expect(await consumer.mintCount()).to.equal(1n);

      await expect(acl.connect(admin).revokeRole(MANAGER_ROLE, manager.address))
        .to.emit(acl, "RoleRevoked")
        .withArgs(MANAGER_ROLE, manager.address, admin.address);

      expect(await acl.hasRole(MANAGER_ROLE, manager.address)).to.equal(false);
      expect(await acl.hasPermission(manager.address, PERM_MINT_ASSET)).to.equal(false);

      await expect(consumer.connect(manager).mint())
        .to.be.revertedWithCustomError(consumer, "NotPermitted")
        .withArgs(manager.address, PERM_MINT_ASSET);

      expect(await consumer.mintCount()).to.equal(1n);
    });

    it("removes the account from role enumeration on revoke", async () => {
      const { acl, admin, manager } = await loadFixture(deployFixture);

      expect(await acl.roleMembers(MANAGER_ROLE)).to.deep.equal([manager.address]);

      await acl.connect(admin).revokeRole(MANAGER_ROLE, manager.address);

      expect(await acl.roleMembers(MANAGER_ROLE)).to.deep.equal([]);
      expect(await acl.rolesOf(manager.address)).to.deep.equal([]);
    });
  });

  describe("access rights are re-scopable at runtime", () => {
    it("an ADMIN can grant and withdraw a permission, and consumers follow immediately", async () => {
      const { acl, consumer, admin, user } = await loadFixture(deployFixture);

      // USER starts with no permissions at all.
      await expect(consumer.connect(user).mint()).to.be.revertedWithCustomError(
        consumer,
        "NotPermitted",
      );

      await expect(acl.connect(admin).setRolePermission(USER_ROLE, PERM_MINT_ASSET, true))
        .to.emit(acl, "PermissionUpdated")
        .withArgs(USER_ROLE, PERM_MINT_ASSET, true, admin.address);

      await consumer.connect(user).mint();
      expect(await consumer.mintCount()).to.equal(1n);

      await acl.connect(admin).setRolePermission(USER_ROLE, PERM_MINT_ASSET, false);

      await expect(consumer.connect(user).mint()).to.be.revertedWithCustomError(
        consumer,
        "NotPermitted",
      );
    });

    it("supports batch re-scoping and enumerating a role's permissions", async () => {
      const { acl, admin } = await loadFixture(deployFixture);

      await acl
        .connect(admin)
        .setRolePermissions(USER_ROLE, [PERM_MINT_ASSET, PERM_REGISTER_DID], true);

      expect(list(await acl.permissionsOf(USER_ROLE))).to.have.members([
        PERM_MINT_ASSET,
        PERM_REGISTER_DID,
      ]);

      await acl.connect(admin).setRolePermissions(USER_ROLE, [PERM_MINT_ASSET], false);
      expect(await acl.permissionsOf(USER_ROLE)).to.deep.equal([PERM_REGISTER_DID]);
    });

    it("refuses to write permissions for DEFAULT_ADMIN_ROLE", async () => {
      const { acl, admin } = await loadFixture(deployFixture);

      await expect(acl.connect(admin).setRolePermission(DEFAULT_ADMIN_ROLE, PERM_MINT_ASSET, true))
        .to.be.revertedWithCustomError(acl, "UnmanageableRole")
        .withArgs(DEFAULT_ADMIN_ROLE);
    });

    it("rejects a zero permission and stays silent when nothing changes", async () => {
      const { acl, admin } = await loadFixture(deployFixture);

      await expect(
        acl.connect(admin).setRolePermission(USER_ROLE, ethers.ZeroHash, true),
      ).to.be.revertedWithCustomError(acl, "InvalidPermission");

      // Re-asserting an existing value emits nothing.
      await expect(
        acl.connect(admin).setRolePermission(MANAGER_ROLE, PERM_MINT_ASSET, true),
      ).to.not.emit(acl, "PermissionUpdated");
    });
  });

  describe("role enumeration", () => {
    it("enumerates roles per account and members per role", async () => {
      const { acl, owner, admin, manager, auditor, user } = await loadFixture(deployFixture);

      expect(await acl.rolesOf(manager.address)).to.deep.equal([MANAGER_ROLE]);
      expect(await acl.roleCountOf(manager.address)).to.equal(1n);

      // owner holds DEFAULT_ADMIN and ADMIN.
      expect(list(await acl.rolesOf(owner.address))).to.have.members([
        DEFAULT_ADMIN_ROLE,
        ADMIN_ROLE,
      ]);
      expect(await acl.roleCountOf(owner.address)).to.equal(2n);

      expect(list(await acl.roleMembers(ADMIN_ROLE))).to.have.members([
        owner.address,
        admin.address,
      ]);
      expect(await acl.roleMemberCount(AUDITOR_ROLE)).to.equal(1n);
      expect(await acl.roleMemberAt(USER_ROLE, 0)).to.equal(user.address);
    });

    it("tracks multiple roles on one account", async () => {
      const { acl, admin, user } = await loadFixture(deployFixture);

      await acl.connect(admin).grantRole(AUDITOR_ROLE, user.address);

      expect(list(await acl.rolesOf(user.address))).to.have.members([USER_ROLE, AUDITOR_ROLE]);
      expect(await acl.hasPermission(user.address, PERM_VIEW_AUDIT)).to.equal(true);

      await acl.connect(admin).revokeRole(AUDITOR_ROLE, user.address);
      expect(await acl.rolesOf(user.address)).to.deep.equal([USER_ROLE]);
      expect(await acl.hasPermission(user.address, PERM_VIEW_AUDIT)).to.equal(false);
    });

    it("is idempotent when a role is granted twice", async () => {
      const { acl, admin, manager } = await loadFixture(deployFixture);

      await acl.connect(admin).grantRole(MANAGER_ROLE, manager.address);

      expect(await acl.roleCountOf(manager.address)).to.equal(1n);
      expect(await acl.roleMemberCount(MANAGER_ROLE)).to.equal(1n);
    });
  });

  describe("DEFAULT_ADMIN two-step transfer and delay", () => {
    it("renouncing requires the delay to elapse", async () => {
      const { acl, owner } = await loadFixture(deployFixture);

      // A direct renounce is refused: the scheduled flow has not begun.
      await expect(
        acl.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlEnforcedDefaultAdminDelay");

      await acl.connect(owner).beginDefaultAdminTransfer(ZERO_ADDRESS);

      // Still refused before the schedule matures.
      await expect(
        acl.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address),
      ).to.be.revertedWithCustomError(acl, "AccessControlEnforcedDefaultAdminDelay");

      const [, schedule] = await acl.pendingDefaultAdmin();
      await time.increaseTo(schedule);

      await acl.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address);
      expect(await acl.defaultAdmin()).to.equal(ZERO_ADDRESS);
    });

    it("transferring requires acceptance by the new admin after the delay", async () => {
      const { acl, owner, outsider } = await loadFixture(deployFixture);

      await expect(acl.connect(owner).beginDefaultAdminTransfer(outsider.address)).to.emit(
        acl,
        "DefaultAdminTransferScheduled",
      );

      // Cannot accept early.
      await expect(
        acl.connect(outsider).acceptDefaultAdminTransfer(),
      ).to.be.revertedWithCustomError(acl, "AccessControlEnforcedDefaultAdminDelay");

      const [pending, schedule] = await acl.pendingDefaultAdmin();
      expect(pending).to.equal(outsider.address);
      await time.increaseTo(schedule);

      // Only the nominated account may accept.
      await expect(acl.connect(owner).acceptDefaultAdminTransfer()).to.be.revertedWithCustomError(
        acl,
        "AccessControlInvalidDefaultAdmin",
      );

      await acl.connect(outsider).acceptDefaultAdminTransfer();

      expect(await acl.defaultAdmin()).to.equal(outsider.address);
      expect(await acl.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(false);
      expect(await acl.rolesOf(owner.address)).to.deep.equal([ADMIN_ROLE]);
    });

    it("a scheduled transfer can be cancelled before it matures", async () => {
      const { acl, owner, outsider } = await loadFixture(deployFixture);

      await acl.connect(owner).beginDefaultAdminTransfer(outsider.address);
      await acl.connect(owner).cancelDefaultAdminTransfer();

      const [pending] = await acl.pendingDefaultAdmin();
      expect(pending).to.equal(ZERO_ADDRESS);
      expect(await acl.defaultAdmin()).to.equal(owner.address);
    });
  });

  describe("identity-scoped grants", () => {
    it("grants and revokes a role by DID", async () => {
      const { acl, owner, admin, outsider } = await loadFixture(deployFixture);
      const registry = await withDIDRegistry(acl, owner.address);

      await registry.connect(outsider).registerDID(ALICE_DID, KEY_COMMITMENT);

      await expect(acl.connect(admin).grantRoleToDID(ALICE_DID, MANAGER_ROLE))
        .to.emit(acl, "RoleGrantedToDID")
        .withArgs(ALICE_DID, MANAGER_ROLE, outsider.address, admin.address);

      expect(await acl.hasRole(MANAGER_ROLE, outsider.address)).to.equal(true);

      await expect(acl.connect(admin).revokeRoleFromDID(ALICE_DID, MANAGER_ROLE))
        .to.emit(acl, "RoleRevokedFromDID")
        .withArgs(ALICE_DID, MANAGER_ROLE, outsider.address, admin.address);

      expect(await acl.hasRole(MANAGER_ROLE, outsider.address)).to.equal(false);
    });

    it("still enforces role administration for DID-scoped grants", async () => {
      const { acl, owner, manager, outsider } = await loadFixture(deployFixture);
      const registry = await withDIDRegistry(acl, owner.address);
      await registry.connect(outsider).registerDID(ALICE_DID, KEY_COMMITMENT);

      await expect(
        acl.connect(manager).grantRoleToDID(ALICE_DID, MANAGER_ROLE),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");
    });

    it("refuses unknown, inactive, and unconfigured cases", async () => {
      const { acl, owner, admin, outsider } = await loadFixture(deployFixture);

      // No registry wired yet.
      await expect(
        acl.connect(admin).grantRoleToDID(ALICE_DID, USER_ROLE),
      ).to.be.revertedWithCustomError(acl, "DIDRegistryNotSet");

      const registry = await withDIDRegistry(acl, owner.address);

      await expect(acl.connect(admin).grantRoleToDID(ALICE_DID, USER_ROLE))
        .to.be.revertedWithCustomError(acl, "UnknownDID")
        .withArgs(ALICE_DID);

      await registry.connect(outsider).registerDID(ALICE_DID, KEY_COMMITMENT);
      await registry.connect(owner).setDIDStatus(ALICE_DID, false);

      await expect(acl.connect(admin).grantRoleToDID(ALICE_DID, USER_ROLE))
        .to.be.revertedWithCustomError(acl, "DIDNotActive")
        .withArgs(ALICE_DID);
    });

    it("only DEFAULT_ADMIN may wire the registry, and never to the zero address", async () => {
      const { acl, owner, admin } = await loadFixture(deployFixture);

      await expect(
        acl.connect(admin).setDIDRegistry(ethers.Wallet.createRandom().address),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");

      await expect(acl.connect(owner).setDIDRegistry(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        acl,
        "ZeroAddress",
      );
    });
  });

  describe("upgradeability", () => {
    it("preserves roles and the permission matrix across an upgrade", async () => {
      const { acl, manager } = await loadFixture(deployFixture);

      const v2Factory = await ethers.getContractFactory("RoleAccessControlV2Mock");
      const upgraded = await upgrades.upgradeProxy(await acl.getAddress(), v2Factory, {
        call: { fn: "initializeV2", args: [] },
        unsafeAllow: ["missing-initializer"],
      });

      expect(await upgraded.version()).to.equal("2.0.0");
      expect(await upgraded.hasRole(MANAGER_ROLE, manager.address)).to.equal(true);
      expect(await upgraded.hasPermission(manager.address, PERM_MINT_ASSET)).to.equal(true);
      expect(await upgraded.roleMembers(MANAGER_ROLE)).to.deep.equal([manager.address]);
    });

    it("refuses upgrades from ADMIN — only DEFAULT_ADMIN may upgrade", async () => {
      const { acl, admin } = await loadFixture(deployFixture);

      const v2Factory = await ethers.getContractFactory("RoleAccessControlV2Mock");
      const v2 = await v2Factory.deploy();
      await v2.waitForDeployment();

      await expect(
        acl.connect(admin).upgradeToAndCall(await v2.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(acl, "AccessControlUnauthorizedAccount");
    });

    it("refuses an upgrade to the zero address", async () => {
      const { acl, owner } = await loadFixture(deployFixture);

      await expect(
        acl.connect(owner).upgradeToAndCall(ZERO_ADDRESS, "0x"),
      ).to.be.revertedWithCustomError(acl, "ZeroAddress");
    });
  });
});
