import type { Address } from "viem";

import type { IdentitySnapshot, PermissionReader, RoleReader } from "../auth/roleReader";
import { OnChainRoleReader } from "../auth/roleReader";
import type { PermissionName } from "../auth/roles";
import type { CredentialReader, CredentialSnapshot } from "../credentials/registry";
import { OnChainCredentialReader } from "../credentials/registry";
import type { AuditFilter, AuditQueryResult, RawAuditEvent } from "../audit/events";
import { FallbackAuditSource, OnChainAuditSource, SubgraphAuditSource } from "../audit/events";
import { IndexedAuditSource } from "../indexer/source";
import type { EventIndexStore } from "../indexer/store";
import type { Logger } from "../http/logger";
import type { NetworkSelector } from "./networkSelector";

/**
 * Chain readers bound to whichever network is currently active.
 *
 * Every one of these was previously constructed once at boot from a fixed environment
 * variable. That is wrong the moment the platform can run on more than one chain: after a
 * switch to Amoy the readers would still be querying the Hardhat addresses, reporting
 * "credential unknown" for credentials that exist and an empty audit trail for a chain full
 * of entries — silently, and in the direction that looks like absence rather than error.
 *
 * So each of these resolves the active network per call and reads from *that* chain's
 * addresses. The selector caches its choice, so the extra indirection costs nothing beyond
 * a map lookup on the hot path.
 *
 * Writes are already handled this way through `ChainBinding`. These are the reads.
 */

/** Credential status, read from the active network's CredentialRegistry. */
export class SelectedCredentialReader implements CredentialReader {
  constructor(private readonly selector: NetworkSelector) {}

  async statusOf(credentialHash: string): Promise<CredentialSnapshot> {
    const active = await this.selector.active();
    const reader = new OnChainCredentialReader(
      active.client,
      active.contracts.CredentialRegistry as Address,
    );
    return reader.statusOf(credentialHash);
  }
}

/**
 * Authorization, read from the active network's RoleAccessControl.
 *
 * This one matters most: it decides whether a mutation is allowed. Reading it from the
 * wrong chain would either refuse a legitimate ADMIN or — far worse — consult a contract
 * whose role assignments have nothing to do with the chain the transaction will land on.
 */
export class SelectedPermissionReader implements PermissionReader {
  constructor(private readonly selector: NetworkSelector) {}

  async hasPermission(address: Address, permission: PermissionName): Promise<boolean> {
    const active = await this.selector.active();
    const reader = new OnChainRoleReader(
      {
        roleAccessControl: active.contracts.RoleAccessControl as Address,
        didRegistry: active.contracts.DIDRegistry as Address,
      },
      "",
      active.client,
    );
    return reader.hasPermission(address, permission);
  }
}

/**
 * Roles and DID at sign-in, read from the active network's registries.
 *
 * This one is easy to overlook because it runs once per login rather than per request, but
 * it is the same hazard: bound to fixed addresses it would read a chain the platform is no
 * longer using, and hand out sessions with no roles and no DID — which looks like a
 * permissions problem rather than a configuration one.
 */
export class SelectedRoleReader implements RoleReader {
  constructor(private readonly selector: NetworkSelector) {}

  async read(address: Address): Promise<IdentitySnapshot> {
    const active = await this.selector.active();
    const reader = new OnChainRoleReader(
      {
        roleAccessControl: active.contracts.RoleAccessControl as Address,
        didRegistry: active.contracts.DIDRegistry as Address,
      },
      "",
      active.client,
    );
    return reader.read(address);
  }
}

/**
 * The audit trail of the active network.
 *
 * The subgraph is only meaningful for the network it indexes, so it is consulted only when
 * one is configured for that network. On the local fallback there is none, and the chain
 * scan is the only path — which is also the path most likely to be wrong, so exercising it
 * routinely is a feature rather than a compromise.
 */
export class SelectedAuditSource {
  constructor(
    private readonly selector: NetworkSelector,
    private readonly options: {
      logger: Logger;
      /** Subgraph endpoint per network id. Absent means "chain only" for that network." */
      subgraphUrls: Partial<Record<string, string>>;
      deploymentBlocks: Partial<Record<string, bigint>>;
      /** Absent means no indexer is running; reads then go straight to the chain. */
      indexStore?: EventIndexStore | undefined;
    },
  ) {}

  async query(filter: AuditFilter): Promise<AuditQueryResult> {
    const active = await this.selector.active();

    const onChain = new OnChainAuditSource({
      client: active.client,
      address: active.contracts.AuditTrail as Address,
      deploymentBlock: this.options.deploymentBlocks[active.network.id] ?? 0n,
    });

    /*
     * The index first, when it has anything to say.
     *
     * `hasData` rather than "did the query return rows": an empty index and a genuinely
     * empty trail look identical in a result set, and reporting "nothing happened" because
     * the indexer has not started yet would be a false statement about the ledger. So an
     * index with no entries at all defers to the chain, and only an index that has
     * demonstrably read something is trusted to answer.
     */
    if (this.options.indexStore) {
      const indexed = new IndexedAuditSource(this.options.indexStore, active.network.id);
      if (await indexed.hasData()) {
        return { events: await indexed.query(filter), source: "index" };
      }
    }

    const subgraphUrl = this.options.subgraphUrls[active.network.id];
    if (!subgraphUrl) {
      return { events: await onChain.query(filter), source: "chain" };
    }

    const fallback = new FallbackAuditSource(
      new SubgraphAuditSource(subgraphUrl),
      onChain,
      (error) => {
        this.options.logger.log({
          level: "warn",
          msg: "audit.subgraph_fallback",
          network: active.network.id,
          detail: error instanceof Error ? error.message : "unknown",
        });
      },
    );

    return fallback.query(filter);
  }
}

export type { RawAuditEvent };
