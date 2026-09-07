import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";

import { corsMiddleware, parseAllowedOrigins } from "./cors";
import { MemoryLogger } from "./logger";
import { createServer } from "../server";

const APP_ORIGIN = "http://localhost:5173";

/** A minimal app carrying only the CORS boundary, so a failure names CORS and nothing else. */
function appWith(allowedOrigins: readonly string[], logger = new MemoryLogger()) {
  const app = express();
  app.use(corsMiddleware({ allowedOrigins, logger }));
  app.get("/thing", (_req, res) => res.json({ ok: true }));
  app.post("/thing", (_req, res) => res.json({ ok: true }));
  return { app, logger };
}

describe("parseAllowedOrigins", () => {
  it("reads several origins from one comma-separated value", () => {
    expect(parseAllowedOrigins("http://localhost:5173, https://app.example.com")).toEqual([
      "http://localhost:5173",
      "https://app.example.com",
    ]);
  });

  it("normalises a trailing slash away, which a browser never sends", () => {
    // Configured as a URL, compared against an Origin header. Without this the two differ by
    // one character and every request is refused for a reason nobody would guess.
    expect(parseAllowedOrigins("https://app.example.com/")).toEqual(["https://app.example.com"]);
  });

  it("lowercases the host, because Origin arrives lowercased", () => {
    expect(parseAllowedOrigins("https://App.Example.COM")).toEqual(["https://app.example.com"]);
  });

  it("treats an unset value as no cross-origin access rather than as any origin", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });
});

describe("corsMiddleware — allowed origins", () => {
  it("names the origin rather than a wildcard, which credentials require", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app).get("/thing").set("Origin", APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("allows credentials, because the session is an httpOnly cookie", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app).get("/thing").set("Origin", APP_ORIGIN);

    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("varies on Origin, so a cache cannot serve one origin's response to another", async () => {
    const { app } = appWith([APP_ORIGIN, "https://app.example.com"]);
    const res = await request(app).get("/thing").set("Origin", APP_ORIGIN);

    expect((res.headers["vary"] as string).toLowerCase()).toContain("origin");
  });

  it("exposes the request id, or the client cannot report which request failed", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app).get("/thing").set("Origin", APP_ORIGIN);

    const exposed = (res.headers["access-control-expose-headers"] as string).toLowerCase();
    expect(exposed).toContain("x-request-id");
  });

  it("admits a second configured origin, not only the first", async () => {
    const { app } = appWith([APP_ORIGIN, "https://app.example.com"]);
    const res = await request(app).get("/thing").set("Origin", "https://app.example.com");

    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });
});

describe("corsMiddleware — refused origins", () => {
  it("omits the header for an origin that is not configured", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app).get("/thing").set("Origin", "https://evil.test");

    // The browser blocks the response on its side when the header is absent. That is the
    // specified behaviour, and it is why the status is still 200.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses an origin that merely ends with an allowed one", async () => {
    // The reason there is no suffix or regex match anywhere in cors.ts: this host is
    // controlled by evil.test and has nothing to do with app.example.com.
    const { app } = appWith(["https://app.example.com"]);
    const res = await request(app).get("/thing").set("Origin", "https://app.example.com.evil.test");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a different scheme on an allowed host", async () => {
    const { app } = appWith(["https://app.example.com"]);
    const res = await request(app).get("/thing").set("Origin", "http://app.example.com");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a different port on an allowed host", async () => {
    const { app } = appWith(["http://localhost:5173"]);
    const res = await request(app).get("/thing").set("Origin", "http://localhost:5174");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses everything when no origins are configured", async () => {
    const { app } = appWith([]);
    const res = await request(app).get("/thing").set("Origin", APP_ORIGIN);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("logs the refusal so an unexpected caller is visible", async () => {
    const { app, logger } = appWith([APP_ORIGIN]);
    await request(app).get("/thing").set("Origin", "https://evil.test");

    const record = logger.find("security.cors_origin_refused");
    expect(record).toBeDefined();
    expect(record?.origin).toBe("https://evil.test");
  });

  it("answers rather than erroring, so a refusal is not a 500", async () => {
    // A thrown error here would be a 500 for every scan and stray Origin, burying real
    // failures in noise.
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app).get("/thing").set("Origin", "https://evil.test");

    expect(res.status).toBe(200);
  });
});

describe("corsMiddleware — preflight", () => {
  it("answers OPTIONS with 204 and the permitted methods", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app)
      .options("/thing")
      .set("Origin", APP_ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("permits the headers the app actually sends", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app)
      .options("/thing")
      .set("Origin", APP_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");

    const allowed = (res.headers["access-control-allow-headers"] as string).toLowerCase();
    expect(allowed).toContain("content-type");
    expect(allowed).toContain("x-request-id");
  });

  it("does not permit Authorization, keeping the cookie the only session path", async () => {
    // Reflecting requested headers would create a second, bearer-token authentication path
    // with different CSRF properties than the cookie the platform actually uses.
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app)
      .options("/thing")
      .set("Origin", APP_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization");

    const allowed = (res.headers["access-control-allow-headers"] as string).toLowerCase();
    expect(allowed).not.toContain("authorization");
  });

  it("caches the preflight, since every mutation is preceded by one", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app)
      .options("/thing")
      .set("Origin", APP_ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(Number(res.headers["access-control-max-age"])).toBeGreaterThan(0);
  });

  it("gives a refused origin no preflight approval", async () => {
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app)
      .options("/thing")
      .set("Origin", "https://evil.test")
      .set("Access-Control-Request-Method", "POST");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("corsMiddleware — requests with no Origin", () => {
  it("passes them through, because they are not subject to CORS", async () => {
    // curl, a health probe and any server-to-server caller send no Origin. Refusing these
    // would break the deployment's own monitoring while protecting nothing: CORS is a
    // browser mechanism.
    const { app } = appWith([APP_ORIGIN]);
    const res = await request(app).get("/thing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("createServer — CORS wiring", () => {
  it("sends no CORS headers when no origins are configured", async () => {
    const res = await request(createServer()).get("/health").set("Origin", APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("admits the configured app origin on a real route", async () => {
    const app = createServer({ allowedOrigins: [APP_ORIGIN] });
    const res = await request(app).get("/health").set("Origin", APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("keeps the security headers on a CORS response", async () => {
    // The two middlewares sit next to each other in the stack; neither may drop the other's
    // headers.
    const app = createServer({ allowedOrigins: [APP_ORIGIN] });
    const res = await request(app).get("/health").set("Origin", APP_ORIGIN);

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("carries a request id on a preflight, so a refusal is traceable", async () => {
    const app = createServer({ allowedOrigins: [APP_ORIGIN] });
    const res = await request(app)
      .options("/health")
      .set("Origin", APP_ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});
