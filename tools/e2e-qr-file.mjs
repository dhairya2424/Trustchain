#!/usr/bin/env node
/**
 * The QR round trip, with real pixels: download it, then verify from the downloaded file.
 *
 *   node tools/e2e-qr-file.mjs
 *
 * Two features meet here, and testing either alone would prove less than testing the loop:
 *
 *   1. The dashboard can save its identity QR as a PNG.
 *   2. The public verifier can read a QR out of an image file.
 *
 * So this signs in, presses Download, catches the actual file the browser wrote, hands that
 * file to the verifier's upload control, and asserts the identity resolves. Nothing is
 * stubbed: the PNG is the one a user would email, and it is decoded by the same code path
 * their browser would run.
 *
 * That matters because the exported code is deliberately *not* a copy of the one on screen —
 * the on-screen QR is pale grey on transparent, which is unscannable on white. If the export
 * ever regresses to a screenshot of it, this fails.
 */
import { chromium } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = process.env.E2E_APP ?? "http://localhost:5173";
const API = process.env.E2E_API ?? "http://localhost:4000";
const OUT = path.join(repoRoot, ".screenshots");

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

mkdirSync(OUT, { recursive: true });

const account = privateKeyToAccount(deployerKey());
const network = await (await fetch(`${API}/network`)).json();
const chainIdHex = `0x${Number(network.active.chainId).toString(16)}`;

console.log(`network ${network.active.label} (${network.active.chainId})`);
console.log(`wallet  ${account.address}\n`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/401|Unauthorized|favicon/.test(m.text())) {
    errors.push(m.text().slice(0, 300));
  }
});
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));

await page.exposeFunction("__walletSign", async (message) => account.signMessage({ message }));

await page.addInitScript(
  ({ address, chainIdHex }) => {
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
            const bytes = params[0]
              .slice(2)
              .match(/.{1,2}/g)
              .map((b) => parseInt(b, 16));
            return window.__walletSign(new TextDecoder().decode(new Uint8Array(bytes)));
          }
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default:
            throw new Error(`unsupported method: ${method}`);
        }
      },
      on: () => {},
      removeListener: () => {},
    };
  },
  { address: account.address, chainIdHex },
);

console.log("1. Sign in and find the identity QR");

await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
await page.getByTestId("connect-button").first().click();
await page.getByTestId("wallet-option-injected").first().click();

const signedIn = await page
  .getByTestId("account-chip")
  .first()
  .waitFor({ state: "visible", timeout: 30_000 })
  .then(() => true)
  .catch(() => false);

check("signed in", signedIn);
if (!signedIn) {
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(2000);
check(
  "the identity QR is on the dashboard",
  await page
    .getByTestId("identity-qr")
    .isVisible()
    .catch(() => false),
);

console.log("\n2. Download it");

const downloadControl = page.getByTestId("qr-download");
check("a download control is offered", (await downloadControl.count()) > 0);

const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 20_000 }),
  downloadControl.click(),
]);

const savedTo = path.join(OUT, "identity-qr.png");
await download.saveAs(savedTo);

const size = statSync(savedTo).size;
check("a PNG was written", size > 0, `${size} bytes`);
check(
  "it is named for the identity it proves",
  /^trustchain-identity-[0-9a-f]{12}\.png$/.test(download.suggestedFilename()),
  download.suggestedFilename(),
);

// A 1024px black-on-white QR is comfortably over a kilobyte; a blank or transparent canvas
// compresses to almost nothing, which is exactly what a regression here would produce.
check("it holds an actual code rather than an empty canvas", size > 1000, `${size} bytes`);

console.log("\n3. Verify from that very file");

await page.goto(`${APP}/verify`, { waitUntil: "networkidle" });

const upload = page.getByTestId("verify-upload");
check("the verifier offers an image upload", (await upload.count()) > 0);

await page.setInputFiles('[data-testid="verify-image-input"]', savedTo);

const resolved = await page
  .getByTestId("identity-verdict")
  .waitFor({ state: "visible", timeout: 30_000 })
  .then(() => true)
  .catch(() => false);

check("the downloaded QR decoded and resolved an identity", resolved);

if (resolved) {
  const text = (await page.getByTestId("identity-verdict").innerText()).toLowerCase();
  // The panel truncates the controller for layout, so match its leading characters rather
  // than the whole address — and search the panel entire, since the address sits well below
  // the heading that announces the verdict.
  const prefix = account.address.slice(0, 6).toLowerCase();
  check(
    "and it is this wallet's identity, read from the chain",
    text.includes(prefix),
    `looked for ${prefix} in: ${text.replace(/\s+/g, " ").slice(0, 160)}`,
  );
}

await page.screenshot({ path: path.join(OUT, "qr-file-verified.png"), fullPage: true });

console.log("\n4. A picture with no code in it");

// The verifier must say "no code here" rather than passing junk to the credential endpoint,
// which would answer "neither a hash nor a JWT" and blame the wrong thing.
await page.goto(`${APP}/verify`, { waitUntil: "networkidle" });
await page.setInputFiles(
  '[data-testid="verify-image-input"]',
  path.join(OUT, "gaps-dashboard.png"),
);

const refused = await page
  .getByTestId("verify-error")
  .waitFor({ state: "visible", timeout: 20_000 })
  .then(() => true)
  .catch(() => false);

check("an image with no QR is reported as such", refused);
if (refused) {
  const message = await page.getByTestId("verify-error").innerText();
  check(
    "with a sentence about the image, not about hashes",
    /No QR code was found/i.test(message),
    message.slice(0, 120),
  );
}

console.log("\n5. Nothing threw");
check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();

console.log(`\n${"-".repeat(60)}`);
console.log(`passed ${passed}   failed ${failed}`);
console.log(`saved QR: ${savedTo}`);
console.log(`\nQR round trip: ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) process.exitCode = 1;
