import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests.
 *
 * These cover what jsdom cannot: real layout, real focus, real navigation, and the CSS
 * actually applying. The component suite is faster and covers far more cases; this exists
 * for the handful of claims that are only true in a browser.
 *
 * The frontend is started by Playwright. The **backend is not** — it needs Postgres, Redis,
 * a chain and a funded relayer, and a test runner that quietly starts and stops that stack
 * would make a failure impossible to interpret. Specs that need the API check for it first
 * and skip with a message naming what to run, which is more useful than a timeout.
 */
export default defineConfig({
  testDir: "./e2e",
  // Chain reads on the local node are not instant, and a flaky timeout reads as a product
  // bug rather than a slow fixture.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  // Serial in CI: the specs share one backend and one chain, and a parallel mint would race
  // the audit assertions of another worker.
  workers: process.env.CI ? 1 : undefined,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "npm run dev --workspace @trustchain/frontend",
    url: "http://localhost:5173",
    // Reuses a dev server that is already up, which is the normal local case; CI always
    // starts its own.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
