import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectJustifications, PATTERNS, scanDirectory, scanSource } from "../check-xss.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("xss audit — sinks that bypass React escaping", () => {
  it("catches dangerouslySetInnerHTML", () => {
    const findings = scanSource(
      "return <div dangerouslySetInnerHTML={{ __html: bio }} />;",
      "src/Bio.tsx",
    );

    expect(findings.map((f) => f.patternId)).toContain("dangerously-set-inner-html");
  });

  it("catches innerHTML and outerHTML assignment", () => {
    expect(scanSource("el.innerHTML = userInput;", "src/a.ts")).toHaveLength(1);
    expect(scanSource("node.outerHTML = value;", "src/a.ts")).toHaveLength(1);
  });

  it("does not mistake an innerHTML comparison for an assignment", () => {
    expect(scanSource("if (el.innerHTML === expected) return;", "src/a.ts")).toHaveLength(0);
  });

  it("catches insertAdjacentHTML and document.write", () => {
    expect(scanSource('el.insertAdjacentHTML("beforeend", s);', "src/a.ts")).toHaveLength(1);
    expect(scanSource("document.write(payload);", "src/a.ts")).toHaveLength(1);
  });

  it("catches eval and the Function constructor", () => {
    expect(scanSource("const r = eval(expr);", "src/a.ts")).toHaveLength(1);
    expect(scanSource("const f = new Function(body);", "src/a.ts")).toHaveLength(1);
  });

  it("does not flag a method that merely ends in eval", () => {
    expect(scanSource("const r = schema.safeEval(expr);", "src/a.ts")).toHaveLength(0);
  });

  it("catches a javascript: URL and a string timer argument", () => {
    expect(scanSource('<a href="javascript:alert(1)">x</a>', "src/a.tsx")).toHaveLength(1);
    expect(scanSource('setTimeout("doThing()", 10);', "src/a.ts")).toHaveLength(1);
  });

  it("does not flag setTimeout with a function argument", () => {
    expect(scanSource("setTimeout(() => refresh(), 10);", "src/a.ts")).toHaveLength(0);
  });

  it("catches srcdoc, which renders its value as a document", () => {
    expect(scanSource("<iframe srcdoc={html} />", "src/a.tsx")).toHaveLength(1);
  });

  it("has no pattern that matches ordinary React output", () => {
    const ordinary = [
      "return <p>{profile.displayName}</p>;",
      "const title = `Asset ${tokenId}`;",
      "res.json({ status: 'ok' });",
    ].join("\n");

    expect(scanSource(ordinary, "src/App.tsx")).toHaveLength(0);
  });
});

describe("xss audit — the justification marker", () => {
  it("suppresses a finding when the marker is on the same line", () => {
    const source = "el.innerHTML = safe; // xss-audit:allow value is sanitizeRichText output";
    expect(scanSource(source, "src/a.ts")).toHaveLength(0);
  });

  it("suppresses a finding when the marker is on the line above", () => {
    const source = [
      "// xss-audit:allow rendered from a trusted template",
      "el.innerHTML = t;",
    ].join("\n");
    expect(scanSource(source, "src/a.ts")).toHaveLength(0);
  });

  it("does not suppress a finding two lines below the marker", () => {
    const source = ["// xss-audit:allow reason", "const x = 1;", "el.innerHTML = t;"].join("\n");
    expect(scanSource(source, "src/a.ts")).toHaveLength(1);
  });
});

/**
 * The gate is only worth anything if it fails. These run the real CLI over a directory
 * containing a real violation and assert the process exits non-zero — the check that would
 * have caught the two silently-passing gates found earlier in this build.
 */
describe("xss audit — the gate rejects", () => {
  it("exits non-zero on a directory containing dangerouslySetInnerHTML", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "xss-audit-"));
    try {
      writeFileSync(
        path.join(dir, "Bad.tsx"),
        "export const Bad = () => <div dangerouslySetInnerHTML={{ __html: bio }} />;\n",
      );

      let exitCode = 0;
      let output = "";
      try {
        output = execFileSync(process.execPath, [path.join(repoRoot, "tools/check-xss.mjs"), dir], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        exitCode = error.status;
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }

      expect(exitCode).toBe(1);
      expect(output).toContain("dangerously-set-inner-html");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits zero on a clean directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "xss-audit-clean-"));
    try {
      writeFileSync(path.join(dir, "Good.tsx"), "export const Good = () => <p>{name}</p>;\n");

      const output = execFileSync(
        process.execPath,
        [path.join(repoRoot, "tools/check-xss.mjs"), dir],
        { encoding: "utf8" },
      );

      expect(output).toContain("clean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The audit P2.5 asks for: every `dangerouslySetInnerHTML` in the repository must be zero
 * or justified. This asserts the count is zero, so if one is ever added the requirement is
 * re-argued in a code review rather than discovered later.
 */
describe("xss audit — the repository itself", () => {
  it("has no unjustified sink in the frontend or the backend", () => {
    const findings = [
      ...scanDirectory(path.join(repoRoot, "packages/frontend/src")),
      ...scanDirectory(path.join(repoRoot, "packages/backend/src")),
    ];

    expect(findings).toEqual([]);
  });

  it("has zero uses of dangerouslySetInnerHTML, justified or otherwise", () => {
    const justified = collectJustifications(path.join(repoRoot, "packages/frontend/src"));

    expect(justified).toEqual([]);
  });

  it("covers every sink class it claims to", () => {
    expect(PATTERNS.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        "dangerously-set-inner-html",
        "inner-html-assignment",
        "insert-adjacent-html",
        "document-write",
        "eval",
        "function-constructor",
        "javascript-url",
      ]),
    );
  });
});
