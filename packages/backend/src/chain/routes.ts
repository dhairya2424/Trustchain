import { Router } from "express";
import { forwardRequestBody } from "@trustchain/shared";
import type { Address, Hex } from "viem";

import { requireSession, type Caller, type CallerResolver } from "../http/authorize";
import { asyncHandler } from "../http/middleware";
import type { Logger } from "../http/logger";
import { buildForwardTypedData, ForwardRequestError } from "./forwardRequest";
import { forwardSignedRequest, FORWARDER_DOMAIN_NAME } from "./forwarding";
import { formatUnitsFixed, NoUsableNetworkError, type NetworkSelector } from "./networkSelector";
import { explorerAddressUrl, explorerTxUrl, type NetworkDescriptor } from "./networks";

/**
 * Reports which chain the platform is actually running on.
 *
 * Public and unauthenticated: the point of the whole primary/fallback design is that
 * nobody has to guess whether a record is publicly verifiable, and hiding that behind a
 * session would defeat it. Nothing here is sensitive — the addresses are on a public
 * chain, and the RPC endpoint (which carries a provider key) is never included.
 */

export interface NetworkDto {
  id: string;
  label: string;
  chainId: number;
  verifiability: "public" | "local";
  verifiabilityLabel: string;
  explorerUrl: string | null;
  /** True only for the primary network. A UI can use it to decide how loudly to warn. */
  isPrimary: boolean;
  isFallback: boolean;
}

export function toNetworkDto(network: NetworkDescriptor): NetworkDto {
  return {
    id: network.id,
    label: network.label,
    chainId: network.chainId,
    verifiability: network.verifiability,
    verifiabilityLabel: network.verifiabilityLabel,
    explorerUrl: network.explorerUrl,
    isPrimary: network.priority === 0,
    isFallback: network.priority > 0,
  };
}

export interface NetworkDependencies {
  selector: NetworkSelector;
  logger: Logger;
  /** Required for /forward, which relays at the platform's expense. */
  resolveCaller: CallerResolver;
}

export function createNetworkRouter(deps: NetworkDependencies): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      let active;
      try {
        active = await deps.selector.active();
      } catch (error) {
        if (error instanceof NoUsableNetworkError) {
          // Honest 503 rather than a cheerful shape with nulls in it: with no usable chain
          // the platform cannot record anything, and a caller must be able to tell.
          res.status(503).json({
            error: "no_usable_network",
            requestId: req.requestId,
            candidates: deps.selector.probes.map((probe) => ({
              ...toNetworkDto(probe.network),
              usable: false,
              checks: probe.checks,
            })),
          });
          return;
        }
        throw error;
      }

      res.json({
        active: {
          ...toNetworkDto(active.network),
          signerAddress: active.signerAddress,
          signerExplorerUrl: explorerAddressUrl(active.network, active.signerAddress),
          signerBalance: formatUnitsFixed(active.balanceWei),
          contracts: active.contracts,
          selectedAt: active.selectedAt.toISOString(),
        },
        // Every candidate and why it was or was not chosen. This is what makes a fallback
        // diagnosable rather than mysterious: "why am I on Hardhat?" is answered here.
        candidates: deps.selector.probes.map((probe) => ({
          ...toNetworkDto(probe.network),
          usable: probe.usable,
          checks: probe.checks,
        })),
      });
    }),
  );

  /**
   * Forces an immediate re-probe.
   *
   * Selection is cached briefly, so a newly funded Amoy signer is adopted on its own
   * within the TTL. This exists so a demo does not have to wait for it.
   */
  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      try {
        const active = await deps.selector.refresh();
        deps.logger.log({
          level: "info",
          msg: "chain.refresh_requested",
          requestId: req.requestId,
          network: active.network.id,
        });
        res.json({ active: toNetworkDto(active.network) });
      } catch (error) {
        if (error instanceof NoUsableNetworkError) {
          res.status(503).json({ error: "no_usable_network", requestId: req.requestId });
          return;
        }
        throw error;
      }
    }),
  );

  /**
   * Relays a request the caller has signed.
   *
   * This is the second half of every attributed write. The client received an EIP-712
   * payload from a `/prepare` endpoint, signed it in the requester's wallet, and returns it
   * here. Nothing in the body is trusted: the actor must be the authenticated session's own
   * address, the signature must verify over exactly this call, and the target must be a
   * contract of the active network.
   *
   * Requires a session — a signature alone would be enough to prove the actor, but relaying
   * costs the platform gas, so it is offered to authenticated callers only.
   */
  router.post(
    "/forward",
    requireSession({ resolve: deps.resolveCaller, logger: deps.logger }),
    asyncHandler(async (req, res) => {
      const parsed = forwardRequestBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_request",
          requestId: req.requestId,
          issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }

      const body = parsed.data;
      const caller = req.caller as Caller;

      const typedData = buildForwardTypedData({
        forwarderName: FORWARDER_DOMAIN_NAME,
        forwarderAddress: body.verifyingContract as Address,
        chainId: body.chainId,
        request: {
          from: body.request.from as Address,
          to: body.request.to as Address,
          value: 0n,
          gas: BigInt(body.request.gas),
          nonce: BigInt(body.request.nonce),
          deadline: body.request.deadline,
          data: body.request.data as Hex,
        },
      });

      let relayed;
      try {
        relayed = await forwardSignedRequest({
          selector: deps.selector,
          typedData,
          signature: body.signature as Hex,
          sessionAddress: caller.address,
        });
      } catch (error) {
        if (error instanceof ForwardRequestError) {
          deps.logger.log({
            level: "warn",
            msg: "security.forward_rejected",
            requestId: req.requestId,
            actor: caller.address,
            claimedFrom: body.request.from,
            target: body.request.to,
            reason: error.code,
          });
          res.status(error.code === "actor_mismatch" ? 403 : 400).json({
            error: error.code,
            requestId: req.requestId,
          });
          return;
        }
        throw error;
      }

      const active = await deps.selector.active();

      deps.logger.log({
        level: "info",
        msg: "chain.request_forwarded",
        requestId: req.requestId,
        actor: caller.address,
        target: body.request.to,
        network: active.network.id,
        transactionId: relayed.transactionId,
      });

      res.status(202).json({
        status: relayed.status,
        transactionId: relayed.transactionId,
        // The actor is the session's address by construction — the verifier refused
        // anything else — so reporting it here is a statement, not a guess.
        actor: caller.address,
        network: toNetworkDto(active.network),
        explorerUrl: relayed.hash ? explorerTxUrl(active.network, relayed.hash) : null,
      });
    }),
  );

  return router;
}
