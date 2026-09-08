import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { decodeFunctionData, keccak256, toBytes, type Address } from "viem";

import { createServer } from "../server";
import { encodeGrantRoleToDID, encodeRevokeRoleFromDID } from "../chain/forwarding";
import { ROLE_IDS } from "../auth/roles";
import { MemoryLogger } from "../http/logger";
import type { Caller } from "../http/authorize";
import type { PermissionName } from "../auth/roles";
import type { IdentitySnapshot } from "../auth/roleReader";

/**
 * Role administration is the most consequential write in the platform — it is how someone
 * becomes able to make every other write. So most of what follows is about refusal.
 */

const ADMIN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const DID_HASH = keccak256(toBytes("did:trustchain:alice"));

const CONTRACTS = {
  RoleAccessControl: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  DIDRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  AssetRegistry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  CredentialRegistry: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  AuditTrail: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  TrustChainForwarder: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
} as const;

/** A selector stub: one network, deterministic addresses, no chain. */
function fakeSelector(overrides: { forwarderNonce?: bigint } = {}) {
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
        readContract: async () => overrides.forwarderNonce ?? 0n,
      },
      relayer: {},
    }),
  };
}

interface Harness {
  app: ReturnType<typeof createServer>;
  logger: MemoryLogger;
}

function buildHarness(
  caller: Caller | null,
  permitted: readonly PermissionName[],
  identity: IdentitySnapshot = { did: null, roles: [] },
): Harness {
  const logger = new MemoryLogger();

  const app = createServer({
    logger,
    roles: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain: fakeSelector() as any,
      logger,
      resolveCaller: () => caller,
      permissions: {
        hasPermission: async (_address: Address, permission: PermissionName) =>
          permitted.includes(permission),
      },
      roles: { read: async () => identity },
    },
  });

  return { app, logger };
}

const adminCaller: Caller = { address: ADMIN, didHash: DID_HASH, roles: ["ADMIN"] };
const managerCaller: Caller = { address: MANAGER, didHash: DID_HASH, roles: ["MANAGER"] };

describe("encodeGrantRoleToDID / encodeRevokeRoleFromDID", () => {
  const abi = [
    {
      type: "function",
      name: "grantRoleToDID",
      stateMutability: "nonpayable",
      inputs: [
        { name: "didHash", type: "bytes32" },
        { name: "role", type: "bytes32" },
      ],
      outputs: [],
    },
    {
      type: "function",
      name: "revokeRoleFromDID",
      stateMutability: "nonpayable",
      inputs: [
        { name: "didHash", type: "bytes32" },
        { name: "role", type: "bytes32" },
      ],
      outputs: [],
    },
  ] as const;

  it("encodes a grant that decodes back to the same DID and role", () => {
    const data = encodeGrantRoleToDID(DID_HASH, ROLE_IDS.MANAGER);
    const decoded = decodeFunctionData({ abi, data });

    expect(decoded.functionName).toBe("grantRoleToDID");
    expect(decoded.args).toEqual([DID_HASH, ROLE_IDS.MANAGER]);
  });

  it("encodes a revoke distinctly from a grant", () => {
    // Same arguments, different selector. If these ever collided, a revoke would grant.
    const grant = encodeGrantRoleToDID(DID_HASH, ROLE_IDS.MANAGER);
    const revoke = encodeRevokeRoleFromDID(DID_HASH, ROLE_IDS.MANAGER);

    expect(grant.slice(0, 10)).not.toBe(revoke.slice(0, 10));
    expect(decodeFunctionData({ abi, data: revoke }).functionName).toBe("revokeRoleFromDID");
  });

  it("targets the DID rather than an address", () => {
    // Roles belong to a verified identity; the contract resolves its active controller at
    // execution. Encoding an address here would strand the role on an old key after a
    // rotation.
    const data = encodeGrantRoleToDID(DID_HASH, ROLE_IDS.ADMIN);
    expect(data).toContain(DID_HASH.slice(2));
    expect(data.toLowerCase()).not.toContain(ADMIN.slice(2).toLowerCase());
  });
});

describe("POST /roles/prepare-grant — authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = buildHarness(null, []);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(res.status).toBe(401);
  });

  it("refuses a caller without MANAGE_ROLES", async () => {
    // A MANAGER can mint and issue, and must not be able to make themselves ADMIN.
    const h = buildHarness(managerCaller, ["MINT_ASSET", "ISSUE_CREDENTIAL"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "ADMIN" });

    expect(res.status).toBe(403);
  });

  it("prepares for a caller holding MANAGE_ROLES", async () => {
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("MANAGER");
    expect(res.body.didHash).toBe(DID_HASH);
  });
});

describe("POST /roles/prepare-grant — what it will not encode", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness(adminCaller, ["MANAGE_ROLES"]);
  });

  it("refuses a role outside the four the platform defines", async () => {
    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "SUPERADMIN" });

    expect(res.status).toBe(400);
  });

  it("refuses a raw role hash, so DEFAULT_ADMIN_ROLE cannot be requested", async () => {
    // The decisive one. Accepting bytes32 would let a caller prepare a grant for the role
    // that administers every other role — including one the contract knows but this
    // platform never intends to hand out.
    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: `0x${"0".repeat(64)}` });

    expect(res.status).toBe(400);
  });

  it("refuses a malformed DID hash", async () => {
    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: "0xnope", role: "MANAGER" });

    expect(res.status).toBe(400);
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    // The schema is strict, so a caller cannot smuggle an `actor` past it and hope some
    // later refactor starts reading it.
    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER", actor: MANAGER });

    expect(res.status).toBe(400);
  });
});

describe("POST /roles/prepare-* — the prepared request itself", () => {
  it("attributes the request to the session, never to the body", async () => {
    // The heart of it: a caller cannot prepare a role change that will be recorded against
    // somebody else.
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(res.body.typedData.message.from.toLowerCase()).toBe(ADMIN.toLowerCase());
  });

  it("targets the RoleAccessControl contract of the active network", async () => {
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(res.body.typedData.message.to.toLowerCase()).toBe(
      CONTRACTS.RoleAccessControl.toLowerCase(),
    );
  });

  it("carries no value, so a signature can never move funds", async () => {
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(String(res.body.typedData.message.value)).toBe("0");
  });

  it("encodes the requested role, not a different one", async () => {
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "AUDITOR" });

    expect(res.body.typedData.message.data).toBe(encodeGrantRoleToDID(DID_HASH, ROLE_IDS.AUDITOR));
  });

  it("prepares a revoke that is genuinely a revoke", async () => {
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-revoke")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(res.status).toBe(200);
    expect(res.body.typedData.message.data).toBe(
      encodeRevokeRoleFromDID(DID_HASH, ROLE_IDS.MANAGER),
    );
  });

  it("submits nothing — 200 with a document to sign, not 202", async () => {
    // Nothing reaches the chain until the ADMIN signs and forwards it. A 202 would imply
    // the platform had accepted responsibility for completing the change.
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    const res = await request(h.app)
      .post("/roles/prepare-grant")
      .send({ didHash: DID_HASH, role: "MANAGER" });

    expect(res.status).toBe(200);
    expect(res.body.typedData).toBeDefined();
  });

  it("logs the prepare, since an unsigned attempt is itself worth seeing", async () => {
    const h = buildHarness(adminCaller, ["MANAGE_ROLES"]);

    await request(h.app).post("/roles/prepare-grant").send({ didHash: DID_HASH, role: "MANAGER" });

    const record = h.logger.find("role.grant_prepared");
    expect(record).toBeDefined();
    expect(record?.actor).toBe(ADMIN);
    expect(record?.role).toBe("MANAGER");
  });
});

describe("GET /roles/:address", () => {
  it("refuses an anonymous caller", async () => {
    const h = buildHarness(null, []);

    const res = await request(h.app).get(`/roles/${MANAGER}`);

    expect(res.status).toBe(401);
  });

  it("returns the roles and DID the chain reports for that address", async () => {
    const h = buildHarness(adminCaller, [], {
      did: "did:trustchain:bob",
      roles: ["MANAGER", "USER"],
    });

    const res = await request(h.app).get(`/roles/${MANAGER}`);

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["MANAGER", "USER"]);
    expect(res.body.did).toBe("did:trustchain:bob");
  });

  it("needs no particular role, because the data is public on-chain anyway", async () => {
    // Gating a public fact on ADMIN would only inconvenience the honest: anyone can call
    // rolesOf against the chain directly.
    const h = buildHarness({ address: MANAGER, didHash: null, roles: [] }, []);

    const res = await request(h.app).get(`/roles/${ADMIN}`);

    expect(res.status).toBe(200);
  });

  it("refuses a malformed address", async () => {
    const h = buildHarness(adminCaller, []);

    const res = await request(h.app).get("/roles/not-an-address");

    expect(res.status).toBe(400);
  });
});
