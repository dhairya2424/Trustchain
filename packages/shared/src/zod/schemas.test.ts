import { describe, expect, it } from "vitest";
import {
  auditQuery,
  bytes32,
  evmAddress,
  ipfsUri,
  issueCredentialPayloadRequest,
  issueCredentialRequest,
  mintAssetRequest,
  nonZeroBytes32,
  pagination,
  profileMutableFields,
  revocationReason,
  revokeCredentialRequest,
  updateProfileRequest,
  verifyCredentialRequest,
} from "../index";

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HASH = `0x${"a1".repeat(32)}`; // secrets-scan:allow
const ZERO = `0x${"0".repeat(64)}`;

describe("primitives", () => {
  it("accepts and lowercases an address so comparisons are total", () => {
    expect(evmAddress.parse(ADDRESS)).toBe(ADDRESS.toLowerCase());
  });

  it.each([
    ["too short", "0x70997970"],
    ["not hex", `0x${"z".repeat(40)}`],
    ["missing prefix", ADDRESS.slice(2)],
    ["empty", ""],
  ])("rejects an address that is %s", (_label, value) => {
    expect(evmAddress.safeParse(value).success).toBe(false);
  });

  it("accepts a 32-byte hash and rejects the wrong width", () => {
    expect(bytes32.parse(HASH)).toBe(HASH.toLowerCase());
    expect(bytes32.safeParse(ADDRESS).success).toBe(false);
  });

  it("rejects the zero hash where a real identifier is required", () => {
    expect(bytes32.safeParse(ZERO).success).toBe(true);
    expect(nonZeroBytes32.safeParse(ZERO).success).toBe(false);
  });

  it("accepts only ipfs:// metadata URIs", () => {
    expect(
      ipfsUri.safeParse("ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").success,
    ).toBe(true);
    // https content can be swapped after issuance, which defeats anchoring it on-chain.
    expect(ipfsUri.safeParse("https://example.com/meta.json").success).toBe(false);
    expect(ipfsUri.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("requires a non-zero revocation reason", () => {
    expect(revocationReason.safeParse(0).success).toBe(false);
    expect(revocationReason.parse("3")).toBe(3);
  });

  it("bounds pagination so a caller cannot request the whole table", () => {
    expect(pagination.parse({}).limit).toBe(25);
    expect(pagination.safeParse({ limit: 1000 }).success).toBe(false);
    expect(pagination.parse({ limit: "50" }).limit).toBe(50);
  });
});

describe("request DTOs are strict", () => {
  it("rejects an unexpected field rather than ignoring it", () => {
    const result = mintAssetRequest.safeParse({
      toDID: HASH,
      tokenURI: "ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      soulbound: false,
      mintedBy: "0xattacker",
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("mintedBy");
  });

  it("refuses a role field on a profile update", () => {
    const result = updateProfileRequest.safeParse({ displayName: "Alice", role: "ADMIN" });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("role");
  });

  it("derives the mass-assignment allowlist from the schema, so they cannot drift", () => {
    expect([...profileMutableFields].sort()).toEqual(["avatarUri", "bio", "displayName"]);
    // The fields that matter are absent by construction.
    expect(profileMutableFields).not.toContain("role");
    expect(profileMutableFields).not.toContain("didHash");
  });

  it("defaults an omitted credential expiry to never", () => {
    const parsed = issueCredentialRequest.parse({
      credentialHash: HASH,
      didHash: HASH,
      schemaId: HASH,
    });

    expect(parsed.expiresAt).toBe(0);
  });

  it("rejects an inverted audit time range", () => {
    expect(auditQuery.safeParse({ from: 200, to: 100 }).success).toBe(false);
    expect(auditQuery.safeParse({ from: 100, to: 200 }).success).toBe(true);
  });
});

describe("audit query", () => {
  it("accepts an action name as well as a numeric code", () => {
    expect(auditQuery.safeParse({ action: "CREDENTIAL_ISSUED" }).success).toBe(true);
    expect(auditQuery.safeParse({ actionCode: 11 }).success).toBe(true);
  });

  it("rejects an action name that is not an identifier", () => {
    expect(auditQuery.safeParse({ action: "<script>" }).success).toBe(false);
  });

  it("rejects an unknown filter, so a typo is not silently ignored", () => {
    expect(auditQuery.safeParse({ acter: ADDRESS }).success).toBe(false);
  });

  it("caps the page size", () => {
    expect(auditQuery.safeParse({ limit: 5000 }).success).toBe(false);
  });
});

describe("credential issuance payload", () => {
  const base = { didHash: HASH, credentialType: "EmploymentCredential", claims: { role: "Eng" } };

  it("accepts flat scalar claims", () => {
    expect(
      issueCredentialPayloadRequest.safeParse({
        ...base,
        claims: { role: "Eng", level: 3, active: true },
      }).success,
    ).toBe(true);
  });

  it("defaults an omitted expiry to never", () => {
    expect(issueCredentialPayloadRequest.parse(base).expiresAt).toBe(0);
  });

  /** A credential is signed, pinned and effectively permanent, so the payload is bounded. */
  it("rejects a nested claim object", () => {
    expect(
      issueCredentialPayloadRequest.safeParse({ ...base, claims: { nested: { a: 1 } } }).success,
    ).toBe(false);
  });

  it("rejects more claims than the cap allows", () => {
    const claims = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]));

    expect(issueCredentialPayloadRequest.safeParse({ ...base, claims }).success).toBe(false);
  });

  /** The subject is derived from the DID; letting a caller set it would redirect it. */
  it("rejects a claim named id", () => {
    expect(
      issueCredentialPayloadRequest.safeParse({ ...base, claims: { id: "did:evil:1" } }).success,
    ).toBe(false);
  });

  it("rejects a credential type that is not an alphanumeric identifier", () => {
    expect(
      issueCredentialPayloadRequest.safeParse({ ...base, credentialType: "<script>x</script>" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(issueCredentialPayloadRequest.safeParse({ ...base, issuer: ADDRESS }).success).toBe(
      false,
    );
  });
});

describe("credential verification request", () => {
  it("accepts a hash alone", () => {
    expect(verifyCredentialRequest.safeParse({ credentialHash: HASH }).success).toBe(true);
  });

  it("accepts a JWT alone", () => {
    expect(verifyCredentialRequest.safeParse({ jwt: "a".repeat(40) }).success).toBe(true);
  });

  /** Supplying both is ambiguous: the two could disagree about which credential is meant. */
  it("rejects both together", () => {
    expect(
      verifyCredentialRequest.safeParse({ credentialHash: HASH, jwt: "a".repeat(40) }).success,
    ).toBe(false);
  });

  it("rejects neither", () => {
    expect(verifyCredentialRequest.safeParse({}).success).toBe(false);
  });
});

describe("revocation", () => {
  /** A boolean says something was revoked; a code says why. The contract requires one. */
  it("refuses a zero reason code", () => {
    expect(revokeCredentialRequest.safeParse({ credentialHash: HASH, reasonCode: 0 }).success).toBe(
      false,
    );
  });

  it("accepts a non-zero reason code", () => {
    expect(revokeCredentialRequest.safeParse({ credentialHash: HASH, reasonCode: 1 }).success).toBe(
      true,
    );
  });
});
