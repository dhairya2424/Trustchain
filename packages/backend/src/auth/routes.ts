import { Router, type CookieOptions, type Request, type Response } from "express";
import { RateLimiterMemory, type RateLimiterAbstract } from "rate-limiter-flexible";
import { z } from "zod";
import { parseSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";

import { asyncHandler } from "../http/middleware";
import type { FailureTracker } from "./failureTracker";
import type { NonceService } from "./nonce";
import type { RoleReader } from "./roleReader";
import type { SiweVerifier } from "./siwe";
import { TokenError, type TokenService } from "./tokens";
import type { TurnstileVerifier } from "./turnstile";

export const ACCESS_COOKIE = "trustchain_session";
export const REFRESH_COOKIE = "trustchain_refresh";

const verifyBodySchema = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "signature must be 0x-prefixed hex"),
  // Optional in the schema on purpose: a missing bot token is a failed bot check (403),
  // not a malformed request (400). Both are rejections, but only one is worth counting
  // against the caller as suspicious.
  turnstileToken: z.string().optional(),
});

export interface AuthDependencies {
  nonces: NonceService;
  tokens: TokenService;
  roles: RoleReader;
  siwe: SiweVerifier;
  turnstile: TurnstileVerifier;
  failures: FailureTracker;
  rateLimiter?: RateLimiterAbstract;
  config: {
    domain: string;
    origin: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    cookieDomain: string;
    secureCookies: boolean;
    rateLimitPoints: number;
    rateLimitWindowSeconds: number;
  };
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Session cookies.
 *
 * httpOnly so script cannot read the token — an XSS becomes a request-forgery problem
 * rather than an instant credential theft. SameSite=Strict so a third-party site cannot
 * ride the session. Secure everywhere except local http development. Never localStorage.
 */
function cookieOptions(deps: AuthDependencies, maxAgeSeconds: number, path = "/"): CookieOptions {
  return {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: "strict",
    domain: deps.config.cookieDomain,
    path,
    maxAge: maxAgeSeconds * 1000,
  };
}

export function createAuthRouter(deps: AuthDependencies): Router {
  const router = Router();

  const limiter =
    deps.rateLimiter ??
    new RateLimiterMemory({
      points: deps.config.rateLimitPoints,
      duration: deps.config.rateLimitWindowSeconds,
      keyPrefix: "auth",
    });

  // Every /auth/* route is rate limited per IP before any work happens, so a flood costs
  // the attacker a request and costs us a counter increment.
  router.use(
    asyncHandler(async (req: Request, res: Response, next) => {
      const ip = clientIp(req);

      const block = await deps.failures.status(ip);
      if (block.blocked) {
        res.setHeader("Retry-After", String(block.retryAfterSeconds));
        res.status(429).json({
          error: "too_many_failures",
          retryAfterSeconds: block.retryAfterSeconds,
        });
        return;
      }

      try {
        await limiter.consume(ip);
        next();
      } catch (rejection) {
        const retryAfter = Math.ceil(
          ((rejection as { msBeforeNext?: number })?.msBeforeNext ?? 1000) / 1000,
        );
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "rate_limited", retryAfterSeconds: retryAfter });
      }
    }),
  );

  router.get(
    "/nonce",
    asyncHandler(async (_req, res) => {
      const issued = await deps.nonces.issue();
      // A nonce must never be cached; a shared cache would hand the same one to two clients.
      res.setHeader("Cache-Control", "no-store");
      res.json(issued);
    }),
  );

  router.post(
    "/verify",
    asyncHandler(async (req, res) => {
      const ip = clientIp(req);

      const parsed = verifyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        await deps.failures.recordFailure(ip);
        res.status(400).json({
          error: "invalid_request",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
        return;
      }

      const { message, signature, turnstileToken } = parsed.data;

      // Bot check first: it is the cheapest way to reject automated traffic, and doing it
      // before signature recovery keeps that cost off our CPU. A missing token fails here.
      if (!(await deps.turnstile.verify(turnstileToken ?? "", ip))) {
        await deps.failures.recordFailure(ip);
        res.status(403).json({ error: "bot_check_failed" });
        return;
      }

      let nonce: string | undefined;
      try {
        nonce = parseSiweMessage(message).nonce;
      } catch {
        nonce = undefined;
      }

      if (!nonce) {
        await deps.failures.recordFailure(ip);
        res.status(400).json({ error: "malformed_siwe_message" });
        return;
      }

      // Consume before verifying the signature. A nonce presented twice is spent even if
      // the second attempt carries a bad signature, so an attacker cannot probe with a
      // captured nonce and keep it alive for a later try.
      if (!(await deps.nonces.consume(nonce))) {
        await deps.failures.recordFailure(ip);
        res.status(401).json({ error: "invalid_or_expired_nonce" });
        return;
      }

      const result = await deps.siwe.verify(message, signature as Hex);
      if (!result.ok) {
        await deps.failures.recordFailure(ip);
        const status = result.reason === "malformed_message" ? 400 : 401;
        res.status(status).json({ error: result.reason });
        return;
      }

      const address = result.address;

      // Authorization comes from the chain, never from anything the client sent.
      const identity = await deps.roles.read(address);

      const accessToken = await deps.tokens.issueAccessToken({
        address,
        did: identity.did,
        roles: identity.roles,
      });
      const refreshToken = await deps.tokens.issueRefreshToken(address);

      await deps.failures.recordSuccess(ip);

      res
        .cookie(ACCESS_COOKIE, accessToken, cookieOptions(deps, deps.config.accessTtlSeconds))
        .cookie(
          REFRESH_COOKIE,
          refreshToken,
          cookieOptions(deps, deps.config.refreshTtlSeconds, "/auth"),
        )
        .json({ address, did: identity.did, roles: identity.roles });
    }),
  );

  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      const token = req.cookies?.[REFRESH_COOKIE];
      if (!token) {
        res.status(401).json({ error: "missing_refresh_token" });
        return;
      }

      try {
        const { address, refreshToken } = await deps.tokens.rotateRefreshToken(token);

        // Re-read the chain on every refresh. A role revoked a minute ago must not survive
        // in a session just because the holder keeps refreshing.
        const identity = await deps.roles.read(address as Address);
        const accessToken = await deps.tokens.issueAccessToken({
          address,
          did: identity.did,
          roles: identity.roles,
        });

        res
          .cookie(ACCESS_COOKIE, accessToken, cookieOptions(deps, deps.config.accessTtlSeconds))
          .cookie(
            REFRESH_COOKIE,
            refreshToken,
            cookieOptions(deps, deps.config.refreshTtlSeconds, "/auth"),
          )
          .json({ address, did: identity.did, roles: identity.roles });
      } catch (error) {
        const code = error instanceof TokenError ? error.code : "invalid_token";

        // A replayed refresh token means one of the two holders is an attacker and we
        // cannot tell which, so both are signed out.
        res
          .clearCookie(ACCESS_COOKIE, cookieOptions(deps, 0))
          .clearCookie(REFRESH_COOKIE, cookieOptions(deps, 0, "/auth"))
          .status(401)
          .json({ error: code });
      }
    }),
  );

  router.post(
    "/logout",
    asyncHandler(async (req, res) => {
      const token = req.cookies?.[REFRESH_COOKIE];
      if (token) await deps.tokens.revokeByToken(token);

      res
        .clearCookie(ACCESS_COOKIE, cookieOptions(deps, 0))
        .clearCookie(REFRESH_COOKIE, cookieOptions(deps, 0, "/auth"))
        .status(204)
        .end();
    }),
  );

  return router;
}
