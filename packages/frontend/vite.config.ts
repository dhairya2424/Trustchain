/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // "@/..." resolves to src/. This is the convention every shadcn and 21st.dev component
  // is written against, so a component's own imports work without being rewritten by hand.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },

  // Primary control for "public keys only": Vite inlines nothing that is not
  // prefixed VITE_PUBLIC_, so a server-only variable cannot reach the bundle
  // even if someone references it. src/config/env.ts asserts the same rule at
  // runtime, and tools/check-frontend-bundle.mjs verifies it against dist/.
  envPrefix: "VITE_PUBLIC_",

  server: { port: 5173 },

  build: {
    outDir: "dist",
    sourcemap: true,

    rollupOptions: {
      output: {
        /*
         * Vendor splitting for cache lifetime, not for total size.
         *
         * React and the web3 stack change on completely different schedules from the
         * application code, so keeping them in the entry chunk means every deploy
         * invalidates ~450kB that did not change. three.js and GSAP are absent here
         * deliberately — they are already separate chunks because they are imported
         * dynamically, and naming them would force them back into the static graph.
         */
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          web3: ["wagmi", "viem", "@tanstack/react-query"],
        },
      },
    },
  },

  // Declared here so vitest does not walk up and adopt the repo-root config,
  // which targets tools/ and would run none of these tests.
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
