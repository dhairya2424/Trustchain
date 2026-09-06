#!/usr/bin/env node
// Fails the build if anything server-only reaches the frontend.
//
//   node tools/check-frontend-bundle.mjs [distDir] [srcDir]
//
// Four independent checks:
//   1. frontend source never reads a non-VITE_PUBLIC_ variable
//   2. frontend source never touches process.env
//   3. no server-only variable NAME appears in the built output
//   4. no server-only variable VALUE (as currently set) appears in the built output
//   5. no generic credential pattern appears in the built output
//
// Sourcemaps are scanned too — they embed original source and leak just as well.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanContent } from "./scan-secrets.mjs";

const DEFAULT_DIST = path.join("packages", "frontend", "dist");
const DEFAULT_SRC = path.join("packages", "frontend", "src");

export const PUBLIC_PREFIX = "VITE_PUBLIC_";

/** Variables that must never be readable from a browser. */
export const SERVER_ONLY_VARS = [
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "FIELD_ENCRYPTION_KEY",
  "PINATA_JWT",
  "TURNSTILE_SECRET_KEY",
  "DEFENDER_API_KEY",
  "DEFENDER_API_SECRET",
  "DEPLOYER_PRIVATE_KEY",
  "POLYGONSCAN_API_KEY",
  "POSTGRES_PASSWORD",
  "AMOY_RPC_URL",
];

const SCANNED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".json",
  ".map",
  ".txt",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

/** A value too short or too generic to be evidence of a leak. */
function isUninterestingValue(value) {
  return (
    typeof value !== "string" ||
    value.length < 12 ||
    /^(?:true|false|localhost|development|production|test)$/i.test(value)
  );
}

function walk(dir, extensions) {
  if (!existsSync(dir)) return [];

  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, extensions));
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function checkSource(srcDir) {
  const findings = [];

  for (const file of walk(srcDir, SOURCE_EXTENSIONS)) {
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      for (const match of line.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) {
        const name = match[1];
        if (
          name.startsWith(PUBLIC_PREFIX) ||
          name === "MODE" ||
          name === "DEV" ||
          name === "PROD" ||
          name === "BASE_URL" ||
          name === "SSR"
        ) {
          continue;
        }
        findings.push({
          check: "source-env-prefix",
          file,
          line: index + 1,
          detail: `reads import.meta.env.${name}; only ${PUBLIC_PREFIX}* is permitted`,
        });
      }

      for (const match of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        findings.push({
          check: "source-process-env",
          file,
          line: index + 1,
          detail: `reads process.env.${match[1]}; browser code has no server environment`,
        });
      }
    });
  }

  return findings;
}

function checkBundleContents(distDir, env) {
  const files = walk(distDir, SCANNED_EXTENSIONS);
  const findings = [];

  for (const file of files) {
    if (statSync(file).size > 20 * 1024 * 1024) continue;
    const content = readFileSync(file, "utf8");

    for (const name of SERVER_ONLY_VARS) {
      if (content.includes(name)) {
        findings.push({
          check: "bundle-var-name",
          file,
          detail: `contains the server-only variable name ${name}`,
        });
      }

      const value = env[name];
      if (!isUninterestingValue(value) && content.includes(value)) {
        findings.push({
          check: "bundle-var-value",
          file,
          detail: `contains the live value of ${name}`,
        });
      }
    }

    for (const finding of scanContent(content, { filePath: file })) {
      findings.push({
        check: "bundle-credential-pattern",
        file,
        detail: `${finding.description} (${finding.patternId}) — ${finding.redacted}`,
      });
    }
  }

  return { findings, fileCount: files.length };
}

export function checkBundle({
  distDir = DEFAULT_DIST,
  srcDir = DEFAULT_SRC,
  env = process.env,
} = {}) {
  if (!existsSync(distDir)) {
    return {
      ok: false,
      fileCount: 0,
      findings: [
        {
          check: "bundle-missing",
          file: distDir,
          detail: "build output not found — run the frontend build first",
        },
      ],
    };
  }

  const source = checkSource(srcDir);
  const bundle = checkBundleContents(distDir, env);
  const findings = [...source, ...bundle.findings];

  return { ok: findings.length === 0, findings, fileCount: bundle.fileCount };
}

function main() {
  const [distArg, srcArg] = process.argv.slice(2);
  const result = checkBundle({ distDir: distArg ?? DEFAULT_DIST, srcDir: srcArg ?? DEFAULT_SRC });

  if (result.ok) {
    console.log(`frontend bundle: clean (${result.fileCount} files scanned)`);
    return 0;
  }

  console.error(`frontend bundle: ${result.findings.length} finding(s)\n`);
  for (const finding of result.findings) {
    const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  [${finding.check}] ${where}`);
    console.error(`    ${finding.detail}`);
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
