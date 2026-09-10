#!/usr/bin/env node
/**
 * Secret sweep over the FULL git history, plus two hygiene checks.
 *
 *   node tools/scan-history.mjs
 *
 * `scan-secrets.mjs` scans the working tree — what a commit is about to add. This scans what
 * every commit already added, across all branches, because a credential removed in a later
 * commit is still sitting in the history for anyone who clones the repo. It is the check that
 * answers "has a secret ever been committed", which the working-tree scan cannot.
 *
 * Three things run:
 *   1. Every line ever *added* in history is passed through the same secret patterns the
 *      working-tree scanner uses, so the two agree on what counts as a secret. If `gitleaks`
 *      is available (native or via Docker) it is run as a second, independent opinion.
 *   2. No `.env` file (or any real dotenv variant) was ever committed — only `.example` ones.
 *   3. `.gitignore` actually ignores the dotenv files, so the first two cannot regress.
 *
 * A finding here is serious: a secret in history must be rotated and the history rewritten,
 * because the scan proves the old value is still retrievable.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { scanContent } from "./scan-secrets.mjs";

let failures = 0;
const note = (line) => console.log(line);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/** True in a linked worktree, where `.git` is a file rather than a directory. */
function isWorktree() {
  try {
    return statSync(".git").isFile();
  } catch {
    return false;
  }
}

// A distinctive ASCII sentinel that begins each commit header, so parsing the diff stream
// never confuses a commit line with a diff line that happens to start with "commit ".
const COMMIT_MARK = "@@TC_COMMIT@@";

/**
 * Triaged historical false positives — the git-history equivalent of a `.gitleaksignore`.
 *
 * The pattern set is deliberately shape-based (a 32-byte hex is *shaped* like a private key),
 * so run line-by-line over history it flags values that are public by construction — a DID
 * hash, a transaction hash, a fixture string. The working-tree scanner suppresses these with
 * field-name context and inline `secrets-scan:allow` markers, but those markers were added in
 * later commits and history cannot be annotated after the fact.
 *
 * Each entry below was investigated at the named commit and confirmed to be a non-secret. A
 * finding that is NOT on this list still fails the sweep, so the gate stays real: a genuinely
 * new secret in a new commit is caught. Match is by commit prefix + file + pattern.
 */
const HISTORY_ALLOWLIST = [
  {
    commit: "bb3566f",
    file: "tools/e2e-verify-page.mjs",
    patternId: "evm-private-key",
    reason: "a `didHash` value (keccak256 of a public DID string), not a key — public by design",
  },
  {
    commit: "226896e0",
    file: "packages/frontend/src/routes/Dashboard.test.tsx",
    patternId: "evm-private-key",
    reason: "an inert test fixture transaction hash (0x3333…3333), not a key",
  },
  {
    commit: "eac8cdd9",
    file: "packages/backend/src/config/env.test.ts",
    patternId: "credential-assignment",
    reason:
      'the fixture string "super-secret-value-that-must-not-leak", asserting the env parser ' +
      "never echoes a secret — not a real credential",
  },
];

function isTriaged(finding) {
  return HISTORY_ALLOWLIST.some(
    (a) =>
      finding.commit.startsWith(a.commit) &&
      finding.file === a.file &&
      finding.patternId === a.patternId,
  );
}

// ---------------------------------------------------------------- 1. history secret sweep
note("1. Secret patterns across all added lines in history");
{
  // `git log -p` across every ref. `-U0` drops context so only real +/- lines appear; we scan
  // only additions. Renames/copies are followed so a moved secret is still seen.
  const diff = git([
    "log",
    "--all",
    "--no-color",
    "-p",
    "-U0",
    "--diff-filter=AM",
    `--pretty=format:${COMMIT_MARK}%H`,
  ]);

  let commit = "unknown";
  let file = "unknown";
  const findings = [];

  for (const raw of diff.split("\n")) {
    if (raw.startsWith(COMMIT_MARK)) {
      commit = raw.slice(COMMIT_MARK.length).trim();
      continue;
    }
    if (raw.startsWith("+++ b/")) {
      file = raw.slice("+++ b/".length).trim();
      continue;
    }
    // An added content line (but not the +++ header, handled above).
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const line = raw.slice(1);
      const hits = scanContent(line, { filePath: file });
      for (const hit of hits) {
        findings.push({
          commit: commit.slice(0, 10),
          file,
          patternId: hit.patternId,
          redacted: hit.redacted,
        });
      }
    }
  }

  const real = findings.filter((f) => !isTriaged(f));
  const triaged = findings.filter(isTriaged);

  if (real.length === 0) {
    note("   clean — no untriaged secret pattern was ever added in any commit");
    if (triaged.length > 0) {
      note(`   (${triaged.length} shape-based false positive(s) triaged as non-secrets:)`);
      for (const f of triaged) {
        const reason = HISTORY_ALLOWLIST.find(
          (a) => f.commit.startsWith(a.commit) && f.file === a.file && f.patternId === a.patternId,
        )?.reason;
        note(`     ${f.commit}  ${f.file}  [${f.patternId}] — ${reason}`);
      }
    }
  } else {
    failures += 1;
    note(`   ${real.length} untriaged finding(s) in history — ROTATE and rewrite history:`);
    for (const f of real.slice(0, 40)) {
      note(`     ${f.commit}  ${f.file}  [${f.patternId}]  ${f.redacted}`);
    }
  }
}

// ---------------------------------------------------------------- gitleaks, if present
note("\n2. gitleaks (independent scanner), if available");
{
  const native = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  const hasDocker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });

  if (native.status === 0) {
    const run = spawnSync("gitleaks", ["detect", "--no-banner", "--redact", "-v"], {
      encoding: "utf8",
    });
    note(run.stdout?.trim() || run.stderr?.trim() || "(no output)");
    if (run.status !== 0) {
      failures += 1;
      note("   gitleaks reported findings — rotate and rewrite history");
    } else {
      note("   gitleaks: no leaks found");
    }
  } else if (hasDocker.status === 0 && !isWorktree()) {
    note("   gitleaks not installed; running it via Docker (small image)…");
    const cwd = process.cwd().replace(/\\/g, "/");
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${cwd}:/repo`,
        "zricethezav/gitleaks:latest",
        "detect",
        "--source=/repo",
        "--no-banner",
        "--redact",
      ],
      { encoding: "utf8" },
    );
    note(run.stdout?.trim() || run.stderr?.trim() || "(no output)");
    if (run.status === 0) {
      note("   gitleaks (Docker): no leaks found");
    } else if (run.status === 1) {
      failures += 1;
      note("   gitleaks (Docker) reported findings — rotate and rewrite history");
    } else {
      note("   gitleaks (Docker) could not run (image pull or resource limit); the built-in");
      note("   history sweep above is authoritative for this run.");
    }
  } else if (isWorktree()) {
    note("   running inside a git worktree, whose .git is a file pointing at the parent repo,");
    note("   so a Docker-mounted gitleaks would see 0 commits and falsely report clean. Skipped");
    note("   here; the built-in sweep above is authoritative. Run gitleaks on the main checkout");
    note("   for a second opinion.");
  } else {
    note("   gitleaks and Docker both unavailable — the built-in history sweep above stands");
    note("   as the full-history check. Install gitleaks for a second opinion.");
  }
}

// ---------------------------------------------------------------- 3. .env never committed
note("\n3. No .env file was ever committed");
{
  // Every path that ever existed in history, on any branch.
  const paths = new Set(
    git(["log", "--all", "--pretty=format:", "--name-only", "--diff-filter=A"])
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
  );

  // A real dotenv file, not a template. `.env.example`, `.env.sample`, `.env.template` are
  // meant to be committed; `.env`, `.env.local`, `.env.production` are not.
  const isRealDotenv = (p) => {
    const base = p.split("/").pop() ?? p;
    if (!/^\.env(\.|$)/.test(base)) return false;
    return !/\.(example|sample|template|dist)$/.test(base);
  };

  const committed = [...paths].filter(isRealDotenv);
  if (committed.length === 0) {
    note("   clean — only .env.example-style templates were ever committed");
  } else {
    failures += 1;
    note("   a real dotenv file appears in history — ROTATE its contents and purge it:");
    for (const p of committed) note(`     ${p}`);
  }
}

// ---------------------------------------------------------------- 4. .gitignore covers .env
note("\n4. .gitignore keeps dotenv files out");
{
  // check-ignore exits 0 and echoes the paths it would ignore, 1 if it would ignore none.
  const run = spawnSync(
    "git",
    ["check-ignore", ".env", "packages/backend/.env", "packages/contracts/.env"],
    { encoding: "utf8" },
  );
  const ignored = run.stdout ?? "";
  if (ignored.includes(".env")) {
    note("   .env paths are ignored — a stray secret file cannot be staged by accident");
  } else {
    failures += 1;
    note("   .gitignore does NOT ignore .env — add it before anything else");
  }
}

note("\n" + "-".repeat(64));
note(failures === 0 ? "history sweep: CLEAN" : `history sweep: ${failures} PROBLEM(S)`);
process.exitCode = failures === 0 ? 0 : 1;
