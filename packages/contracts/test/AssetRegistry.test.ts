import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type {
  AssetRegistry,
  DIDRegistry,
  ReentrantReceiverMock,
  RoleAccessControl,
} from "../typechain-types";

const ZERO_ADDRESS = ethers.ZeroAddress;
const ADMIN_TRANSFER_DELAY = 3n * 24n * 60n * 60n;

const id = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

const ADMIN_ROLE = id("ADMIN_ROLE");
const MANAGER_ROLE = id("MANAGER_ROLE");
const AUDITOR_ROLE = id("AUDITOR_ROLE");
const USER_ROLE = id("USER_ROLE");
const PERM_MINT_ASSET = id("PERM_MINT_ASSET");

const ALICE_DID = id("did:trustchain:alice");
const BOB_DID = id("did:trustchain:bob");
const KEY = id("key-material");

const URI = "ipfs://bafkreiasseturi/metadata.json";
const URI_2 = "ipfs://bafkreiasseturi/second.json";

async function deployFixture() {
  const [owner, manager, alice, bob, auditor, outsider] = await ethers.getSigners();
  if (!owner || !manager || !alice || !bob || !auditor || !outsider) {
    throw new Error("expected at least six funded signers");
  }

  const aclFactory = await ethers.getContractFactory("RoleAccessControl");
  const acl = (await upgrades.deployProxy(aclFactory, [owner.address, ADMIN_TRANSFER_DELAY], {
    kind: "uups",
  })) as unknown as RoleAccessControl;
  await acl.waitForDeployment();

  const didFactory = await ethers.getContractFactory("DIDRegistry");
  const did = (await upgrades.deployProxy(didFactory, [owner.address], {
    kind: "uups",
  })) as unknown as DIDRegistry;
  await did.waitForDeployment();

  const assetFactory = await ethers.getContractFactory("AssetRegistry");
  const assets = (await upgrades.deployProxy(
    assetFactory,
    ["TrustChain Asset", "TCA", await acl.getAddress(), await did.getAddress()],
    { kind: "uups" },
  )) as unknown as AssetRegistry;
  await assets.waitForDeployment();

  await acl.connect(owner).grantRole(MANAGER_ROLE, manager.address);
  await acl.connect(owner).grantRole(AUDITOR_ROLE, auditor.address);
  await acl.connect(owner).grantRole(USER_ROLE, alice.address);

  await did.connect(alice).registerDID(ALICE_DID, KEY);
  await did.connect(bob).registerDID(BOB_DID, KEY);

  return { acl, did, assets, owner, manager, alice, bob, auditor, outsider };
}

describe("AssetRegistry", () => {
  describe("minting", () => {
    it("a MANAGER mints an asset allocated to an identity", async () => {
      const { assets, manager, alice } = await loadFixture(deployFixture);

      await expect(assets.connect(manager).mint(ALICE_DID, URI, false))
        .to.emit(assets, "AssetMinted")
        .withArgs(1n, ALICE_DID, alice.address, URI, false, manager.address);

      expect(await assets.ownerOf(1n)).to.equal(alice.address);
      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
      expect(await assets.tokenURI(1n)).to.equal(URI);
      expect(await assets.isSoulbound(1n)).to.equal(false);
      expect(await assets.totalMinted()).to.equal(1n);
    });

    it("an ADMIN may also mint", async () => {
      const { assets, owner } = await loadFixture(deployFixture);

      await expect(assets.connect(owner).mint(ALICE_DID, URI, false)).to.emit(
        assets,
        "AssetMinted",
      );
    });

    it("UNAUTHORIZED MINT: a USER, an AUDITOR and an outsider are all refused", async () => {
      const { assets, alice, auditor, outsider } = await loadFixture(deployFixture);

      for (const caller of [alice, auditor, outsider]) {
        await expect(assets.connect(caller).mint(ALICE_DID, URI, false))
          .to.be.revertedWithCustomError(assets, "NotPermitted")
          .withArgs(caller.address, PERM_MINT_ASSET);
      }

      expect(await assets.totalMinted()).to.equal(0n);
    });

    it("stops minting the moment MINT_ASSET is withdrawn from MANAGER", async () => {
      const { acl, assets, owner, manager } = await loadFixture(deployFixture);

      await assets.connect(manager).mint(ALICE_DID, URI, false);
      await acl.connect(owner).setRolePermission(MANAGER_ROLE, PERM_MINT_ASSET, false);

      await expect(
        assets.connect(manager).mint(ALICE_DID, URI_2, false),
      ).to.be.revertedWithCustomError(assets, "NotPermitted");
    });

    it("refuses unknown DIDs, inactive DIDs and an empty URI", async () => {
      const { assets, did, owner, manager } = await loadFixture(deployFixture);

      await expect(assets.connect(manager).mint(id("did:nobody"), URI, false))
        .to.be.revertedWithCustomError(assets, "UnknownDID")
        .withArgs(id("did:nobody"));

      await expect(
        assets.connect(manager).mint(ALICE_DID, "", false),
      ).to.be.revertedWithCustomError(assets, "EmptyTokenURI");

      await did.connect(owner).setDIDStatus(ALICE_DID, false);
      await expect(assets.connect(manager).mint(ALICE_DID, URI, false))
        .to.be.revertedWithCustomError(assets, "DIDNotActive")
        .withArgs(ALICE_DID);
    });

    it("issues sequential token ids", async () => {
      const { assets, manager } = await loadFixture(deployFixture);

      await assets.connect(manager).mint(ALICE_DID, URI, false);
      await assets.connect(manager).mint(BOB_DID, URI_2, false);

      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
      expect(await assets.ownerDIDOf(2n)).to.equal(BOB_DID);
      expect(await assets.totalMinted()).to.equal(2n);
    });
  });

  describe("DID binding across transfers", () => {
    it("rebinds ownerDID and emits AssetTransferred", async () => {
      const { assets, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await expect(assets.connect(alice).transferFrom(alice.address, bob.address, 1n))
        .to.emit(assets, "AssetTransferred")
        .withArgs(1n, ALICE_DID, BOB_DID, alice.address, bob.address);

      expect(await assets.ownerOf(1n)).to.equal(bob.address);
      expect(await assets.ownerDIDOf(1n)).to.equal(BOB_DID);
    });

    it("survives a chain of transfers with the binding always matching the holder", async () => {
      const { assets, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await assets.connect(alice).transferFrom(alice.address, bob.address, 1n);
      expect(await assets.ownerDIDOf(1n)).to.equal(BOB_DID);

      await assets.connect(bob).transferFrom(bob.address, alice.address, 1n);
      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
      expect(await assets.ownerOf(1n)).to.equal(alice.address);
    });

    it("refuses transfer to an address that controls no DID", async () => {
      const { assets, manager, alice, outsider } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await expect(assets.connect(alice).transferFrom(alice.address, outsider.address, 1n))
        .to.be.revertedWithCustomError(assets, "RecipientHasNoDID")
        .withArgs(outsider.address);

      expect(await assets.ownerOf(1n)).to.equal(alice.address);
      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
    });

    it("refuses transfer to a suspended identity", async () => {
      const { assets, did, owner, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await did.connect(owner).setDIDStatus(BOB_DID, false);

      await expect(assets.connect(alice).transferFrom(alice.address, bob.address, 1n))
        .to.be.revertedWithCustomError(assets, "DIDNotActive")
        .withArgs(BOB_DID);
    });
  });

  describe("soulbound assets", () => {
    it("cannot move between identities", async () => {
      const { assets, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, true);

      expect(await assets.isSoulbound(1n)).to.equal(true);

      await expect(assets.connect(alice).transferFrom(alice.address, bob.address, 1n))
        .to.be.revertedWithCustomError(assets, "SoulboundToken")
        .withArgs(1n);

      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
    });

    it("does not restrict ordinary assets minted alongside it", async () => {
      const { assets, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, true);
      await assets.connect(manager).mint(ALICE_DID, URI_2, false);

      await assets.connect(alice).transferFrom(alice.address, bob.address, 2n);
      expect(await assets.ownerDIDOf(2n)).to.equal(BOB_DID);
    });
  });

  describe("key rotation and reclaim", () => {
    it("assets follow the identity, not the key", async () => {
      const { assets, did, manager, alice, outsider } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      // Alice rotates to a new key; the old key still physically holds the token.
      await did.connect(alice).rotateControllerDirect(ALICE_DID, outsider.address);
      expect(await assets.ownerOf(1n)).to.equal(alice.address);
      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);

      await expect(assets.connect(outsider).reclaim(1n))
        .to.emit(assets, "AssetReclaimed")
        .withArgs(1n, ALICE_DID, alice.address, outsider.address);

      expect(await assets.ownerOf(1n)).to.equal(outsider.address);
      // The identity binding never changed — only the key holding it.
      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
    });

    it("a rotated-out key cannot move the asset to a third party", async () => {
      const { assets, did, manager, alice, bob, outsider } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await did.connect(alice).rotateControllerDirect(ALICE_DID, outsider.address);

      // This is the compromised-key case: the old key still holds the token but no
      // longer controls the identity, so it must not be able to sell it on.
      await expect(assets.connect(alice).transferFrom(alice.address, bob.address, 1n))
        .to.be.revertedWithCustomError(assets, "StaleHolder")
        .withArgs(alice.address, ALICE_DID);

      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
    });

    it("a soulbound credential is still reclaimable after rotation", async () => {
      const { assets, did, manager, alice, outsider } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, true);

      await did.connect(alice).rotateControllerDirect(ALICE_DID, outsider.address);

      await expect(assets.connect(outsider).reclaim(1n)).to.emit(assets, "AssetReclaimed");
      expect(await assets.ownerOf(1n)).to.equal(outsider.address);
    });

    it("refuses reclaim by a non-controller, when already held, and for unknown tokens", async () => {
      const { assets, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await expect(assets.connect(bob).reclaim(1n))
        .to.be.revertedWithCustomError(assets, "NotDIDController")
        .withArgs(bob.address, ALICE_DID);

      await expect(assets.connect(alice).reclaim(1n))
        .to.be.revertedWithCustomError(assets, "AlreadyHeldByController")
        .withArgs(1n);

      await expect(assets.connect(alice).reclaim(99n)).to.be.revertedWithCustomError(
        assets,
        "ERC721NonexistentToken",
      );
    });

    it("refuses reclaim while the identity is suspended", async () => {
      const { assets, did, owner, manager, alice, outsider } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await did.connect(alice).rotateControllerDirect(ALICE_DID, outsider.address);
      await did.connect(owner).setDIDStatus(ALICE_DID, false);

      await expect(assets.connect(outsider).reclaim(1n))
        .to.be.revertedWithCustomError(assets, "DIDNotActive")
        .withArgs(ALICE_DID);
    });
  });

  describe("reentrancy", () => {
    it("REENTRANCY PROBE: a malicious receiver cannot mint a second token mid-mint", async () => {
      const { acl, assets, did, owner, manager } = await loadFixture(deployFixture);

      const receiverFactory = await ethers.getContractFactory("ReentrantReceiverMock");
      const receiver = (await receiverFactory.deploy(
        await assets.getAddress(),
      )) as unknown as ReentrantReceiverMock;
      await receiver.waitForDeployment();
      const receiverAddress = await receiver.getAddress();

      const receiverDID = id("did:trustchain:receiver");
      await did.connect(owner).registerDIDFor(receiverDID, receiverAddress, KEY);

      // Give the attacker MINT_ASSET so the permission check cannot be what stops it —
      // the reentrancy guard is the only remaining defence.
      await acl.connect(owner).grantRole(MANAGER_ROLE, receiverAddress);
      expect(await acl.hasPermission(receiverAddress, PERM_MINT_ASSET)).to.equal(true);

      await receiver.arm(receiverDID, URI_2);
      await assets.connect(manager).mint(receiverDID, URI, false);

      expect(await receiver.attempted()).to.equal(true);
      expect(await receiver.attackSucceeded()).to.equal(false);
      expect(await assets.totalMinted()).to.equal(1n);
      expect(await assets.balanceOf(receiverAddress)).to.equal(1n);

      // Prove the REENTRANCY GUARD is what refused it — not a permission check or a
      // DID lookup, either of which would make this test pass for the wrong reason.
      const guardError = assets.interface.getError("ReentrancyGuardReentrantCall");
      expect(guardError, "guard error missing from ABI").to.not.equal(null);
      expect(await receiver.lastRevertData()).to.equal(guardError?.selector);
    });
  });

  describe("pause", () => {
    it("blocks minting and transfers, leaves reads working, and resumes on unpause", async () => {
      const { assets, owner, manager, alice, bob } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);

      await assets.connect(owner).pause();

      await expect(
        assets.connect(manager).mint(BOB_DID, URI_2, false),
      ).to.be.revertedWithCustomError(assets, "EnforcedPause");

      await expect(
        assets.connect(alice).transferFrom(alice.address, bob.address, 1n),
      ).to.be.revertedWithCustomError(assets, "EnforcedPause");

      // Reads remain available while paused.
      expect(await assets.ownerOf(1n)).to.equal(alice.address);
      expect(await assets.ownerDIDOf(1n)).to.equal(ALICE_DID);
      expect(await assets.tokenURI(1n)).to.equal(URI);

      await assets.connect(owner).unpause();
      await assets.connect(alice).transferFrom(alice.address, bob.address, 1n);
      expect(await assets.ownerDIDOf(1n)).to.equal(BOB_DID);
    });

    it("blocks reclaim while paused", async () => {
      const { assets, did, owner, manager, alice, outsider } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, false);
      await did.connect(alice).rotateControllerDirect(ALICE_DID, outsider.address);

      await assets.connect(owner).pause();

      await expect(assets.connect(outsider).reclaim(1n)).to.be.revertedWithCustomError(
        assets,
        "EnforcedPause",
      );
    });

    it("only an ADMIN can pause or unpause", async () => {
      const { assets, owner, manager, auditor } = await loadFixture(deployFixture);

      await expect(assets.connect(manager).pause())
        .to.be.revertedWithCustomError(assets, "NotAdmin")
        .withArgs(manager.address);

      await assets.connect(owner).pause();

      await expect(assets.connect(auditor).unpause())
        .to.be.revertedWithCustomError(assets, "NotAdmin")
        .withArgs(auditor.address);
    });
  });

  describe("initialisation and upgradeability", () => {
    it("rejects zero dependency addresses", async () => {
      const { acl, did } = await loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("AssetRegistry");

      await expect(
        upgrades.deployProxy(factory, ["n", "s", ZERO_ADDRESS, await did.getAddress()], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");

      await expect(
        upgrades.deployProxy(factory, ["n", "s", await acl.getAddress(), ZERO_ADDRESS], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("refuses an upgrade to the zero address", async () => {
      const { assets, owner } = await loadFixture(deployFixture);

      await expect(
        assets.connect(owner).upgradeToAndCall(ZERO_ADDRESS, "0x"),
      ).to.be.revertedWithCustomError(assets, "ZeroAddress");
    });

    it("exposes ERC-721 metadata and interface support", async () => {
      const { assets } = await loadFixture(deployFixture);

      expect(await assets.name()).to.equal("TrustChain Asset");
      expect(await assets.symbol()).to.equal("TCA");
      expect(await assets.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
      expect(await assets.supportsInterface("0x5b5e139f")).to.equal(true); // ERC721Metadata
    });

    it("preserves tokens and bindings across an upgrade", async () => {
      const { assets, manager, alice } = await loadFixture(deployFixture);
      await assets.connect(manager).mint(ALICE_DID, URI, true);

      const v2Factory = await ethers.getContractFactory("AssetRegistryV2Mock");
      const upgraded = await upgrades.upgradeProxy(await assets.getAddress(), v2Factory, {
        call: { fn: "initializeV2", args: [] },
        unsafeAllow: ["missing-initializer"],
      });

      expect(await upgraded.version()).to.equal("2.0.0");
      expect(await upgraded.ownerOf(1n)).to.equal(alice.address);
      expect(await upgraded.ownerDIDOf(1n)).to.equal(ALICE_DID);
      expect(await upgraded.isSoulbound(1n)).to.equal(true);
      expect(await upgraded.tokenURI(1n)).to.equal(URI);
    });

    it("refuses an upgrade from a non-ADMIN", async () => {
      const { assets, manager } = await loadFixture(deployFixture);

      const v2Factory = await ethers.getContractFactory("AssetRegistryV2Mock");
      const v2 = await v2Factory.deploy();
      await v2.waitForDeployment();

      await expect(
        assets.connect(manager).upgradeToAndCall(await v2.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(assets, "NotAdmin");
    });
  });
});
