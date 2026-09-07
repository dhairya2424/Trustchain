import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type {
  AssetRegistry,
  AuditTrail,
  DIDRegistry,
  RoleAccessControl,
  TrustChainForwarder,
} from "../typechain-types";

/**
 * Actor attribution: who ASKED, kept apart from who EXECUTED.
 *
 * Transactions reach the chain through a relayer, so without a forwarder every audit entry
 * would name that relayer and the ledger could never answer "which administrator minted
 * this?" — the question the problem statement actually asks of an audit trail.
 *
 * Adding an `actor` argument alone would not fix it. The relayer builds its own calldata,
 * so an unverified `actor` parameter is the relayer's claim written on-chain and dressed as
 * a fact. These tests exist to prove the claim is verified: the actor is recovered from the
 * actor's OWN EIP-712 signature, and a relayer that tries to assert someone else fails.
 */

const ADMIN_TRANSFER_DELAY = 3 * 24 * 60 * 60;
const MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
const USER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("USER_ROLE"));
const ALICE_DID = ethers.keccak256(ethers.toUtf8Bytes("did:alice"));
const MANAGER_DID = ethers.keccak256(ethers.toUtf8Bytes("did:manager"));
const KEY = ethers.keccak256(ethers.toUtf8Bytes("key"));
const ACTION_ASSET_MINTED = 8;

const proxyOptionsFor = (forwarder: string) =>
  ({
    kind: "uups" as const,
    constructorArgs: [forwarder],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  }) as never;

async function deployFixture() {
  const [owner, manager, alice, relayer, attacker] = await ethers.getSigners();

  const forwarder = (await (
    await ethers.getContractFactory("TrustChainForwarder")
  ).deploy("TrustChainForwarder")) as unknown as TrustChainForwarder;
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();

  const acl = (await upgrades.deployProxy(
    await ethers.getContractFactory("RoleAccessControl"),
    [owner!.address, ADMIN_TRANSFER_DELAY],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as RoleAccessControl;

  const did = (await upgrades.deployProxy(
    await ethers.getContractFactory("DIDRegistry"),
    [owner!.address],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as DIDRegistry;

  const assets = (await upgrades.deployProxy(
    await ethers.getContractFactory("AssetRegistry"),
    ["TrustChain Asset", "TCA", await acl.getAddress(), await did.getAddress()],
    proxyOptionsFor(forwarderAddress),
  )) as unknown as AssetRegistry;

  const trail = (await (
    await ethers.getContractFactory("AuditTrail")
  ).deploy(await acl.getAddress())) as unknown as AuditTrail;
  await trail.waitForDeployment();

  await acl.connect(owner!).setDIDRegistry(await did.getAddress());
  await trail.connect(owner!).setTrustedCaller(await assets.getAddress(), true);
  await assets.connect(owner!).setAuditTrail(await trail.getAddress());

  await did.connect(manager!).registerDID(MANAGER_DID, KEY);
  await did.connect(alice!).registerDID(ALICE_DID, KEY);
  await acl.connect(owner!).grantRole(MANAGER_ROLE, manager!.address);
  await acl.connect(owner!).grantRole(USER_ROLE, alice!.address);

  return {
    forwarder,
    forwarderAddress,
    acl,
    did,
    assets,
    trail,
    owner,
    manager,
    alice,
    relayer,
    attacker,
  };
}

/**
 * Builds and signs an ERC-2771 forward request.
 *
 * `signer` is the ACTOR — the identity whose authority the action is taken under. The
 * relayer submits the result but never signs it, which is the entire security property.
 */
async function signRequest(
  forwarder: TrustChainForwarder,
  signer: HardhatEthersSigner,
  to: string,
  data: string,
) {
  const nonce = await forwarder.nonces(signer.address);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const { chainId } = await ethers.provider.getNetwork();

  const request = {
    from: signer.address,
    to,
    value: 0n,
    gas: 1_000_000n,
    nonce,
    deadline,
    data,
  };

  const signature = await signer.signTypedData(
    {
      name: "TrustChainForwarder",
      version: "1",
      chainId,
      verifyingContract: await forwarder.getAddress(),
    },
    {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    },
    request,
  );

  // `nonce` is signed but not resubmitted: the forwarder reads it from storage.
  const { nonce: _nonce, ...rest } = request;
  return { ...rest, signature };
}

describe("actor attribution", () => {
  describe("the actor is the signer, not the submitter", () => {
    it("records the requesting identity, not the relayer that paid for gas", async () => {
      const { forwarder, assets, trail, manager, relayer } = await loadFixture(deployFixture);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://x", false]);
      const request = await signRequest(forwarder, manager!, await assets.getAddress(), data);

      // The RELAYER submits. The MANAGER signed.
      await forwarder.connect(relayer!).execute(request);

      const entry = await trail.entryAt(0n);
      expect(entry.actionCode).to.equal(ACTION_ASSET_MINTED);
      expect(entry.actor).to.equal(manager!.address);
      expect(entry.actor).to.not.equal(relayer!.address);
    });

    it("keeps actor, writing contract and executor as three distinct facts", async () => {
      const { forwarder, assets, trail, manager, relayer } = await loadFixture(deployFixture);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://x", false]);
      const tx = await forwarder
        .connect(relayer!)
        .execute(await signRequest(forwarder, manager!, await assets.getAddress(), data));
      const receipt = await tx.wait();

      const entry = await trail.entryAt(0n);

      // who asked
      expect(entry.actor).to.equal(manager!.address);
      // which contract wrote the row
      expect(entry.caller).to.equal(await assets.getAddress());
      // who executed — recorded by the chain itself, never taken from calldata
      expect(receipt!.from).to.equal(relayer!.address);
    });

    it("emits the actor in the event, so an indexer can filter by requester", async () => {
      const { forwarder, assets, manager, relayer, trail } = await loadFixture(deployFixture);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://y", false]);

      await expect(
        forwarder
          .connect(relayer!)
          .execute(await signRequest(forwarder, manager!, await assets.getAddress(), data)),
      )
        .to.emit(trail, "ActionLogged")
        .withArgs(
          0n,
          ALICE_DID,
          ACTION_ASSET_MINTED,
          manager!.address,
          ...new Array(3).fill(anyValueMatcher),
        );
    });
  });

  describe("a relayer cannot spoof an actor", () => {
    /**
     * The property the whole design exists for. The attacker holds no role, so it forges a
     * request claiming to be the manager. It cannot produce the manager's signature, so the
     * forwarder refuses before any system contract is reached.
     */
    it("refuses a request the claimed actor did not sign", async () => {
      const { forwarder, assets, manager, attacker, relayer } = await loadFixture(deployFixture);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://evil", false]);

      // The attacker signs, then rewrites `from` to name the manager.
      const forged = await signRequest(forwarder, attacker!, await assets.getAddress(), data);
      const spoofed = { ...forged, from: manager!.address };

      await expect(forwarder.connect(relayer!).execute(spoofed)).to.be.revertedWithCustomError(
        forwarder,
        "ERC2771ForwarderInvalidSigner",
      );
    });

    it("refuses a request whose calldata was altered after signing", async () => {
      const { forwarder, assets, manager, relayer } = await loadFixture(deployFixture);

      const signed = await signRequest(
        forwarder,
        manager!,
        await assets.getAddress(),
        assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://agreed", false]),
      );

      // The relayer keeps the signature but mints a different token URI.
      const tampered = {
        ...signed,
        data: assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://swapped", false]),
      };

      await expect(forwarder.connect(relayer!).execute(tampered)).to.be.revertedWithCustomError(
        forwarder,
        "ERC2771ForwarderInvalidSigner",
      );
    });

    it("refuses a replayed request", async () => {
      const { forwarder, assets, manager, relayer } = await loadFixture(deployFixture);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://once", false]);
      const request = await signRequest(forwarder, manager!, await assets.getAddress(), data);

      await forwarder.connect(relayer!).execute(request);

      // The nonce is inside the signed payload, so the second attempt cannot verify.
      await expect(forwarder.connect(relayer!).execute(request)).to.be.revertedWithCustomError(
        forwarder,
        "ERC2771ForwarderInvalidSigner",
      );
    });

    it("refuses a request after its deadline", async () => {
      const { forwarder, assets, manager, relayer } = await loadFixture(deployFixture);

      const nonce = await forwarder.nonces(manager!.address);
      const { chainId } = await ethers.provider.getNetwork();
      const deadline = Math.floor(Date.now() / 1000) - 60;
      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://late", false]);

      const request = {
        from: manager!.address,
        to: await assets.getAddress(),
        value: 0n,
        gas: 1_000_000n,
        nonce,
        deadline,
        data,
      };

      const signature = await manager!.signTypedData(
        {
          name: "TrustChainForwarder",
          version: "1",
          chainId,
          verifyingContract: await forwarder.getAddress(),
        },
        {
          ForwardRequest: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "gas", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint48" },
            { name: "data", type: "bytes" },
          ],
        },
        request,
      );

      const { nonce: _n, ...rest } = request;
      await expect(
        forwarder.connect(relayer!).execute({ ...rest, signature }),
      ).to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderExpiredRequest");
    });
  });

  describe("authorization follows the actor, not the relayer", () => {
    /**
     * The confused deputy, closed at the contract level.
     *
     * Before ERC-2771 the permission check saw the relayer, which necessarily holds the
     * permission or it could not relay anything — so any authenticated caller inherited it.
     * Now the check sees the signer, and a USER signing a mint is refused by the contract
     * itself.
     */
    it("refuses a mint signed by an identity without MINT_ASSET", async () => {
      const { forwarder, assets, alice, relayer } = await loadFixture(deployFixture);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://nope", false]);
      const request = await signRequest(forwarder, alice!, await assets.getAddress(), data);

      // The forwarder relays; the target rejects. ERC2771Forwarder surfaces the inner
      // revert, so the call does not succeed.
      await expect(forwarder.connect(relayer!).execute(request)).to.be.reverted;
    });

    /**
     * A compromised relayer is now a much smaller problem: it can decline to forward, but
     * it cannot mint, because it holds nothing. Previously it needed MINT_ASSET itself.
     */
    it("does not require the relayer to hold any platform role", async () => {
      const { acl, relayer, forwarder, assets, alice, manager, trail } =
        await loadFixture(deployFixture);

      // The relayer is an ordinary funded account with no role at all.
      expect(await acl.rolesOf(relayer!.address)).to.deep.equal([]);

      const data = assets.interface.encodeFunctionData("mint", [ALICE_DID, "ipfs://ok", false]);
      await forwarder
        .connect(relayer!)
        .execute(await signRequest(forwarder, manager!, await assets.getAddress(), data));

      // The mint succeeded on the manager's authority, and the asset belongs to Alice.
      expect(await assets.balanceOf(alice!.address)).to.equal(1n);
      expect((await trail.entryAt(0n)).actor).to.equal(manager!.address);
    });
  });

  describe("the trail refuses an unattributable entry", () => {
    it("rejects a zero actor", async () => {
      const { trail, owner, relayer } = await loadFixture(deployFixture);
      await trail.connect(owner!).setTrustedCaller(relayer!.address, true);

      await expect(
        trail.connect(relayer!).logAction(ALICE_DID, ACTION_ASSET_MINTED, KEY, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(trail, "InvalidActor");
    });
  });
});

/** Placeholder matcher for event fields this test does not constrain. */
const anyValueMatcher = () => true;
