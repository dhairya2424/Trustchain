import type { Request } from "express";

import type { Caller, CallerResolver } from "../http/authorize";
import type { Logger } from "../http/logger";
import type { TokenService } from "./tokens";
import { ACCESS_COOKIE } from "./routes";

/**
 * Turns a session cookie into a caller.
 *
 * The token is verified, never merely decoded — an unverified JWT is a client-supplied
 * JSON blob and treating its `roles` claim as authorization would let anyone mint
 * themselves an ADMIN session with a text editor.
 *
 * What comes back is identity plus the roles held *at sign-in*. Those claims are enough to
 * decide what to show someone, and deliberately not enough to authorise a state change:
 * mutations go through `requirePermission`, which re-reads the chain, because a token
 * minted before a revocation still carries the revoked role until it expires.
 *
 * A missing or invalid cookie resolves to null rather than throwing. "Not signed in" is
 * an ordinary condition on an endpoint that may or may not require a session, and the
 * middleware turns it into a 401 where that is the right answer.
 */
export function createSessionResolver(options: {
  tokens: TokenService;
  logger?: Logger;
  cookieName?: string;
}): CallerResolver {
  const cookieName = options.cookieName ?? ACCESS_COOKIE;

  return async (req: Request): Promise<Caller | null> => {
    const token = (req.cookies as Record<string, string> | undefined)?.[cookieName];
    if (!token) return null;

    try {
      const payload = await options.tokens.verifyAccessToken(token);
      const address = payload.sub;
      if (typeof address !== "string" || address.length === 0) return null;

      const roles = Array.isArray(payload.roles)
        ? (payload.roles as unknown[]).filter((r): r is string => typeof r === "string")
        : [];

      return {
        address,
        didHash: typeof payload.did === "string" ? payload.did : null,
        roles,
      };
    } catch (error) {
      // Logged at debug: an expired cookie is routine, and warning on every one of them
      // would bury the failures that matter.
      options.logger?.log({
        level: "debug",
        msg: "session.token_rejected",
        requestId: req.requestId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  };
}
