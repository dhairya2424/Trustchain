import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { planTransfer, TransferError } from "./transfer";

/**
 * Every rule here is also enforced by the contract, so none of these tests prove a security
 * property — `AssetRegistry._update` does that, and its own suite covers it. What they pin is
 * that the *refusal* is correct and specific: the difference between telling somebody their
 * asset is soulbound and letting them watch a transaction revert with no explanation.
 *
 * The last case is the one worth reading. A key that no longer controls the owning identity
 * is exactly the position a stolen key is in, and it must not be able to hand the asset to a
 * third party.
 */

const ASSETS = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;
const DIDS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
/** Bob rotated to this key; `controllerOf(BOB_DID)` resolves here, not to BOB. */
const BOB_NEW_KEY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;

const ALICE_DID = `0x${"a1".repeat(32)}`;
const BOB_DID = `0x${"b0".repeat(32)}`;
const ZERO_DID = `0x${"0".repeat(64)}`;

interface ChainState {
  ownerOf?: Address | "missing";
  ownerDIDOf?: string;
  isSoulbound?: boolean;
  didOf?: Record<string, string>;
  isActive?: boolean;
  controllerOf?: Address;
}

/** A chain that answers exactly what the scenario says, and reverts for a missing token. */
function fakeClient(state: ChainState): PublicClient {
  const didOf = state.didOf ?? { [ALICE.toLowerCase()]: ALICE_DID, [BOB.toLowerCase()]: BOB_DID };

  return {
    async readContract({ functionName, args }: { functionName: string; args: unknown[] }) {
      if (state.ownerOf === "missing") throw new Error("ERC721NonexistentToken");

      switch (functionName) {
        case "ownerOf":
          return state.ownerOf ?? ALICE;
        case "ownerDIDOf":
          return state.ownerDIDOf ?? ALICE_DID;
        case "isSoulbound":
          return state.isSoulbound ?? false;
        case "didOf":
          return didOf[String(args[0]).toLowerCase()] ?? ZERO_DID;
        case "isActive":
          return state.isActive ?? true;
        case "controllerOf":
          return state.controllerOf ?? BOB_NEW_KEY;
        default:
          throw new Error(`unexpected read: ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const plan = (
  state: ChainState,
  to: { address: Address } | { didHash: string } = { address: BOB },
) =>
  planTransfer({
    client: fakeClient(state),
    assetRegistry: ASSETS,
    didRegistry: DIDS,
    tokenId: 7,
    holder: ALICE,
    to,
  });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "(no error)";
  } catch (error) {
    return error instanceof TransferError ? error.code : `(${String(error)})`;
  }
}

describe("planTransfer", () => {
  it("plans a legitimate transfer between two identities", async () => {
    const result = await plan({});

    expect(result).toEqual({
      tokenId: 7,
      fromDID: ALICE_DID,
      toDID: BOB_DID,
      recipient: BOB_NEW_KEY,
    });
  });

  it("delivers to the recipient's current key, not the address that was typed", async () => {
    // Bob rotated his key. The asset belongs to Bob's *identity*, so it must follow the
    // identity to whatever key controls it now — sending to the old address would strand it
    // with a key Bob has already abandoned, which is the exact scenario rotation exists for.
    const result = await plan({ controllerOf: BOB_NEW_KEY });

    expect(result.recipient).toBe(BOB_NEW_KEY);
    expect(result.recipient).not.toBe(BOB);
  });

  it("accepts a recipient named by DID as readily as by address", async () => {
    const result = await plan({}, { didHash: BOB_DID });
    expect(result.toDID).toBe(BOB_DID);
  });
});

describe("planTransfer — refusals, each with its own reason", () => {
  it("refuses a token that was never minted", async () => {
    expect(await refusal(plan({ ownerOf: "missing" }))).toBe("asset_not_found");
  });

  it("refuses when the caller does not hold the token", async () => {
    expect(await refusal(plan({ ownerOf: BOB }))).toBe("not_asset_owner");
  });

  it("refuses to move a soulbound token", async () => {
    expect(await refusal(plan({ isSoulbound: true }))).toBe("asset_is_soulbound");
  });

  it("refuses a recipient with no identity", async () => {
    const stranger = "0x000000000000000000000000000000000000dEaD" as Address;
    expect(await refusal(plan({}, { address: stranger }))).toBe("recipient_has_no_identity");
  });

  it("refuses a recipient whose identity has been deactivated", async () => {
    expect(await refusal(plan({ isActive: false }))).toBe("recipient_identity_inactive");
  });

  it("refuses a transfer to the identity that already owns it", async () => {
    // Same identity, different key, is a reclaim — a different action with its own audit
    // code. Silently treating it as a transfer would misreport what happened.
    expect(await refusal(plan({}, { didHash: ALICE_DID }))).toBe("recipient_already_owns_asset");
  });

  it("refuses a holder whose key no longer controls the owning identity", async () => {
    // Alice's key was rotated out — the position a compromised key is in. It still physically
    // holds the token, and it must not be able to sell it. The only move available is a
    // reclaim by the real controller.
    expect(
      await refusal(
        plan({ didOf: { [ALICE.toLowerCase()]: ZERO_DID, [BOB.toLowerCase()]: BOB_DID } }),
      ),
    ).toBe("stale_holder");
  });

  it("checks the holder's standing before anything about the recipient", async () => {
    // A stale holder gets "stale_holder" even when the recipient is also invalid. Reporting
    // the recipient's problem first would send them off fixing the wrong thing.
    expect(
      await refusal(
        plan({ didOf: { [ALICE.toLowerCase()]: ZERO_DID }, isActive: false }, { address: BOB }),
      ),
    ).toBe("stale_holder");
  });
});
