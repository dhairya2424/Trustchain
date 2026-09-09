import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { Address } from "viem";

import { createServer } from "../server";
import { ACCESS_COOKIE, REFRESH_COOKIE, type AuthDependencies } from "./routes";
import { FailureTracker } from "./failureTracker";
import { MemoryStore } from "../store/kv";
import { NonceService } from "./nonce";
import { SiweVerifier } from "./siwe";
import { TokenService } from "./tokens";
import type { RoleReader } from "./roleReader";
import type { TurnstileVerifier } from "./turnstile";

const DOMAIN = "localhost:5173";
const ORIGIN = "http://localhost:5173";
const CHAIN_ID = 80002;

const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775"; // secrets-scan:allow
const ALICE_DID = "0x1111111111111111111111111111111111111111111111111111111111111111"; // secrets-scan:allow

// Well-known Hardhat test key. Never funded, never used outside tests.
const USER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secrets-scan:allow
const ATTACKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // secrets-scan:allow

const account = privateKeyToAccount(USER_KEY);
const attacker = privateKeyToAccount(ATTACKER_KEY);

class StubTurnstile implements TurnstileVerifier {
  constructor(public shouldPass = true) {}
  async verify(token: string): Promise<boolean> {
    return this.shouldPass && token.length > 0;
  }
}

class StubRoleReader implements RoleReader {
  public calls = 0;
  constructor(
    public roles: readonly string[] = [ADMIN_ROLE],
    public did: string | null = ALICE_DID,
  ) {}
  async read(_address: Address) {
    this.calls += 1;
    return { roles: this.roles, did: this.did };
  }
}

interface Harness {
  app: ReturnType<typeof createServer>;
  store: MemoryStore;
  nonces: NonceService;
  tokens: TokenService;
  turnstile: StubTurnstile;
  roles: StubRoleReader;
  deps: AuthDependencies;
}

async function buildHarness(overrides: { rateLimitPoints?: number } = {}): Promise<Harness> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

  const store = new MemoryStore();
  const nonces = new NonceService(store, 300);
  const tokens = new TokenService(store, {
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
    accessTtlSeconds: 900,
    refreshTtlSeconds: 604_800,
  });
  const turnstile = new StubTurnstile();
  const roles = new StubRoleReader();
  const failures = new FailureTracker(store, {
    threshold: 10,
    baseSeconds: 60,
    maxSeconds: 86_400,
    windowSeconds: 3600,
  });

  const deps: AuthDependencies = {
    nonces,
    tokens,
    roles,
    siwe: new SiweVerifier({ domains: [DOMAIN] }),
    turnstile,
    failures,
    config: {
      domain: DOMAIN,
      origin: ORIGIN,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 604_800,
      cookieDomain: "localhost",
      secureCookies: false,
      rateLimitPoints: overrides.rateLimitPoints ?? 1000,
      rateLimitWindowSeconds: 60,
    },
  };

  return { app: createServer({ auth: deps }), store, nonces, tokens, turnstile, roles, deps };
}

async function signIn(h: Harness, signer = account, overrides: { nonce?: string } = {}) {
  const nonceRes = await request(h.app).get("/auth/nonce");
  const nonce = overrides.nonce ?? nonceRes.body.nonce;

  const message = createSiweMessage({
    address: signer.address,
    chainId: CHAIN_ID,
    domain: DOMAIN,
    nonce,
    uri: ORIGIN,
    version: "1",
  });

  const signature = await signer.signMessage({ message });
  return { message, signature, nonce };
}

function cookiesOf(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function cookieValue(res: request.Response, name: string): string | undefined {
  const entry = cookiesOf(res).find((c) => c.startsWith(`${name}=`));
  return entry?.split(";")[0]?.split("=")[1];
}

describe("POST /auth/verify — happy path", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it("issues a session for a valid SIWE signature", async () => {
    const { message, signature } = await signIn(h);

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(res.status).toBe(200);
    expect(res.body.address.toLowerCase()).toBe(account.address.toLowerCase());
    // Names in the body. The chain returns 32-byte ids and the token keeps them, but a
    // client comparing against "ADMIN" is reading a name — see the token assertion below.
    expect(res.body.roles).toEqual(["ADMIN"]);
    expect(res.body.did).toBe(ALICE_DID);
  });

  it("reads roles ON-CHAIN rather than trusting the client", async () => {
    const { message, signature } = await signIn(h);

    // The client asks for roles it does not have; the server must ignore that entirely.
    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok", roles: ["0xdeadbeef"], did: "0xfake" });

    expect(res.status).toBe(200);
    expect(h.roles.calls).toBe(1);
    expect(res.body.roles).toEqual(["ADMIN"]);
    expect(res.body.did).toBe(ALICE_DID);
  });

  it("sets httpOnly, SameSite=Strict session cookies and never returns a raw token", async () => {
    const { message, signature } = await signIn(h);

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    const cookies = cookiesOf(res);
    const access = cookies.find((c) => c.startsWith(ACCESS_COOKIE));
    const refresh = cookies.find((c) => c.startsWith(REFRESH_COOKIE));

    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    // Refresh cookie is scoped to /auth so it is not sent on every API call.
    expect(refresh).toMatch(/Path=\/auth/i);

    // The body must carry no token — anything here is reachable from JavaScript.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("eyJ");
  });

  it("issues an access token the server can verify, carrying the on-chain roles", async () => {
    const { message, signature } = await signIn(h);
    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    const token = cookieValue(res, ACCESS_COOKIE);
    const payload = await h.tokens.verifyAccessToken(decodeURIComponent(token ?? ""));

    expect(String(payload.sub).toLowerCase()).toBe(account.address.toLowerCase());
    // Ids, deliberately: `requireRole` compares ids, so translating them into the token
    // claims would silently un-gate every role-checked route.
    expect(payload.roles).toEqual([ADMIN_ROLE]);
  });
});

describe("POST /auth/verify — rejection paths", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it("REPLAY: the same nonce cannot be used twice", async () => {
    const { message, signature } = await signIn(h);

    const first = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });
    expect(first.status).toBe(200);

    // Identical, still-valid signature. Only the spent nonce stops it.
    const replay = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("invalid_or_expired_nonce");
  });

  it("EXPIRED NONCE: a nonce past its TTL is refused", async () => {
    const { message, signature, nonce } = await signIn(h);

    h.store.expire(`siwe:nonce:${nonce}`);

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_or_expired_nonce");
  });

  it("UNKNOWN NONCE: a nonce the server never issued is refused", async () => {
    const { message, signature } = await signIn(h, account, { nonce: "attackerchosennonce1" });

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_or_expired_nonce");
  });

  it("FORGED SIGNATURE: a message signed by someone else is refused", async () => {
    const nonceRes = await request(h.app).get("/auth/nonce");

    // Claims to be `account`, but is signed by `attacker`.
    const message = createSiweMessage({
      address: account.address,
      chainId: CHAIN_ID,
      domain: DOMAIN,
      nonce: nonceRes.body.nonce,
      uri: ORIGIN,
      version: "1",
    });
    const signature = await attacker.signMessage({ message });

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("address_mismatch");
    expect(cookiesOf(res)).toEqual([]);
  });

  it("TAMPERED MESSAGE: altering the message after signing is refused", async () => {
    const { message, signature } = await signIn(h);
    const tampered = message.replace(account.address, attacker.address);

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message: tampered, signature, turnstileToken: "ok" });

    expect(res.status).toBe(401);
  });

  it("WRONG DOMAIN: a signature farmed by another site is refused", async () => {
    const nonceRes = await request(h.app).get("/auth/nonce");
    const message = createSiweMessage({
      address: account.address,
      chainId: CHAIN_ID,
      domain: "evil.example",
      nonce: nonceRes.body.nonce,
      uri: "https://evil.example",
      version: "1",
    });
    const signature = await account.signMessage({ message });

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("field_validation_failed");
  });

  it("MISSING TURNSTILE: a request with no bot token is refused with 403", async () => {
    const { message, signature } = await signIn(h);

    const res = await request(h.app).post("/auth/verify").send({ message, signature });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bot_check_failed");
  });

  it("FAILED TURNSTILE: a rejected bot token is refused with 403", async () => {
    h.turnstile.shouldPass = false;
    const { message, signature } = await signIn(h);

    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "bad" });

    expect(res.status).toBe(403);
  });

  it("the bot check runs before the nonce is spent", async () => {
    h.turnstile.shouldPass = false;
    const { message, signature } = await signIn(h);

    await request(h.app).post("/auth/verify").send({ message, signature, turnstileToken: "bad" });

    // The nonce survived, so a legitimate retry still works.
    h.turnstile.shouldPass = true;
    const retry = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(retry.status).toBe(200);
  });

  it("rejects a malformed body", async () => {
    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message: "not-a-siwe-message", signature: "nothex", turnstileToken: "ok" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("rate limiting and backoff", () => {
  it("RATE LIMIT: caps /auth/* per IP and answers 429 with Retry-After", async () => {
    const h = await buildHarness({ rateLimitPoints: 5 });

    for (let i = 0; i < 5; i++) {
      expect((await request(h.app).get("/auth/nonce")).status).toBe(200);
    }

    const limited = await request(h.app).get("/auth/nonce");

    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("blocks an IP after repeated failures and grows the delay exponentially", async () => {
    const h = await buildHarness();
    const tracker = new FailureTracker(new MemoryStore(), {
      threshold: 10,
      baseSeconds: 60,
      maxSeconds: 86_400,
      windowSeconds: 3600,
    });

    // Below the threshold nothing is blocked.
    expect(tracker.blockSecondsFor(9)).toBe(0);
    // Then it doubles each further failure.
    expect(tracker.blockSecondsFor(10)).toBe(60);
    expect(tracker.blockSecondsFor(11)).toBe(120);
    expect(tracker.blockSecondsFor(12)).toBe(240);
    // And is capped, so an automated counter can never ban an address forever.
    expect(tracker.blockSecondsFor(99)).toBe(86_400);

    // Drive real failures through the API until the block engages.
    for (let i = 0; i < 10; i++) {
      await request(h.app)
        .post("/auth/verify")
        .send({ message: "bad", signature: "0xdead", turnstileToken: "ok" });
    }

    const blocked = await request(h.app).get("/auth/nonce");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("too_many_failures");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a successful sign-in clears the failure record", async () => {
    const h = await buildHarness();

    for (let i = 0; i < 3; i++) {
      await request(h.app)
        .post("/auth/verify")
        .send({ message: "bad", signature: "0xdead", turnstileToken: "ok" });
    }

    const { message, signature } = await signIn(h);
    const ok = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    expect(ok.status).toBe(200);
    expect(await h.store.get("auth:failures:::ffff:127.0.0.1")).toBeNull();
  });
});

describe("refresh token rotation", () => {
  let h: Harness;
  let refreshToken: string;

  beforeEach(async () => {
    h = await buildHarness();
    const { message, signature } = await signIn(h);
    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });
    refreshToken = decodeURIComponent(cookieValue(res, REFRESH_COOKIE) ?? "");
  });

  it("rotates the refresh token and re-reads roles from the chain", async () => {
    const before = h.roles.calls;

    const res = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);

    expect(res.status).toBe(200);
    expect(h.roles.calls).toBe(before + 1);

    const rotated = decodeURIComponent(cookieValue(res, REFRESH_COOKIE) ?? "");
    expect(rotated).not.toBe(refreshToken);
  });

  it("REUSE DETECTION: replaying a spent refresh token revokes the whole family", async () => {
    const first = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);
    const rotated = decodeURIComponent(cookieValue(first, REFRESH_COOKIE) ?? "");

    // The stolen original is replayed.
    const replay = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);

    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("reuse_detected");

    // The legitimate holder's newer token is killed too: we cannot tell which party is
    // the attacker, so the whole family goes.
    const afterRevocation = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${rotated}`);

    expect(afterRevocation.status).toBe(401);
    expect(afterRevocation.body.error).toBe("family_revoked");
  });

  it("clears both cookies when a refresh is rejected", async () => {
    await request(h.app).post("/auth/refresh").set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);

    const replay = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);

    const cleared = cookiesOf(replay).join(";");
    expect(cleared).toContain(ACCESS_COOKIE);
    expect(cleared).toContain(REFRESH_COOKIE);
  });

  it("rejects a refresh with no cookie, and a forged one", async () => {
    expect((await request(h.app).post("/auth/refresh")).status).toBe(401);

    const forged = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=not.a.jwt`);

    expect(forged.status).toBe(401);
  });

  it("logout revokes the family so the token cannot be reused", async () => {
    const out = await request(h.app)
      .post("/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);
    expect(out.status).toBe(204);

    const after = await request(h.app)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refreshToken}`);

    expect(after.status).toBe(401);
  });
});

describe("GET /auth/nonce", () => {
  it("returns a unique, non-cacheable nonce each time", async () => {
    const h = await buildHarness();

    const first = await request(h.app).get("/auth/nonce");
    const second = await request(h.app).get("/auth/nonce");

    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.nonce).not.toBe(second.body.nonce);
    expect(new Date(first.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("GET /auth/session", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  /** Signs in and returns the access cookie a browser would then send back. */
  async function sessionCookie(): Promise<string> {
    const { message, signature } = await signIn(h);
    const res = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });
    return `${ACCESS_COOKIE}=${cookieValue(res, ACCESS_COOKIE)}`;
  }

  it("returns the signed-in identity, so a reload need not re-sign", async () => {
    // The whole reason this route exists: the session is an httpOnly cookie, so after a
    // reload the app is authenticated but has no way to say who it is.
    const cookie = await sessionCookie();

    const res = await request(h.app).get("/auth/session").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.address.toLowerCase()).toBe(account.address.toLowerCase());
    expect(res.body.did).toBe(ALICE_DID);
    expect(res.body.roles).toEqual(["ADMIN"]);
  });

  it("refuses a request with no session rather than answering with nulls", async () => {
    // A 200 carrying nulls invites a caller to treat "not signed in" as a valid session.
    const res = await request(h.app).get("/auth/session");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("refuses a forged token", async () => {
    const res = await request(h.app)
      .get("/auth/session")
      .set("Cookie", `${ACCESS_COOKIE}=not.a.real.token`);

    expect(res.status).toBe(401);
  });

  it("gives a tampered token the same answer as no token at all", async () => {
    // Distinguishing them would tell an attacker whether a token was ever valid.
    const cookie = await sessionCookie();
    const tampered = `${cookie.slice(0, -2)}xy`;

    const forged = await request(h.app).get("/auth/session").set("Cookie", tampered);
    const absent = await request(h.app).get("/auth/session");

    expect(forged.status).toBe(absent.status);
    expect(forged.body).toEqual(absent.body);
  });

  it("treats the refresh cookie as no session, since only the access token is one", async () => {
    const { message, signature } = await signIn(h);
    const verified = await request(h.app)
      .post("/auth/verify")
      .send({ message, signature, turnstileToken: "ok" });

    const res = await request(h.app)
      .get("/auth/session")
      .set("Cookie", `${REFRESH_COOKIE}=${cookieValue(verified, REFRESH_COOKIE)}`);

    expect(res.status).toBe(401);
  });

  it("grants no authority beyond what the presented token already carried", async () => {
    // Everything returned is a claim inside the token the caller already sent, so this
    // route cannot be a privilege escalation — it is a read of the request's own
    // credential. Pinned as a contract so a later edit cannot quietly widen it.
    const cookie = await sessionCookie();

    const res = await request(h.app).get("/auth/session").set("Cookie", cookie);

    expect(Object.keys(res.body).sort()).toEqual(["address", "did", "roles"]);
  });
});
