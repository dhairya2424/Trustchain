import { describe, expect, it } from "vitest";
import { isAllowlisted, scanContent } from "../scan-secrets.mjs";

const AWS_KEY = `AKIA${"Q7WFHTNM4XZ2B8VK"}`;
const EVM_KEY = `0x${"a3f1".repeat(16)}`;

describe("secret scanner", () => {
  it("detects an AWS access key id", () => {
    const findings = scanContent(`const k = "${AWS_KEY}";`, { filePath: "src/a.ts" });
    expect(findings.map((f) => f.patternId)).toContain("aws-access-key-id");
  });

  it("detects a PEM private key header", () => {
    const findings = scanContent("-----BEGIN RSA PRIVATE KEY-----", { filePath: "src/a.ts" });
    expect(findings.map((f) => f.patternId)).toContain("private-key-pem");
  });

  it("detects a 32-byte hex private key", () => {
    const findings = scanContent(`const pk = "${EVM_KEY}";`, { filePath: "src/a.ts" });
    expect(findings.map((f) => f.patternId)).toContain("evm-private-key");
  });

  it("detects a connection string carrying a password", () => {
    const findings = scanContent("postgresql://admin:h9Zq2Lm4Vt@db.internal:5432/app", {
      filePath: "src/a.ts",
    });
    expect(findings.map((f) => f.patternId)).toContain("connection-string-password");
  });

  it("detects a credential assigned to a literal", () => {
    const findings = scanContent(`api_key = "s8Kd93Lqm4Zx7Rt2"`, { filePath: "src/a.ts" });
    expect(findings.map((f) => f.patternId)).toContain("credential-assignment");
  });

  it("redacts the match rather than reprinting it", () => {
    const [finding] = scanContent(`const k = "${AWS_KEY}";`, { filePath: "src/a.ts" });
    expect(finding.redacted).not.toBe(AWS_KEY);
    expect(finding.redacted).toContain("*");
  });

  it("ignores documented placeholders", () => {
    const findings = scanContent('DEPLOYER_PRIVATE_KEY="replace-me-with-deployer-private-key"', {
      filePath: "src/a.ts",
    });
    expect(findings).toHaveLength(0);
  });

  it("ignores allowlisted files", () => {
    expect(isAllowlisted("packages/backend/.env.example")).toBe(true);
    expect(isAllowlisted("package-lock.json")).toBe(true);
    expect(isAllowlisted("packages/backend/src/config/env.ts")).toBe(false);

    const findings = scanContent(`key = "${AWS_KEY}"`, {
      filePath: "packages/backend/.env.example",
    });
    expect(findings).toHaveLength(0);
  });

  it("honours an inline allow marker", () => {
    const findings = scanContent(`const k = "${AWS_KEY}"; // secrets-scan:allow`, {
      filePath: "src/a.ts",
    });
    expect(findings).toHaveLength(0);
  });

  it("reports clean content as clean", () => {
    expect(scanContent("export const answer = 42;", { filePath: "src/a.ts" })).toHaveLength(0);
  });

  /**
   * A private key and a transaction hash are both 32 bytes of hex, so shape alone cannot
   * separate them — the JSON key does. These tests pin the exclusion to exactly that, since
   * an over-broad version would quietly stop the scanner catching the thing it exists for.
   */
  describe("public chain hashes are not private keys", () => {
    it("ignores a 32-byte hex under txHash", () => {
      // OpenZeppelin's upgrades manifest records the transaction that created each proxy.
      // It must be committed, and it is rewritten on every deploy — so inline allow markers
      // would be erased each time and this has to hold by rule.
      const findings = scanContent(`    "txHash": "${EVM_KEY}",`, {
        filePath: "packages/contracts/.openzeppelin/unknown-80002.json",
      });
      expect(findings).toHaveLength(0);
    });

    it("ignores blockHash too", () => {
      const findings = scanContent(`  "blockHash": "${EVM_KEY}"`, { filePath: "a.json" });
      expect(findings).toHaveLength(0);
    });

    it("still flags the same value under a key that is not a public hash", () => {
      const findings = scanContent(`  "deployerKey": "${EVM_KEY}"`, { filePath: "a.json" });
      expect(findings.map((f) => f.patternId)).toContain("evm-private-key");
    });

    it("still flags a bare key on a line that merely mentions txHash", () => {
      // The hex must be the value that key introduces. Naming a field nearby is not enough,
      // or "// see txHash above" would launder a pasted key.
      const findings = scanContent(`const pk = "${EVM_KEY}"; // next to txHash`, {
        filePath: "src/a.ts",
      });
      expect(findings.map((f) => f.patternId)).toContain("evm-private-key");
    });
  });
});
