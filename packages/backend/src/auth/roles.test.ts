import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { keccak256, toBytes } from "viem";

import {
  hasAnyRole,
  hasRole,
  PERMISSION_IDS,
  PERMISSION_NAMES,
  ROLE_IDS,
  ROLE_NAMES,
  roleNameOf,
  roleNames,
} from "./roles";

const contractsDir = path.resolve(process.cwd(), "..", "contracts", "contracts", "libraries");

function solidityConstants(file: string): Map<string, string> {
  const source = readFileSync(path.join(contractsDir, file), "utf8");
  const found = new Map<string, string>();

  // `bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");`
  const pattern = /constant\s+(\w+)\s*=\s*keccak256\(\s*"([^"]+)"\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    found.set(match[1] as string, match[2] as string);
  }

  return found;
}

/**
 * These assertions are the whole reason the identifiers are derived rather than pasted.
 *
 * A role id is 32 bytes of hex that nobody reviews by eye. If the Solidity were renamed
 * and this table were not, every gate keyed on the stale id would silently stop matching —
 * and a role check that never matches is a door that is always shut or, depending on which
 * side the comparison sits, always open. Reading the contract source here means that
 * rename fails the build.
 */
describe("role identifiers match the contracts", () => {
  const roleSource = solidityConstants("TrustChainRoles.sol");

  it("declares exactly the four roles the problem statement fixes", () => {
    expect([...ROLE_NAMES]).toEqual(["ADMIN", "MANAGER", "AUDITOR", "USER"]);
    expect(roleSource.size).toBe(4);
  });

  it.each([...ROLE_NAMES])("%s matches the Solidity constant", (name) => {
    const label = roleSource.get(`${name}_ROLE`);

    expect(label, `TrustChainRoles.sol has no ${name}_ROLE`).toBeDefined();
    expect(ROLE_IDS[name]).toBe(keccak256(toBytes(label as string)));
  });

  it("has no ISSUER or VERIFIER role, because the chain implements neither", () => {
    expect([...roleSource.keys()]).not.toContain("ISSUER_ROLE");
    expect([...roleSource.keys()]).not.toContain("VERIFIER_ROLE");
    expect(Object.keys(ROLE_IDS)).not.toContain("ISSUER");
  });
});

describe("permission identifiers match the contracts", () => {
  const permissionSource = solidityConstants("Permissions.sol");

  it("covers every permission the contracts declare", () => {
    expect(PERMISSION_NAMES.length).toBe(permissionSource.size);
  });

  it.each([...PERMISSION_NAMES])("%s matches the Solidity constant", (name) => {
    const label = permissionSource.get(name);

    expect(label, `Permissions.sol has no ${name}`).toBeDefined();
    expect(PERMISSION_IDS[name]).toBe(keccak256(toBytes(label as string)));
  });

  it("names the credential permissions the issuance routes gate on", () => {
    expect(permissionSource.get("ISSUE_CREDENTIAL")).toBe("PERM_ISSUE_CREDENTIAL");
    expect(permissionSource.get("REVOKE_CREDENTIAL")).toBe("PERM_REVOKE_CREDENTIAL");
    expect(permissionSource.get("VIEW_AUDIT")).toBe("PERM_VIEW_AUDIT");
  });
});

describe("role predicates", () => {
  it("matches a held role regardless of hex casing", () => {
    expect(hasRole([ROLE_IDS.MANAGER.toUpperCase()], "MANAGER")).toBe(true);
  });

  it("does not match a role the account does not hold", () => {
    expect(hasRole([ROLE_IDS.USER], "ADMIN")).toBe(false);
  });

  it("treats an empty role set as holding nothing", () => {
    expect(hasAnyRole([], ["ADMIN", "MANAGER", "AUDITOR", "USER"])).toBe(false);
  });

  it("names known ids and ignores unknown ones", () => {
    expect(roleNames([ROLE_IDS.ADMIN, "0xdead"])).toEqual(["ADMIN"]);
    expect(roleNameOf("0xdead")).toBeNull();
  });

  it("does not report a role twice when an id repeats", () => {
    expect(roleNames([ROLE_IDS.USER, ROLE_IDS.USER])).toEqual(["USER"]);
  });
});
