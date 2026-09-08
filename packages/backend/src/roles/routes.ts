import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";

import {
  encodeGrantRoleToDID,
  encodeRevokeRoleFromDID,
  prepareForwardedCall,
} from "../chain/forwarding";
import { toNetworkDto } from "../chain/routes";
import { serializeTypedData } from "../chain/forwardRequest";
import type { NetworkSelector } from "../chain/networkSelector";
import type { PermissionReader, RoleReader } from "../auth/roleReader";
import { ROLE_IDS, ROLE_NAMES, type RoleName } from "../auth/roles";
import { asyncHandler } from "../http/middleware";
import { requirePermission, requireSession, type CallerResolver } from "../http/authorize";
import type { Logger } from "../http/logger";

/**
 * Role administration.
 *
 * Two prepare endpoints and one read. The prepare endpoints deliberately do not submit
 * anything: they return EIP-712 typed data for the caller to sign, exactly like asset
 * minting and credential issuance, and the signed request goes back through
 * `POST /network/forward`.
 *
 * That indirection is the whole point. A role change is the most consequential write in the
 * system — it is how someone becomes able to make every other write — so it must be
 * attributable to the human who asked for it and not to the relayer that paid the gas. With
 * ERC-2771 the contract sees the actor recovered from their own signature, so
 * `grantRoleToDID` enforces "you administer this role" against the ADMIN, not against a
 * relayer that would otherwise hold that authority on everyone's behalf.
 *
 * Roles attach to a DID rather than to an address, following the problem statement: rights
 * belong to a verified identity. The contract resolves the DID's active controller when the
 * transaction executes, so a key rotation carries the role with it instead of stranding it
 * on an old wallet.
 */

export interface RoleDependencies {
  chain: NetworkSelector;
  logger: Logger;
  resolveCaller: CallerResolver;
  /** Reads authorization from the chain. Required — see requirePermission. */
  permissions: PermissionReader;
  /** Reads roles and DID for an arbitrary address. */
  roles: RoleReader;
}

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex string");

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed address");

/**
 * The role is named, never supplied as a raw hash.
 *
 * Accepting a bytes32 would let a caller prepare a grant for any role identifier the
 * contract happens to recognise, including `DEFAULT_ADMIN_ROLE` — the one role that
 * administers every other. Constraining the input to the four names the platform defines
 * means the API cannot be used to prepare a call outside that set at all, rather than
 * relying on the contract to refuse it.
 */
const roleChange = z
  .object({
    didHash: bytes32,
    role: z.enum(ROLE_NAMES),
  })
  .strict();

export function createRoleRouter(deps: RoleDependencies): Router {
  const router = Router();

  const authorize = {
    resolve: deps.resolveCaller,
    logger: deps.logger,
    permissions: deps.permissions,
  };

  /**
   * Roles held by an address.
   *
   * Requires a session but no particular role. The data is public — it is on a public
   * chain, and anyone can read `rolesOf` directly — so gating it on ADMIN would be
   * security theatre that only stops the honest. The session requirement exists because
   * this endpoint makes the platform do a chain read on request, and an unauthenticated
   * amplifier is worth avoiding.
   */
  router.get(
    "/:address",
    requireSession({ resolve: deps.resolveCaller, logger: deps.logger }),
    asyncHandler(async (req, res) => {
      const parsed = evmAddress.safeParse(req.params.address);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_address", requestId: req.requestId });
        return;
      }

      const identity = await deps.roles.read(parsed.data as Address);

      res.json({
        address: parsed.data,
        did: identity.did,
        roles: identity.roles,
      });
    }),
  );

  const prepare = (kind: "grant" | "revoke") =>
    asyncHandler(async (req, res) => {
      const caller = await deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }

      const parsed = roleChange.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const { didHash, role } = parsed.data;
      const roleId = ROLE_IDS[role as RoleName];

      const chain = await deps.chain.active();

      const prepared = await prepareForwardedCall({
        chain,
        chainId: chain.network.chainId,
        // The session's own address, never anything from the body. A caller cannot prepare
        // a role change attributed to someone else.
        actor: caller.address,
        target: chain.contracts.RoleAccessControl,
        data:
          kind === "grant"
            ? encodeGrantRoleToDID(didHash, roleId)
            : encodeRevokeRoleFromDID(didHash, roleId),
        action: `${kind === "grant" ? "Grant" : "Revoke"} ${role}`,
      });

      // Logged at prepare rather than only at forward, because a prepared-but-unsigned role
      // change is itself worth seeing: a burst of them from one account is what an attempt
      // to find an unguarded path looks like.
      deps.logger.log({
        level: "info",
        msg: `role.${kind}_prepared`,
        requestId: req.requestId,
        actor: caller.address,
        didHash,
        role,
        network: chain.network.id,
      });

      // 200, not 202. Nothing has been submitted; this is a document to sign.
      res.status(200).json({
        role,
        didHash,
        network: toNetworkDto(chain.network),
        typedData: serializeTypedData(prepared.typedData),
        summary: prepared.summary,
      });
    });

  /**
   * Both gated on MANAGE_ROLES, read from the chain for the caller's own address.
   *
   * The contract would refuse an unauthorised grant anyway, and that refusal is the control
   * that actually matters. This check is here so the platform does not spend relayer gas
   * discovering what it could have known first, and so the caller gets a 403 that explains
   * itself rather than a reverted transaction.
   */
  router.post(
    "/prepare-grant",
    requirePermission({ ...authorize, permission: "MANAGE_ROLES" }),
    prepare("grant"),
  );

  router.post(
    "/prepare-revoke",
    requirePermission({ ...authorize, permission: "MANAGE_ROLES" }),
    prepare("revoke"),
  );

  return router;
}
