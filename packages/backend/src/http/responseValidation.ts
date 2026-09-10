import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { Logger } from "./logger";
import {
  FORBIDDEN_KEY_EXACT,
  FORBIDDEN_KEY_SUBSTRINGS,
  RESPONSE_CONTRACTS,
} from "./responseContracts";

/**
 * Response validation: the guard that keeps internal fields out of the wire.
 *
 * Two independent checks run on every JSON response, in development and test only:
 *
 *   1. **The denylist floor.** No response, from any endpoint, may contain a field whose name
 *      looks like server-only material — a private key, password, secret, seed. This holds
 *      even for endpoints with no contract of their own.
 *
 *   2. **The strict contract.** A 2xx response from an endpoint listed in responseContracts.ts
 *      is parsed against a `.strict()` schema, so an *extra* field — one the DTO does not
 *      name — throws. This is the "trim API responses" enforcement: a handler that spreads one
 *      field too many out of an internal record is caught the first time it runs.
 *
 * A violation throws. Handlers call `res.json` inside the async wrapper, so the throw unwinds
 * into the error handler and becomes a 500 the developer cannot miss — nothing was sent,
 * because the check runs before the real `res.json`. In production the middleware is a
 * pass-through: zero overhead, and no chance of a contract quirk taking down a live response.
 *
 * It is mounted after {@link sanitizeResponses} so it inspects the body the handler produced,
 * then hands off to the sanitiser and the real serialiser.
 */

export class ResponseContractError extends Error {
  constructor(
    message: string,
    readonly detail: { method: string; path: string; status: number; fields: string[] },
  ) {
    super(message);
    this.name = "ResponseContractError";
  }
}

/** Field-name paths whose name matches the server-only denylist, at any depth. */
function forbiddenKeyPaths(value: unknown, base = "", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, i) => forbiddenKeyPaths(item, `${base}[${i}]`, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const norm = key.toLowerCase().replace(/[_-]/g, "");
      const path = base ? `${base}.${key}` : key;
      const substringHit = FORBIDDEN_KEY_SUBSTRINGS.some((f) => norm.includes(f));
      const exactHit = FORBIDDEN_KEY_EXACT.includes(norm);
      if (substringHit || exactHit) found.push(path);
      forbiddenKeyPaths(child, path, found);
    }
  }
  return found;
}

/** The unknown-key paths a strict schema rejected, flattened for a readable message. */
function unknownKeyPaths(error: z.ZodError): string[] {
  const paths: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      const prefix = issue.path.join(".");
      for (const key of issue.keys) paths.push(prefix ? `${prefix}.${key}` : key);
    }
  }
  return paths;
}

export interface ResponseValidationOptions {
  /** When false the middleware does nothing. Defaults follow NODE_ENV at the call site. */
  enabled: boolean;
  logger: Logger;
}

export function validateResponses(options: ResponseValidationOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.enabled) return next();

    const original = res.json.bind(res);

    res.json = (body: unknown) => {
      const status = res.statusCode;

      // 1 — the denylist floor, on every response.
      const leaked = forbiddenKeyPaths(body);
      if (leaked.length > 0 && !res.headersSent) {
        throw new ResponseContractError(
          `response carries server-only field(s) [${leaked.join(", ")}] — these must never ` +
            `leave the backend`,
          { method: req.method, path: req.path, status, fields: leaked },
        );
      }

      // 2 — the strict contract, on a matched 2xx response.
      if (status >= 200 && status < 300) {
        const contract = RESPONSE_CONTRACTS.find(
          (c) => c.method === req.method && c.pattern.test(req.path),
        );

        if (contract) {
          const result = contract.schema.safeParse(body);
          if (!result.success && !res.headersSent) {
            const extra = unknownKeyPaths(result.error);
            if (extra.length > 0) {
              throw new ResponseContractError(
                `response for ${req.method} ${req.path} has field(s) not in the ` +
                  `${contract.name} contract: [${extra.join(", ")}] — add them to the DTO or ` +
                  `stop returning them`,
                { method: req.method, path: req.path, status, fields: extra },
              );
            }
            // A non-key failure (a value that did not match a loose type) is not a leak and
            // not what this guard is for; it is logged, never thrown, so a mistyped contract
            // value cannot take down a correct response.
            options.logger.log({
              level: "debug",
              msg: "response.contract_value_mismatch",
              requestId: req.requestId,
              path: req.path,
              contract: contract.name,
            });
          }
        } else {
          // Visible, not fatal: a 2xx body with no strict contract is held only to the
          // denylist. Logged once-ish so the audit can see which endpoints are uncontracted.
          options.logger.log({
            level: "debug",
            msg: "response.no_contract",
            requestId: req.requestId,
            method: req.method,
            path: req.path,
          });
        }
      }

      return original(body);
    };

    next();
  };
}
