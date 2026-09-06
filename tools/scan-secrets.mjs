#!/usr/bin/env node
// Regex credential scanner (a `git secrets` equivalent with no external tooling).
//
// Scans git-tracked files by default:  node tools/scan-secrets.mjs
// Scans explicit paths:                node tools/scan-secrets.mjs path/a path/b
//
// Exit code 1 on any finding. Matches are reported redacted so the scanner's own
// output never becomes a second copy of the secret.

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SECRET_PATTERNS = [
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    id: "private-key-pem",
    description: "PEM-encoded private key block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: "evm-private-key",
    description: "32-byte hex value (possible EVM private key)",
    regex: /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g,
  },
  {
    id: "json-web-token",
    description: "JSON Web Token",
    regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: "github-token",
    description: "GitHub token",
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    regex: /AIza[0-9A-Za-z_-]{35}/g,
  },
  {
    id: "credential-assignment",
    description: "Credential assigned to a literal",
    regex:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
  },
  {
    id: "connection-string-password",
    description: "Connection string with inline password",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:/\s]+:[^@\s]+@/g,
  },
];

/** Obvious non-secrets. Keeps documentation and fixtures from tripping the scan. */
const PLACEHOLDER =
  /replace[-_]?me|example|changeme|dummy|placeholder|your[-_]|sample|xxxx|<[^>]+>|\bpw\b|password123|0{16,}/i;

/** Paths whose whole purpose is to contain secret-shaped text. */
const ALLOWLISTED_PATHS = [
  /(^|[\\/])\.env\.example$/,
  /(^|[\\/])[^\\/]*\.env\.example$/,
  /(^|[\\/])package-lock\.json$/,
  /(^|[\\/])tools[\\/]scan-secrets\.mjs$/,
  /(^|[\\/])tools[\\/]check-frontend-bundle\.mjs$/,
  /(^|[\\/])tools[\\/]__tests__[\\/]/,
  /(^|[\\/])docs[\\/]SECURITY_BASELINE\.md$/,
];

const INLINE_ALLOW = "secrets-scan:allow";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".gz",
  ".wasm",
]);

const MAX_BYTES = 2 * 1024 * 1024;

export function isAllowlisted(filePath) {
  const normalised = filePath.replace(/\\/g, "/");
  return ALLOWLISTED_PATHS.some((pattern) => pattern.test(normalised));
}

function redact(match) {
  if (match.length <= 8) return "*".repeat(match.length);
  return `${match.slice(0, 4)}${"*".repeat(Math.min(match.length - 8, 24))}${match.slice(-4)}`;
}

/** Scan a string. Returns [{ patternId, description, line, redacted }]. */
export function scanContent(content, { filePath = "<memory>" } = {}) {
  if (isAllowlisted(filePath)) return [];

  const lines = content.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, index) => {
    if (line.includes(INLINE_ALLOW)) return;

    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of line.matchAll(pattern.regex)) {
        const value = match[0];
        if (PLACEHOLDER.test(value)) continue;

        findings.push({
          filePath,
          patternId: pattern.id,
          description: pattern.description,
          line: index + 1,
          redacted: redact(value),
        });
      }
    }
  });

  return findings;
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr?.trim() ?? "unknown error"}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export function scanFiles(files) {
  const findings = [];

  for (const file of files) {
    if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

    let stats;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) continue;

    findings.push(...scanContent(readFileSync(file, "utf8"), { filePath: file }));
  }

  return findings;
}

function main() {
  const explicit = process.argv.slice(2);
  const files = explicit.length > 0 ? explicit : trackedFiles();
  const findings = scanFiles(files);

  if (findings.length === 0) {
    console.log(`secret scan: clean (${files.length} files)`);
    return 0;
  }

  console.error(`secret scan: ${findings.length} finding(s)\n`);
  for (const finding of findings) {
    console.error(
      `  ${finding.filePath}:${finding.line}  [${finding.patternId}] ${finding.description}`,
    );
    console.error(`    match: ${finding.redacted}`);
  }
  console.error(
    `\nRotate anything real, remove it from the working tree and history, and re-run.` +
      `\nIf a match is genuinely inert, append "${INLINE_ALLOW}" to that line.`,
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
