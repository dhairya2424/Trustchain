import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { DIDRegistry } from "../typechain-types";

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;

const didHashOf = (did: string) => ethers.keccak256(ethers.toUtf8Bytes(did));
const commitmentOf = (secret: string) => ethers.keccak256(ethers.toUtf8Bytes(secret));

const ALICE_DID = didHashOf("did:trustchain:alice");
const BOB_DID = didHashOf("did:trustchain:bob");
const ALICE_KEY = commitmentOf("alice-key-material");

const ROTATION_TYPES = {
  ControllerRotation: [
    { name: "didHash", type: "bytes32" },
    { name: "newController", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

async function deployFixture() {
  const [admin, alice, bob, carol, relayer] = await ethers.getSigners();
  if (!admin || !alice || !bob || !carol || !relayer) {
    throw new Error("expected at least five funded signers");
  }

  const factory = await ethers.getContractFactory("DIDRegistry");
  const registry = (await upgrades.deployProxy(factory, [admin.address], {
    kind: "uups",
  })) as unknown as DIDRegistry;
  await registry.waitForDeployment();

  return { registry, admin, alice, bob, carol, relayer };
}

async function signRotation(
  registry: DIDRegistry,
  signer: HardhatEthersSigner,
  params: { didHash: string; newController: string; nonce: bigint; deadline: bigint },
) {
  const domain = {
    name: "TrustChainDIDRegistry",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await registry.getAddress(),
  };

  return signer.signTypedData(domain, ROTATION_TYPES as never, params);
}

async function futureDeadline(seconds = 3600): Promise<bigint> {
  return BigInt((await time.latest()) + seconds);
}

describe("DIDRegistry", () => {
  describe("initialisation", () => {
    it("grants the deployer admin roles and starts unpaused", async () => {
      const { registry, admin } = await loadFixture(deployFixture);

      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(
        true,
      );
      expect(await registry.hasRole(await registry.ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await registry.paused()).to.equal(false);
    });

    it("cannot be initialised twice", async () => {
      const { registry, alice } = await loadFixture(deployFixture);

      await expect(registry.initialize(alice.address)).to.be.revertedWithCustomError(
        registry,
        "InvalidInitialization",
      );
    });

    it("rejects a zero admin", async () => {
      const factory = await ethers.getContractFactory("DIDRegistry");

      await expect(
        upgrades.deployProxy(factory, [ZERO_ADDRESS], { kind: "uups" }),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("leaves the implementation contract uninitialisable", async () => {
      const { registry, alice } = await loadFixture(deployFixture);
      const implAddress = await upgrades.erc1967.getImplementationAddress(
        await registry.getAddress(),
      );
      const implementation = await ethers.getContractAt("DIDRegistry", implAddress);

      await expect(implementation.initialize(alice.address)).to.be.revertedWithCustomError(
        implementation,
        "InvalidInitialization",
      );
    });
  });

  describe("registration", () => {
    it("registers a DID for the caller and emits an event", async () => {
      const { registry, alice } = await loadFixture(deployFixture);

      // The timestamp is asserted as "some value" rather than a predicted one:
      // predicting the next block's timestamp is flaky under slower runs such as
      // coverage instrumentation. createdAt is checked for sanity below.
      await expect(registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY))
        .to.emit(registry, "DIDRegistered")
        .withArgs(ALICE_DID, alice.address, ALICE_KEY, alice.address, anyValue);

      const record = await registry.recordOf(ALICE_DID);
      expect(record.controller).to.equal(alice.address);
      expect(record.keyCommitment).to.equal(ALICE_KEY);
      expect(record.rotationNonce).to.equal(0n);
      expect(record.active).to.equal(true);
      expect(record.createdAt).to.be.greaterThan(0n);
    });

    it("resolves both directions", async () => {
      const { registry, alice } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      expect(await registry.controllerOf(ALICE_DID)).to.equal(alice.address);
      expect(await registry.didOf(alice.address)).to.equal(ALICE_DID);
      expect(await registry.exists(ALICE_DID)).to.equal(true);
      expect(await registry.isActive(ALICE_DID)).to.equal(true);
    });

    it("rejects a duplicate DID hash", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      await expect(registry.connect(bob).registerDID(ALICE_DID, ALICE_KEY))
        .to.be.revertedWithCustomError(registry, "DIDAlreadyRegistered")
        .withArgs(ALICE_DID);
    });

    it("rejects a second DID for the same controller", async () => {
      const { registry, alice } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      await expect(registry.connect(alice).registerDID(BOB_DID, ALICE_KEY))
        .to.be.revertedWithCustomError(registry, "ControllerAlreadyHasDID")
        .withArgs(alice.address);
    });

    it("rejects a zero DID hash or key commitment", async () => {
      const { registry, alice } = await loadFixture(deployFixture);

      await expect(
        registry.connect(alice).registerDID(ZERO_BYTES32, ALICE_KEY),
      ).to.be.revertedWithCustomError(registry, "InvalidDIDHash");

      await expect(
        registry.connect(alice).registerDID(ALICE_DID, ZERO_BYTES32),
      ).to.be.revertedWithCustomError(registry, "InvalidKeyCommitment");
    });

    it("lets an admin enrol a member who holds no gas", async () => {
      const { registry, admin, alice } = await loadFixture(deployFixture);

      await expect(registry.connect(admin).registerDIDFor(ALICE_DID, alice.address, ALICE_KEY))
        .to.emit(registry, "DIDRegistered")
        .withArgs(ALICE_DID, alice.address, ALICE_KEY, admin.address, anyValue);

      // Control rests with the member, not the enrolling admin.
      expect(await registry.controllerOf(ALICE_DID)).to.equal(alice.address);
    });

    it("refuses admin enrolment from a non-admin", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);

      await expect(
        registry.connect(alice).registerDIDFor(BOB_DID, bob.address, ALICE_KEY),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("rejects a zero controller in admin enrolment", async () => {
      const { registry, admin } = await loadFixture(deployFixture);

      await expect(
        registry.connect(admin).registerDIDFor(ALICE_DID, ZERO_ADDRESS, ALICE_KEY),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts recordOf for an unknown DID", async () => {
      const { registry } = await loadFixture(deployFixture);

      await expect(registry.recordOf(ALICE_DID))
        .to.be.revertedWithCustomError(registry, "DIDNotFound")
        .withArgs(ALICE_DID);
    });
  });

  describe("controller rotation by signature", () => {
    it("rotates to a new controller when the current one authorises it", async () => {
      const { registry, alice, bob, relayer } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      // Submitted by a relayer: authority comes from the signature, not msg.sender.
      await expect(
        registry.connect(relayer).rotateController(ALICE_DID, bob.address, 0n, deadline, signature),
      )
        .to.emit(registry, "ControllerRotated")
        .withArgs(ALICE_DID, alice.address, bob.address, 0n, true);

      expect(await registry.controllerOf(ALICE_DID)).to.equal(bob.address);
      expect(await registry.didOf(bob.address)).to.equal(ALICE_DID);
      expect(await registry.didOf(alice.address)).to.equal(ZERO_BYTES32);
      expect(await registry.rotationNonceOf(ALICE_DID)).to.equal(1n);
    });

    it("REPLAY: a captured rotation signature cannot be reused", async () => {
      const { registry, alice, bob, carol, relayer } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      await registry
        .connect(relayer)
        .rotateController(ALICE_DID, bob.address, 0n, deadline, signature);

      // Bob hands control back to Alice, restoring the exact pre-replay state.
      await registry.connect(bob).rotateControllerDirect(ALICE_DID, alice.address);
      expect(await registry.controllerOf(ALICE_DID)).to.equal(alice.address);

      // The original signature is still perfectly valid cryptographically —
      // only the consumed nonce stops it.
      await expect(
        registry.connect(carol).rotateController(ALICE_DID, bob.address, 0n, deadline, signature),
      )
        .to.be.revertedWithCustomError(registry, "InvalidNonce")
        .withArgs(2n, 0n);

      expect(await registry.controllerOf(ALICE_DID)).to.equal(alice.address);
    });

    it("rejects a signature from anyone but the current controller", async () => {
      const { registry, alice, bob, carol } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const forged = await signRotation(registry, carol, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      await expect(
        registry.rotateController(ALICE_DID, bob.address, 0n, deadline, forged),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects an expired authorisation", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline(60);
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      await time.increaseTo(deadline + 1n);

      await expect(
        registry.rotateController(ALICE_DID, bob.address, 0n, deadline, signature),
      ).to.be.revertedWithCustomError(registry, "SignatureExpired");
    });

    it("rejects a signature bound to a different DID", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);
      await registry.connect(bob).registerDID(BOB_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const forOtherDid = await signRotation(registry, alice, {
        didHash: BOB_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      await expect(
        registry.rotateController(ALICE_DID, bob.address, 0n, deadline, forOtherDid),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a nonce that does not match the DID's current value", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 5n,
        deadline,
      });

      await expect(registry.rotateController(ALICE_DID, bob.address, 5n, deadline, signature))
        .to.be.revertedWithCustomError(registry, "InvalidNonce")
        .withArgs(0n, 5n);
    });

    it("accepts an ERC-1271 signature so a contract wallet can control a DID", async () => {
      const { registry, alice, bob, relayer } = await loadFixture(deployFixture);

      const walletFactory = await ethers.getContractFactory("ERC1271WalletMock");
      const wallet = await walletFactory.deploy(alice.address);
      await wallet.waitForDeployment();
      const walletAddress = await wallet.getAddress();

      await registry.registerDIDFor(ALICE_DID, walletAddress, ALICE_KEY);

      const deadline = await futureDeadline();
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      await expect(
        registry.connect(relayer).rotateController(ALICE_DID, bob.address, 0n, deadline, signature),
      ).to.emit(registry, "ControllerRotated");

      expect(await registry.controllerOf(ALICE_DID)).to.equal(bob.address);
    });

    it("exposes the digest a client must sign", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const digest = await registry.rotationDigest(ALICE_DID, bob.address, 0n, deadline);
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      expect(ethers.recoverAddress(digest, signature)).to.equal(alice.address);
    });
  });

  describe("controller rotation, direct", () => {
    it("lets the controller rotate without a signature", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      await expect(registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address))
        .to.emit(registry, "ControllerRotated")
        .withArgs(ALICE_DID, alice.address, bob.address, 0n, false);

      expect(await registry.rotationNonceOf(ALICE_DID)).to.equal(1n);
    });

    it("a direct rotation neutralises an already-issued signature", async () => {
      const { registry, alice, bob, carol } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const leaked = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: carol.address,
        nonce: 0n,
        deadline,
      });

      // Alice suspects the signature leaked and burns the nonce.
      await registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address);

      await expect(
        registry.rotateController(ALICE_DID, carol.address, 0n, deadline, leaked),
      ).to.be.revertedWithCustomError(registry, "InvalidNonce");
    });

    it("refuses rotation from a non-controller", async () => {
      const { registry, alice, bob, carol } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      await expect(registry.connect(carol).rotateControllerDirect(ALICE_DID, bob.address))
        .to.be.revertedWithCustomError(registry, "NotController")
        .withArgs(carol.address, alice.address);
    });

    it("refuses rotation to the zero address, the same controller, or an address that already holds a DID", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);
      await registry.connect(bob).registerDID(BOB_DID, ALICE_KEY);

      await expect(
        registry.connect(alice).rotateControllerDirect(ALICE_DID, ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");

      await expect(
        registry.connect(alice).rotateControllerDirect(ALICE_DID, alice.address),
      ).to.be.revertedWithCustomError(registry, "ControllerUnchanged");

      await expect(registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address))
        .to.be.revertedWithCustomError(registry, "ControllerAlreadyHasDID")
        .withArgs(bob.address);
    });
  });

  describe("key commitment rotation", () => {
    it("replaces the commitment and emits both values", async () => {
      const { registry, alice } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const newKey = commitmentOf("alice-rotated-key");

      await expect(registry.connect(alice).rotateKeyCommitment(ALICE_DID, newKey))
        .to.emit(registry, "KeyCommitmentRotated")
        .withArgs(ALICE_DID, ALICE_KEY, newKey);

      expect(await registry.keyCommitmentOf(ALICE_DID)).to.equal(newKey);
    });

    it("refuses a zero commitment or a non-controller caller", async () => {
      const { registry, alice, carol } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      await expect(
        registry.connect(alice).rotateKeyCommitment(ALICE_DID, ZERO_BYTES32),
      ).to.be.revertedWithCustomError(registry, "InvalidKeyCommitment");

      await expect(
        registry.connect(carol).rotateKeyCommitment(ALICE_DID, commitmentOf("x")),
      ).to.be.revertedWithCustomError(registry, "NotController");
    });
  });

  describe("status", () => {
    it("an admin can suspend and restore a DID", async () => {
      const { registry, admin, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      await expect(registry.connect(admin).setDIDStatus(ALICE_DID, false))
        .to.emit(registry, "DIDStatusChanged")
        .withArgs(ALICE_DID, false, admin.address);

      expect(await registry.isActive(ALICE_DID)).to.equal(false);

      await expect(registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address))
        .to.be.revertedWithCustomError(registry, "DIDNotActive")
        .withArgs(ALICE_DID);

      await registry.connect(admin).setDIDStatus(ALICE_DID, true);
      await expect(registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address)).to.emit(
        registry,
        "ControllerRotated",
      );
    });

    it("refuses status changes from a non-admin and for unknown DIDs", async () => {
      const { registry, admin, alice } = await loadFixture(deployFixture);

      await expect(
        registry.connect(alice).setDIDStatus(ALICE_DID, false),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      await expect(registry.connect(admin).setDIDStatus(ALICE_DID, false))
        .to.be.revertedWithCustomError(registry, "DIDNotFound")
        .withArgs(ALICE_DID);
    });
  });

  describe("pause", () => {
    it("blocks every mutation while paused and resumes after unpause", async () => {
      const { registry, admin, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline();
      const signature = await signRotation(registry, alice, {
        didHash: ALICE_DID,
        newController: bob.address,
        nonce: 0n,
        deadline,
      });

      await registry.connect(admin).pause();

      await expect(
        registry.connect(bob).registerDID(BOB_DID, ALICE_KEY),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await expect(
        registry.registerDIDFor(BOB_DID, bob.address, ALICE_KEY),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await expect(
        registry.rotateController(ALICE_DID, bob.address, 0n, deadline, signature),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await expect(
        registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await expect(
        registry.connect(alice).rotateKeyCommitment(ALICE_DID, commitmentOf("y")),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      // Reads stay available while paused.
      expect(await registry.controllerOf(ALICE_DID)).to.equal(alice.address);

      await registry.connect(admin).unpause();
      await expect(registry.connect(bob).registerDID(BOB_DID, ALICE_KEY)).to.emit(
        registry,
        "DIDRegistered",
      );
    });

    it("only an admin can pause or unpause", async () => {
      const { registry, admin, alice } = await loadFixture(deployFixture);

      await expect(registry.connect(alice).pause()).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );

      await registry.connect(admin).pause();

      await expect(registry.connect(alice).unpause()).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("upgradeability", () => {
    it("preserves state across an authorised upgrade", async () => {
      const { registry, alice } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const v2Factory = await ethers.getContractFactory("DIDRegistryV2Mock");
      // `missing-initializer` is suppressed deliberately: a V2 in the same lineage
      // must NOT re-run its parents' initializers, which is exactly what the
      // validator's heuristic looks for. State migration goes in initializeV2.
      const upgraded = await upgrades.upgradeProxy(await registry.getAddress(), v2Factory, {
        call: { fn: "initializeV2", args: [] },
        unsafeAllow: ["missing-initializer"],
      });

      expect(await upgraded.version()).to.equal("2.0.0");
      expect(await upgraded.controllerOf(ALICE_DID)).to.equal(alice.address);
      expect(await upgraded.keyCommitmentOf(ALICE_DID)).to.equal(ALICE_KEY);
    });

    it("refuses an upgrade to the zero address", async () => {
      const { registry, admin } = await loadFixture(deployFixture);

      await expect(
        registry.connect(admin).upgradeToAndCall(ZERO_ADDRESS, "0x"),
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("refuses an upgrade from an account without DEFAULT_ADMIN_ROLE", async () => {
      const { registry, alice } = await loadFixture(deployFixture);

      const v2Factory = await ethers.getContractFactory("DIDRegistryV2Mock");
      const v2 = await v2Factory.deploy();
      await v2.waitForDeployment();

      await expect(
        registry.connect(alice).upgradeToAndCall(await v2.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  // Randomised property testing. Foundry is not installed in this environment, so
  // the invariants the plan assigns to `forge test --fuzz-runs` are exercised here
  // instead; test/foundry/DIDRegistry.t.sol holds the Foundry equivalents.
  describe("fuzz", () => {
    const RUNS = 64;

    it("any distinct (didHash, controller) pair registers and resolves both ways", async () => {
      const { registry } = await loadFixture(deployFixture);

      for (let i = 0; i < RUNS; i++) {
        const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
        const didHash = ethers.hexlify(ethers.randomBytes(32));
        const keyCommitment = ethers.hexlify(ethers.randomBytes(32));

        await registry.registerDIDFor(didHash, wallet.address, keyCommitment);

        expect(await registry.controllerOf(didHash)).to.equal(wallet.address);
        expect(await registry.didOf(wallet.address)).to.equal(didHash);
        expect(await registry.rotationNonceOf(didHash)).to.equal(0n);
      }
    });

    it("the nonce is strictly monotonic across arbitrary rotation chains", async () => {
      const { registry, alice } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      let current = alice;
      let previousNonce = await registry.rotationNonceOf(ALICE_DID);

      for (let i = 0; i < 24; i++) {
        const next = ethers.Wallet.createRandom().connect(ethers.provider);
        await ethers.provider.send("hardhat_setBalance", [next.address, "0x56BC75E2D63100000"]);

        await registry.connect(current).rotateControllerDirect(ALICE_DID, next.address);

        const nonce = await registry.rotationNonceOf(ALICE_DID);
        expect(nonce).to.equal(previousNonce + 1n);
        expect(await registry.controllerOf(ALICE_DID)).to.equal(next.address);
        expect(await registry.didOf(next.address)).to.equal(ALICE_DID);

        previousNonce = nonce;
        current = next as unknown as HardhatEthersSigner;
      }
    });

    it("no signature with a stale nonce is ever accepted", async () => {
      const { registry, alice, bob } = await loadFixture(deployFixture);
      await registry.connect(alice).registerDID(ALICE_DID, ALICE_KEY);

      const deadline = await futureDeadline(86_400);
      const staleSignatures: string[] = [];

      // Collect signatures at nonce 0, then advance the nonce past them.
      for (let i = 0; i < 8; i++) {
        staleSignatures.push(
          await signRotation(registry, alice, {
            didHash: ALICE_DID,
            newController: bob.address,
            nonce: BigInt(i),
            deadline,
          }),
        );
      }

      await registry.connect(alice).rotateControllerDirect(ALICE_DID, bob.address);
      const currentNonce = await registry.rotationNonceOf(ALICE_DID);

      for (const [index, signature] of staleSignatures.entries()) {
        if (BigInt(index) === currentNonce) continue;
        await expect(
          registry.rotateController(ALICE_DID, bob.address, BigInt(index), deadline, signature),
        ).to.be.revertedWithCustomError(registry, "InvalidNonce");
      }
    });
  });
});
