#!/usr/bin/env node
/**
 * Drives the running app in a real browser against the real backend.
 *
 *   node tools/drive-app.mjs
 *
 * Not a test — a walkthrough. It issues a genuine credential through the API, anchors it
 * on-chain, then opens each page in Chromium, screenshots it, and reports any console error
 * or failed request. Nothing is stubbed: this is the app as a visitor meets it.
 *
 * Screenshots land in .screenshots/ so they can be looked at, which is the point. A page
 * that renders blank still returns 200.
 */
import { chromium } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = "http://localhost:4000";
const APP = "http://localhost:5173";
const SHOTS = path.join(repoRoot, ".screenshots");

/** Hardhat #1 — MANAGER, so it may issue. Public test key. */
const MANAGER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // secrets-scan:allow public Hardhat test key

function jar() {
  const store = new Map();
  return {
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const i = pair.indexOf("=");
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

async function call(method, url, { body, cookies } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookies ? { cookie: cookies.header() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  cookies?.absorb(res);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Issues and anchors a real credential, returning its hash. */
async function mintCredential() {
  const account = privateKeyToAccount(MANAGER_KEY);
  const cookies = jar();

  const nonce = await call("GET", "/auth/nonce", { cookies });
  const message = createSiweMessage({
    address: account.address,
    chainId: 31337,
    domain: "localhost:5173",
    nonce: nonce.body.nonce,
    uri: APP,
    version: "1",
  });

  const signIn = await call("POST", "/auth/verify", {
    cookies,
    body: {
      message,
      signature: await account.signMessage({ message }),
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    },
  });

  if (signIn.status !== 200) {
    throw new Error(`sign-in failed: ${signIn.status} ${JSON.stringify(signIn.body)}`);
  }

  const seed = JSON.parse(
    readFileSync(
      path.join(repoRoot, "packages", "contracts", "deployments", "localhost.seed.json"),
      "utf8",
    ),
  );
  const subject = seed.seeded.find((s) => s.label === "user");

  const issued = await call("POST", "/credentials/issue", {
    cookies,
    body: {
      didHash: subject.didHash,
      credentialType: "ProofOfInspection",
      claims: { inspected: true, site: "Turbine 4" },
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    },
  });

  if (issued.status !== 200) {
    throw new Error(`issue failed: ${issued.status} ${JSON.stringify(issued.body).slice(0, 200)}`);
  }

  // Sign the prepared request and relay it, so the credential is genuinely anchored.
  const td = issued.body.typedData;
  const signature = await account.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: "ForwardRequest",
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value),
      gas: BigInt(td.message.gas),
      nonce: BigInt(td.message.nonce),
      deadline: td.message.deadline,
      data: td.message.data,
    },
  });

  await call("POST", "/network/forward", {
    cookies,
    body: {
      request: {
        from: td.message.from,
        to: td.message.to,
        value: "0",
        gas: td.message.gas,
        nonce: td.message.nonce,
        deadline: td.message.deadline,
        data: td.message.data,
      },
      signature,
      verifyingContract: td.domain.verifyingContract,
      chainId: td.domain.chainId,
    },
  });

  // Wait for the anchor to land, so the verifier has something real to say.
  for (let i = 0; i < 25; i += 1) {
    const check = await call("POST", "/credentials/verify", {
      body: { credentialHash: issued.body.credentialHash },
    });
    if (check.body?.status === "valid") break;
    await new Promise((r) => setTimeout(r, 600));
  }

  return issued.body.credentialHash;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  console.log("issuing a real credential through the API…");
  const hash = await mintCredential();
  console.log(`  anchored ${hash}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text().slice(0, 160)}`);
  });
  page.on("requestfailed", (req) => {
    problems.push(`request failed: ${req.method()} ${req.url().slice(0, 90)}`);
  });

  const pages = [
    ["landing", "/"],
    ["dashboard", "/dashboard"],
    ["admin-audit", "/admin"],
    ["admin-mint", "/admin/mint"],
    ["admin-roles", "/admin/roles"],
    ["verify", `/verify?hash=${hash}`],
  ];

  for (const [name, route] of pages) {
    await page.goto(`${APP}${route}`, { waitUntil: "networkidle" });
    // Let entrance animations settle so the screenshot shows the resting state.
    await page.waitForTimeout(900);

    const file = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });

    const heading = await page
      .locator("h1")
      .first()
      .textContent()
      .catch(() => null);
    const badge = await page
      .getByTestId("network-badge")
      .first()
      .textContent()
      .catch(() => null);

    console.log(`${name.padEnd(13)} ${route}`);
    console.log(`  h1      ${heading?.trim().slice(0, 60) ?? "(none)"}`);
    console.log(`  network ${badge?.trim().slice(0, 70) ?? "(not shown at this width)"}`);
    console.log(`  shot    ${path.relative(repoRoot, file)}`);
  }

  // The verdict is the thing worth confirming rendered from real data.
  await page.goto(`${APP}/verify?hash=${hash}`, { waitUntil: "networkidle" });
  const verdict = await page
    .getByTestId("verdict")
    .getAttribute("data-kind")
    .catch(() => null);
  console.log(`\nverifier verdict for the freshly issued credential: ${verdict ?? "(none)"}`);

  await browser.close();

  console.log(`\n${problems.length === 0 ? "no console errors or failed requests" : "problems:"}`);
  for (const problem of [...new Set(problems)].slice(0, 10)) console.log(`  ${problem}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
