import { keccak256, toHex } from "viem";

/**
 * How a DID hash is derived from an address, in one place.
 *
 * Three programs need this value to agree exactly: the seed script that creates the first
 * identities, the onboarding tool, and now the API that registers identities in-product. A
 * disagreement of a single character produces a *different identity* — one that resolves to
 * nobody, holds no roles, and looks from the outside like the chain forgetting a user. That
 * failure is silent and miserable to diagnose, so the derivation is defined here and pinned
 * by a test with a literal expected hash.
 *
 * The scope segment keeps testnet and local identities distinct, so a DID minted against a
 * local Hardhat chain cannot be mistaken for its Amoy namesake when both databases are on
 * the same laptop.
 *
 * ## This is a deployment convenience, not the model
 *
 * Deriving a DID deterministically from an address means an address has exactly one possible
 * identity, which is what makes the seed re-runnable and lets a tool compute the hash without
 * asking the chain. Real DIDs are not functions of a wallet — an identity should outlive any
 * particular key, which is precisely what `rotateController` exists for. The registry itself
 * imposes no such derivation: it stores whatever hash it is given. So this is how *this
 * deployment* names identities, and nothing downstream depends on it being reversible.
 */

/** The network segment of a DID string. Anything that is not Amoy is local, as in the seed. */
export function didScopeFor(networkId: string): string {
  return networkId === "amoy" ? "amoy" : "local";
}

/** The DID string itself — `did:trustchain:<scope>:<lowercased address>`. */
export function didStringFor(address: string, networkId: string): string {
  return `did:trustchain:${didScopeFor(networkId)}:${address.toLowerCase()}`;
}

/** keccak256 of the DID string. This is the `bytes32` every contract stores. */
export function didHashFor(address: string, networkId: string): `0x${string}` {
  return keccak256(toHex(didStringFor(address, networkId)));
}

/**
 * A commitment to the identity's key material.
 *
 * The registry stores a hash and never the material itself, so nothing here is reversible
 * and no personal data reaches the chain. The value is opaque to every consumer — nothing
 * re-derives it for comparison, and controller rotation is authorised by an EIP-712
 * signature rather than by revealing a pre-image — so what matters is only that it is
 * non-zero and deterministic for a given address.
 *
 * The address is lowercased before hashing. The onboarding tool hashed whatever casing the
 * operator typed, which made the commitment depend on how the address was pasted; that never
 * caused a fault, because nothing reads it back, but a value that changes with keyboard input
 * has no business being called deterministic.
 */
export function keyCommitmentFor(address: string): `0x${string}` {
  return keccak256(toHex(`key:${address.toLowerCase()}`));
}
