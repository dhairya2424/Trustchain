import { Router, type Request } from "express";
import { profileMutableFields, type UpdateProfileRequest } from "@trustchain/shared";

import { applyAllowlist, logRejectedFields } from "../http/allowlist";
import type { Logger } from "../http/logger";
import { asyncHandler, validated } from "../http/middleware";
import type { ProfileRepository } from "./repository";

export interface ProfileDependencies {
  profiles: ProfileRepository;
  logger: Logger;
  /** Resolves the caller's DID from the session. Injected so tests need no auth stack. */
  resolveCaller: (req: Request) => { didHash: string; address: string } | null;
}

export function createProfileRouter(deps: ProfileDependencies): Router {
  const router = Router();

  router.get(
    "/me",
    asyncHandler(async (req, res) => {
      const caller = deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }

      const profile = await deps.profiles.find(caller.didHash);
      if (!profile) {
        res.status(404).json({ error: "profile_not_found" });
        return;
      }

      res.json(profile);
    }),
  );

  /**
   * Two independent defences, on purpose.
   *
   * The schema is `.strict()`, so an unknown field is a 400 before anything else runs.
   * The allowlist then filters again, which matters because a schema can be loosened by
   * one careless edit while the allowlist is the thing an auditor actually reads. Either
   * alone would work today; both together survive a bad refactor.
   */
  router.patch(
    "/me",
    asyncHandler(async (req, res) => {
      const caller = deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }

      const body = validated<UpdateProfileRequest>(req) as Record<string, unknown>;
      const { data, rejected } = applyAllowlist<UpdateProfileRequest>(body, profileMutableFields);

      logRejectedFields(deps.logger, rejected, {
        requestId: req.requestId,
        actor: caller.address,
        method: req.method,
        path: req.path,
      });

      const updated = await deps.profiles.update(caller.didHash, data);
      if (!updated) {
        res.status(404).json({ error: "profile_not_found" });
        return;
      }

      res.json(updated);
    }),
  );

  return router;
}
