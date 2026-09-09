#!/usr/bin/env node
/**
 * Proves the identity QR code is functional rather than decorative.
 *
 *   node tools/e2e-qr.mjs
 *
 * The dashboard used to render a QR of the bare DID hash. A phone camera reads that as a
 * hex string and offers to copy it — the code is a picture of a QR code, not a working one.
 * The only way to know the difference is to decode the pixels that were actually drawn and
 * see whether following them arrives anywhere.
 *
 * So this does exactly that, and nothing softer:
 *
 *   1. sign in, so a real DID is on screen
 *   2. screenshot the QR element itself
 *   3. decode those pixels with jsQR — the decoder the scanner falls back to, and the one
 *      that actually runs on desktop, so this measures what a camera would see
 *   4. follow the decoded value as a URL
 *   5. confirm the page it lands on resolves the identity against the chain
 *
 * Step 3 is the part that matters. Reading the component's props would only confirm we
 * passed the string we meant to pass; decoding the image confirms a scanner can read it.
 */
import { chromium } from "@playwright/test";
import jsQR from "jsqr";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = process.env.E2E_APP ?? "http://localhost:5173";
const API = process.env.E2E_API ?? "http://localhost:4000";

function deployerKey() {
  for (const line of readFileSync(path.join(repoRoot, "packages/contracts/.env"), "utf8").split(
    /\r?\n/,
  )) {
    const match = line.match(/^DEPLOYER_PRIVATE_KEY=(.*)$/);
    if (match) return match[1].trim();
  }
  throw new Error("no DEPLOYER_PRIVATE_KEY");
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

/*
 * Real Chrome, not bundled Chromium.
 *
 * BarcodeDetector is part of the Shape Detection API and ships in Chrome, but not in the
 * Chromium build Playwright downloads — so decoding has to happen in the same engine a
 * visitor would use. If Chrome is not installed this falls back, and says so rather than
 * quietly testing something weaker.
 */
let usingChrome = true;
const browser = await chromium.launch({ channel: "chrome" }).catch(async () => {
  usingChrome = false;
  return chromium.launch();
});

if (!usingChrome) {
  console.log("(Chrome not found — falling back to bundled Chromium, no BarcodeDetector there)\n");
}
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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
          default:
            return null;
        }
      },
      on: () => {},
      removeListener: () => {},
    };
  },
  { address: account.address, chainIdHex },
);

console.log("1. Reach a dashboard with a real identity on it");

await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
await page.getByTestId("connect-button").first().click();
await page.getByTestId("wallet-option-injected").first().click();
await page.getByTestId("account-chip").first().waitFor({ state: "visible", timeout: 30_000 });

const qr = page.getByTestId("identity-qr").first();
const rendered = await qr.isVisible().catch(() => false);
check("the identity card renders a QR", rendered);

const did = (
  await page
    .getByTestId("identity-did")
    .first()
    .textContent()
    .catch(() => "")
)?.trim();
check("a DID is on screen", /^0x[0-9a-f]{64}$/i.test(did ?? ""), did ?? "(none)");

console.log("\n2. Decode the pixels a camera would actually see");

const png = await qr.screenshot();
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

/*
 * Pixels out of the browser, decoded in Node with jsQR.
 *
 * Not BarcodeDetector: that is part of the Shape Detection API and Chrome does not expose
 * it on Windows, which is the very gap that made the in-app scanner unavailable to desktop
 * users. jsQR is the decoder the scanner now falls back to, so decoding with it here
 * measures what a visitor's camera would actually read.
 *
 * The page draws the screenshot to a canvas and hands back raw RGBA, because jsQR wants
 * pixels rather than a PNG — so no image decoder is needed on this side.
 */
const frame = await page.evaluate(async (src) => {
  const image = new Image();
  image.src = src;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, pixels: Array.from(data.data) };
}, dataUrl);

const result = jsQR(Uint8ClampedArray.from(frame.pixels), frame.width, frame.height, {
  inversionAttempts: "attemptBoth",
});
const decodedValue = result?.data ?? null;

check("the rendered code decodes", Boolean(decodedValue), "jsQR read nothing from the pixels");
console.log(`        decoded: ${decodedValue ?? "(nothing)"}`);

// The heart of it. A bare hash decodes fine and leads nowhere; a URL is followable.
let target = null;
try {
  target = new URL(decodedValue ?? "");
} catch {
  target = null;
}

check(
  "the code carries a followable URL, not a bare identifier",
  target !== null,
  "decoded to a plain string, which a camera cannot act on",
);
check(
  "it points at this deployment's verifier",
  target?.pathname === "/verify" && target.searchParams.get("did") === did,
  `${target?.pathname ?? "?"} did=${target?.searchParams.get("did") ?? "?"}`,
);

console.log("\n3. Follow it, as a scanner would");

if (target) {
  const visitor = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A fresh context: no wallet, no session. A verifier scanning a badge is a stranger.
  await visitor.goto(target.toString(), { waitUntil: "networkidle" });
  await visitor.waitForTimeout(2500);

  const verdict = visitor.getByTestId("identity-verdict").first();
  const shown = await verdict.isVisible().catch(() => false);
  check("an unauthenticated visitor gets a verdict", shown);

  const state = await verdict.getAttribute("data-state").catch(() => null);
  check("the identity resolves as active", state === "active", String(state));

  const text = (await verdict.innerText().catch(() => "")) ?? "";
  check(
    "it names the controlling address",
    text.includes(account.address.slice(0, 6)),
    text.slice(0, 60),
  );
  check("it reports roles read from the chain", /ADMIN|MANAGER/.test(text));

  await visitor.screenshot({ path: ".screenshots/qr-verified.png", fullPage: true });
  await visitor.close();
}

await browser.close();

console.log(`\n${"-".repeat(60)}`);
console.log(`passed ${passed}   failed ${failed}`);
console.log(`\nQR identity verification: ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) process.exitCode = 1;
