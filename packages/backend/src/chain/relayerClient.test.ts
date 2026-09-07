import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Hex } from "viem";

import { mapRelayerStatus, OpenZeppelinRelayerClient } from "./relayerClient";
import { RelayerError } from "../assets/relayer";

const ASSET_REGISTRY = "0x1111111111111111111111111111111111111111";
const CREDENTIAL_REGISTRY = "0x2222222222222222222222222222222222222222";
const DID = `0x${"a".repeat(64)}` as Hex;
const HASH = `0x${"b".repeat(64)}` as Hex;
const SCHEMA = `0x${"c".repeat(64)}` as Hex;

const MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "toDID", type: "bytes32" },
      { name: "uri", type: "string" },
      { name: "soulbound", type: "bool" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

const CREDENTIAL_ABI = [
  {
    type: "function",
    name: "issue",
    stateMutability: "nonpayable",
    inputs: [
      { name: "credentialHash", type: "bytes32" },
      { name: "didHash", type: "bytes32" },
      { name: "schemaId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [
      { name: "credentialHash", type: "bytes32" },
      { name: "reasonCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function build(response: unknown = { id: "tx-1", status: "submitted" }) {
  const fetchImpl = vi.fn(async () =>
    response instanceof Error ? Promise.reject(response) : ok(response),
  );

  const client = new OpenZeppelinRelayerClient({
    baseUrl: "http://relayer:8080/",
    relayerId: "trustchain-amoy",
    apiKey: "test-api-key", // secrets-scan:allow inert test fixture
    assetRegistryAddress: ASSET_REGISTRY,
    credentialRegistryAddress: CREDENTIAL_REGISTRY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  return { client, fetchImpl };
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string }).body) as {
    to: string;
    value: number;
    data: Hex;
    speed: string;
  };
}

describe("request shape", () => {
  it("posts to the relayer's transactions endpoint", async () => {
    const { client, fetchImpl } = build();

    await client.relayMint({ toDID: DID, tokenURI: "ipfs://cid", soulbound: false });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://relayer:8080/api/v1/relayers/trustchain-amoy/transactions",
    );
  });

  it("authenticates with a bearer token", async () => {
    const { client, fetchImpl } = build();

    await client.relayMint({ toDID: DID, tokenURI: "ipfs://cid", soulbound: false });

    const headers = (fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe("Bearer test-api-key");
  });

  it("sends zero value — these calls never transfer native currency", async () => {
    const { client, fetchImpl } = build();

    await client.relayMint({ toDID: DID, tokenURI: "ipfs://cid", soulbound: false });

    expect(sentBody(fetchImpl).value).toBe(0);
  });
});

/**
 * The relayer takes pre-encoded calldata, so encoding is this client's job. These assert
 * the bytes decode back to the intended call — the previous Defender adapter sent an ABI
 * function name and arguments, which the relay API does not accept at all.
 */
describe("calldata encoding", () => {
  it("encodes a mint against the asset registry", async () => {
    const { client, fetchImpl } = build();

    await client.relayMint({ toDID: DID, tokenURI: "ipfs://cid", soulbound: true });

    const body = sentBody(fetchImpl);
    expect(body.to).toBe(ASSET_REGISTRY);

    const decoded = decodeFunctionData({ abi: MINT_ABI, data: body.data });
    expect(decoded.functionName).toBe("mint");
    expect(decoded.args).toEqual([DID, "ipfs://cid", true]);
  });

  it("encodes an issue against the credential registry", async () => {
    const { client, fetchImpl } = build();

    await client.relayIssue({
      credentialHash: HASH,
      didHash: DID,
      schemaId: SCHEMA,
      expiresAt: 1_800_000_000,
    });

    const body = sentBody(fetchImpl);
    expect(body.to).toBe(CREDENTIAL_REGISTRY);

    const decoded = decodeFunctionData({ abi: CREDENTIAL_ABI, data: body.data });
    expect(decoded.functionName).toBe("issue");
    expect(decoded.args).toEqual([HASH, DID, SCHEMA, 1_800_000_000n]);
  });

  it("encodes a revoke with its reason code", async () => {
    const { client, fetchImpl } = build();

    await client.relayRevoke({ credentialHash: HASH, reasonCode: 3 });

    const decoded = decodeFunctionData({ abi: CREDENTIAL_ABI, data: sentBody(fetchImpl).data });
    expect(decoded.functionName).toBe("revoke");
    expect(decoded.args).toEqual([HASH, 3]);
  });

  it("sends a never-expiring credential as zero, not as omitted", async () => {
    const { client, fetchImpl } = build();

    await client.relayIssue({
      credentialHash: HASH,
      didHash: DID,
      schemaId: SCHEMA,
      expiresAt: 0,
    });

    const decoded = decodeFunctionData({ abi: CREDENTIAL_ABI, data: sentBody(fetchImpl).data });
    expect(decoded.args?.[3]).toBe(0n);
  });
});

/**
 * The relayer reports six states; the application understands three. The mapping must
 * never turn an in-flight transaction into a reported success.
 */
describe("status mapping", () => {
  it.each([
    ["pending", "pending"],
    ["sent", "pending"],
    ["submitted", "pending"],
    ["inmempool", "pending"],
    ["mined", "mined"],
    ["confirmed", "mined"],
    ["failed", "failed"],
    ["canceled", "failed"],
    ["expired", "failed"],
  ])("maps %s to %s", (input, expected) => {
    expect(mapRelayerStatus(input)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(mapRelayerStatus("CONFIRMED")).toBe("mined");
  });

  it("treats an unrecognised status as pending, never as mined", () => {
    // A status we do not understand must not be reported as a completed mint.
    expect(mapRelayerStatus("something_new")).toBe("pending");
    expect(mapRelayerStatus(undefined)).toBe("pending");
    expect(mapRelayerStatus(42)).toBe("pending");
  });
});

describe("response handling", () => {
  it("reads a bare response object", async () => {
    const { client } = build({ id: "tx-9", hash: "0xabc", status: "confirmed" });

    const result = await client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false });

    expect(result).toEqual({ transactionId: "tx-9", hash: "0xabc", status: "mined" });
  });

  it("reads a { success, data } envelope", async () => {
    const { client } = build({ success: true, data: { id: "tx-7", status: "mined" } });

    const result = await client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false });

    expect(result.transactionId).toBe("tx-7");
    expect(result.status).toBe("mined");
  });

  it("accepts snake_case identifiers as well", async () => {
    const { client } = build({ transaction_id: "tx-5", transaction_hash: "0xdef" });

    const result = await client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false });

    expect(result.transactionId).toBe("tx-5");
    expect(result.hash).toBe("0xdef");
  });

  it("omits the hash when the relayer has not assigned one yet", async () => {
    const { client } = build({ id: "tx-2", status: "pending" });

    const result = await client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false });

    expect(result.hash).toBeUndefined();
  });

  it("fails when the response carries no transaction id", async () => {
    const { client } = build({ status: "submitted" });

    await expect(
      client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false }),
    ).rejects.toThrowError(/no transaction id/);
  });
});

describe("error handling", () => {
  it("raises a RelayerError on a non-2xx response", async () => {
    const client = new OpenZeppelinRelayerClient({
      baseUrl: "http://relayer:8080",
      relayerId: "r",
      apiKey: "k", // secrets-scan:allow inert test fixture
      assetRegistryAddress: ASSET_REGISTRY,
      credentialRegistryAddress: CREDENTIAL_REGISTRY,
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({ error: "Bearer k rejected" }),
        }) as unknown as Response) as typeof fetch,
    });

    await expect(
      client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false }),
    ).rejects.toThrowError(RelayerError);
  });

  /**
   * A relayer error can quote the request that caused it, and that request carried the API
   * credential in its headers. Echoing the body into an exception puts it in a log.
   */
  it("does not echo the relayer's response body into the error", async () => {
    const client = new OpenZeppelinRelayerClient({
      baseUrl: "http://relayer:8080",
      relayerId: "r",
      apiKey: "super-secret-key", // secrets-scan:allow inert test fixture
      assetRegistryAddress: ASSET_REGISTRY,
      credentialRegistryAddress: CREDENTIAL_REGISTRY,
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ echoed: "authorization: Bearer super-secret-key" }),
        }) as unknown as Response) as typeof fetch,
    });

    await expect(
      client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false }),
    ).rejects.toThrowError(/^(?!.*super-secret-key).*$/s);
  });

  it("reports an unreachable relayer rather than hanging", async () => {
    const { client } = build(new Error("ECONNREFUSED"));

    await expect(
      client.relayMint({ toDID: DID, tokenURI: "ipfs://c", soulbound: false }),
    ).rejects.toThrowError(/unreachable/);
  });
});

describe("relayer introspection", () => {
  it("reports the signer address, which is what needs gas and roles", async () => {
    const { client } = build({ data: { address: ASSET_REGISTRY } });

    expect(await client.address()).toBe(ASSET_REGISTRY);
  });

  it("looks up a transaction's current status", async () => {
    const { client, fetchImpl } = build({ data: { id: "tx-1", status: "confirmed" } });

    const result = await client.statusOf("tx-1");

    expect(result.status).toBe("mined");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/transactions/tx-1");
  });
});
