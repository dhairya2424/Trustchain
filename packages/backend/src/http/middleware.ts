import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";

import type { Logger } from "./logger";
import { sanitizeDeep } from "./sanitize";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
    validated?: unknown;
  }
}

const REQUEST_ID_HEADER = "x-request-id";
/** Only accept an inbound id that looks like one — it ends up in logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Assigns every request a stable id, echoed back in the response.
 *
 * An inbound id is honoured so a trace survives across services, but only after shape
 * checking: an unvalidated header would let a caller inject newlines into log lines and
 * forge entries.
 */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header(REQUEST_ID_HEADER);
    const id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();

    req.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

export interface ValidationOptions {
  logger: Logger;
  source?: "body" | "query" | "params";
}

/**
 * Validates a request against a zod schema and stores the parsed result.
 *
 * Handlers read `req.validated`, never `req.body`. That is the point: the raw body stays
 * out of reach, so an unexpected field cannot be picked up further downstream.
 *
 * Failures are logged with the request id and the offending paths — never the values,
 * which is how a rejected password ends up in a log file.
 */
export function validate<S extends ZodTypeAny>(
  schema: S,
  options: ValidationOptions,
): RequestHandler {
  const source = options.source ?? "body";

  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        code: issue.code,
        message: issue.message,
      }));

      options.logger.log({
        level: "warn",
        msg: "request.validation_failed",
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        source,
        issues,
      });

      res.status(400).json({ error: "invalid_request", requestId: req.requestId, issues });
      return;
    }

    req.validated = result.data as z.infer<S>;
    next();
  };
}

/** Typed accessor so handlers do not re-cast `req.validated` everywhere. */
export function validated<T>(req: Request): T {
  return req.validated as T;
}

/**
 * Sanitises the validated body in place, before a handler ever sees it.
 *
 * Runs after `validate`, not before. Sanitising first would let a payload that fails the
 * schema still be quietly repaired into one that passes — a string of 300 characters of
 * markup collapsing to 40 characters of text would slip past a length rule the author
 * intended to enforce on what the user actually sent. Validating first means the schema
 * judges the real input and the sanitiser only cleans what was already acceptable.
 *
 * This is the store-clean half. `sanitizeResponses` is the render-clean half, and both
 * exist because neither is sufficient: this one cannot clean rows written by a migration
 * or read from a chain event, and that one cannot stop dirty data being stored.
 */
export function sanitizeInput(options: { logger: Logger }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.validated === undefined) return next();

    const { value, findings } = sanitizeDeep(req.validated);
    const fields = Object.keys(findings);

    if (fields.length > 0) {
      options.logger.log({
        level: "warn",
        msg: "security.input_sanitized",
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        // Field paths and finding names only — never the value, which is the payload.
        fields,
        findings,
      });
    }

    req.validated = value;
    next();
  };
}
