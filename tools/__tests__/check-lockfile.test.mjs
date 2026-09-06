import { describe, expect, it } from "vitest";
import { checkLockfile, checkLockfileData } from "../check-lockfile.mjs";

const good = (extra = {}) => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "root" },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-abc",
    },
    ...extra,
  },
});

describe("lockfile integrity", () => {
  it("passes a clean lockfile", () => {
    const result = checkLockfileData(good());
    expect(result.ok).toBe(true);
    expect(result.inspected).toBe(1);
  });

  it("rejects lockfileVersion below 3", () => {
    const result = checkLockfileData({ ...good(), lockfileVersion: 1 });
    expect(result.findings.map((f) => f.check)).toContain("lockfile-version");
  });

  it("rejects a dependency from a non-npm registry", () => {
    const result = checkLockfileData(
      good({
        "node_modules/evil": {
          version: "1.0.0",
          resolved: "https://registry.attacker.example/evil/-/evil-1.0.0.tgz",
          integrity: "sha512-xyz",
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.check)).toContain("untrusted-registry");
  });

  it("rejects a dependency pulled from git", () => {
    const result = checkLockfileData(
      good({
        "node_modules/forked": {
          version: "1.0.0",
          resolved: "git+ssh://git@github.com/someone/forked.git#deadbeef",
        },
      }),
    );
    expect(result.findings.map((f) => f.check)).toContain("forbidden-source");
  });

  it("rejects a dependency pulled over plaintext HTTP", () => {
    const result = checkLockfileData(
      good({
        "node_modules/insecure": {
          version: "1.0.0",
          resolved: "http://registry.npmjs.org/insecure/-/insecure-1.0.0.tgz",
          integrity: "sha512-xyz",
        },
      }),
    );
    expect(result.findings.map((f) => f.check)).toContain("forbidden-source");
  });

  it("rejects a dependency with no integrity hash", () => {
    const result = checkLockfileData(
      good({
        "node_modules/nohash": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/nohash/-/nohash-1.0.0.tgz",
        },
      }),
    );
    expect(result.findings.map((f) => f.check)).toContain("missing-integrity");
  });

  it("ignores workspace links and bundled dependencies", () => {
    const result = checkLockfileData(
      good({
        "packages/backend": { name: "@trustchain/backend", version: "1.0.0" },
        "node_modules/@trustchain/backend": { resolved: "packages/backend", link: true },
        "node_modules/bundled": { version: "1.0.0", inBundle: true },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("reports a missing lockfile rather than passing silently", () => {
    const result = checkLockfile("definitely-not-a-lockfile.json");
    expect(result.ok).toBe(false);
    expect(result.findings[0].check).toBe("lockfile-missing");
  });

  it("passes against this repository's real lockfile", () => {
    const result = checkLockfile("package-lock.json");
    expect(result.findings).toEqual([]);
    expect(result.inspected).toBeGreaterThan(100);
  });
});
