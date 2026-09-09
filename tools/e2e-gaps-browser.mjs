#!/usr/bin/env node
/**
 * The three new surfaces, in a real browser, signed in with a real key.
 *
 *   node tools/e2e-gaps-browser.mjs
 *
 * `tools/e2e-gaps.mjs` proves the API can register an identity, move an asset and issue a
 * credential. It says nothing about whether a person can. This drives the pages themselves:
 * Chromium, a wallet injected as `window.ethereum`, signing delegated to viem in Node, and a
 * screenshot of each surface so the result can be looked at rather than inferred.
 *
 * Console errors are collected and reported. A page that renders while throwing is not
 * working, and a suite that only asserts on visible text will happily miss it.
 */
import { chromium } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = process.env.E2E_APP ?? "http://localhost:5173";
const API = process.env.E2E_API ?? "http://localhost:4000";
const SHOTS = path.join(repoRoot, ".screenshots");

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

mkdirSync(SHOTS, { recursive: true });

const account = privateKeyToAccount(deployerKey());
const network = await (await fetch(`${API}/network`)).json();
const chainIdHex = `0x${Number(network.active.chainId).toString(16)}`;

console.log(`network ${network.active.label} (${network.active.chainId})`);
console.log(`wallet  ${account.address}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/401|Unauthorized|favicon/.test(m.text())) {
    errors.push(m.text().slice(0, 400));
  }
});
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));

await page.exposeFunction("__walletSign", async (message) => account.signMessage({ message }));
await page.exposeFunction("__walletSignTypedData", async (json) => {
  const payload = JSON.parse(json);
  // EIP-712 from the page arrives as JSON, so the uint256 fields are strings. viem wants
  // bigints; a lossy Number conversion on a nonce would sign a different request than the
  // one submitted.
  const message = { ...payload.message };
  for (const field of ["value", "gas", "nonce"]) {
    if (message[field] !== undefined) message[field] = BigInt(message[field]);
  }
  const types = { ...payload.types };
  delete types.EIP712Domain;

  return account.signTypedData({
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message,
  });
});

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
            const hex = params[0];
            const bytes = hex
              .slice(2)
              .match(/.{1,2}/g)
              .map((byte) => parseInt(byte, 16));
            return window.__walletSign(new TextDecoder().decode(new Uint8Array(bytes)));
          }
          case "eth_signTypedData_v4":
            // params: [address, jsonPayload]
            return window.__walletSignTypedData(params[1]);
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default:
            throw new Error(`unsupported method: ${method}`);
        }
      },
      on: (event, handler) => listeners.set(event, handler),
      removeListener: (event) => listeners.delete(event),
    };
  },
  { address: account.address, chainIdHex },
);

console.log("1. Sign in");

await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
await page.getByTestId("connect-button").first().click();
await page.getByTestId("wallet-option-injected").first().click();

const signedIn = await page
  .getByTestId("account-chip")
  .first()
  .waitFor({ state: "visible", timeout: 30_000 })
  .then(() => true)
  .catch(() => false);

check("the header shows a signed-in identity", signedIn);
if (!signedIn) {
  await page.screenshot({ path: path.join(SHOTS, "gaps-signin-failed.png"), fullPage: true });
  console.log("\nCannot continue without a session.");
  await browser.close();
  process.exit(1);
}

console.log("\n2. The dashboard offers a transfer on each owned asset");

await page.waitForTimeout(2500);
const transferButtons = page.getByTestId("asset-transfer");
const transferCount = await transferButtons.count();

check("at least one asset card carries a transfer control", transferCount > 0, `${transferCount}`);
await page.screenshot({ path: path.join(SHOTS, "gaps-dashboard.png"), fullPage: true });

if (transferCount > 0) {
  await transferButtons.first().click();
  const dialog = await page
    .getByTestId("transfer-dialog")
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  check("the transfer dialog opens", dialog);

  if (dialog) {
    // A malformed address must not be submittable — the guard people actually hit.
    await page.getByTestId("transfer-recipient").fill("0xnot-an-address");
    check(
      "a malformed recipient is refused before submission",
      await page
        .getByTestId("transfer-malformed")
        .isVisible()
        .catch(() => false),
    );
    check(
      "and the submit control stays disabled",
      await page.getByTestId("transfer-submit").isDisabled(),
    );

    await page.screenshot({ path: path.join(SHOTS, "gaps-transfer-dialog.png") });
    await page.keyboard.press("Escape");
  }
}

console.log("\n2b. Minting actually mints");

/*
 * The reported fault, driven through the interface.
 *
 * The wizard sent no `toDID`, so every mint answered 400 — and then reported success anyway,
 * because it treated the prepare endpoint's 200 as "handed to the relayer". Either fault alone
 * is enough to make this section fail: a 400 leaves no transaction, and a false success leaves
 * no `/network/forward` call.
 */
await page.goto(`${APP}/admin/mint`, { waitUntil: "networkidle" });

let forwardCalls = 0;
const countForwards = (response) => {
  if (response.url().includes("/network/forward")) forwardCalls += 1;
};
page.on("response", countForwards);

await page.getByTestId("mint-name").fill(`Browser mint ${Date.now()}`);
await page.getByTestId("mint-description").fill("Minted by tools/e2e-gaps-browser.mjs");
// Recipient left empty: the common case, which must resolve to the signed-in identity.
await page.getByTestId("wizard-next").click();

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
await page.setInputFiles('[data-testid="file-input"]', {
  name: "art.png",
  mimeType: "image/png",
  buffer: png,
});

await page.getByTestId("wizard-next").click();
await page.getByTestId("wizard-submit").click();

// Pinning to IPFS then signing then relaying: slower than a single request, and worth waiting
// for, because the whole point is that something reaches the chain.
const minted = await page
  .getByText(/Mint submitted/i)
  .first()
  .waitFor({ state: "visible", timeout: 90_000 })
  .then(() => true)
  .catch(() => false);

check("the wizard reports a submitted mint", minted);
check("and a signed request really was forwarded", forwardCalls > 0, `${forwardCalls} calls`);
page.off("response", countForwards);

await page.screenshot({ path: path.join(SHOTS, "gaps-mint.png"), fullPage: true });

console.log("\n3. The admin console offers credentials");

await page.goto(`${APP}/admin/credentials`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

check(
  "the issue panel renders",
  await page
    .getByTestId("credential-issue")
    .isVisible()
    .catch(() => false),
);
check(
  "the revoke panel renders",
  await page
    .getByTestId("credential-revoke")
    .isVisible()
    .catch(() => false),
);
check(
  "issuing is refused until the form is complete",
  await page.getByTestId("credential-issue-submit").isDisabled(),
);

// A revocation reason is mandatory and defaulted, because a verifier needs to know which.
check(
  "a revocation reason is offered",
  await page
    .getByTestId("revoke-reason")
    .isVisible()
    .catch(() => false),
);

await page.screenshot({ path: path.join(SHOTS, "gaps-credentials.png"), fullPage: true });

console.log("\n4. The identities console offers registration where the dead end was");

await page.goto(`${APP}/admin/roles`, { waitUntil: "networkidle" });

// An address that certainly has no identity: freshly derived, never seen by the registry.
const stranger = "0x1234567890AbcdEF1234567890aBcdef12345678";
await page.getByTestId("role-lookup-input").fill(stranger);
await page.getByTestId("role-lookup").click();

const noDid = await page
  .getByTestId("subject-no-did")
  .waitFor({ state: "visible", timeout: 15_000 })
  .then(() => true)
  .catch(() => false);

check("an address with no identity is reported as such", noDid);
check(
  "and registration is offered right there, rather than being a terminal task",
  await page
    .getByTestId("register-identity")
    .isVisible()
    .catch(() => false),
);
check(
  "the control is live",
  await page
    .getByTestId("register-identity-submit")
    .isEnabled()
    .catch(() => false),
);

await page.screenshot({ path: path.join(SHOTS, "gaps-identities.png"), fullPage: true });

console.log("\n5. Nothing threw along the way");
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();

console.log(`\n${"-".repeat(60)}`);
console.log(`passed ${passed}   failed ${failed}`);
console.log(`screenshots in .screenshots/gaps-*.png`);
console.log(`\nBrowser acceptance: ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) process.exitCode = 1;
