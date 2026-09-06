// The P0.2 proof artifact: build the frontend with real server secrets present
// in the environment, then read every file in dist/ and assert they are absent.
//
// A positive control runs first — a VITE_PUBLIC_ sentinel MUST be found in the
// output. Without it, "secret not found" could simply mean the grep was broken.

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle } from "../check-frontend-bundle.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distDir = path.join(repoRoot, "packages", "frontend", "dist");
const srcDir = path.join(repoRoot, "packages", "frontend", "src");

const SERVER_SECRET = "SENTINEL-SERVER-KEY-3f9a1c7e5b2d4086";
const PUBLIC_SENTINEL = "sentinel-public-6f1a2b3c";

const buildEnv = {
  JWT_PRIVATE_KEY: SERVER_SECRET,
  PINATA_JWT: SERVER_SECRET,
  TURNSTILE_SECRET_KEY: SERVER_SECRET,
  DEPLOYER_PRIVATE_KEY: SERVER_SECRET,
  DATABASE_URL: `postgresql://trustchain:${SERVER_SECRET}@localhost:5432/trustchain`,
  VITE_PUBLIC_API_URL: `http://${PUBLIC_SENTINEL}.example.com`,
};

function distFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).size < 20 * 1024 * 1024) out.push(full);
    }
  };
  walk(distDir);
  return out;
}

beforeAll(() => {
  rmSync(distDir, { recursive: true, force: true });

  // Drive Vite through node directly. Going via `npm` would need shell:true on
  // Windows (npm is a .cmd), which is deprecated and an injection surface.
  const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error(`vite binary not found at ${viteBin} — run npm install first`);
  }

  const result = spawnSync(process.execPath, [viteBin, "build"], {
    cwd: path.join(repoRoot, "packages", "frontend"),
    env: { ...process.env, ...buildEnv },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`frontend build failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}, 300_000);

describe("frontend bundle contains no server secrets", () => {
  it("produced a build", () => {
    expect(existsSync(distDir)).toBe(true);
    expect(distFiles().length).toBeGreaterThan(0);
  });

  it("positive control: the VITE_PUBLIC_ sentinel IS present in dist", () => {
    const found = distFiles().some((file) => readFileSync(file, "utf8").includes(PUBLIC_SENTINEL));

    expect(
      found,
      "public sentinel missing — the build did not inline env, so this suite proves nothing",
    ).toBe(true);
  });

  it("the server private key is absent from every emitted file", () => {
    const leaked = distFiles().filter((file) => readFileSync(file, "utf8").includes(SERVER_SECRET));

    expect(leaked.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it("no server-only variable name is present in the bundle", () => {
    const offenders = [];

    for (const file of distFiles()) {
      const content = readFileSync(file, "utf8");
      for (const name of [
        "JWT_PRIVATE_KEY",
        "DATABASE_URL",
        "PINATA_JWT",
        "TURNSTILE_SECRET_KEY",
      ]) {
        if (content.includes(name)) offenders.push(`${path.relative(repoRoot, file)} → ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the bundle checker passes against the real build", () => {
    const result = checkBundle({ distDir, srcDir, env: { ...process.env, ...buildEnv } });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
