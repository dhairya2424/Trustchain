import type { Address, PublicClient } from "viem";

/**
 * Deciding whether a transfer is legitimate, before spending gas discovering it is not.
 *
 * Every rule checked here is also enforced by `AssetRegistry._update`, and the contract is
 * the control that actually matters — this module cannot make an illegitimate transfer
 * succeed, and removing it would not make one possible. What it changes is the failure: a
 * caller learns "that asset is soulbound" instead of watching a transaction burn gas and
 * come back `execution reverted`.
 *
 * The rules, and why each exists:
 *
 *   - **You must currently hold the token.** Otherwise there is nothing to send.
 *   - **The recipient must have an active identity.** Assets belong to identities here, so
 *     sending one to an address the registry has never heard of would break the invariant
 *     the whole design rests on.
 *   - **A soulbound token cannot move.** That is what soulbound means: a credential-like
 *     asset that would be meaningless if it could be sold.
 *   - **Your key must still control the owning identity.** A rotated-out key is exactly the
 *     position a compromised key is in. It may not hand the asset to a third party; the only
 *     move available to it is being reclaimed by the real controller.
 *   - **The recipient must be a different identity.** Moving an asset between two keys of
 *     the same identity is a reclaim, which has its own function and its own audit code.
 */

const ASSET_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
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

const DID_ABI = [
  {
    type: "function",
    name: "didOf",
    stateMutability: "view",
    inputs: [{ name: "controller", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [{ name: "didHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "controllerOf",
    stateMutability: "view",
    inputs: [{ name: "didHash", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

const ZERO_DID = `0x${"0".repeat(64)}`;

/**
 * Why a transfer was refused.
 *
 * Each maps to one sentence in the interface. They are deliberately specific: "you cannot
 * transfer this" would be true of all of them and useful for none.
 */
export type TransferRefusal =
  | "asset_not_found"
  | "not_asset_owner"
  | "asset_is_soulbound"
  | "recipient_has_no_identity"
  | "recipient_identity_inactive"
  | "recipient_already_owns_asset"
  | "stale_holder";

export class TransferError extends Error {
  constructor(readonly code: TransferRefusal) {
    super(code);
    this.name = "TransferError";
  }
}

export interface TransferPlan {
  tokenId: number;
  /** The identity giving the asset up. */
  fromDID: string;
  /** The identity receiving it. */
  toDID: string;
  /** The address the token moves to — the recipient identity's *current* controller. */
  recipient: Address;
}

/**
 * Reads the chain and either returns a plan or throws the reason it cannot.
 *
 * `holder` is the authenticated session's address and never a value from the request body.
 * The recipient is resolved to whatever address controls their DID *now*, which is why the
 * caller supplies an identity or an address and the transfer still lands correctly if that
 * identity rotated its key in the meantime.
 */
export async function planTransfer(options: {
  client: PublicClient;
  assetRegistry: Address;
  didRegistry: Address;
  tokenId: number;
  holder: Address;
  /** Either the recipient's address, or their DID hash. One is required. */
  to: { address: Address } | { didHash: string };
}): Promise<TransferPlan> {
  const { client, assetRegistry, didRegistry, tokenId, holder } = options;

  let currentOwner: Address;
  let fromDID: string;
  let soulbound: boolean;

  try {
    [currentOwner, fromDID, soulbound] = (await Promise.all([
      client.readContract({
        address: assetRegistry,
        abi: ASSET_ABI,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      }),
      client.readContract({
        address: assetRegistry,
        abi: ASSET_ABI,
        functionName: "ownerDIDOf",
        args: [BigInt(tokenId)],
      }),
      client.readContract({
        address: assetRegistry,
        abi: ASSET_ABI,
        functionName: "isSoulbound",
        args: [BigInt(tokenId)],
      }),
    ])) as [Address, string, boolean];
  } catch {
    // All three revert with the same `ERC721NonexistentToken` for an id that was never
    // minted, so there is nothing to distinguish here — and a token that does not exist is
    // not a permission problem to report as one.
    throw new TransferError("asset_not_found");
  }

  if (currentOwner.toLowerCase() !== holder.toLowerCase()) {
    throw new TransferError("not_asset_owner");
  }

  if (soulbound) throw new TransferError("asset_is_soulbound");

  // The holder's key must still control the identity the asset is bound to. Checked before
  // anything about the recipient, because if this fails the caller has no standing to send
  // the asset anywhere and the recipient is beside the point.
  const holderDID = (await client.readContract({
    address: didRegistry,
    abi: DID_ABI,
    functionName: "didOf",
    args: [holder],
  })) as string;

  if (holderDID.toLowerCase() !== fromDID.toLowerCase()) {
    throw new TransferError("stale_holder");
  }

  const toDID =
    "didHash" in options.to
      ? options.to.didHash
      : ((await client.readContract({
          address: didRegistry,
          abi: DID_ABI,
          functionName: "didOf",
          args: [options.to.address],
        })) as string);

  if (!toDID || toDID.toLowerCase() === ZERO_DID) {
    throw new TransferError("recipient_has_no_identity");
  }

  if (toDID.toLowerCase() === fromDID.toLowerCase()) {
    throw new TransferError("recipient_already_owns_asset");
  }

  const active = (await client.readContract({
    address: didRegistry,
    abi: DID_ABI,
    functionName: "isActive",
    args: [toDID as `0x${string}`],
  })) as boolean;

  if (!active) throw new TransferError("recipient_identity_inactive");

  // Resolved now rather than trusting the address the caller typed: if the recipient has
  // rotated their key, the asset must follow the identity to the new one.
  const recipient = (await client.readContract({
    address: didRegistry,
    abi: DID_ABI,
    functionName: "controllerOf",
    args: [toDID as `0x${string}`],
  })) as Address;

  if (!recipient || recipient === "0x0000000000000000000000000000000000000000") {
    throw new TransferError("recipient_has_no_identity");
  }

  return { tokenId, fromDID, toDID, recipient };
}
