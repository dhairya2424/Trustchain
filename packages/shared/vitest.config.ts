import { defineConfig } from "vitest/config";

// Required: without a config here, vitest walks up and adopts the repo-root config
// (which targets tools/), silently running none of these tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
