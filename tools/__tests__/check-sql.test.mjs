import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanDirectory, scanSource } from "../check-sql.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("sql audit", () => {
  it("catches SQL built by interpolating a template literal", () => {
    const findings = scanSource(
      "const q = `SELECT * FROM users WHERE id = ${userId}`;",
      "src/bad.ts",
    );

    expect(findings.map((f) => f.patternId)).toContain("template-interpolation");
  });

  it("catches SQL assembled with string concatenation", () => {
    const findings = scanSource(
      'const q = "SELECT * FROM users WHERE id = " + userId;',
      "src/bad.ts",
    );

    expect(findings.length).toBeGreaterThan(0);
  });

  it("catches a value concatenated onto a WHERE clause", () => {
    const findings = scanSource('const q = base + " WHERE name = \'" + name;', "src/bad.ts");

    expect(findings.length).toBeGreaterThan(0);
  });

  it("accepts the safe tagged template", () => {
    const findings = scanSource(
      "const q = compile(sql`SELECT * FROM users WHERE id = ${userId}`);",
      "src/good.ts",
    );

    expect(findings).toEqual([]);
  });

  it("ignores prose that merely mentions SQL keywords", () => {
    const findings = scanSource("// SELECT the right approach, then UPDATE the docs", "src/doc.ts");

    expect(findings).toEqual([]);
  });

  it("honours an inline allow marker", () => {
    const findings = scanSource(
      "const q = `SELECT * FROM t WHERE id = ${id}`; // sql-audit:allow",
      "src/bad.ts",
    );

    expect(findings).toEqual([]);
  });

  it("does not flag the tagged template implementation itself", () => {
    const findings = scanSource(
      "const q = `SELECT * FROM users WHERE id = ${x}`;",
      "packages/backend/src/db/sql.ts",
    );

    expect(findings).toEqual([]);
  });

  it("REAL AUDIT: the backend source contains no concatenated SQL", () => {
    const findings = scanDirectory(path.join(repoRoot, "packages", "backend", "src"));

    expect(
      findings.map((f) => `${f.filePath}:${f.line} ${f.description}`),
      "concatenated SQL found — use the sql`` tagged template",
    ).toEqual([]);
  });
});
