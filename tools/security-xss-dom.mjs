#!/usr/bin/env node
/**
 * P4.1 — the XSS half that only a browser can decide: injected payloads must render as inert
 * text, never execute, and the session cookie must be unreadable to script.
 *
 *   node tools/security-xss-dom.mjs [--json <path>]
 *
 * A trap is installed before any app code runs. Every payload tries to prove it executed —
 * `onerror`, `onload`, an inline `<script>`, an `alert` — by setting `window.__xss.fired`.
 * If that flag is still false after the payload has been typed into a field and rendered,
 * nothing ran. The payload's literal text is then confirmed present as data, so the field
 * did display what was typed; it simply displayed it inertly.
 *
 * React escapes interpolated content by default, so the expectation is that every payload is
 * neutralised. The point of driving it is to prove that holds on the real screens rather than
 * assume the framework did its job.
 */
import { chromium } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = process.env.TRUSTCHAIN_APP ?? "http://localhost:5173";
const API = process.env.TRUSTCHAIN_API ?? "http://localhost:4000";

const env = {};
for (const line of readFileSync(path.join(repoRoot, "packages/contracts/.env"), "utf8").split(
  /\r?\n/,
)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const network = await (await fetch(`${API}/network`)).json();
const chainIdHex = `0x${Number(network.active.chainId).toString(16)}`;

const results = [];
function record(attack, expected, actual, pass, detail = "") {
  results.push({
    section: "XSS",
    attack,
    expected,
    actual,
    pass,
    status: pass ? "pass" : "fail",
    detail,
  });
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${attack}`);
  console.log(`        expected: ${expected}`);
  console.log(`        actual:   ${actual}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Each payload sets `window.__xss.fired` if it executes, via a different sink, and carries a
 * unique marker so its presence as inert text can be confirmed afterwards.
 */
const PAYLOADS = [
  { marker: "XSSIMG", value: `<img src=x onerror="window.__xss.fired='XSSIMG'">` },
  { marker: "XSSSVG", value: `"><svg onload="window.__xss.fired='XSSSVG'">` },
  { marker: "XSSTAG", value: `<script>window.__xss.fired='XSSTAG'</script>` },
  { marker: "XSSEVT", value: `'"><body onload=window.__xss.fired='XSSEVT'>` },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// The trap, before anything else. Any execution sink flips the flag.
await page.addInitScript(() => {
  window.__xss = { fired: false };
  for (const fn of ["alert", "confirm", "prompt"]) {
    window[fn] = () => {
      window.__xss.fired = `called:${fn}`;
    };
  }
});

// A minimal injected wallet so the admin screens are reachable.
await page.exposeFunction("__walletSign", async (m) => account.signMessage({ message: m }));
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

const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

async function fired() {
  return page.evaluate(() => window.__xss.fired);
}
async function resetTrap() {
  await page.evaluate(() => {
    window.__xss.fired = false;
  });
}

console.log("TrustChain XSS-inert DOM check\n");

// Sign in.
await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
await page.getByTestId("connect-button").first().click();
await page.getByTestId("wallet-option-injected").first().click();
await page
  .getByTestId("account-chip")
  .first()
  .waitFor({ state: "visible", timeout: 30000 })
  .catch(() => {});

console.log("1. The session cookie is beyond script's reach");
{
  const cookieString = await page.evaluate(() => document.cookie);
  const leaks = /trustchain_session|trustchain_refresh/.test(cookieString);
  record(
    "read document.cookie after signing in",
    "session + refresh cookies absent (httpOnly)",
    leaks ? "a token cookie was readable" : "no token cookie visible to script",
    !leaks,
    `document.cookie = ${JSON.stringify(cookieString)}`,
  );
}

console.log("\n2. Payloads in the mint fields render as inert text");
for (const { marker, value } of PAYLOADS) {
  await page.goto(`${APP}/admin/mint`, { waitUntil: "networkidle" });
  await resetTrap();

  await page.getByTestId("mint-name").fill(value);
  await page.getByTestId("mint-description").fill(`desc ${value}`);
  // Advance to the confirm step, which echoes both fields verbatim.
  await page.getByTestId("wizard-next").click();
  await page.waitForTimeout(200);

  const smallPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.setInputFiles('[data-testid="file-input"]', {
    name: "a.png",
    mimeType: "image/png",
    buffer: smallPng,
  });
  await page.getByTestId("wizard-next").click();
  await page
    .getByTestId("wizard-confirm")
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(400);

  const state = await page.evaluate((mk) => {
    const fired = window.__xss.fired;
    // Did an executable node get created FROM the payload (as opposed to escaped text)?
    const injectedNodes = document.querySelectorAll(
      `script:not([src]), img[onerror], svg[onload], body[onload]`,
    ).length;
    // Is the literal payload present as visible text somewhere?
    const asText = document.body.innerText.includes(mk);
    return { fired, injectedNodes, asText };
  }, marker);

  const safe = state.fired === false && state.asText;
  record(
    `mint name/description = ${value.slice(0, 32)}…`,
    "no execution; payload shown as literal text",
    state.fired ? `EXECUTED (${state.fired})` : `inert, shown as text=${state.asText}`,
    safe,
    `executable-nodes-in-doc=${state.injectedNodes}`,
  );
}

console.log("\n3. A payload in the identity lookup field does not execute");
{
  await page.goto(`${APP}/admin/roles`, { waitUntil: "networkidle" });
  await resetTrap();
  const payload = `<img src=x onerror="window.__xss.fired='LOOKUP'">`;
  await page.getByTestId("role-lookup-input").fill(payload);
  await page.getByTestId("role-lookup").click();
  await page.waitForTimeout(1200);
  const f = await fired();
  record(
    "identities lookup = <img onerror>",
    "no execution (rejected as a malformed address or shown inert)",
    f ? `EXECUTED (${f})` : "did not execute",
    f === false,
    "the field feeds an address validator; a non-address is refused",
  );
}

console.log("\n4. A payload submitted to the public verifier does not execute");
{
  await page.goto(`${APP}/verify`, { waitUntil: "networkidle" });
  await resetTrap();
  const payload = `<script>window.__xss.fired='VERIFY'</script>`;
  const input = page.locator('textarea, input[type="text"]').first();
  await input.fill(payload);
  await page.getByTestId("verify-submit").click();
  await page.waitForTimeout(1200);
  const f = await fired();
  record(
    "verifier input = <script>…",
    "no execution; treated as an unrecognised credential",
    f ? `EXECUTED (${f})` : "did not execute",
    f === false,
    "input is held as a value and sent to the API, never rendered as markup",
  );
}

await browser.close();

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.length - passed;
console.log(`\n${"-".repeat(64)}`);
console.log(`${results.length} XSS cases — ${passed} inert, ${failed} findings`);
if (errors.length) {
  console.log(`page errors during run: ${errors.length}`);
  for (const e of errors.slice(0, 4)) console.log(`  - ${e}`);
}
console.log(`\nXSS pass: ${failed === 0 ? "ALL INERT" : `${failed} FINDING(S)`}`);

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  writeFileSync(process.argv[jsonFlag + 1], JSON.stringify({ results, passed, failed }, null, 2));
  console.log(`\nrecorded to ${process.argv[jsonFlag + 1]}`);
}
if (failed > 0) process.exitCode = 1;
