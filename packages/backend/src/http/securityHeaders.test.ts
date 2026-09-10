import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";

import { MemoryLogger } from "./logger";
import { requestId } from "./middleware";
import {
  API_CSP_DIRECTIVES,
  HSTS_MAX_AGE_SECONDS,
  requireHttps,
  sanitizeResponses,
  spaCspDirectives,
} from "./securityHeaders";
import { createServer } from "../server";

/** Parses a CSP header into directive -> sources. */
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of header.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

describe("securityHeaders — CSP", () => {
  it("sends default-src 'none' on the API, because JSON needs no resources", async () => {
    const res = await request(createServer()).get("/health");
    const csp = parseCsp(res.headers["content-security-policy"] as string);

    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["script-src"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
  });

  it("forbids framing, which is the enforced clickjacking control", async () => {
    const res = await request(createServer()).get("/health");

    expect(parseCsp(res.headers["content-security-policy"] as string)["frame-ancestors"]).toEqual([
      "'none'",
    ]);
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("keeps the full CSP on a 404, rather than letting finalhandler reduce it", async () => {
    // An unknown path used to fall through to Express's finalhandler, which stamps its own
    // `default-src 'none'` over helmet's policy — dropping frame-ancestors and form-action,
    // which do not fall back to default-src. An OWASP ZAP baseline flagged that as a Medium.
    // The explicit JSON 404 handler keeps the full policy.
    const res = await request(createServer()).get("/no-such-route");
    const csp = parseCsp(res.headers["content-security-policy"] as string);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", requestId: expect.any(String) });
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    // The two directives that finalhandler dropped, now present on the 404 too.
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
  });

  it("never allows unsafe-inline or unsafe-eval anywhere in the API policy", () => {
    const flat = Object.values(API_CSP_DIRECTIVES).flat().join(" ");

    expect(flat).not.toContain("unsafe-inline");
    expect(flat).not.toContain("unsafe-eval");
  });

  it("locks base-uri and form-action, so an injected tag cannot retarget the page", () => {
    expect(API_CSP_DIRECTIVES["base-uri"]).toEqual(["'none'"]);
    expect(API_CSP_DIRECTIVES["form-action"]).toEqual(["'none'"]);
  });
});

describe("securityHeaders — the SPA policy", () => {
  const directives = spaCspDirectives({
    apiOrigin: "https://api.example.com",
    ipfsGateway: "https://gw.example.com",
  });

  it("allows scripts only from self, with no inline and no eval", () => {
    expect(directives["script-src"]).toEqual(["'self'"]);
  });

  it("relaxes inline only for styles, which cannot execute", () => {
    expect(directives["style-src"]).toContain("'unsafe-inline'");
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("names connect-src hosts explicitly, so an injected script cannot exfiltrate freely", () => {
    expect(directives["connect-src"]).toEqual([
      "'self'",
      "https://api.example.com",
      "https://gw.example.com",
    ]);
  });

  it("matches the policy shipped in the Nginx snippet", async () => {
    // The two must not drift. If this fails, one of them was edited alone.
    const { readFileSync } = await import("node:fs");
    const snippet = readFileSync(
      new URL("../../../../infra/nginx/snippets/security-headers.conf", import.meta.url),
      "utf8",
    );

    expect(snippet).toContain("script-src 'self';");
    expect(snippet).toContain("frame-ancestors 'none'");
    expect(snippet).toContain(`max-age=${HSTS_MAX_AGE_SECONDS}`);
    expect(snippet).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("securityHeaders — transport and sniffing", () => {
  it("sends HSTS for one year with includeSubDomains and preload", async () => {
    const res = await request(createServer()).get("/health");

    expect(res.headers["strict-transport-security"]).toBe(
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`,
    );
    expect(HSTS_MAX_AGE_SECONDS).toBe(31_536_000);
  });

  it("omits HSTS when disabled for a plain-HTTP local run", async () => {
    const res = await request(createServer({ security: { hsts: false } })).get("/health");

    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends nosniff, so an uploaded file is never guessed into HTML", async () => {
    const res = await request(createServer()).get("/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends no referrer, so a request id in a URL cannot leak to a third party", async () => {
    const res = await request(createServer()).get("/health");

    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("denies the browser features this application never uses", async () => {
    const res = await request(createServer()).get("/health");
    const policy = res.headers["permissions-policy"] as string;

    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("does not advertise the framework", async () => {
    const res = await request(createServer()).get("/health");

    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("still sends the headers on a 404, which is where a header is most often lost", async () => {
    const res = await request(createServer()).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});

describe("requireHttps", () => {
  const build = (logger = new MemoryLogger()) => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(requestId());
    app.use(requireHttps({ enabled: true, logger }));
    app.get("/thing", (_req, res) => res.json({ ok: true }));
    app.post("/thing", (_req, res) => res.json({ ok: true }));
    return { app, logger };
  };

  it("passes a request that arrived over TLS", async () => {
    const { app } = build();
    const res = await request(app).get("/thing").set("x-forwarded-proto", "https");

    expect(res.status).toBe(200);
  });

  it("redirects a plain-HTTP GET permanently, so the second visit never leaves in the clear", async () => {
    const { app } = build();
    const res = await request(app).get("/thing").set("x-forwarded-proto", "http");

    expect(res.status).toBe(308);
    expect(res.headers.location).toMatch(/^https:\/\//);
  });

  it("refuses a plain-HTTP POST instead of redirecting it", async () => {
    // Redirecting would ask the client to resend a body it already sent in the clear. The
    // credential in that first request is already compromised; it needs rotating, not
    // replaying over TLS.
    const { app } = build();
    const res = await request(app).post("/thing").set("x-forwarded-proto", "http");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("https_required");
    expect(res.headers.location).toBeUndefined();
  });

  it("refuses rather than redirects when Host is not a plausible hostname", async () => {
    // Host is attacker-controlled. Redirecting to it unvalidated is an open redirect.
    const { app } = build();
    const res = await request(app)
      .get("/thing")
      .set("x-forwarded-proto", "http")
      .set("host", "evil.com/path?x=1");

    expect(res.status).toBe(403);
  });

  it("logs the plaintext request with its id", async () => {
    const { app, logger } = build();
    await request(app).get("/thing").set("x-forwarded-proto", "http");

    const record = logger.find("security.plaintext_request");
    expect(record).toBeDefined();
    expect(record?.requestId).toBeTruthy();
  });

  it("is a no-op when disabled", async () => {
    const app = express();
    app.use(requireHttps({ enabled: false }));
    app.get("/thing", (_req, res) => res.json({ ok: true }));

    expect((await request(app).get("/thing")).status).toBe(200);
  });
});

describe("sanitizeResponses", () => {
  const build = () => {
    const logger = new MemoryLogger();
    const app = express();
    app.use(requestId());
    app.use(sanitizeResponses({ logger }));
    app.get("/dirty", (_req, res) => {
      res.json({ displayName: "<script>alert(1)</script>Ada", tokenId: "42" });
    });
    app.get("/clean", (_req, res) => res.json({ tokenId: "42", uri: "ipfs://bafy" }));
    return { app, logger };
  };

  it("strips markup from a value a handler returned without sanitising", async () => {
    const { app } = build();
    const res = await request(app).get("/dirty");

    expect(res.body.displayName).toBe("Ada");
    expect(res.body.tokenId).toBe("42");
  });

  it("logs the field path, because a finding means dirty data is already stored", async () => {
    const { app, logger } = build();
    await request(app).get("/dirty");

    const record = logger.find("security.output_sanitized");
    expect(record).toBeDefined();
    expect(record?.fields).toEqual(["displayName"]);
  });

  it("never copies the offending value into the log line", async () => {
    const { app, logger } = build();
    await request(app).get("/dirty");

    expect(JSON.stringify(logger.records)).not.toContain("alert(1)");
  });

  it("leaves a clean response untouched and logs nothing", async () => {
    const { app, logger } = build();
    const res = await request(app).get("/clean");

    expect(res.body).toEqual({ tokenId: "42", uri: "ipfs://bafy" });
    expect(logger.find("security.output_sanitized")).toBeUndefined();
  });

  it("covers every route, including ones added later", async () => {
    // The point of wrapping res.json rather than editing each serialiser: a route that
    // forgets to sanitise is still covered.
    const res = await request(createServer()).get("/health");

    expect(res.body.status).toBe("ok");
  });
});
