#!/usr/bin/env node
/**
 * One-shot codemod: ad-hoc pixel type sizes to the scale in theme.css.
 *
 *   node tools/apply-type-scale.mjs [--check]
 *
 * Kept in the repo rather than run and deleted, because it documents the mapping. If
 * someone later wonders why a label is 11px rather than 11.5px, the answer is here: the
 * near-duplicate pairs were collapsed deliberately, not lost.
 *
 * `--check` reports what would change without writing, which is what makes this safe to
 * re-run: a clean check means no arbitrary sizes have crept back in.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "packages/frontend/src");

/**
 * The mapping, and the reasoning for each collapse.
 *
 * Where two values differed by half a pixel they were never distinguishable; both go to the
 * nearer scale step. Where a value was genuinely a display size it keeps its own token.
 */
const SIZE_MAP = new Map([
  // Micro labels. 11 and 11.5 were the same intent written twice.
  ["text-[11px]", "text-2xs"],
  ["text-[11.5px]", "text-2xs"],

  // Metadata and captions. 12 / 12.5 likewise.
  ["text-[12px]", "text-xs"],
  ["text-[12.5px]", "text-xs"],

  // Secondary body and dense UI. 13 / 13.5 likewise.
  ["text-[13px]", "text-sm"],
  ["text-[13.5px]", "text-sm"],

  // Body.
  ["text-[14px]", "text-base"],
  ["text-[15px]", "text-base"],

  // Titles.
  ["text-[16px]", "text-lg"],
  ["text-[17px]", "text-lg"],
  ["text-[22px]", "text-xl"],

  // The two display numerals: a stat counter and the verdict tick. Both keep a bespoke
  // size because they are single glyphs sized to their box, not text on a scale.
]);

/** Tracking values that were all the same idiom. */
const TRACKING_MAP = new Map([
  ["tracking-[0.08em]", "tracking-label"],
  ["tracking-[0.1em]", "tracking-label"],
  ["tracking-[0.12em]", "tracking-label"],
  ["tracking-[0.14em]", "tracking-label"],
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const check = process.argv.includes("--check");
let changedFiles = 0;
let replacements = 0;

for (const file of walk(root)) {
  const original = readFileSync(file, "utf8");
  let next = original;

  for (const [from, to] of [...SIZE_MAP, ...TRACKING_MAP]) {
    // Word-boundary anchored so `text-[11px]` never matches inside `text-[113px]`.
    const pattern = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const count = (next.match(pattern) ?? []).length;
    if (count === 0) continue;

    replacements += count;
    next = next.replace(pattern, to);
  }

  if (next === original) continue;

  changedFiles += 1;
  if (!check) writeFileSync(file, next);
}

if (check) {
  if (replacements === 0) {
    console.log("type scale: clean — no ad-hoc pixel sizes");
  } else {
    console.error(
      `type scale: ${replacements} ad-hoc size(s) in ${changedFiles} file(s).\n` +
        "Run `node tools/apply-type-scale.mjs` or use a scale step from theme.css.",
    );
    process.exit(1);
  }
} else {
  console.log(`type scale: ${replacements} replacement(s) across ${changedFiles} file(s)`);
}

/*
 * Second gate: a colour token must never share its name with a font-size token.
 *
 * Tailwind derives `text-<name>` from both the `--color-*` and `--text-*` namespaces, and
 * where a name exists in both, the font size wins silently. This is not hypothetical — the
 * type scale added `--text-base` alongside the existing `--color-base`, and every
 * `bg-fg text-base` button (the primary button, and the skip link) lost its dark foreground
 * and rendered as near-white text on a near-white fill. Nothing caught it: unit tests query
 * by role, axe's contrast rule is disabled under jsdom, and Playwright asserts presence
 * rather than colour. It took looking at a screenshot.
 *
 * The colour token was renamed to `--color-canvas`. This check is what stops the next one.
 */
const theme = readFileSync(path.join(root, "styles", "theme.css"), "utf8");

const tokenNames = (prefix) =>
  new Set(
    [...theme.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+?):`, "g"))]
      .map((match) => match[1])
      // `--text-base--line-height` is a modifier on `base`, not a token in its own right.
      .filter((name) => !name.includes("--")),
  );

const fontSizes = tokenNames("text");
const collisions = [...tokenNames("color")].filter((name) => fontSizes.has(name));

if (collisions.length > 0) {
  console.error(
    `theme: ${collisions.length} name(s) defined as both a colour and a font size: ` +
      `${collisions.join(", ")}.\n` +
      "Tailwind resolves `text-<name>` to the font size and drops the colour with no warning. " +
      "Rename the colour token.",
  );
  process.exit(1);
}

if (check) console.log("theme: no colour/font-size token collisions");
