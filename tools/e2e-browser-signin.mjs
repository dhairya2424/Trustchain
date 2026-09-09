#!/usr/bin/env node
/**
 * Signs in through the browser, the way a person with a wallet does.
 *
 *   node tools/e2e-browser-signin.mjs
 *
 * This exists because a bug got all the way to a user through a gap exactly this shaped.
 * The frontend had no Sign-In With Ethereum implementation at all: a wallet connected, the
 * header showed an address, and `/auth/session` stayed 401 forever. Every end-to-end tool
 * signed in from Node by driving the four HTTP calls directly, which exercised the server's
 * half of the protocol thoroughly and the browser's half not at all.
 *
 * So this drives the browser. Chromium has no wallet extension, so a minimal EIP-1193
 * provider is injected as `window.ethereum`; signing is delegated back to Node through a
 * Playwright binding, using a real key and viem's real signer. The message that gets signed
 * is the one the application actually built, and the session that comes back is a real
 * cookie from the real API.
 */
import { chromium } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = process.env.E2E_APP ?? "http://localhost:5173";
const API = process.env.E2E_API ?? "http://localhost:4000";

/** Hardhat #0 — a published test key, and the Amoy deployer. */
function deployerKey() {
  for (const line of readFileSync(path.join(repoRoot, "packages/contracts/.env"), "utf8").split(
    /\r?\n/,
  )) {
    const match = line.match(/^DEPLOYER_PRIVATE_KEY=(.*)$/);
    if (match) return match[1].trim();
  }
  throw new Error("no DEPLOYER_PRIVATE_KEY in packages/contracts/.env");
}

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const account = privateKeyToAccount(deployerKey());
const network = await (await fetch(`${API}/network`)).json();
const chainIdHex = `0x${Number(network.active.chainId).toString(16)}`;

console.log(`network ${network.active.label} (${network.active.chainId})`);
console.log(`wallet  ${account.address}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/401|Unauthorized/.test(m.text()))
    errors.push(m.text().slice(0, 600));
});
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 140)}`));

// Signing happens in Node with a real key; the page only asks for it.
await page.exposeFunction("__walletSign", async (message) => account.signMessage({ message }));

/**
 * A minimal EIP-1193 provider.
 *
 * Only the methods wagmi's injected connector and SIWE actually use. Anything else throws
 * rather than returning a plausible lie, so a missing method shows up as a failure here
 * instead of as odd behaviour later.
 */
await page.addInitScript(
  ({ address, chainIdHex }) => {
    const listeners = new Map();

    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return chainIdHex;
          case "net_version":
            return String(parseInt(chainIdHex, 16));
          case "personal_sign": {
            // params: [hexMessage, address]
            const hex = params[0];
            const bytes = hex
              .slice(2)
              .match(/.{1,2}/g)
              .map((byte) => parseInt(byte, 16));
            const message = new TextDecoder().decode(new Uint8Array(bytes));
            return window.__walletSign(message);
          }
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default:
            throw new Error(`unsupported method: ${method}`);
        }
      },
      on: (event, handler) => {
        listeners.set(event, handler);
      },
      removeListener: (event) => listeners.delete(event),
    };
  },
  { address: account.address, chainIdHex },
);

console.log("1. Connect a wallet");

await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
await page.getByTestId("connect-button").first().click();

const injected = page.getByTestId("wallet-option-injected").first();
check("the injected wallet is offered", await injected.isVisible().catch(() => false));
await injected.click();

console.log("\n2. Sign in happens without being asked twice");

// The point of the whole exercise: connecting should lead to a session on its own.
const chip = page.getByTestId("account-chip").first();
const appeared = await chip
  .waitFor({ state: "visible", timeout: 30_000 })
  .then(() => true)
  .catch(() => false);

check("the header shows a signed-in identity", appeared);
if (!appeared) {
  const signInVisible = await page
    .getByTestId("sign-in-button")
    .first()
    .isVisible()
    .catch(() => false);
  const error = await page
    .getByTestId("sign-in-error")
    .first()
    .textContent()
    .catch(() => null);
  console.log(`        sign-in button visible: ${signInVisible}, error: ${error ?? "(none)"}`);
}

console.log("\n3. The dashboard shows the identity, not a sign-in prompt");

await page.waitForTimeout(1500);
const main =
  (await page
    .locator("#main")
    .innerText()
    .catch(() => "")) ?? "";

check("the sign-in prompt is gone", !/Sign in to see your identity/i.test(main));
check("the DID is on screen", /Decentralized identifier/i.test(main), main.slice(0, 80));
check("roles read from the chain are shown", /ROLES, READ FROM THE CHAIN/i.test(main));

await page.screenshot({ path: ".screenshots/browser-signin.png", fullPage: true });

console.log("\n4. The session is real, not just local state");

// Scoped to the API's own origin. Asking the context for every cookie it holds returns
// the ones belonging to pages it has visited, and the session cookie belongs to the API —
// a different origin from the app whenever the two are on different hosts.
const cookies = await page.context().cookies(API);
check(
  "a session cookie was set by the API",
  cookies.some((c) => c.name.includes("trustchain") || c.name.includes("session")),
  cookies.length ? cookies.map((c) => c.name).join(", ") : "no cookies for " + API,
);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();

console.log(`\n${"-".repeat(60)}`);
console.log(`passed ${passed}   failed ${failed}`);
console.log(`\nBrowser sign-in: ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) process.exitCode = 1;
