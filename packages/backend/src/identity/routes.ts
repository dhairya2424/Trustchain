import { Router } from "express";
import type { Address, Hex, PublicClient } from "viem";

import { asyncHandler } from "../http/middleware";
import type { Logger } from "../http/logger";
import type { ChainResolver } from "../chain/binding";
import { roleNames } from "../auth/roles";
import { readOwnedAssets } from "../assets/owned";

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
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function createIdentityRouter(deps: IdentityDependencies): Router {
  const router = Router();

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
