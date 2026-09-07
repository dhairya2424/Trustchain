import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { AuditTrail, RoleAccessControl } from "../typechain-types";

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

/**
 * A stand-in requester for direct logAction calls.
 *
 * These tests exercise the allowlist and the append-only shape, not attribution, so
 * any non-zero address serves. That the trail REFUSES a zero actor is covered
 * separately.
 */
const ACTOR_ADDRESS = "0x00000000000000000000000000000000000000A1";

async function deployForwarder(): Promise<string> {
  const forwarder = await (
    await ethers.getContractFactory("TrustChainForwarder")
  ).deploy("TrustChainForwarder");
  await forwarder.waitForDeployment();
  return forwarder.getAddress();
}

const ZERO_ADDRESS = ethers.ZeroAddress;
const ADMIN_TRANSFER_DELAY = 3n * 24n * 60n * 60n;

const id = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

const MANAGER_ROLE = id("MANAGER_ROLE");
const ALICE_DID = id("did:trustchain:alice");
const REF = id("ref");

const ACTION_CREDENTIAL_ISSUED = 11;

async function deployFixture() {
  const forwarderAddress = await deployForwarder();
  const [owner, sibling, otherSibling, manager, outsider] = await ethers.getSigners();
  if (!owner || !sibling || !otherSibling || !manager || !outsider) {
    throw new Error("expected at least five funded signers");
  }

  const aclFactory = await ethers.getContractFactory("RoleAccessControl");
  const acl = (await upgrades.deployProxy(
    aclFactory,
    [owner.address, ADMIN_TRANSFER_DELAY],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as RoleAccessControl;
  await acl.waitForDeployment();

  const trailFactory = await ethers.getContractFactory("AuditTrail");
  const trail = (await trailFactory.deploy(await acl.getAddress())) as unknown as AuditTrail;
  await trail.waitForDeployment();

  await acl.connect(owner).grantRole(MANAGER_ROLE, manager.address);

  return { forwarderAddress, acl, trail, owner, sibling, otherSibling, manager, outsider };
}

describe("AuditTrail", () => {
  describe("append-only by construction", () => {
    it("exposes no function that can update or delete an entry", async () => {
      const { trail } = await loadFixture(deployFixture);

      const functionNames: string[] = [];
      trail.interface.forEachFunction((fn) => functionNames.push(fn.name));

      // The guarantee is structural: these functions do not exist to be gated.
      for (const forbidden of ["update", "delete", "remove", "edit", "set", "clear", "prune"]) {
        const offenders = functionNames.filter(
          (name) => name.toLowerCase().startsWith(forbidden) && name !== "setTrustedCaller",
        );
        expect(offenders, `unexpected mutating function(s): ${offenders.join(", ")}`).to.deep.equal(
          [],
        );
      }
    });

    it("rejects a zero access-control address at construction", async () => {
      const factory = await ethers.getContractFactory("AuditTrail");

      await expect(factory.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress",
      );
    });
  });

  describe("trusted-caller allowlist", () => {
    it("refuses writes from an address that is not allowlisted", async () => {
      const { trail, outsider, manager, owner } = await loadFixture(deployFixture);

      // Not even an ADMIN or MANAGER may write directly: only sibling contracts.
      for (const caller of [outsider, manager, owner]) {
        await expect(
          trail.connect(caller).logAction(ALICE_DID, ACTION_CREDENTIAL_ISSUED, REF, ACTOR_ADDRESS),
        )
          .to.be.revertedWithCustomError(trail, "NotTrustedCaller")
          .withArgs(caller.address);
      }

      expect(await trail.entryCount()).to.equal(0n);
    });

    it("only an ADMIN can change the allowlist, and every change is emitted", async () => {
      const { trail, owner, manager, sibling } = await loadFixture(deployFixture);

      await expect(trail.connect(manager).setTrustedCaller(sibling.address, true))
        .to.be.revertedWithCustomError(trail, "NotAdmin")
        .withArgs(manager.address);

      await expect(trail.connect(owner).setTrustedCaller(sibling.address, true))
        .to.emit(trail, "TrustedCallerUpdated")
        .withArgs(sibling.address, true, owner.address);

      expect(await trail.isTrustedCaller(sibling.address)).to.equal(true);

      await expect(
        trail.connect(owner).setTrustedCaller(ZERO_ADDRESS, true),
      ).to.be.revertedWithCustomError(trail, "ZeroAddress");
    });

    it("revoking trust stops writes immediately", async () => {
      const { trail, owner, sibling } = await loadFixture(deployFixture);

      await trail.connect(owner).setTrustedCaller(sibling.address, true);
      await trail
        .connect(sibling)
        .logAction(ALICE_DID, ACTION_CREDENTIAL_ISSUED, REF, ACTOR_ADDRESS);
      expect(await trail.entryCount()).to.equal(1n);

      await trail.connect(owner).setTrustedCaller(sibling.address, false);

      await expect(
        trail.connect(sibling).logAction(ALICE_DID, ACTION_CREDENTIAL_ISSUED, REF, ACTOR_ADDRESS),
      ).to.be.revertedWithCustomError(trail, "NotTrustedCaller");

      // The entry already written is untouched.
      expect(await trail.entryCount()).to.equal(1n);
    });
  });

  describe("appending", () => {
    it("records the entry and emits it for the subgraph", async () => {
      const { trail, owner, sibling } = await loadFixture(deployFixture);
      await trail.connect(owner).setTrustedCaller(sibling.address, true);

      await expect(
        trail.connect(sibling).logAction(ALICE_DID, ACTION_CREDENTIAL_ISSUED, REF, ACTOR_ADDRESS),
      )
        .to.emit(trail, "ActionLogged")
        .withArgs(
          0n,
          ALICE_DID,
          ACTION_CREDENTIAL_ISSUED,
          ACTOR_ADDRESS,
          REF,
          sibling.address,
          anyValue,
        );

      const entry = await trail.entryAt(0n);
      expect(entry.didHash).to.equal(ALICE_DID);
      expect(entry.refHash).to.equal(REF);
      expect(entry.caller).to.equal(sibling.address);
      expect(entry.actionCode).to.equal(ACTION_CREDENTIAL_ISSUED);
      expect(entry.timestamp).to.be.greaterThan(0n);
      expect(entry.blockNumber).to.be.greaterThan(0n);

      // The field the whole change exists for: who asked, kept apart from which contract
      // wrote the row and from whichever account paid for the gas.
      expect(entry.actor).to.equal(ACTOR_ADDRESS);
      expect(entry.actor).to.not.equal(entry.caller);
    });

    it("assigns strictly increasing ids across callers", async () => {
      const { trail, owner, sibling, otherSibling } = await loadFixture(deployFixture);
      await trail.connect(owner).setTrustedCaller(sibling.address, true);
      await trail.connect(owner).setTrustedCaller(otherSibling.address, true);

      for (let i = 0; i < 5; i++) {
        const writer = i % 2 === 0 ? sibling : otherSibling;
        await trail
          .connect(writer)
          .logAction(ALICE_DID, ACTION_CREDENTIAL_ISSUED, REF, ACTOR_ADDRESS);
        expect(await trail.entryCount()).to.equal(BigInt(i + 1));
      }

      for (let i = 0; i < 5; i++) {
        const entry = await trail.entryAt(BigInt(i));
        expect(entry.caller).to.equal(i % 2 === 0 ? sibling.address : otherSibling.address);
      }
    });

    it("accepts a zero DID for actions that are not identity-scoped", async () => {
      const { trail, owner, sibling } = await loadFixture(deployFixture);
      await trail.connect(owner).setTrustedCaller(sibling.address, true);

      await trail.connect(sibling).logAction(ethers.ZeroHash, 7, REF, ACTOR_ADDRESS);
      expect((await trail.entryAt(0n)).didHash).to.equal(ethers.ZeroHash);
    });
  });

  describe("reading", () => {
    it("paginates and clamps an over-long range", async () => {
      const { trail, owner, sibling } = await loadFixture(deployFixture);
      await trail.connect(owner).setTrustedCaller(sibling.address, true);

      for (let i = 0; i < 6; i++) {
        await trail.connect(sibling).logAction(ALICE_DID, i + 1, REF, ACTOR_ADDRESS);
      }

      const firstPage = await trail.entriesInRange(0n, 4n);
      expect(firstPage.length).to.equal(4);
      expect(firstPage[0]?.actionCode).to.equal(1);

      // Clamped to the end rather than reverting.
      const lastPage = await trail.entriesInRange(4n, 100n);
      expect(lastPage.length).to.equal(2);
      expect(lastPage[1]?.actionCode).to.equal(6);

      expect((await trail.entriesInRange(6n, 5n)).length).to.equal(0);
    });

    it("reverts on an out-of-bounds index or start", async () => {
      const { trail } = await loadFixture(deployFixture);

      await expect(trail.entryAt(0n))
        .to.be.revertedWithCustomError(trail, "IndexOutOfBounds")
        .withArgs(0n, 0n);

      await expect(trail.entriesInRange(1n, 1n))
        .to.be.revertedWithCustomError(trail, "InvalidRange")
        .withArgs(1n, 0n);
    });
  });
});
