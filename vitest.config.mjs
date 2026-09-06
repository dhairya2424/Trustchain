import { defineConfig } from "vitest/config";

// Root suite covers repo-level security tooling only. Package suites run
// through their own workspaces via `turbo run test`.
export default defineConfig({
  test: {
    include: ["tools/**/*.test.mjs"],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
