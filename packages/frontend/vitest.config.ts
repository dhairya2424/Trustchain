import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Component tests need a DOM, so this config opts into jsdom. The environment is set here
 * rather than per-file so a new component test does not silently run without a DOM and
 * fail in a way that looks like a component bug.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
});
