import { describe, expect, it, vi } from "vitest";

import { readOwnedAssets } from "./owned";

/**
 * Reading ownership from the chain.
 *
 * The behaviour that matters is what happens when the answer cannot be complete. A scan
 * bounded by `maxScan` can find fewer tokens than the contract says exist, and presenting
 * that short list as the whole truth would tell somebody they own less than they do.
 */

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const REGISTRY = "0x3333333333333333333333333333333333333333" as const;

/** A registry where `owners[tokenId]` holds the owner, or undefined for a burned id. */
function fakeClient(owners: Record<number, string | undefined>, balance?: number) {
  const minted = Math.max(0, ...Object.keys(owners).map(Number));
  const calls: string[] = [];

  const client = {
    readContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        calls.push(functionName);
        switch (functionName) {
          case "balanceOf":
            return BigInt(
              balance ?? Object.values(owners).filter((o) => o?.toLowerCase() === OWNER).length,
            );
          case "totalMinted":
            return BigInt(minted);
          case "ownerOf": {
            const id = Number(args?.[0]);
            const owner = owners[id];
            if (!owner) throw new Error("ERC721NonexistentToken");
            return owner;
          }
          case "tokenURI":
            return `ipfs://token/${Number(args?.[0])}`;
          case "ownerDIDOf":
            return `0x${"dd".repeat(32)}`;
          case "isSoulbound":
            return false;
          default:
            throw new Error(`unexpected call: ${functionName}`);
        }
      },
    ),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

describe("readOwnedAssets", () => {
  it("returns the tokens the address owns and ignores everyone else's", async () => {
    const { client } = fakeClient({ 1: OTHER, 2: OWNER, 3: OTHER, 4: OWNER });

    const result = await readOwnedAssets({ client, assetRegistry: REGISTRY, owner: OWNER });

    expect(result.tokens.map((t) => t.tokenId)).toEqual([2, 4]);
    expect(result.balance).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("skips ids that no longer exist rather than failing the whole read", async () => {
    // ownerOf reverts for a burned or never-minted id. A gap is ordinary, not an error.
    const { client } = fakeClient({ 1: undefined, 2: OWNER, 3: undefined });

    const result = await readOwnedAssets({ client, assetRegistry: REGISTRY, owner: OWNER });
    expect(result.tokens.map((t) => t.tokenId)).toEqual([2]);
  });

  it("stops scanning once it has found the whole balance", async () => {
    // The balance is the number to look for, so a token owned early in a large registry
    // costs a handful of calls rather than a walk to the end.
    const owners: Record<number, string> = { 1: OWNER };
    for (let id = 2; id <= 200; id += 1) owners[id] = OTHER;

    const { client, calls } = fakeClient(owners, 1);
    const result = await readOwnedAssets({ client, assetRegistry: REGISTRY, owner: OWNER });

    expect(result.tokens).toHaveLength(1);
    expect(calls.filter((c) => c === "ownerOf")).toHaveLength(1);
  });

  it("admits when the scan bound cut the answer short", async () => {
    // The contract says three; only ids up to the bound were looked at. Reporting two as
    // the complete set would understate what somebody owns.
    const { client } = fakeClient({ 1: OWNER, 2: OWNER, 3: OTHER, 4: OWNER }, 3);

    const result = await readOwnedAssets({
      client,
      assetRegistry: REGISTRY,
      owner: OWNER,
      maxScan: 2,
    });

    expect(result.tokens.map((t) => t.tokenId)).toEqual([1, 2]);
    expect(result.balance).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("does no scanning at all for an address that owns nothing", async () => {
    const { client, calls } = fakeClient({ 1: OTHER, 2: OTHER }, 0);

    const result = await readOwnedAssets({ client, assetRegistry: REGISTRY, owner: OWNER });

    expect(result.tokens).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(calls).not.toContain("ownerOf");
  });

  it("reads metadata only for tokens that are actually the owner's", async () => {
    // Reading tokenURI for every id would triple the calls to describe other people's
    // property.
    const { client, calls } = fakeClient({ 1: OTHER, 2: OWNER });

    await readOwnedAssets({ client, assetRegistry: REGISTRY, owner: OWNER });

    expect(calls.filter((c) => c === "tokenURI")).toHaveLength(1);
  });
});
