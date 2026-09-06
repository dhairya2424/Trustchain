// solhint exits 255 when a glob matches nothing, which breaks CI while the
// contracts package is still empty. Skip only in that exact case — once sources
// exist, solhint's own exit code is propagated untouched.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SOURCE_DIR = "contracts";

const solidityFiles = existsSync(SOURCE_DIR)
  ? readdirSync(SOURCE_DIR, { recursive: true }).filter((entry) => String(entry).endsWith(".sol"))
  : [];

if (solidityFiles.length === 0) {
  console.log("solhint: no Solidity sources yet — skipping");
  process.exit(0);
}

const result = spawnSync("npx", ["solhint", `${SOURCE_DIR}/**/*.sol`], {
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
