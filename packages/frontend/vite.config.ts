/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Primary control for "public keys only": Vite inlines nothing that is not
  // prefixed VITE_PUBLIC_, so a server-only variable cannot reach the bundle
  // even if someone references it. src/config/env.ts asserts the same rule at
  // runtime, and tools/check-frontend-bundle.mjs verifies it against dist/.
  envPrefix: "VITE_PUBLIC_",

  server: { port: 5173 },
  build: { outDir: "dist", sourcemap: true },

  // Declared here so vitest does not walk up and adopt the repo-root config,
  // which targets tools/ and would run none of these tests.
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
