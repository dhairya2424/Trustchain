import type { Address, PublicClient } from "viem";

/**
 * The tokens an address actually owns, read from the chain.
 *
 * The dashboard used to derive "my assets" from the audit trail: every ASSET_MINTED event
 * whose actor was you. That is a different question, and it gives a wrong answer in both
 * directions — a token you minted and then transferred away still appeared, and a token
 * someone transferred *to* you never did. It also required VIEW_AUDIT, so an ordinary user
 * was told they lacked permission to see their own property.
 *
 * Ownership is a fact the contract already holds, so it is asked directly.
 *
 * ## Why enumeration works here without ERC721Enumerable
 *
 * AssetRegistry implements ERC721 and ERC721Metadata but not Enumerable, so there is no
 * `tokenOfOwnerByIndex`. What it does expose is `totalMinted()`, and token ids are assigned
 * sequentially from 1 — so the id space is a known, dense range, and `ownerOf` answers for
 * each. `balanceOf` gives the count to look for, which lets the scan stop as soon as it has
 * found them all rather than always walking to the end.
 *
 * That is linear in supply, which is honest for a registry of this size and would not be for
 * a large one. `maxScan` bounds it, and a truncated scan says so rather than quietly
 * returning a short list — a partial answer presented as complete would tell somebody they
 * own less than they do.
 */

const ERC721_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerDIDOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isSoulbound",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface OwnedToken {
  tokenId: number;
  /** The metadata pointer the chain holds. IPFS; never the metadata itself. */
  tokenURI: string | null;
  /** The DID the contract records as owner, which is the authoritative link. */
  ownerDidHash: string | null;
  soulbound: boolean;
}

export interface OwnedAssets {
  owner: string;
  /** What the contract says the balance is. The number that must be matched. */
  balance: number;
  tokens: OwnedToken[];
  /**
   * True when the scan hit its bound before accounting for the whole balance.
   *
   * The UI must say so. "You own 12, here are 8" is a usable answer; presenting those 8 as
   * the complete set is not.
   */
  truncated: boolean;
  /** Total ever minted on this registry, for context on how far the scan had to look. */
  totalMinted: number;
}

export interface OwnedAssetsOptions {
  client: PublicClient;
  assetRegistry: Address;
  owner: Address;
  /** Highest token id to inspect in one request. */
  maxScan?: number;
}

export async function readOwnedAssets(options: OwnedAssetsOptions): Promise<OwnedAssets> {
  const { client, assetRegistry, owner } = options;
  const maxScan = options.maxScan ?? 500;

  const contract = { address: assetRegistry, abi: ERC721_ABI } as const;

  const [balanceRaw, totalRaw] = await Promise.all([
    client.readContract({ ...contract, functionName: "balanceOf", args: [owner] }),
    client.readContract({ ...contract, functionName: "totalMinted", args: [] }),
  ]);

  const balance = Number(balanceRaw);
  const totalMinted = Number(totalRaw);

  if (balance === 0) {
    return { owner, balance: 0, tokens: [], truncated: false, totalMinted };
  }

  const ceiling = Math.min(totalMinted, maxScan);
  const tokens: OwnedToken[] = [];

  for (let tokenId = 1; tokenId <= ceiling && tokens.length < balance; tokenId += 1) {
    let holder: string;
    try {
      holder = (await client.readContract({
        ...contract,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      })) as string;
    } catch {
      // Burned or never minted: ownerOf reverts. A gap in the id space is ordinary.
      continue;
    }

    if (holder.toLowerCase() !== owner.toLowerCase()) continue;

    // Read the rest only for tokens that are actually theirs. Doing it for every id would
    // triple the calls to describe tokens belonging to somebody else.
    const [tokenURI, ownerDidHash, soulbound] = await Promise.all([
      client
        .readContract({ ...contract, functionName: "tokenURI", args: [BigInt(tokenId)] })
        .catch(() => null),
      client
        .readContract({ ...contract, functionName: "ownerDIDOf", args: [BigInt(tokenId)] })
        .catch(() => null),
      client
        .readContract({ ...contract, functionName: "isSoulbound", args: [BigInt(tokenId)] })
        .catch(() => false),
    ]);

    tokens.push({
      tokenId,
      tokenURI: (tokenURI as string | null) ?? null,
      ownerDidHash: (ownerDidHash as string | null) ?? null,
      soulbound: Boolean(soulbound),
    });
  }

  return {
    owner,
    balance,
    tokens,
    // Found fewer than the balance means the answer is incomplete, whatever the reason.
    truncated: tokens.length < balance,
    totalMinted,
  };
}
