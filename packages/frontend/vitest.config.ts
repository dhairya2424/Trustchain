import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Component tests need a DOM, so this config opts into jsdom. The environment is set here
 * rather than per-file so a new component test does not silently run without a DOM and
 * fail in a way that looks like a component bug.
 *
 * This file takes precedence over vite.config.ts, so the "@/" alias has to be repeated
 * here — without it every component that imports "@/lib/utils" fails to resolve under test
 * while working perfectly in the browser, which is a confusing way to spend an afternoon.
 *
 * The Tailwind plugin is deliberately absent: tests assert structure and behaviour, never
 * computed styles, so compiling the stylesheet would cost time and buy nothing.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
    css: false,
  },
});
