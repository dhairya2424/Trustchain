import { Router } from "express";

import { asyncHandler } from "../http/middleware";
import type { Logger } from "../http/logger";
import { formatUnitsFixed, NoUsableNetworkError, type NetworkSelector } from "./networkSelector";
import { explorerAddressUrl, type NetworkDescriptor } from "./networks";

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

  return router;
}
