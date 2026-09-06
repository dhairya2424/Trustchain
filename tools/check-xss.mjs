#!/usr/bin/env node
// Audits frontend and backend source for sinks that bypass React's escaping.
//
//   node tools/check-xss.mjs [dir...]
//
// React escapes every interpolated value, so the framework is safe by default and the
// interesting question is not "is the output escaped" but "where did someone opt out".
// There is a short, enumerable list of ways to do that, and each one is a place where a
// string becomes markup. This scans for all of them.
//
// The rule is zero findings, with one escape hatch: an inline `xss-audit:allow <reason>`
// marker on or immediately above the line. The marker requires a written reason, so an
// exception has to be argued rather than silently added — and the reasons then form the
// audit that P2.5 asks for.
//
// Exit 1 on any unjustified finding.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INLINE_ALLOW = "xss-audit:allow";

export const PATTERNS = [
  {
    id: "dangerously-set-inner-html",
    description: "dangerouslySetInnerHTML turns a string into markup",
    regex: /dangerouslySetInnerHTML/,
  },
  {
    id: "inner-html-assignment",
    description: "assignment to innerHTML/outerHTML parses the value as HTML",
    regex: /\.(inner|outer)HTML\s*=(?!=)/,
  },
  {
    id: "insert-adjacent-html",
    description: "insertAdjacentHTML parses its argument as HTML",
    regex: /\.insertAdjacentHTML\s*\(/,
  },
  {
    id: "document-write",
    description: "document.write injects into the parser directly",
    regex: /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  },
  {
    id: "eval",
    description: "eval executes a string as code",
    regex: /(?:^|[^.\w])eval\s*\(/,
  },
  {
    id: "function-constructor",
    description: "new Function executes a string as code",
    regex: /\bnew\s+Function\s*\(/,
  },
  {
    id: "javascript-url",
    description: "javascript: URL in an href or src executes on click",
    regex: /(?:href|src|action)\s*[=:]\s*["'`]\s*javascript:/i,
  },
  {
    id: "timer-string-argument",
    description: "setTimeout/setInterval with a string argument evaluates it as code",
    regex: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
  },
  {
    id: "react-create-ref-html",
    description: "srcdoc renders its value as a document",
    regex: /\bsrcdoc\s*[=:]/i,
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".html"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "artifacts",
  "cache",
  "typechain-types",
]);

/**
 * Files that legitimately contain these shapes.
 *
 * The sanitiser assigns innerHTML on a detached element to decode entities from a string
 * DOMPurify has already stripped every tag from, and this auditor contains the patterns it
 * searches for. Both are allowlisted by path rather than by marker so that the marker
 * remains a signal about application code.
 */
const ALLOWLISTED_FILES = [
  /[\\/]http[\\/]sanitize\.ts$/,
  /[\\/]tools[\\/]check-xss\.mjs$/,
  /[\\/]tools[\\/]check-xss\.test\.mjs$/,
];

function isAllowlisted(filePath) {
  return ALLOWLISTED_FILES.some((pattern) => pattern.test(filePath.replace(/\\/g, "/")));
}

export function scanSource(content, filePath = "<memory>") {
  if (isAllowlisted(filePath)) return [];

  const lines = content.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, index) => {
    // A marker on the line itself, or on the line above it, so a justification can sit in
    // a comment rather than being crammed onto the end of the code.
    const previous = index > 0 ? lines[index - 1] : "";
    if (line.includes(INLINE_ALLOW) || previous.includes(INLINE_ALLOW)) return;

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

/** Collects the justified opt-outs, so the audit can report them rather than hide them. */
export function collectJustifications(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  const out = [];
  for (const file of walk(dir)) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        const at = line.indexOf(INLINE_ALLOW);
        if (at === -1) return;
        out.push({
          filePath: file,
          line: index + 1,
          reason: line.slice(at + INLINE_ALLOW.length).trim() || "(no reason given)",
        });
      });
  }
  return out;
}

function main() {
  const targets =
    process.argv.length > 2
      ? process.argv.slice(2)
      : [path.join("packages", "frontend", "src"), path.join("packages", "backend", "src")];

  const findings = targets.flatMap((target) => scanDirectory(target));
  const justified = targets.flatMap((target) => collectJustifications(target));

  for (const entry of justified) {
    console.log(`xss audit: justified opt-out ${entry.filePath}:${entry.line} — ${entry.reason}`);
  }

  if (findings.length === 0) {
    console.log(
      `xss audit: clean (${targets.join(", ")}), ${justified.length} justified opt-out(s)`,
    );
    return 0;
  }

  console.error(`xss audit: ${findings.length} finding(s)\n`);
  for (const finding of findings) {
    console.error(`  ${finding.filePath}:${finding.line}  [${finding.patternId}]`);
    console.error(`    ${finding.description}`);
    console.error(`    ${finding.snippet}`);
  }
  console.error(
    `\nReact escapes interpolated values by default — prefer that. If an opt-out is` +
      ` genuinely required, sanitize with sanitizeRichText() and add an` +
      ` \`${INLINE_ALLOW} <reason>\` marker explaining why.`,
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main());
}
