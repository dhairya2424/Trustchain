import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Address } from "viem";

import type { PermissionReader } from "../auth/roleReader";
import { hasAnyRole, roleNames, type PermissionName, type RoleName } from "../auth/roles";
import type { Logger } from "./logger";

declare module "express-serve-static-core" {
  interface Request {
    caller?: Caller;
  }
}

export interface Caller {
  address: string;
  didHash: string | null;
  /** Role ids as the chain returned them at sign-in. */
  roles: readonly string[];
}

/**
 * Resolves the caller from the request.
 *
 * Allowed to be asynchronous because verifying a signed session token is: the real
 * implementation checks an RS256 signature. Tests supply a synchronous function and the
 * `await` below accepts both.
 */
export type CallerResolver = (req: Request) => Caller | null | Promise<Caller | null>;

export interface AuthorizeOptions {
  resolve: CallerResolver;
  logger: Logger;
  /**
   * Reads authorization from the chain. Required for permission gating; when absent,
   * `requirePermission` refuses every request rather than falling back to the session's
   * cached roles — failing closed is the only safe direction for an authorization check
   * whose authority is unavailable.
   */
  permissions?: PermissionReader;
}

function deny(
  res: Response,
  req: Request,
  logger: Logger,
  status: number,
  error: string,
  detail: Record<string, unknown> = {},
): void {
  logger.log({
    level: "warn",
    msg: "security.authorization_denied",
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    error,
    ...detail,
  });
  res.status(status).json({ error, requestId: req.requestId });
}

/**
 * Requires an authenticated session and attaches the caller to the request.
 *
 * Authentication only — it says who is calling, never what they may do.
 */
export function requireSession(options: AuthorizeOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const caller = await options.resolve(req);
      if (!caller) {
        deny(res, req, options.logger, 401, "unauthenticated");
        return;
      }

      req.caller = caller;
      next();
    })();
  };
}

/**
 * Requires one of the named roles, judged against the session's role claims.
 *
 * This is the cheap gate, and it is deliberately only used for *reads*. The claims were
 * read from the chain at sign-in, so they can be up to one access-token lifetime stale —
 * acceptable for deciding whether to render an audit page, not acceptable for authorising
 * a state change. Mutations go through `requirePermission`, which re-reads the chain.
 */
export function requireRole(
  options: AuthorizeOptions & { roles: readonly RoleName[] },
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const caller = req.caller ?? (await options.resolve(req));
      if (!caller) {
        deny(res, req, options.logger, 401, "unauthenticated");
        return;
      }

      req.caller = caller;

      if (!hasAnyRole(caller.roles, options.roles)) {
        deny(res, req, options.logger, 403, "forbidden", {
          actor: caller.address,
          required: options.roles,
          held: roleNames(caller.roles),
        });
        return;
      }

      next();
    })();
  };
}

/**
 * Requires an on-chain permission, read from RoleAccessControl at request time.
 *
 * This is the control that matters, and it exists to satisfy the platform's first hard
 * rule: only on-chain roles authorize mutations. The session's role claims are not
 * consulted at all here — a token minted before a revocation would still carry the role,
 * and honouring it would mean the API had granted access the chain no longer does.
 *
 * The contract enforces the same permission again when the transaction lands, so this
 * check is not the last line of defence. It is the one that produces a clean 403 and an
 * audit line instead of a reverted transaction and a wasted relayer fee.
 *
 * An RPC failure is a 503, never an allow. If we cannot ask who is authorised, we do not
 * guess.
 */
export function requirePermission(
  options: AuthorizeOptions & { permission: PermissionName },
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const caller = req.caller ?? (await options.resolve(req));
      if (!caller) {
        deny(res, req, options.logger, 401, "unauthenticated");
        return;
      }

      req.caller = caller;

      const reader = options.permissions;
      if (!reader) {
        deny(res, req, options.logger, 503, "authorization_unavailable", {
          detail: "no permission reader configured",
        });
        return;
      }

      let permitted: boolean;
      try {
        permitted = await reader.hasPermission(caller.address as Address, options.permission);
      } catch (error) {
        deny(res, req, options.logger, 503, "authorization_unavailable", {
          actor: caller.address,
          permission: options.permission,
          detail: error instanceof Error ? error.message : "unknown",
        });
        return;
      }

      if (!permitted) {
        deny(res, req, options.logger, 403, "forbidden", {
          actor: caller.address,
          permission: options.permission,
        });
        return;
      }

      next();
    })();
  };
}
