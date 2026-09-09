import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "../http/logger";
import { OpenZeppelinRelayerClient } from "./relayerClient";
import {
  CONTRACT_NAMES,
  NETWORKS_BY_PRIORITY,
  type NetworkContracts,
  type NetworkDescriptor,
  type NetworkId,
} from "./networks";

/**
 * Chooses which chain the platform actually runs on.
 *
 * Polygon Amoy is the primary target and is used whenever it can genuinely carry a
 * transaction. Local Hardhat is the fallback — not an equal alternative, and never
 * presented as one.
 *
 * Four things have to be true before a network is selectable, and each corresponds to a
 * way the system could otherwise accept a request and then fail after it was too late to
 * refuse cleanly:
 *
 *   1. the RPC answers, and reports the chain id we expect
 *   2. the relayer service has a relayer for that network, with an address
 *   3. the contracts are deployed there — a deployment record AND real bytecode on chain
 *   4. the signer holds enough native currency to pay for a transaction
 *
 * Check 3 deliberately verifies bytecode rather than trusting the deployment record. A
 * record is a file on disk; it survives `hardhat node` being restarted, which wipes the
 * chain. Trusting it would mean confidently sending transactions to an address where
 * nothing lives.
 *
 * Check 4 is why "Amoy is configured" is not the same as "Amoy is usable". An unfunded
 * signer is the expected state until someone visits a faucet, and the system has to work
 * in the meantime.
 */

export interface CheckResult {
  name: "rpc" | "relayer" | "contracts" | "balance";
  ok: boolean;
  detail: string;
}

export interface NetworkProbe {
  network: NetworkDescriptor;
  usable: boolean;
  checks: CheckResult[];
  /** Populated when the probe got far enough to learn them. */
  contracts?: NetworkContracts;
  signerAddress?: string;
  balanceWei?: bigint;
}

/** A network that passed every check, with everything needed to use it. */
export interface ActiveNetwork {
  network: NetworkDescriptor;
  contracts: NetworkContracts;
  client: PublicClient;
  relayer: OpenZeppelinRelayerClient;
  signerAddress: string;
  balanceWei: bigint;
  selectedAt: Date;
}

export interface SelectorOptions {
  logger: Logger;
  /** Directory holding the deployment records written by the deploy script. */
  deploymentsDir: string;
  /** RPC endpoint per network. A network with no endpoint is skipped entirely. */
  rpcUrls: Partial<Record<NetworkId, string>>;
  relayer: {
    baseUrl: string;
    apiKey: string;
    speed?: "safeLow" | "average" | "fast" | "fastest";
  };
  /** How long a selection is trusted before it is re-probed. */
  ttlMs?: number;
  /** Injected for tests. */
  now?: () => Date;
  clientFactory?: (rpcUrl: string) => PublicClient;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TTL_MS = 60_000;

export class NoUsableNetworkError extends Error {
  constructor(readonly probes: NetworkProbe[]) {
    super(
      `no usable network. ${probes
        .map((p) => `${p.network.id}: ${p.checks.find((c) => !c.ok)?.detail ?? "unknown"}`)
        .join("; ")}`,
    );
    this.name = "NoUsableNetworkError";
  }
}

export class NetworkSelector {
  private cached: ActiveNetwork | undefined;
  private cachedAt = 0;
  private lastProbes: NetworkProbe[] = [];
  private inFlight: Promise<ActiveNetwork> | undefined;

  constructor(private readonly options: SelectorOptions) {}

  private get ttl(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private client(rpcUrl: string): PublicClient {
    return (
      this.options.clientFactory?.(rpcUrl) ??
      (createPublicClient({ transport: http(rpcUrl) }) as PublicClient)
    );
  }

  /** Most recent probe results, for the /network endpoint. */
  get probes(): NetworkProbe[] {
    return this.lastProbes;
  }

  /**
   * The network to use right now.
   *
   * Cached for `ttlMs`, so a funded Amoy wallet is picked up automatically within a minute
   * without anyone restarting anything, while a burst of requests does not re-probe the
   * chain once per request. Concurrent callers share one in-flight probe.
   */
  async active(): Promise<ActiveNetwork> {
    const age = Date.now() - this.cachedAt;
    if (this.cached && age < this.ttl) return this.cached;

    this.inFlight ??= this.select().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  /** Forces a re-probe, ignoring the cache. */
  async refresh(): Promise<ActiveNetwork> {
    this.cachedAt = 0;
    return this.active();
  }

  private async select(): Promise<ActiveNetwork> {
    const probes: NetworkProbe[] = [];

    for (const network of NETWORKS_BY_PRIORITY) {
      const probe = await this.probe(network);
      probes.push(probe);

      if (probe.usable) {
        const active: ActiveNetwork = {
          network,
          contracts: probe.contracts as NetworkContracts,
          client: this.client(this.options.rpcUrls[network.id] as string),
          relayer: this.relayerFor(network, probe.contracts as NetworkContracts),
          signerAddress: probe.signerAddress as string,
          balanceWei: probe.balanceWei as bigint,
          selectedAt: this.now(),
        };

        const changed = this.cached?.network.id !== network.id;
        this.cached = active;
        this.cachedAt = Date.now();
        this.lastProbes = probes;

        if (changed) {
          this.options.logger.log({
            level: network.id === "amoy" ? "info" : "warn",
            msg: "chain.network_selected",
            network: network.id,
            label: network.label,
            verifiability: network.verifiability,
            chainId: network.chainId,
            signer: active.signerAddress,
            // The reason the primary was passed over belongs in the log, so an operator
            // can see at a glance whether it was funding, deployment or connectivity.
            ...(network.id !== "amoy"
              ? { primarySkipped: probes[0]?.checks.filter((c) => !c.ok).map((c) => c.detail) }
              : {}),
          });
        }

        return active;
      }
    }

    this.lastProbes = probes;
    throw new NoUsableNetworkError(probes);
  }

  private relayerFor(
    network: NetworkDescriptor,
    contracts: NetworkContracts,
  ): OpenZeppelinRelayerClient {
    return new OpenZeppelinRelayerClient({
      baseUrl: this.options.relayer.baseUrl,
      relayerId: network.relayerId,
      apiKey: this.options.relayer.apiKey,
      assetRegistryAddress: contracts.AssetRegistry,
      credentialRegistryAddress: contracts.CredentialRegistry,
      ...(this.options.relayer.speed ? { speed: this.options.relayer.speed } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
  }

  /** Runs all four checks. Stops at the first failure — later checks depend on earlier. */
  async probe(network: NetworkDescriptor): Promise<NetworkProbe> {
    const checks: CheckResult[] = [];
    const fail = (probe: Partial<NetworkProbe> = {}): NetworkProbe => ({
      network,
      usable: false,
      checks,
      ...probe,
    });

    // ---------------------------------------------------------------- 1. RPC
    const rpcUrl = this.options.rpcUrls[network.id];
    if (!rpcUrl) {
      checks.push({ name: "rpc", ok: false, detail: "no RPC endpoint configured" });
      return fail();
    }

    let client: PublicClient;
    try {
      client = this.client(rpcUrl);
      const chainId = await client.getChainId();

      if (chainId !== network.chainId) {
        // A wrong chain id means the endpoint points somewhere else entirely. Proceeding
        // would send transactions to a chain the addresses do not belong to.
        checks.push({
          name: "rpc",
          ok: false,
          detail: `endpoint reports chain id ${chainId}, expected ${network.chainId}`,
        });
        return fail();
      }

      checks.push({ name: "rpc", ok: true, detail: `reachable, chain id ${chainId}` });
    } catch (error) {
      checks.push({
        name: "rpc",
        ok: false,
        detail: `unreachable: ${error instanceof Error ? error.message : "unknown"}`,
      });
      return fail();
    }

    // ---------------------------------------------------------------- 3. contracts
    // Run before the relayer check because the relayer client needs the addresses.
    const recordPath = path.join(this.options.deploymentsDir, network.deploymentFile);
    if (!existsSync(recordPath)) {
      checks.push({
        name: "contracts",
        ok: false,
        detail: `no deployment record at ${network.deploymentFile}`,
      });
      return fail();
    }

    let contracts: NetworkContracts;
    try {
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        chainId?: number | string;
        contracts?: Record<string, { address?: string }>;
      };

      if (record.chainId !== undefined && Number(record.chainId) !== network.chainId) {
        checks.push({
          name: "contracts",
          ok: false,
          detail: `deployment record is for chain ${record.chainId}, not ${network.chainId}`,
        });
        return fail();
      }

      const resolved: Partial<NetworkContracts> = {};
      for (const name of CONTRACT_NAMES) {
        const address = record.contracts?.[name]?.address;
        if (!address) {
          checks.push({
            name: "contracts",
            ok: false,
            detail: `deployment record has no address for ${name}`,
          });
          return fail();
        }
        resolved[name] = address;
      }
      contracts = resolved as NetworkContracts;
    } catch (error) {
      checks.push({
        name: "contracts",
        ok: false,
        detail: `deployment record unreadable: ${error instanceof Error ? error.message : "?"}`,
      });
      return fail();
    }

    // The record is a file; the chain is the truth. A restarted Hardhat node leaves a
    // stale record pointing at addresses with no code.
    try {
      for (const name of CONTRACT_NAMES) {
        const code = await client.getBytecode({ address: contracts[name] as Address });
        if (!code || code === "0x") {
          checks.push({
            name: "contracts",
            ok: false,
            detail: `${name} has no bytecode at ${contracts[name]} — not deployed on this chain`,
          });
          return fail({ contracts });
        }
      }
      // Counted from the list rather than written out: this said "five" for as long as
      // there were five, and kept saying it after TrustChainForwarder made six.
      checks.push({
        name: "contracts",
        ok: true,
        detail: `all ${CONTRACT_NAMES.length} contracts have bytecode`,
      });
    } catch (error) {
      checks.push({
        name: "contracts",
        ok: false,
        detail: `bytecode check failed: ${error instanceof Error ? error.message : "unknown"}`,
      });
      return fail({ contracts });
    }

    // ---------------------------------------------------------------- 2. relayer
    let signerAddress: string;
    try {
      signerAddress = await this.relayerFor(network, contracts).address();
      checks.push({ name: "relayer", ok: true, detail: `signer ${signerAddress}` });
    } catch (error) {
      checks.push({
        name: "relayer",
        ok: false,
        detail: `relayer "${network.relayerId}" unavailable: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      });
      return fail({ contracts });
    }

    // ---------------------------------------------------------------- 4. balance
    let balanceWei: bigint;
    try {
      balanceWei = await client.getBalance({ address: signerAddress as Address });
    } catch (error) {
      checks.push({
        name: "balance",
        ok: false,
        detail: `balance lookup failed: ${error instanceof Error ? error.message : "unknown"}`,
      });
      return fail({ contracts, signerAddress });
    }

    if (balanceWei < network.minBalanceWei) {
      checks.push({
        name: "balance",
        ok: false,
        detail:
          `signer holds ${formatUnitsFixed(balanceWei)} — needs at least ` +
          `${formatUnitsFixed(network.minBalanceWei)} to send a transaction`,
      });
      return fail({ contracts, signerAddress, balanceWei });
    }

    checks.push({
      name: "balance",
      ok: true,
      detail: `signer holds ${formatUnitsFixed(balanceWei)}`,
    });

    return { network, usable: true, checks, contracts, signerAddress, balanceWei };
  }
}

/** Fixed 6-decimal rendering, so a balance never appears as `1e-8` in an operator message. */
export function formatUnitsFixed(wei: bigint, decimals = 18): string {
  const negative = wei < 0n;
  const value = negative ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = ((value % base) * 1_000_000n) / base;

  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(6, "0")}`;
}
