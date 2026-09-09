import { describe, expect, it } from "vitest";

import { didHashFor, didScopeFor, didStringFor, keyCommitmentFor } from "./didHash";

const ADDRESS = "0xF2A2bd537e0a1a59F2B5dF4e9d972b8e76e76a5f";

/**
 * These literals are the point of the file.
 *
 * The seed script, the onboarding tool and the registration endpoint each compute this hash
 * independently, and they must agree exactly — a one-character difference produces a
 * different identity that resolves to nobody and silently holds no roles. Asserting against
 * a recomputed value would pass no matter how the derivation drifted, so the expected hashes
 * are written out in full.
 *
 * Each is marked for the secret scanner, which cannot tell a 32-byte hash from a 32-byte
 * private key by shape alone and is right to flag both. These are keccak256 of a public
 * string over a public address: anyone can recompute them, and there is nothing in them to
 * rotate.
 */
describe("didHashFor", () => {
  it("derives the Amoy identity hash", () => {
    expect(didHashFor(ADDRESS, "amoy")).toBe(
      "0x16f00cf49edec64f04be4dcbec0e7972055b239ae5e2233e9d83e2b3bf469ea3", // secrets-scan:allow
    );
  });

  it("derives a different hash on a local chain", () => {
    // Same wallet, different chain, different identity — so a DID created against a local
    // Hardhat node is never mistaken for its Amoy namesake on the same laptop.
    expect(didHashFor(ADDRESS, "hardhat")).toBe(
      "0xf8eca4a0cd72656cfd7e4809b6b1fab09f3112145a1713c13e6fbb8ef76bb045", // secrets-scan:allow
    );
    expect(didHashFor(ADDRESS, "hardhat")).not.toBe(didHashFor(ADDRESS, "amoy"));
  });

  it("does not depend on how the address was typed", () => {
    expect(didHashFor(ADDRESS.toLowerCase(), "amoy")).toBe(
      didHashFor(ADDRESS.toUpperCase().replace("0X", "0x"), "amoy"),
    );
  });

  it("names the scope the seed script uses", () => {
    expect(didScopeFor("amoy")).toBe("amoy");
    expect(didScopeFor("hardhat")).toBe("local");
    expect(didStringFor(ADDRESS, "amoy")).toBe(`did:trustchain:amoy:${ADDRESS.toLowerCase()}`);
  });
});

describe("keyCommitmentFor", () => {
  it("is deterministic and never zero", () => {
    expect(keyCommitmentFor(ADDRESS)).toBe(
      "0xa936b8f0d6dbd1f748a58f0dd4a785acd5bcfeb4a5f3d65b8bf0e8a145852c95", // secrets-scan:allow
    );
    // The registry rejects a zero commitment, so a derivation that could produce one would
    // fail at the contract rather than here.
    expect(keyCommitmentFor(ADDRESS)).not.toBe(`0x${"0".repeat(64)}`);
  });

  it("ignores address casing, unlike the tool it replaces", () => {
    expect(keyCommitmentFor(ADDRESS.toLowerCase())).toBe(keyCommitmentFor(ADDRESS));
  });
});
