import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type {
  AuditTrail,
  CredentialRegistry,
  DIDRegistry,
  RoleAccessControl,
} from "../typechain-types";

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

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const ADMIN_TRANSFER_DELAY = 3n * 24n * 60n * 60n;

const id = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

const MANAGER_ROLE = id("MANAGER_ROLE");
const AUDITOR_ROLE = id("AUDITOR_ROLE");
const USER_ROLE = id("USER_ROLE");
const PERM_ISSUE_CREDENTIAL = id("PERM_ISSUE_CREDENTIAL");
const PERM_REVOKE_CREDENTIAL = id("PERM_REVOKE_CREDENTIAL");

const ALICE_DID = id("did:trustchain:alice");
const KEY = id("key-material");

// The hash of a VC payload. The payload itself never reaches the chain.
const VC_HASH = ethers.keccak256(
  ethers.toUtf8Bytes(JSON.stringify({ type: "KYCCredential", subject: "alice", over18: true })),
);
const VC_HASH_2 = id("second-credential");
const SCHEMA_KYC = id("schema:kyc:v1");

const REASON_KEY_COMPROMISED = 1;
const REASON_SUPERSEDED = 2;

const STATUS = { Unknown: 0n, Valid: 1n, Expired: 2n, Revoked: 3n };
const ACTION_CREDENTIAL_ISSUED = 11;
const ACTION_CREDENTIAL_REVOKED = 12;

async function deployFixture() {
  const forwarderAddress = await deployForwarder();
  const [owner, manager, alice, auditor, outsider] = await ethers.getSigners();
  if (!owner || !manager || !alice || !auditor || !outsider) {
    throw new Error("expected at least five funded signers");
  }

  const aclFactory = await ethers.getContractFactory("RoleAccessControl");
  const acl = (await upgrades.deployProxy(
    aclFactory,
    [owner.address, ADMIN_TRANSFER_DELAY],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as RoleAccessControl;
  await acl.waitForDeployment();

  const didFactory = await ethers.getContractFactory("DIDRegistry");
  const did = (await upgrades.deployProxy(
    didFactory,
    [owner.address],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as DIDRegistry;
  await did.waitForDeployment();

  const credFactory = await ethers.getContractFactory("CredentialRegistry");
  const credentials = (await upgrades.deployProxy(
    credFactory,
    [await acl.getAddress(), await did.getAddress()],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as CredentialRegistry;
  await credentials.waitForDeployment();

  const trailFactory = await ethers.getContractFactory("AuditTrail");
  const trail = (await trailFactory.deploy(await acl.getAddress())) as unknown as AuditTrail;
  await trail.waitForDeployment();

  await acl.connect(owner).grantRole(MANAGER_ROLE, manager.address);
  await acl.connect(owner).grantRole(AUDITOR_ROLE, auditor.address);
  await acl.connect(owner).grantRole(USER_ROLE, alice.address);

  await did.connect(alice).registerDID(ALICE_DID, KEY);

  return {
    forwarderAddress,
    acl,
    did,
    credentials,
    trail,
    owner,
    manager,
    alice,
    auditor,
    outsider,
  };
}

async function wireAuditTrail(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const { credentials, trail, owner } = fixture;
  await trail.connect(owner).setTrustedCaller(await credentials.getAddress(), true);
  await credentials.connect(owner).setAuditTrail(await trail.getAddress());
}

describe("CredentialRegistry", () => {
  describe("issuance", () => {
    it("anchors a credential hash to an identity", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);

      await expect(credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0))
        .to.emit(credentials, "CredentialIssued")
        .withArgs(VC_HASH, ALICE_DID, SCHEMA_KYC, manager.address, anyValue, 0n);

      const credential = await credentials.credentialOf(VC_HASH);
      expect(credential.didHash).to.equal(ALICE_DID);
      expect(credential.schemaId).to.equal(SCHEMA_KYC);
      expect(credential.issuer).to.equal(manager.address);
      expect(credential.revoked).to.equal(false);
      expect(credential.expiresAt).to.equal(0n);

      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Valid);
      expect(await credentials.isValid(VC_HASH)).to.equal(true);
      expect(await credentials.issuedCountOf(ALICE_DID)).to.equal(1n);
    });

    it("stores only the hash — the payload never reaches the chain", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      const credential = await credentials.credentialOf(VC_HASH);
      const encoded = JSON.stringify(credential, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );

      // Nothing recoverable about the subject is present anywhere in the record.
      expect(encoded.toLowerCase()).to.not.include("alice");
      expect(encoded.toLowerCase()).to.not.include("over18");
      expect(encoded.toLowerCase()).to.not.include("kyccredential");
    });

    it("UNAUTHORIZED: a USER, an AUDITOR and an outsider cannot issue", async () => {
      const { credentials, alice, auditor, outsider } = await loadFixture(deployFixture);

      for (const caller of [alice, auditor, outsider]) {
        await expect(credentials.connect(caller).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0))
          .to.be.revertedWithCustomError(credentials, "NotPermitted")
          .withArgs(caller.address, PERM_ISSUE_CREDENTIAL);
      }
    });

    it("refuses duplicates, zero hashes, zero schemas and past expiry", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      await expect(credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0))
        .to.be.revertedWithCustomError(credentials, "CredentialAlreadyIssued")
        .withArgs(VC_HASH);

      await expect(
        credentials.connect(manager).issue(ZERO_BYTES32, ALICE_DID, SCHEMA_KYC, 0),
      ).to.be.revertedWithCustomError(credentials, "InvalidCredentialHash");

      await expect(
        credentials.connect(manager).issue(VC_HASH_2, ALICE_DID, ZERO_BYTES32, 0),
      ).to.be.revertedWithCustomError(credentials, "InvalidSchemaId");

      const past = BigInt(await time.latest()) - 1n;
      await expect(
        credentials.connect(manager).issue(VC_HASH_2, ALICE_DID, SCHEMA_KYC, past),
      ).to.be.revertedWithCustomError(credentials, "ExpiryInThePast");
    });

    it("refuses unknown and suspended identities", async () => {
      const { credentials, did, owner, manager } = await loadFixture(deployFixture);

      await expect(credentials.connect(manager).issue(VC_HASH, id("did:nobody"), SCHEMA_KYC, 0))
        .to.be.revertedWithCustomError(credentials, "UnknownDID")
        .withArgs(id("did:nobody"));

      await did.connect(owner).setDIDStatus(ALICE_DID, false);
      await expect(credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0))
        .to.be.revertedWithCustomError(credentials, "DIDNotActive")
        .withArgs(ALICE_DID);
    });
  });

  describe("expiry", () => {
    it("turns Expired once the deadline passes, without any transaction", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);

      const expiresAt = BigInt(await time.latest()) + 3600n;
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, expiresAt);
      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Valid);

      await time.increaseTo(expiresAt);

      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Expired);
      expect(await credentials.isValid(VC_HASH)).to.equal(false);
    });
  });

  describe("revocation registry", () => {
    it("revokes with a reason code and records who and when", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      await expect(credentials.connect(manager).revoke(VC_HASH, REASON_KEY_COMPROMISED))
        .to.emit(credentials, "CredentialRevoked")
        .withArgs(VC_HASH, ALICE_DID, REASON_KEY_COMPROMISED, manager.address, anyValue);

      const credential = await credentials.credentialOf(VC_HASH);
      expect(credential.revoked).to.equal(true);
      expect(credential.revocationReason).to.equal(REASON_KEY_COMPROMISED);
      expect(credential.revokedAt).to.be.greaterThan(0n);

      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Revoked);
    });

    it("demands a non-zero reason so every revocation is attributable", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      await expect(credentials.connect(manager).revoke(VC_HASH, 0)).to.be.revertedWithCustomError(
        credentials,
        "InvalidReasonCode",
      );

      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Valid);
    });

    it("refuses unknown credentials and double revocation", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);

      await expect(credentials.connect(manager).revoke(VC_HASH, REASON_SUPERSEDED))
        .to.be.revertedWithCustomError(credentials, "CredentialNotFound")
        .withArgs(VC_HASH);

      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);
      await credentials.connect(manager).revoke(VC_HASH, REASON_SUPERSEDED);

      await expect(credentials.connect(manager).revoke(VC_HASH, REASON_KEY_COMPROMISED))
        .to.be.revertedWithCustomError(credentials, "CredentialAlreadyRevoked")
        .withArgs(VC_HASH);
    });

    it("UNAUTHORIZED: an AUDITOR cannot revoke", async () => {
      const { credentials, manager, auditor } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      await expect(credentials.connect(auditor).revoke(VC_HASH, REASON_SUPERSEDED))
        .to.be.revertedWithCustomError(credentials, "NotPermitted")
        .withArgs(auditor.address, PERM_REVOKE_CREDENTIAL);
    });

    it("revocation outranks expiry in the reported status", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);

      const expiresAt = BigInt(await time.latest()) + 3600n;
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, expiresAt);
      await credentials.connect(manager).revoke(VC_HASH, REASON_KEY_COMPROMISED);

      await time.increaseTo(expiresAt + 10n);

      // An auditor must see WHY it is invalid, and "revoked" carries a reason code.
      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Revoked);
    });
  });

  describe("public verification", () => {
    it("needs no account and reports Unknown for anything unissued", async () => {
      const { credentials, outsider } = await loadFixture(deployFixture);

      expect(await credentials.connect(outsider).statusOf(id("never-issued"))).to.equal(
        STATUS.Unknown,
      );
      expect(await credentials.connect(outsider).isValid(id("never-issued"))).to.equal(false);

      await expect(credentials.credentialOf(id("never-issued")))
        .to.be.revertedWithCustomError(credentials, "CredentialNotFound")
        .withArgs(id("never-issued"));
    });
  });

  describe("audit trail integration", () => {
    it("records issuance and revocation in the append-only ledger", async () => {
      const fixture = await loadFixture(deployFixture);
      const { credentials, trail, manager } = fixture;
      await wireAuditTrail(fixture);

      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);
      await credentials.connect(manager).revoke(VC_HASH, REASON_KEY_COMPROMISED);

      expect(await trail.entryCount()).to.equal(2n);

      const issued = await trail.entryAt(0n);
      expect(issued.actionCode).to.equal(ACTION_CREDENTIAL_ISSUED);
      expect(issued.didHash).to.equal(ALICE_DID);
      expect(issued.refHash).to.equal(VC_HASH);
      expect(issued.caller).to.equal(await credentials.getAddress());

      const revoked = await trail.entryAt(1n);
      expect(revoked.actionCode).to.equal(ACTION_CREDENTIAL_REVOKED);
      expect(revoked.refHash).to.equal(VC_HASH);
    });

    it("works before a trail is wired, and only an ADMIN may wire one", async () => {
      const { credentials, trail, owner, manager } = await loadFixture(deployFixture);

      // No trail yet — issuance still succeeds.
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      await expect(credentials.connect(manager).setAuditTrail(await trail.getAddress()))
        .to.be.revertedWithCustomError(credentials, "NotAdmin")
        .withArgs(manager.address);

      await expect(
        credentials.connect(owner).setAuditTrail(ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(credentials, "ZeroAddress");

      await expect(credentials.connect(owner).setAuditTrail(await trail.getAddress()))
        .to.emit(credentials, "AuditTrailUpdated")
        .withArgs(ZERO_ADDRESS, await trail.getAddress());
    });

    it("fails the whole action when the trail refuses the write", async () => {
      const fixture = await loadFixture(deployFixture);
      const { credentials, trail, owner, manager } = fixture;

      // Wire the trail but never allowlist the registry.
      await credentials.connect(owner).setAuditTrail(await trail.getAddress());

      await expect(
        credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0),
      ).to.be.revertedWithCustomError(trail, "NotTrustedCaller");

      // The credential was not issued: an unaudited action must not survive.
      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Unknown);
    });
  });

  describe("pause and upgradeability", () => {
    it("pause blocks issuance and revocation but not verification", async () => {
      const { credentials, owner, manager } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);

      await credentials.connect(owner).pause();

      await expect(
        credentials.connect(manager).issue(VC_HASH_2, ALICE_DID, SCHEMA_KYC, 0),
      ).to.be.revertedWithCustomError(credentials, "EnforcedPause");

      await expect(
        credentials.connect(manager).revoke(VC_HASH, REASON_SUPERSEDED),
      ).to.be.revertedWithCustomError(credentials, "EnforcedPause");

      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Valid);

      await credentials.connect(owner).unpause();
      await credentials.connect(manager).revoke(VC_HASH, REASON_SUPERSEDED);
      expect(await credentials.statusOf(VC_HASH)).to.equal(STATUS.Revoked);
    });

    it("only an ADMIN may pause", async () => {
      const { credentials, manager } = await loadFixture(deployFixture);

      await expect(credentials.connect(manager).pause())
        .to.be.revertedWithCustomError(credentials, "NotAdmin")
        .withArgs(manager.address);
    });

    it("rejects zero dependencies and refuses non-ADMIN upgrades", async () => {
      const { forwarderAddress, acl, did, credentials, manager, owner } =
        await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("CredentialRegistry");

      await expect(
        upgrades.deployProxy(
          factory,
          [ZERO_ADDRESS, await did.getAddress()],
          proxyOptionsFor(forwarderAddress),
        ),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      await expect(
        upgrades.deployProxy(
          factory,
          [await acl.getAddress(), ZERO_ADDRESS],
          proxyOptionsFor(forwarderAddress),
        ),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      const v2Factory = await ethers.getContractFactory("CredentialRegistryV2Mock");
      const v2 = await v2Factory.deploy(forwarderAddress);
      await v2.waitForDeployment();

      await expect(
        credentials.connect(manager).upgradeToAndCall(await v2.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(credentials, "NotAdmin");

      await expect(
        credentials.connect(owner).upgradeToAndCall(ZERO_ADDRESS, "0x"),
      ).to.be.revertedWithCustomError(credentials, "ZeroAddress");
    });

    it("preserves credentials across an upgrade", async () => {
      const { forwarderAddress, credentials, manager } = await loadFixture(deployFixture);
      await credentials.connect(manager).issue(VC_HASH, ALICE_DID, SCHEMA_KYC, 0);
      await credentials.connect(manager).revoke(VC_HASH, REASON_KEY_COMPROMISED);

      const v2Factory = await ethers.getContractFactory("CredentialRegistryV2Mock");
      const upgraded = await upgrades.upgradeProxy(await credentials.getAddress(), v2Factory, {
        call: { fn: "initializeV2", args: [] },
        // The V2 implementation takes the same immutable forwarder as V1, so the upgrade
        // must supply it too — an upgrade that dropped it would silently deploy an
        // implementation with no trusted forwarder and break actor attribution.
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["missing-initializer", "constructor", "state-variable-immutable"],
      });

      expect(await upgraded.version()).to.equal("2.0.0");
      expect(await upgraded.statusOf(VC_HASH)).to.equal(STATUS.Revoked);
      expect((await upgraded.credentialOf(VC_HASH)).revocationReason).to.equal(
        REASON_KEY_COMPROMISED,
      );
    });
  });
});
