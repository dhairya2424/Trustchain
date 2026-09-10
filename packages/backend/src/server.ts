import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import cookieParser from "cookie-parser";
import { updateProfileRequest } from "@trustchain/shared";

import { createAssetRouter, type AssetDependencies } from "./assets/routes";
import { createAuditRouter, type AuditDependencies } from "./audit/routes";
import { createNetworkRouter, type NetworkDependencies } from "./chain/routes";
import { createStreamRouter, type StreamDependencies } from "./stream/routes";
import { createIdentityRouter, type IdentityDependencies } from "./identity/routes";
import { createAuthRouter, type AuthDependencies } from "./auth/routes";
import { createCredentialRouter, type CredentialDependencies } from "./credentials/routes";
import { createProfileRouter, type ProfileDependencies } from "./profiles/routes";
import { createRoleRouter, type RoleDependencies } from "./roles/routes";
import { ConsoleLogger, type Logger } from "./http/logger";
import { errorHandler, requestId, sanitizeInput, validate } from "./http/middleware";
import { validateResponses } from "./http/responseValidation";
import { corsMiddleware } from "./http/cors";
import { requireHttps, sanitizeResponses, securityHeaders } from "./http/securityHeaders";

export interface SecurityOptions {
  /** Send HSTS. Off for a plain-HTTP local run. */
  hsts?: boolean;
  /** Refuse plain-HTTP requests. On in production, where Nginx terminates TLS. */
  requireHttps?: boolean;
  /**
   * Validate outgoing responses against their DTO contract and throw on an extra field.
   * On in development and test, off in production. See http/responseValidation.ts.
   */
  validateResponses?: boolean;
}

export interface ServerOptions {
  auth?: AuthDependencies;
  profiles?: ProfileDependencies;
  assets?: AssetDependencies;
  audit?: AuditDependencies;
  /** Reports which chain is active. Public — see chain/routes.ts. */
  network?: NetworkDependencies;
  credentials?: CredentialDependencies;
  /** Role administration: two prepare endpoints and a public-ish read. */
  roles?: RoleDependencies;
  /** Server-sent events: confirmed chain activity, pushed rather than polled. */
  stream?: StreamDependencies;
  /** Public DID resolution. No session — a DID only its issuer can resolve is not one. */
  identity?: IdentityDependencies;
  logger?: Logger;
  security?: SecurityOptions;
  /**
   * Origins allowed to call this API from a browser.
   *
   * Absent means no cross-origin access, which is correct for an API with no browser
   * client. It is never a reason to reflect whatever Origin arrived.
   */
  allowedOrigins?: readonly string[];
  /**
   * Per-request access logging, injected rather than constructed.
   *
   * `createServer` stays free of a logging transport so tests can build a server without
   * starting pino; `index.ts` supplies `httpLogger(...)` for the real process.
   */
  httpLogger?: RequestHandler;
}

export function createServer(options: ServerOptions = {}): Express {
  const app = express();
  const logger = options.logger ?? new ConsoleLogger();
  const security = options.security ?? {};

  app.disable("x-powered-by");
  // req.ip must reflect the real client, not the proxy, or per-IP limiting protects
  // nothing. It is also what `req.secure` reads X-Forwarded-Proto through, which is how
  // requireHttps sees the scheme the browser actually used. Nginx sits in front in
  // production (infra/nginx/), and this must stay in step with that hop count: trusting
  // more proxies than exist lets a client forge its own address.
  app.set("trust proxy", 1);

  // First, before any route, any error handler and any 404. A response that skips the rest
  // of the stack must still carry its headers.
  app.use(...securityHeaders({ ...(security.hsts !== undefined ? { hsts: security.hsts } : {}) }));

  app.use(requestId());

  // Before the rest of the stack: a preflight carries no cookies, no body and no session,
  // and answering it early keeps an OPTIONS request from paying for parsing and logging it
  // has no use for. After requestId so a refusal is still traceable.
  if (options.allowedOrigins?.length) {
    app.use(corsMiddleware({ allowedOrigins: options.allowedOrigins, logger }));
  }

  if (security.requireHttps) {
    app.use(requireHttps({ enabled: true, logger }));
  }

  // After requestId, so an access line carries the same id as the application lines it
  // belongs with.
  if (options.httpLogger) app.use(options.httpLogger);

  app.use(sanitizeResponses({ logger }));

  // After the sanitiser so it inspects the body the handler produced, before that body is
  // trimmed or serialised. Off in production — a contract quirk must never be able to fail a
  // live response — and on everywhere else, where a leaked or extra field should be loud.
  app.use(
    validateResponses({
      enabled: security.validateResponses ?? process.env.NODE_ENV !== "production",
      logger,
    }),
  );

  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "trustchain-backend" });
  });

  if (options.auth) {
    app.use("/auth", createAuthRouter(options.auth));
  }

  if (options.profiles) {
    app.patch(
      "/profiles/me",
      validate(updateProfileRequest, { logger }),
      sanitizeInput({ logger }),
    );
    app.use("/profiles", createProfileRouter(options.profiles));
  }

  if (options.assets) {
    app.use("/assets", createAssetRouter(options.assets));
  }

  if (options.network) {
    app.use("/network", createNetworkRouter(options.network));
  }

  if (options.identity) {
    app.use("/identity", createIdentityRouter(options.identity));
  }

  if (options.stream) {
    app.use("/stream", createStreamRouter(options.stream));
  }

  if (options.audit) {
    app.use("/audit", createAuditRouter(options.audit));
  }

  if (options.credentials) {
    app.use("/credentials", createCredentialRouter(options.credentials));
  }

  if (options.roles) {
    app.use("/roles", createRoleRouter(options.roles));
  }

  // An explicit JSON 404 for anything unmatched.
  //
  // Without this, an unknown path falls through to Express's built-in `finalhandler`, which
  // sends an HTML error page and — as a defence for that page — stamps its own
  // `Content-Security-Policy: default-src 'none'` over the one helmet set. That reduced
  // header drops `frame-ancestors` and `form-action`, which do not fall back to
  // `default-src`, so a 404 page became framable and form-targetable while every real
  // response was locked down. An OWASP ZAP baseline flagged exactly that as a Medium
  // ("CSP: Failure to Define Directive with No Fallback"). Answering the 404 ourselves keeps
  // helmet's full policy and returns the JSON shape the rest of the API uses.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", requestId: req.requestId });
  });

  // Last, after every route. Handlers are wrapped in `asyncHandler`, which forwards a
  // rejected promise here — without it Express 4 would leave the request hanging with no
  // response at all, which turns a dependency outage into a pile of stuck connections.
  app.use(errorHandler({ logger }));

  return app;
}
