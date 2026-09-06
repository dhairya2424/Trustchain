#!/usr/bin/env node
// Audits backend source for string-concatenated SQL.
//
//   node tools/check-sql.mjs [dir]
//
// The `sql` tagged template makes parameterization automatic, so this exists to catch the
// one thing that template cannot prevent: someone bypassing it and building a statement
// with `+` or an interpolated string. A convention nobody checks is a convention that
// erodes, and this is the class of bug that ends with a dropped table.
//
// Exit 1 on any finding.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SQL_KEYWORD =
  /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP|ALTER|CREATE\s+TABLE|TRUNCATE)\b/i;

export const PATTERNS = [
  {
    id: "template-interpolation",
    description: "SQL built with an interpolated template literal",
    // A backtick string containing a SQL keyword and a ${...} placeholder.
    regex: /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*\$\{[^`]*`/i,
  },
  {
    id: "string-concatenation",
    description: "SQL assembled with +",
    regex: /["'][^"']*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE)\b[^"']*["']\s*\+/i,
  },
  {
    id: "concat-into-sql",
    description: "value concatenated onto a SQL string",
    regex: /\+\s*["'][^"']*\b(?:WHERE|VALUES|SET|FROM|AND|OR)\b/i,
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".turbo"]);
const INLINE_ALLOW = "sql-audit:allow";

/** The tagged template itself, and this auditor, legitimately contain these shapes. */
const ALLOWLISTED_FILES = [/[\\/]db[\\/]sql\.ts$/, /[\\/]tools[\\/]check-sql\.mjs$/];

function isAllowlisted(filePath) {
  return ALLOWLISTED_FILES.some((pattern) => pattern.test(filePath.replace(/\\/g, "/")));
}

/** True when the line's SQL is produced by the safe tagged template. */
function usesTaggedTemplate(line) {
  return /\bsql`/.test(line);
}

export function scanSource(content, filePath = "<memory>") {
  if (isAllowlisted(filePath)) return [];

  const findings = [];

  content.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(INLINE_ALLOW)) return;
    if (!SQL_KEYWORD.test(line) && !/\+\s*["']/.test(line)) return;
    if (usesTaggedTemplate(line)) return;

    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          filePath,
          line: index + 1,
          patternId: pattern.id,
          description: pattern.description,
          snippet: line.trim().slice(0, 120),
        });
        break;
      }
    }
  });

  return findings;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

export function scanDirectory(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  return walk(dir).flatMap((file) => scanSource(readFileSync(file, "utf8"), file));
}

function main() {
  const target = process.argv[2] ?? path.join("packages", "backend", "src");
  const findings = scanDirectory(target);

  if (findings.length === 0) {
    console.log(`sql audit: clean (${target})`);
    return 0;
  }

  console.error(`sql audit: ${findings.length} finding(s)\n`);
  for (const finding of findings) {
    console.error(`  ${finding.filePath}:${finding.line}  [${finding.patternId}]`);
    console.error(`    ${finding.description}`);
    console.error(`    ${finding.snippet}`);
  }
  console.error(
    `\nUse the sql\`\` tagged template in db/sql.ts — it parameterizes by construction.`,
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
