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

/**
 * JSON keys whose value is a 32-byte hash by definition, and public by definition.
 *
 * An EVM private key and a transaction hash are both 32 bytes of hex, so no regex can tell
 * them apart from shape alone. The field name can: nothing writes a private key under
 * `txHash`, and everything that publishes a chain reference does.
 *
 * This became necessary when the Amoy deployment landed. OpenZeppelin's upgrades plugin
 * writes a manifest recording the transaction that created each proxy and implementation —
 * eight `txHash` entries, every one a real, public, already-mined Amoy transaction, and
 * every one flagged as a possible private key. The manifest must be committed (it is how
 * upgrade safety is checked later) and it is regenerated on every deploy, so inline allow
 * markers would be erased and have to be re-added each time.
 *
 * The exclusion is deliberately narrow: it applies only to the private-key pattern, only
 * when the hex sits in the value position of one of these keys on the same line. A key
 * pasted under any other name, or bare in a file, still fails the scan.
 */
const PUBLIC_HASH_KEYS =
  /"(?:tx|transaction)Hash"|"blockHash"|"parentHash"|"receiptsRoot"|"stateRoot"|"transactionsRoot"|"commit"|"sha"/i;

function isPublicChainHash(line, value) {
  if (!PUBLIC_HASH_KEYS.test(line)) return false;
  // The hex must be the value that key introduces, not merely present on a busy line.
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${PUBLIC_HASH_KEYS.source}\\s*:\\s*"${escaped}"`, "i").test(line);
}

/**
 * The same hash, written as a link instead of a field.
 *
 * Documentation cites transactions the way a reader can actually check them — as an explorer
 * URL — and `https://amoy.polygonscan.com/tx/0x…` is the canonical form. The hex there is a
 * mined transaction by definition: it is already public, and a private key pasted into that
 * position would not be a secret leak so much as a broken link.
 *
 * As narrow as the field rule above: the hex must directly follow an explorer's `/tx/`
 * segment. A bare hash anywhere else in the same sentence still fails the scan.
 */
function isExplorerTxUrl(line, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/tx/${escaped}\\b`, "i").test(line);
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
        if (
          pattern.id === "evm-private-key" &&
          (isPublicChainHash(line, value) || isExplorerTxUrl(line, value))
        ) {
          continue;
        }

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

/**
 * Tracked files PLUS untracked-but-not-ignored ones.
 *
 * Scanning only tracked files would skip a newly written file that has not been
 * committed yet — precisely where a freshly pasted credential lives. Ignored
 * paths (node_modules, .env, build output) stay excluded.
 */
function candidateFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr?.trim() ?? "unknown error"}`);
  }
  return [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))];
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
  const files = explicit.length > 0 ? explicit : candidateFiles();
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
