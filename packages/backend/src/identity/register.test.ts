import { describe, expect, it } from "vitest";
import request from "supertest";
import { decodeFunctionData, keccak256, toHex, type Address } from "viem";

import { createServer } from "../server";
import { MemoryLogger } from "../http/logger";
import { didHashFor, keyCommitmentFor } from "./didHash";
import type { Caller } from "../http/authorize";

/**
 * Registering an identity in-product, which until now required an operator and a terminal.
 *
 * The interesting decision under test is *which* authority is checked. The platform's
 * permission matrix grants PERM_REGISTER_DID to MANAGER, but `registerDIDFor` is gated on
 * ADMIN_ROLE against the DIDRegistry's own AccessControl — a different register entirely.
 * Gating on the platform's answer would let a MANAGER sign a request, spend relayer gas and
 * receive a revert, so the route asks the contract that actually decides.
 */

const DEPLOYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const NEWCOMER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_DID = `0x${"0".repeat(64)}`;
const ADMIN_ROLE = keccak256(toHex("ADMIN_ROLE"));

const CONTRACTS = {
  RoleAccessControl: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  DIDRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  AssetRegistry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  CredentialRegistry: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  AuditTrail: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  TrustChainForwarder: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
} as const;

interface ChainState {
  /** Addresses the DIDRegistry considers its own admins. */
  admins?: readonly Address[];
  /** didHash -> controller, for identities that already exist. */
  controllers?: Record<string, string>;
  /** address -> didHash, for addresses that already hold one. */
  didOf?: Record<string, string>;
}

function fakeSelector(state: ChainState = {}) {
  const admins = (state.admins ?? [DEPLOYER]).map((a) => a.toLowerCase());

  return {
    active: async () => ({
      network: {
        id: "hardhat",
        label: "LOCAL HARDHAT",
        chainId: 31337,
        verifiability: "local" as const,
        verifiabilityLabel: "Local Development/Demo / Locally Verifiable",
        explorerUrl: null,
        isPrimary: false,
        isFallback: true,
      },
      contracts: CONTRACTS,
      client: {
        async readContract({ functionName, args }: { functionName: string; args: unknown[] }) {
          switch (functionName) {
            case "hasRole":
              return args[0] === ADMIN_ROLE && admins.includes(String(args[1]).toLowerCase());
            case "controllerOf":
              return state.controllers?.[String(args[0]).toLowerCase()] ?? ZERO_ADDRESS;
            case "didOf":
              return state.didOf?.[String(args[0]).toLowerCase()] ?? ZERO_DID;
            case "nonces":
              return 0n;
            default:
              throw new Error(`unexpected read: ${functionName}`);
          }
        },
      },
      relayer: {},
    }),
  };
}

function buildApp(caller: Caller | null, state: ChainState = {}) {
  const logger = new MemoryLogger();
  const app = createServer({
    logger,
    identity: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain: fakeSelector(state) as any,
      logger,
      resolveCaller: () => caller,
    },
  });
  return { app, logger };
}

const admin: Caller = { address: DEPLOYER, didHash: null, roles: ["ADMIN"] };
const manager: Caller = { address: MANAGER, didHash: `0x${"11".repeat(32)}`, roles: ["MANAGER"] };

describe("POST /identity/register", () => {
  it("prepares a registerDIDFor call the administrator signs themselves", async () => {
    const { app } = buildApp(admin);

    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });

    expect(res.status).toBe(200);
    expect(res.body.didHash).toBe(didHashFor(NEWCOMER, "hardhat"));
    expect(res.body.controller).toBe(NEWCOMER);

    // The call must name the newcomer as controller — not the administrator preparing it.
    // Registering an identity *to* the admin's own address would hand them the newcomer's
    // assets, silently, and look like onboarding.
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "registerDIDFor",
          stateMutability: "nonpayable",
          inputs: [
            { name: "didHash", type: "bytes32" },
            { name: "controller", type: "address" },
            { name: "keyCommitment", type: "bytes32" },
          ],
          outputs: [],
        },
      ] as const,
      data: res.body.typedData.message.data,
    });

    expect(decoded.functionName).toBe("registerDIDFor");
    expect(decoded.args[0]).toBe(didHashFor(NEWCOMER, "hardhat"));
    expect(decoded.args[1]).toBe(NEWCOMER);
    expect(decoded.args[2]).toBe(keyCommitmentFor(NEWCOMER));
  });

  it("signs as the administrator, so the contract's ADMIN_ROLE check is against them", async () => {
    const { app } = buildApp(admin);
    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });

    // Not the relayer. Under ERC-2771 the registry recovers `from` from the signature, and
    // that is what `onlyRole(ADMIN_ROLE)` is checked against.
    expect(res.body.typedData.message.from).toBe(DEPLOYER);
    expect(res.body.typedData.message.to).toBe(CONTRACTS.DIDRegistry);
  });

  it("nothing is submitted — 200 with a document to sign, not 202", async () => {
    const { app } = buildApp(admin);
    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });

    expect(res.status).toBe(200);
    expect(res.body.typedData).toBeDefined();
  });
});

describe("POST /identity/register — refusals", () => {
  it("refuses without a session", async () => {
    const { app } = buildApp(null);
    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });
    expect(res.status).toBe(401);
  });

  it("refuses a MANAGER, whom the contract would refuse too", async () => {
    // The platform grants this account PERM_REGISTER_DID. The DIDRegistry does not care:
    // it wants ADMIN_ROLE on itself. Passing them through would spend gas to learn that.
    const { app, logger } = buildApp(manager);

    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(logger.find("security.identity_register_refused")).toBeDefined();
  });

  it("refuses when the identity hash is already registered", async () => {
    const taken = didHashFor(NEWCOMER, "hardhat").toLowerCase();
    const { app } = buildApp(admin, { controllers: { [taken]: NEWCOMER } });

    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("identity_already_registered");
  });

  it("refuses when the address already controls a different identity", async () => {
    // Distinct from the case above: the hash is free but the address is spoken for, which
    // is what a re-registration under a new scope would look like. The contract refuses
    // both; an administrator needs to know which one they hit.
    const { app } = buildApp(admin, {
      didOf: { [NEWCOMER.toLowerCase()]: `0x${"cd".repeat(32)}` },
    });

    const res = await request(app).post("/identity/register").send({ address: NEWCOMER });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("address_already_has_identity");
  });

  it("rejects a malformed address before it reaches a contract call", async () => {
    const { app } = buildApp(admin);
    const res = await request(app).post("/identity/register").send({ address: "not-an-address" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects unknown fields rather than ignoring them", async () => {
    const { app } = buildApp(admin);
    const res = await request(app)
      .post("/identity/register")
      .send({ address: NEWCOMER, role: "ADMIN" });

    // A `role` field here would read as "register and grant", which this endpoint does not
    // do. Accepting and dropping it would be the worst of both.
    expect(res.status).toBe(400);
  });
});
