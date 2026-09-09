import { Router } from "express";
import { evmAddress } from "@trustchain/shared";
import { getAddress, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";

import { asyncHandler } from "../http/middleware";
import type { CallerResolver } from "../http/authorize";
import type { Logger } from "../http/logger";
import type { ChainResolver } from "../chain/binding";
import { roleNames } from "../auth/roles";
import { readOwnedAssets } from "../assets/owned";
import { encodeRegisterDIDFor, prepareForwardedCall } from "../chain/forwarding";
import { serializeTypedData } from "../chain/forwardRequest";
import { toNetworkDto } from "../chain/routes";
import { didHashFor, keyCommitmentFor } from "./didHash";

/**
 * Resolving a decentralized identifier — publicly, with no account.
 *
 * A DID that only its issuer can resolve is not decentralized in any useful sense. The
 * whole claim is that an identity is verifiable by a stranger against the chain, so this
 * endpoint takes no session and asks for no permission: everything it returns is already
 * public on a public ledger, and refusing to serve it would only mean the asker has to run
 * their own node to learn what the chain already tells everyone.
 *
 * This existed nowhere. The dashboard rendered a QR code of the raw DID hash, which scans
 * to a hex string and leads nowhere — decorative rather than functional. A QR is only worth
 * printing if pointing a camera at it produces an answer, and that requires something to
 * resolve against.
 *
 * ## What is deliberately not here
 *
 * No personal data, because none is on chain to return. The registry holds a key
 * commitment, not a key; a controller address, not a name. That is the design — the ledger
 * proves control of an identity without disclosing who holds it — and this endpoint cannot
 * leak what the chain never stored.
 */

const DID_ABI = [
  {
    type: "function",
    name: "controllerOf",
    stateMutability: "view",
    inputs: [{ name: "didHash", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [{ name: "didHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * The DIDRegistry's own access control, which is not the platform's.
 *
 * `ADMIN_ROLE` here is a grant on the DIDRegistry contract made at deployment, entirely
 * separate from the RoleAccessControl matrix. Reading it is how the registration route
 * discovers what the contract will actually accept, rather than what the platform's
 * permission model would suggest.
 */
const DID_ADMIN_ABI = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "didOf",
    stateMutability: "view",
    inputs: [{ name: "controller", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const DID_REGISTRY_ADMIN_ROLE = keccak256(toHex("ADMIN_ROLE"));

const ACL_ABI = [
  {
    type: "function",
    name: "rolesOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
] as const;

export interface IdentityDependencies {
  chain: ChainResolver;
  logger: Logger;
  /**
   * Resolves the caller from the session, for registration. Optional so the public resolver
   * still mounts on a deployment with no auth stack wired — reading an identity needs no
   * caller, and the registration route refuses when this is absent rather than assuming one.
   *
   * Note the caller's own `didHash` may be null here, and that is fine: registration reads
   * the administrator's *address* to check ADMIN_ROLE on the registry. An administrator
   * without a DID of their own can still create one for somebody else, which is exactly the
   * bootstrap case — the deployer holds ADMIN_ROLE from deployment and may hold no identity.
   */
  resolveCaller?: CallerResolver;
}

const ZERO = "0x0000000000000000000000000000000000000000";

const registerRequest = z.object({ address: evmAddress }).strict();

export function createIdentityRouter(deps: IdentityDependencies): Router {
  const router = Router();

  /**
   * Register an identity for an address.
   *
   * This is the endpoint that makes onboarding a product feature rather than an operator
   * task. Until it existed the only way to create an identity was `tools/onboard-wallet.mjs`
   * run against the deployer key, which meant a new user could sign in, see "permission
   * required" everywhere, and have no path forward that did not involve somebody opening a
   * terminal.
   *
   * ## Why the gate is ADMIN_ROLE on the DIDRegistry, and not REGISTER_DID
   *
   * The platform's permission matrix grants `PERM_REGISTER_DID` to both ADMIN and MANAGER.
   * The contract does not consult it: `registerDIDFor` is `onlyRole(ADMIN_ROLE)` against the
   * DIDRegistry's *own* AccessControl, which is a separate grant made at deployment and not
   * the RoleAccessControl matrix that governs everything else.
   *
   * So there are two different answers to "may I register an identity", and gating on the
   * wrong one would be worse than useless: a MANAGER would pass this check, sign a request,
   * spend relayer gas, and get a revert. The gate therefore asks the contract that will
   * actually decide. `PERM_REGISTER_DID` is, for now, a permission nothing reads — recorded
   * in docs/TRACEABILITY.md rather than papered over here.
   */
  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      if (!deps.resolveCaller) {
        res.status(503).json({ error: "registration_unavailable", requestId: req.requestId });
        return;
      }

      const caller = await deps.resolveCaller(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated", requestId: req.requestId });
        return;
      }

      const parsed = registerRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const subject = parsed.data.address;
      const binding = await deps.chain.active();
      const client = binding.client as PublicClient;
      const didRegistry = binding.contracts.DIDRegistry as Address;

      const isAdmin = (await client
        .readContract({
          address: didRegistry,
          abi: DID_ADMIN_ABI,
          functionName: "hasRole",
          args: [DID_REGISTRY_ADMIN_ROLE, caller.address as Address],
        })
        .catch(() => false)) as boolean;

      if (!isAdmin) {
        deps.logger.log({
          level: "warn",
          msg: "security.identity_register_refused",
          requestId: req.requestId,
          actor: caller.address,
          subject,
          reason: "not_did_registry_admin",
        });
        res.status(403).json({ error: "forbidden", requestId: req.requestId });
        return;
      }

      const didHash = didHashFor(subject, binding.network.id);

      // Two ways an identity can already exist, and they are different mistakes. The
      // contract refuses both, but "this address already has an identity" and "this hash is
      // taken" send an administrator to different places.
      const [existingController, existingDID] = (await Promise.all([
        client.readContract({
          address: didRegistry,
          abi: DID_ABI,
          functionName: "controllerOf",
          args: [didHash],
        }),
        client.readContract({
          address: didRegistry,
          abi: DID_ADMIN_ABI,
          functionName: "didOf",
          args: [subject as Address],
        }),
      ])) as [string, string];

      if (existingController && existingController !== ZERO) {
        res.status(409).json({
          error: "identity_already_registered",
          requestId: req.requestId,
          didHash,
          controller: existingController,
        });
        return;
      }

      if (existingDID && existingDID !== `0x${"0".repeat(64)}`) {
        res.status(409).json({
          error: "address_already_has_identity",
          requestId: req.requestId,
          didHash: existingDID,
        });
        return;
      }

      const prepared = await prepareForwardedCall({
        chain: binding,
        chainId: binding.network.chainId,
        // The administrator's own address. Under ERC-2771 the registry recovers this from
        // the signature, so the ADMIN_ROLE check on-chain is against the human who asked —
        // not against the relayer that pays.
        actor: caller.address,
        target: binding.contracts.DIDRegistry,
        data: encodeRegisterDIDFor(didHash, subject, keyCommitmentFor(subject)),
        action: `Register identity for ${subject.slice(0, 10)}...`,
      });

      deps.logger.log({
        level: "info",
        msg: "identity.register_prepared",
        requestId: req.requestId,
        actor: caller.address,
        subject,
        didHash,
        network: binding.network.id,
      });

      // 200, not 202. Nothing is registered until the administrator signs and forwards.
      res.status(200).json({
        didHash,
        // Checksummed for display. The schema lowercases on the way in so comparisons are
        // total; echoing that back would show an administrator an address that does not
        // look like the one in their wallet, at the moment they are checking it carefully.
        controller: getAddress(subject),
        network: toNetworkDto(binding.network),
        typedData: serializeTypedData(prepared.typedData),
        summary: prepared.summary,
      });
    }),
  );

  router.get(
    "/:didHash",
    asyncHandler(async (req, res) => {
      const didHash = String(req.params.didHash ?? "");

      // Shape-checked before it reaches a contract call, so a malformed value is a 400 here
      // rather than an RPC error surfacing as a 500.
      if (!/^0x[0-9a-fA-F]{64}$/.test(didHash)) {
        res.status(400).json({
          error: "invalid_did_hash",
          requestId: req.requestId,
          issues: ["didHash: expected 0x followed by 64 hex characters"],
        });
        return;
      }

      const binding = await deps.chain.active();
      const client = binding.client as PublicClient;

      const controller = (await client.readContract({
        address: binding.contracts.DIDRegistry as Address,
        abi: DID_ABI,
        functionName: "controllerOf",
        args: [didHash as Hex],
      })) as string;

      // An unregistered DID is a real answer, not an error: "no such identity" is exactly
      // what a verifier scanning an unknown code needs to be told.
      if (!controller || controller === ZERO) {
        res.json({
          didHash,
          registered: false,
          controller: null,
          active: false,
          roles: [],
          assets: null,
          network: toNetwork(binding),
        });
        return;
      }

      const [active, rawRoles] = await Promise.all([
        client
          .readContract({
            address: binding.contracts.DIDRegistry as Address,
            abi: DID_ABI,
            functionName: "isActive",
            args: [didHash as Hex],
          })
          .catch(() => true),
        client
          .readContract({
            address: binding.contracts.RoleAccessControl as Address,
            abi: ACL_ABI,
            functionName: "rolesOf",
            args: [controller as Address],
          })
          .catch(() => [] as readonly string[]),
      ]);

      /*
       * Names, not 32-byte ids.
       *
       * The contract stores role identifiers as hashes. A verifier comparing against
       * "ADMIN" would find every comparison false and see a wall of hex where a role should
       * be — the same mistake this codebase already made once at the session boundary.
       */
      const roles = roleNames([...(rawRoles as readonly string[])]);

      // What they hold, since ownership is part of what a verifier is checking.
      const assets = await readOwnedAssets({
        client,
        assetRegistry: binding.contracts.AssetRegistry as Address,
        owner: controller as Address,
      }).catch(() => null);

      res.json({
        didHash,
        registered: true,
        controller,
        active: Boolean(active),
        roles,
        assets: assets
          ? { balance: assets.balance, tokenIds: assets.tokens.map((t) => t.tokenId) }
          : null,
        network: toNetwork(binding),
      });
    }),
  );

  return router;
}

function toNetwork(binding: {
  network: {
    id: string;
    label: string;
    chainId: number;
    explorerUrl: string | null;
    verifiability: string;
  };
}) {
  return {
    id: binding.network.id,
    label: binding.network.label,
    chainId: binding.network.chainId,
    explorerUrl: binding.network.explorerUrl,
    verifiability: binding.network.verifiability,
  };
}
