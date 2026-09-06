import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { updateProfileRequest } from "@trustchain/shared";

import { createAuthRouter, type AuthDependencies } from "./auth/routes";
import { createProfileRouter, type ProfileDependencies } from "./profiles/routes";
import { ConsoleLogger, type Logger } from "./http/logger";
import { requestId, validate } from "./http/middleware";

export interface ServerOptions {
  auth?: AuthDependencies;
  profiles?: ProfileDependencies;
  logger?: Logger;
}

export function createServer(options: ServerOptions = {}): Express {
  const app = express();
  const logger = options.logger ?? new ConsoleLogger();

  app.disable("x-powered-by");
  // req.ip must reflect the real client, not the proxy, or per-IP limiting protects
  // nothing. Nginx sits in front in production (see P2.5).
  app.set("trust proxy", 1);

  app.use(requestId());
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "trustchain-backend" });
  });

  if (options.auth) {
    app.use("/auth", createAuthRouter(options.auth));
  }

  if (options.profiles) {
    app.patch("/profiles/me", validate(updateProfileRequest, { logger }));
    app.use("/profiles", createProfileRouter(options.profiles));
  }

  return app;
}
