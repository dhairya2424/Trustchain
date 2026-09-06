import express, { type Express } from "express";
import cookieParser from "cookie-parser";

import { createAuthRouter, type AuthDependencies } from "./auth/routes";

export interface ServerOptions {
  auth?: AuthDependencies;
}

export function createServer(options: ServerOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  // req.ip must reflect the real client, not the proxy, or per-IP limiting protects
  // nothing. Nginx sits in front in production (see P2.5).
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "trustchain-backend" });
  });

  if (options.auth) {
    app.use("/auth", createAuthRouter(options.auth));
  }

  return app;
}
