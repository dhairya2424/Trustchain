import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ACTION_CODES, actionCode, actionName } from "./actions";

const solidity = readFileSync(
  path.resolve(process.cwd(), "..", "contracts", "contracts", "libraries", "ActionCodes.sol"),
  "utf8",
);

function solidityCodes(): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of solidity.matchAll(/constant\s+(\w+)\s*=\s*(\d+);/g)) {
    found.set(match[1] as string, Number(match[2]));
  }
  return found;
}

/**
 * An action code is part of the permanent record. Renumbering one would retroactively
 * change the meaning of history already written to an append-only ledger, and there is no
 * migration for that — so the mapping is asserted against the contract source rather than
 * trusted to stay in step by convention.
 */
describe("action codes match the contracts", () => {
  const codes = solidityCodes();

  it("covers every code the Solidity declares", () => {
    expect(Object.keys(ACTION_CODES).length).toBe(codes.size);
  });

  it.each([...Object.keys(ACTION_CODES)])("%s has the same number as the Solidity", (name) => {
    expect(ACTION_CODES[name as keyof typeof ACTION_CODES]).toBe(codes.get(name));
  });

  it("keeps the credential codes the audit filters rely on", () => {
    expect(ACTION_CODES.CREDENTIAL_ISSUED).toBe(11);
    expect(ACTION_CODES.CREDENTIAL_REVOKED).toBe(12);
  });
});

describe("actionName", () => {
  it("names a known code", () => {
    expect(actionName(8)).toBe("ASSET_MINTED");
  });

  /**
   * An API older than the contract that wrote the entry must still render it. Dropping
   * unnameable entries would put holes in the one document that must not have holes.
   */
  it("renders an unknown code rather than hiding the entry", () => {
    expect(actionName(200)).toBe("UNKNOWN_ACTION_200");
  });

  it("renders code zero, which no contract emits, rather than treating it as absent", () => {
    expect(actionName(0)).toBe("UNKNOWN_ACTION_0");
  });
});

describe("actionCode", () => {
  it("resolves a name to its code", () => {
    expect(actionCode("CREDENTIAL_REVOKED")).toBe(12);
  });

  it("accepts a lowercase name, since it arrives from a query string", () => {
    expect(actionCode("role_granted")).toBe(5);
  });

  it("returns null for a name it does not know", () => {
    expect(actionCode("NOT_A_REAL_ACTION")).toBeNull();
  });
});
