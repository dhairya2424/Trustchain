import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

import { MemoryLogger } from "./logger";
import { requirePermission, requireRole, requireSession, type Caller } from "./authorize";
import { ROLE_IDS } from "../auth/roles";
import type { PermissionReader } from "../auth/roleReader";
import { requestId } from "./middleware";

const ADMIN: Caller = {
  address: "0x1111111111111111111111111111111111111111",
  didHash: `0x${"a".repeat(64)}`,
  roles: [ROLE_IDS.ADMIN],
};

const USER: Caller = {
  address: "0x2222222222222222222222222222222222222222",
  didHash: `0x${"b".repeat(64)}`,
  roles: [ROLE_IDS.USER],
};

function build(handler: express.RequestHandler, logger = new MemoryLogger()) {
  const app = express();
  app.use(requestId());
  app.use(handler);
  app.get("/thing", (req, res) => res.json({ ok: true, caller: req.caller?.address ?? null }));
  return { app, logger };
}

const reader = (permitted: boolean | Error): PermissionReader => ({
  hasPermission: async () => {
    if (permitted instanceof Error) throw permitted;
    return permitted;
  },
});

describe("requireSession", () => {
  it("passes an authenticated caller through and attaches it to the request", async () => {
    const logger = new MemoryLogger();
    const { app } = build(requireSession({ resolve: () => ADMIN, logger }), logger);

    const res = await request(app).get("/thing");

    expect(res.status).toBe(200);
    expect(res.body.caller).toBe(ADMIN.address);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const logger = new MemoryLogger();
    const { app } = build(requireSession({ resolve: () => null, logger }), logger);

    const res = await request(app).get("/thing");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("accepts an asynchronous resolver, since verifying a token is async", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requireSession({ resolve: async () => Promise.resolve(ADMIN), logger }),
      logger,
    );

    expect((await request(app).get("/thing")).status).toBe(200);
  });

  it("logs the denial with the request id, so an alert can be traced", async () => {
    const logger = new MemoryLogger();
    const { app } = build(requireSession({ resolve: () => null, logger }), logger);

    await request(app).get("/thing");

    const record = logger.find("security.authorization_denied");
    expect(record?.requestId).toBeTruthy();
  });
});

describe("requireRole", () => {
  it("admits a caller holding the required role", async () => {
    const logger = new MemoryLogger();
    const { app } = build(requireRole({ resolve: () => ADMIN, logger, roles: ["ADMIN"] }), logger);

    expect((await request(app).get("/thing")).status).toBe(200);
  });

  it("refuses a caller who holds a different role", async () => {
    const logger = new MemoryLogger();
    const { app } = build(requireRole({ resolve: () => USER, logger, roles: ["ADMIN"] }), logger);

    const res = await request(app).get("/thing");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("admits a caller holding any one of several accepted roles", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requireRole({ resolve: () => USER, logger, roles: ["ADMIN", "USER"] }),
      logger,
    );

    expect((await request(app).get("/thing")).status).toBe(200);
  });

  it("refuses a caller with no roles at all", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requireRole({ resolve: () => ({ ...USER, roles: [] }), logger, roles: ["ADMIN"] }),
      logger,
    );

    expect((await request(app).get("/thing")).status).toBe(403);
  });

  it("logs the roles held and required, in readable names rather than hashes", async () => {
    const logger = new MemoryLogger();
    const { app } = build(requireRole({ resolve: () => USER, logger, roles: ["ADMIN"] }), logger);

    await request(app).get("/thing");

    const record = logger.find("security.authorization_denied");
    expect(record?.held).toEqual(["USER"]);
    expect(record?.required).toEqual(["ADMIN"]);
  });
});

describe("requirePermission", () => {
  it("admits a caller the chain says is permitted", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requirePermission({
        resolve: () => ADMIN,
        logger,
        permissions: reader(true),
        permission: "ISSUE_CREDENTIAL",
      }),
      logger,
    );

    expect((await request(app).get("/thing")).status).toBe(200);
  });

  it("refuses a caller the chain says is not permitted", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requirePermission({
        resolve: () => ADMIN,
        logger,
        permissions: reader(false),
        permission: "ISSUE_CREDENTIAL",
      }),
      logger,
    );

    const res = await request(app).get("/thing");

    expect(res.status).toBe(403);
  });

  /**
   * The platform's first hard rule: only on-chain roles authorize mutations. A session
   * token minted before a revocation still carries the role, so honouring its claims here
   * would mean the API granting access the chain no longer does.
   */
  it("ignores the session's role claims entirely and asks the chain", async () => {
    const logger = new MemoryLogger();
    const hasPermission = vi.fn(async () => false);
    const { app } = build(
      requirePermission({
        // Claims say ADMIN. The chain says no. The chain wins.
        resolve: () => ADMIN,
        logger,
        permissions: { hasPermission },
        permission: "ISSUE_CREDENTIAL",
      }),
      logger,
    );

    const res = await request(app).get("/thing");

    expect(hasPermission).toHaveBeenCalledWith(ADMIN.address, "ISSUE_CREDENTIAL");
    expect(res.status).toBe(403);
  });

  it("fails closed with 503 when the chain cannot be reached", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requirePermission({
        resolve: () => ADMIN,
        logger,
        permissions: reader(new Error("ECONNREFUSED")),
        permission: "ISSUE_CREDENTIAL",
      }),
      logger,
    );

    const res = await request(app).get("/thing");

    // Not a 200. If we cannot ask who is authorised, we do not guess.
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("authorization_unavailable");
  });

  it("fails closed when no permission reader is configured at all", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requirePermission({ resolve: () => ADMIN, logger, permission: "ISSUE_CREDENTIAL" }),
      logger,
    );

    expect((await request(app).get("/thing")).status).toBe(503);
  });

  it("rejects an unauthenticated caller before consulting the chain", async () => {
    const logger = new MemoryLogger();
    const hasPermission = vi.fn(async () => true);
    const { app } = build(
      requirePermission({
        resolve: () => null,
        logger,
        permissions: { hasPermission },
        permission: "ISSUE_CREDENTIAL",
      }),
      logger,
    );

    const res = await request(app).get("/thing");

    expect(res.status).toBe(401);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it("does not leak the permission name to the caller in the error body", async () => {
    const logger = new MemoryLogger();
    const { app } = build(
      requirePermission({
        resolve: () => ADMIN,
        logger,
        permissions: reader(false),
        permission: "MANAGE_ROLES",
      }),
      logger,
    );

    const res = await request(app).get("/thing");

    // Logged for operators, not echoed to the caller.
    expect(JSON.stringify(res.body)).not.toContain("MANAGE_ROLES");
    expect(logger.find("security.authorization_denied")?.permission).toBe("MANAGE_ROLES");
  });
});
