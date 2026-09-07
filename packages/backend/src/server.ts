import express, { type Express, type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import { updateProfileRequest } from "@trustchain/shared";

import { createAssetRouter, type AssetDependencies } from "./assets/routes";
import { createAuditRouter, type AuditDependencies } from "./audit/routes";
import { createNetworkRouter, type NetworkDependencies } from "./chain/routes";
import { createAuthRouter, type AuthDependencies } from "./auth/routes";
import { createCredentialRouter, type CredentialDependencies } from "./credentials/routes";
import { createProfileRouter, type ProfileDependencies } from "./profiles/routes";
import { ConsoleLogger, type Logger } from "./http/logger";
import { errorHandler, requestId, sanitizeInput, validate } from "./http/middleware";
import { corsMiddleware } from "./http/cors";
import { requireHttps, sanitizeResponses, securityHeaders } from "./http/securityHeaders";

export interface SecurityOptions {
  /** Send HSTS. Off for a plain-HTTP local run. */
  hsts?: boolean;
  /** Refuse plain-HTTP requests. On in production, where Nginx terminates TLS. */
  requireHttps?: boolean;
}

export interface ServerOptions {
  auth?: AuthDependencies;
  profiles?: ProfileDependencies;
  assets?: AssetDependencies;
  audit?: AuditDependencies;
  /** Reports which chain is active. Public — see chain/routes.ts. */
  network?: NetworkDependencies;
  credentials?: CredentialDependencies;
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

  if (options.audit) {
    app.use("/audit", createAuditRouter(options.audit));
  }

  if (options.credentials) {
    app.use("/credentials", createCredentialRouter(options.credentials));
  }

  // Last, after every route. Handlers are wrapped in `asyncHandler`, which forwards a
  // rejected promise here — without it Express 4 would leave the request hanging with no
  // response at all, which turns a dependency outage into a pile of stuck connections.
  app.use(errorHandler({ logger }));

  return app;
}
