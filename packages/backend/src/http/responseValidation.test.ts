import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { errorHandler } from "./middleware";
import { MemoryLogger } from "./logger";
import { validateResponses } from "./responseValidation";

/**
 * The response guard has to do three things and not a fourth:
 *   - pass a response that matches its DTO contract,
 *   - throw on an *extra* field the contract does not name (the "trim responses" property),
 *   - throw on any server-only field name anywhere in the body (the denylist floor),
 * and it must NOT flag an ordinary field whose name merely contains a short token — `active`
 * contains "iv", and an early version of the denylist wrongly rejected it.
 */

function appWith(route: (app: express.Express) => void) {
  const app = express();
  app.use((req, res, next) => {
    // requestId is referenced by the error handler's log line.
    (req as { requestId?: string }).requestId = "test";
    next();
  });
  app.use(validateResponses({ enabled: true, logger: new MemoryLogger() }));
  route(app);
  app.use(errorHandler({ logger: new MemoryLogger() }));
  return app;
}

describe("validateResponses — strict contracts", () => {
  it("passes a session response that matches its contract", async () => {
    const app = appWith((a) =>
      a.get("/auth/session", (_req, res) => {
        res.json({ address: "0xabc", did: null, roles: ["ADMIN"] });
      }),
    );
    const res = await request(app).get("/auth/session");
    expect(res.status).toBe(200);
    expect(res.body.address).toBe("0xabc");
  });

  it("throws on an extra field not named by the contract", async () => {
    const app = appWith((a) =>
      a.get("/auth/session", (_req, res) => {
        // `internalUserId` is not part of the session DTO — exactly the accidental leak the
        // guard exists to catch.
        res.json({ address: "0xabc", did: null, roles: [], internalUserId: 42 });
      }),
    );
    const res = await request(app).get("/auth/session");
    expect(res.status).toBe(500);
  });

  it("does not flag `active`, whose name contains the short token 'iv'", async () => {
    // Regression: the denylist matched "iv" as a substring and rejected `active`,
    // `derivative`, `receiver`. Short tokens are matched exactly now.
    const app = appWith((a) =>
      a.get("/identity/0xdeadbeef", (_req, res) => {
        res.json({
          didHash: "0xdeadbeef",
          registered: true,
          controller: "0xabc",
          active: true,
          roles: [],
          assets: null,
          network: {
            id: "amoy",
            label: "AMOY",
            chainId: 80002,
            explorerUrl: null,
            verifiability: "public",
          },
        });
      }),
    );
    const res = await request(app).get("/identity/0xdeadbeef");
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
  });
});

describe("validateResponses — denylist floor", () => {
  it("throws when any response carries a server-only field", async () => {
    const app = appWith((a) =>
      a.get("/anything", (_req, res) => {
        // The guard matches on the field NAME, so the value is a harmless placeholder — no
        // need for a real (or real-looking) key here.
        res.json({ ok: true, jwtPrivateKey: "redacted-in-test" });
      }),
    );
    const res = await request(app).get("/anything");
    expect(res.status).toBe(500);
  });

  it("throws on a server-only field nested deep in the body", async () => {
    const app = appWith((a) =>
      a.get("/anything", (_req, res) => {
        res.json({ data: { user: { profile: { mnemonic: "twelve words here" } } } });
      }),
    );
    const res = await request(app).get("/anything");
    expect(res.status).toBe(500);
  });

  it("allows the public SIWE nonce, which is named `nonce` by design", async () => {
    const app = appWith((a) =>
      a.get("/auth/nonce", (_req, res) => {
        res.json({ nonce: "abc123", expiresAt: new Date().toISOString() });
      }),
    );
    const res = await request(app).get("/auth/nonce");
    expect(res.status).toBe(200);
    expect(res.body.nonce).toBe("abc123");
  });
});

describe("validateResponses — disabled in production", () => {
  it("is a pass-through when disabled, even for a leaking response", async () => {
    // In production the guard must never be able to fail a live response. When disabled it
    // does nothing — the leak would be caught by tests and the denylist in dev, not here.
    const app = express();
    app.use(validateResponses({ enabled: false, logger: new MemoryLogger() }));
    app.get("/anything", (_req, res) => res.json({ jwtPrivateKey: "x" }));
    const res = await request(app).get("/anything");
    expect(res.status).toBe(200);
  });
});
