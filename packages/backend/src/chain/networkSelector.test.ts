import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublicClient } from "viem";

import { MemoryLogger } from "../http/logger";
import { formatUnitsFixed, NetworkSelector, NoUsableNetworkError } from "./networkSelector";
import { AMOY, CONTRACT_NAMES, HARDHAT } from "./networks";

const ADDRESSES = {
  RoleAccessControl: "0x1111111111111111111111111111111111111111",
  DIDRegistry: "0x2222222222222222222222222222222222222222",
  AssetRegistry: "0x3333333333333333333333333333333333333333",
  CredentialRegistry: "0x4444444444444444444444444444444444444444",
  AuditTrail: "0x5555555555555555555555555555555555555555",
  TrustChainForwarder: "0x6666666666666666666666666666666666666666",
};

const SIGNER = "0x29DA04934BCA824829Ece37452Dbc58DE986234A";

let deploymentsDir: string;

beforeEach(() => {
  deploymentsDir = mkdtempSync(path.join(tmpdir(), "trustchain-deploy-"));
});

afterEach(() => {
  rmSync(deploymentsDir, { recursive: true, force: true });
});

function writeRecord(file: string, chainId: number, contracts = ADDRESSES) {
  writeFileSync(
    path.join(deploymentsDir, file),
    JSON.stringify({
      network: file.replace(".json", ""),
      chainId,
      contracts: Object.fromEntries(
        Object.entries(contracts).map(([name, address]) => [name, { address }]),
      ),
    }),
  );
}

interface ChainStub {
  chainId?: number;
  chainIdError?: Error;
  bytecode?: string | undefined;
  balance?: bigint;
  balanceError?: Error;
}

function clientFor(stub: ChainStub): PublicClient {
  return {
    getChainId: async () => {
      if (stub.chainIdError) throw stub.chainIdError;
      return stub.chainId ?? 0;
    },
    getBytecode: async () => stub.bytecode,
    getBalance: async () => {
      if (stub.balanceError) throw stub.balanceError;
      return stub.balance ?? 0n;
    },
  } as unknown as PublicClient;
}

interface Harness {
  amoy?: ChainStub | null;
  hardhat?: ChainStub | null;
  relayerAddress?: string;
  relayerFails?: string[];
  ttlMs?: number;
}

/** Healthy defaults; each test breaks exactly one thing. */
function build(options: Harness = {}) {
  const logger = new MemoryLogger();

  const stubs: Record<string, ChainStub | null | undefined> = {
    "http://amoy":
      options.amoy === undefined
        ? { chainId: 80002, bytecode: "0x60", balance: 10n ** 18n }
        : options.amoy,
    "http://hardhat":
      options.hardhat === undefined
        ? { chainId: 31337, bytecode: "0x60", balance: 10n ** 21n }
        : options.hardhat,
  };

  const fetchImpl = vi.fn(async (url: string) => {
    const relayerId = String(url).split("/relayers/")[1]?.split("/")[0] ?? "";
    if (options.relayerFails?.includes(relayerId)) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { address: options.relayerAddress ?? SIGNER } }),
    } as unknown as Response;
  });

  const selector = new NetworkSelector({
    logger,
    deploymentsDir,
    rpcUrls: {
      ...(stubs["http://amoy"] === null ? {} : { amoy: "http://amoy" }),
      ...(stubs["http://hardhat"] === null ? {} : { hardhat: "http://hardhat" }),
    },
    relayer: { baseUrl: "http://relayer:8080", apiKey: "k" }, // secrets-scan:allow inert fixture
    clientFactory: (url) => clientFor(stubs[url] as ChainStub),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });

  return { selector, logger, fetchImpl };
}

describe("Amoy is the primary network", () => {
  it("is selected when every check passes", async () => {
    writeRecord("amoy.json", 80002);
    writeRecord("localhost.json", 31337);
    const { selector } = build();

    const active = await selector.active();

    expect(active.network.id).toBe("amoy");
    expect(active.network.label).toBe("POLYGON AMOY");
    expect(active.network.verifiability).toBe("public");
  });

  it("is preferred over Hardhat even when Hardhat is also perfectly healthy", async () => {
    writeRecord("amoy.json", 80002);
    writeRecord("localhost.json", 31337);

    expect((await build().selector.active()).network.id).toBe("amoy");
  });

  it("uses the relayer declared for that network", async () => {
    writeRecord("amoy.json", 80002);
    const { selector, fetchImpl } = build({ hardhat: null });

    await selector.active();

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/relayers/trustchain-amoy");
  });
});

describe("falling back to Hardhat", () => {
  const expectFallback = async (harness: Harness) => {
    writeRecord("amoy.json", 80002);
    writeRecord("localhost.json", 31337);
    const { selector, logger } = build(harness);

    const active = await selector.active();

    expect(active.network.id).toBe("hardhat");
    expect(active.network.verifiability).toBe("local");
    return { selector, logger };
  };

  /** The expected state until someone visits a faucet. */
  it("falls back when the Amoy signer is unfunded", async () => {
    await expectFallback({ amoy: { chainId: 80002, bytecode: "0x60", balance: 0n } });
  });

  it("falls back when the Amoy signer is below the minimum, not merely at zero", async () => {
    // A dust balance cannot pay for a mint. Selecting Amoy here would accept a request and
    // then fail after it was too late to refuse cleanly.
    await expectFallback({
      amoy: { chainId: 80002, bytecode: "0x60", balance: AMOY.minBalanceWei - 1n },
    });
  });

  it("falls back when the Amoy RPC is unreachable", async () => {
    await expectFallback({ amoy: { chainIdError: new Error("ECONNREFUSED") } });
  });

  it("falls back when the contracts are not deployed on Amoy", async () => {
    await expectFallback({ amoy: { chainId: 80002, bytecode: "0x", balance: 10n ** 18n } });
  });

  it("falls back when the Amoy relayer is unavailable", async () => {
    await expectFallback({ relayerFails: ["trustchain-amoy"] });
  });

  it("falls back when no Amoy endpoint is configured at all", async () => {
    await expectFallback({ amoy: null });
  });

  it("records why the primary was passed over", async () => {
    const { logger } = await expectFallback({
      amoy: { chainId: 80002, bytecode: "0x60", balance: 0n },
    });

    const record = logger.find("chain.network_selected");
    expect(record?.network).toBe("hardhat");
    expect(JSON.stringify(record?.primarySkipped)).toContain("needs at least");
  });
});

describe("checks that protect against a wrong chain", () => {
  it("refuses an endpoint reporting a different chain id", async () => {
    // A mainnet endpoint in POLYGON_AMOY_RPC_URL would otherwise send real transactions to
    // addresses that mean nothing there.
    writeRecord("amoy.json", 80002);
    writeRecord("localhost.json", 31337);
    const { selector } = build({ amoy: { chainId: 137, bytecode: "0x60", balance: 10n ** 18n } });

    const active = await selector.active();
    const amoyProbe = selector.probes.find((p) => p.network.id === "amoy");

    expect(active.network.id).toBe("hardhat");
    expect(amoyProbe?.checks.find((c) => c.name === "rpc")?.detail).toContain("expected 80002");
  });

  /**
   * A deployment record is a file on disk and survives `hardhat node` restarting, which
   * wipes the chain. Trusting it would mean sending transactions to empty addresses.
   */
  it("verifies bytecode rather than trusting the deployment record", async () => {
    writeRecord("localhost.json", 31337);
    const { selector } = build({
      amoy: null,
      hardhat: { chainId: 31337, bytecode: "0x", balance: 10n ** 21n },
    });

    await expect(selector.active()).rejects.toThrowError(NoUsableNetworkError);
  });

  it("refuses a deployment record written for a different chain", async () => {
    writeRecord("amoy.json", 137);
    writeRecord("localhost.json", 31337);
    const { selector } = build();

    expect((await selector.active()).network.id).toBe("hardhat");
  });

  it("refuses a record missing a contract address", async () => {
    const partial = { ...ADDRESSES };
    delete (partial as Record<string, string>).AuditTrail;
    writeRecord("amoy.json", 80002, partial as typeof ADDRESSES);
    writeRecord("localhost.json", 31337);

    const { selector } = build();
    const active = await selector.active();
    const probe = selector.probes.find((p) => p.network.id === "amoy");

    expect(active.network.id).toBe("hardhat");
    expect(probe?.checks.find((c) => c.name === "contracts")?.detail).toContain("AuditTrail");
  });

  it("reports no usable network rather than guessing when both fail", async () => {
    const { selector } = build({ amoy: null, hardhat: null });

    await expect(selector.active()).rejects.toThrowError(NoUsableNetworkError);
  });
});

describe("adopting Amoy once it becomes usable", () => {
  /** The requirement: funding the wallet later must switch the system over on its own. */
  it("switches from Hardhat to Amoy after the signer is funded, with no restart", async () => {
    writeRecord("amoy.json", 80002);
    writeRecord("localhost.json", 31337);

    const amoy: ChainStub = { chainId: 80002, bytecode: "0x60", balance: 0n };
    const { selector } = build({ amoy, ttlMs: 0 });

    expect((await selector.active()).network.id).toBe("hardhat");

    // The faucet arrives.
    amoy.balance = 10n ** 18n;

    expect((await selector.active()).network.id).toBe("amoy");
  });

  it("caches within the TTL rather than probing on every request", async () => {
    writeRecord("amoy.json", 80002);
    const { selector, fetchImpl } = build({ hardhat: null, ttlMs: 60_000 });

    await selector.active();
    await selector.active();
    await selector.active();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-probes immediately when refreshed", async () => {
    writeRecord("amoy.json", 80002);
    const { selector, fetchImpl } = build({ hardhat: null, ttlMs: 60_000 });

    await selector.active();
    await selector.refresh();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one probe between concurrent callers", async () => {
    writeRecord("amoy.json", 80002);
    const { selector, fetchImpl } = build({ hardhat: null, ttlMs: 60_000 });

    await Promise.all([selector.active(), selector.active(), selector.active()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("formatUnitsFixed", () => {
  it("renders a whole token", () => {
    expect(formatUnitsFixed(10n ** 18n)).toBe("1.000000");
  });

  it("renders a small balance without scientific notation", () => {
    // 1e-8 in an operator message is unreadable and easy to misjudge by orders of magnitude.
    expect(formatUnitsFixed(10n ** 10n)).toBe("0.000000");
    expect(formatUnitsFixed(20_000_000_000_000_000n)).toBe("0.020000");
  });

  it("renders zero", () => {
    expect(formatUnitsFixed(0n)).toBe("0.000000");
  });
});

describe("network descriptors", () => {
  it("labels the two environments exactly as the UI must show them", () => {
    expect(AMOY.label).toBe("POLYGON AMOY");
    expect(AMOY.verifiabilityLabel).toBe("Public Testnet / Publicly Verifiable");
    expect(HARDHAT.label).toBe("LOCAL HARDHAT");
    expect(HARDHAT.verifiabilityLabel).toBe("Local Development/Demo / Locally Verifiable");
  });

  it("puts Amoy ahead of Hardhat in priority", () => {
    expect(AMOY.priority).toBeLessThan(HARDHAT.priority);
  });

  it("covers every contract a network needs, including the forwarder", () => {
    // The forwarder is checked like any other: a network without one cannot attribute an
    // action to the identity that requested it, so it is not a usable network.
    expect(CONTRACT_NAMES).toHaveLength(6);
    expect(CONTRACT_NAMES).toContain("TrustChainForwarder");
  });
});
