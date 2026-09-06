import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkBundle } from "../check-frontend-bundle.mjs";

const created = [];

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "trustchain-bundle-"));
  created.push(dir);
  const dist = path.join(dir, "dist");
  const src = path.join(dir, "src");
  mkdirSync(dist);
  mkdirSync(src);
  return { dist, src };
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true });
  }
});

describe("frontend bundle check", () => {
  it("passes on a clean bundle and clean source", () => {
    const { dist, src } = scratch();
    writeFileSync(path.join(dist, "index.js"), 'const api="http://localhost:4000";');
    writeFileSync(path.join(src, "App.tsx"), "export default function App(){return null;}");

    expect(checkBundle({ distDir: dist, srcDir: src, env: {} }).ok).toBe(true);
  });

  it("catches a server-only value inlined into the bundle", () => {
    const { dist, src } = scratch();
    const secret = "sk-live-9f2b7c41d8e6a35b0c7d";
    writeFileSync(path.join(dist, "index.js"), `const t="${secret}";`);

    const result = checkBundle({
      distDir: dist,
      srcDir: src,
      env: { TURNSTILE_SECRET_KEY: secret },
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.check)).toContain("bundle-var-value");
  });

  it("catches a server-only variable name in the bundle", () => {
    const { dist, src } = scratch();
    writeFileSync(path.join(dist, "index.js"), 'const x=env["JWT_PRIVATE_KEY"];');

    const result = checkBundle({ distDir: dist, srcDir: src, env: {} });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.check)).toContain("bundle-var-name");
  });

  it("catches a credential pattern in the bundle", () => {
    const { dist, src } = scratch();
    writeFileSync(path.join(dist, "index.js"), "-----BEGIN PRIVATE KEY-----");

    const result = checkBundle({ distDir: dist, srcDir: src, env: {} });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.check)).toContain("bundle-credential-pattern");
  });

  it("catches source reading a non-public VITE_ variable", () => {
    const { dist, src } = scratch();
    writeFileSync(path.join(dist, "index.js"), "const a=1;");
    writeFileSync(path.join(src, "leak.ts"), "export const k = import.meta.env.VITE_SECRET_KEY;");

    const result = checkBundle({ distDir: dist, srcDir: src, env: {} });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.check)).toContain("source-env-prefix");
  });

  it("allows the documented public and built-in Vite variables", () => {
    const { dist, src } = scratch();
    writeFileSync(path.join(dist, "index.js"), "const a=1;");
    writeFileSync(
      path.join(src, "ok.ts"),
      "export const a = import.meta.env.VITE_PUBLIC_API_URL; export const b = import.meta.env.MODE;",
    );

    expect(checkBundle({ distDir: dist, srcDir: src, env: {} }).ok).toBe(true);
  });

  it("catches browser source touching process.env", () => {
    const { dist, src } = scratch();
    writeFileSync(path.join(dist, "index.js"), "const a=1;");
    writeFileSync(path.join(src, "leak.ts"), "export const k = process.env.DATABASE_URL;");

    const result = checkBundle({ distDir: dist, srcDir: src, env: {} });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.check)).toContain("source-process-env");
  });

  it("reports a missing build instead of silently passing", () => {
    const result = checkBundle({ distDir: path.join(tmpdir(), "definitely-absent-dist") });

    expect(result.ok).toBe(false);
    expect(result.findings[0].check).toBe("bundle-missing");
  });
});
