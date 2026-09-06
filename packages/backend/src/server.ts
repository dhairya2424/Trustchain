import express, { type Express } from "express";

/** Skeleton app factory. Routing, auth and persistence arrive in Phase 2. */
export function createServer(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "trustchain-backend" });
  });

  return app;
}
