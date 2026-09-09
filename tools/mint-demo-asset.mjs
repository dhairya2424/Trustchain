#!/usr/bin/env node
/**
 * Mint one transferable asset to the signed-in deployer's identity.
 *
 *   node tools/mint-demo-asset.mjs ["Asset name"]
 *
 * Purely a convenience for demo state. `tools/e2e-gaps.mjs` mints its own asset and then
 * gives it away — that is the point of the test — so after an acceptance run the deployer's
 * dashboard is empty and the transfer control has nothing to appear on. This puts one back.
 *
 * It is not a shortcut around anything. The mint goes through `POST /assets/mint` exactly as
 * the admin console does: the file is scanned, its type decided by content, metadata stripped
 * and pinned to IPFS, and the resulting call signed by the deployer's own key and relayed. The
 * same permission check applies, and the same audit record is written.
 *
 * Requires the backend running and the deployer holding MINT_ASSET, which it does by
 * deployment.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = process.env.TRUSTCHAIN_API ?? "http://localhost:4000";
const ORIGIN = process.env.TRUSTCHAIN_APP ?? "http://localhost:5173";
const NAME = process.argv[2] ?? "Demo asset";

const env = {};
for (const line of readFileSync(path.join(repoRoot, "packages/contracts/.env"), "utf8").split(
  /\r?\n/,
)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
}

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const jar = new Map();
const header = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

function absorb(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(method, url, body) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), cookie: header() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  absorb(response);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

const nonce = await call("GET", "/auth/nonce");
const message = createSiweMessage({
  address: account.address,
  chainId: 80002,
  domain: new URL(ORIGIN).host,
  nonce: nonce.body.nonce,
  uri: ORIGIN,
  version: "1",
});

const verified = await call("POST", "/auth/verify", {
  message,
  signature: await account.signMessage({ message }),
  turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
});

if (verified.status !== 200) {
  console.error(`sign-in failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  process.exit(1);
}

const session = await call("GET", "/auth/session");
// `did`, not `didHash` — the session DTO names it that way, and reading the wrong field here
// looks exactly like the deployer having no identity.
const didHash = session.body.did;

if (!didHash) {
  console.error("the deployer has no DID on the active network — nothing to mint to");
  process.exit(1);
}

console.log(`minting "${NAME}" to ${didHash}`);

// A 1×1 PNG: genuinely a PNG by magic number, with no metadata to strip.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "demo.png");
form.append("toDID", didHash);
form.append("name", NAME);
form.append("description", "Seeded by tools/mint-demo-asset.mjs so the dashboard has an asset.");
form.append("soulbound", "false");

const response = await fetch(`${API}/assets/mint`, {
  method: "POST",
  headers: { cookie: header() },
  body: form,
});

const prepared = await response.json().catch(() => ({}));
if (response.status !== 200) {
  console.error(`mint failed: ${response.status} ${JSON.stringify(prepared)}`);
  process.exit(1);
}

const typed = prepared.typedData;
const signature = await account.signTypedData({
  domain: typed.domain,
  types: typed.types,
  primaryType: typed.primaryType,
  message: {
    from: typed.message.from,
    to: typed.message.to,
    value: 0n,
    gas: BigInt(typed.message.gas),
    nonce: BigInt(typed.message.nonce),
    deadline: typed.message.deadline,
    data: typed.message.data,
  },
});

const forwarded = await call("POST", "/network/forward", {
  request: {
    from: typed.message.from,
    to: typed.message.to,
    value: "0",
    gas: typed.message.gas,
    nonce: typed.message.nonce,
    deadline: typed.message.deadline,
    data: typed.message.data,
  },
  signature,
  verifyingContract: typed.domain.verifyingContract,
  chainId: typed.domain.chainId,
});

if (forwarded.status >= 300) {
  console.error(`relay failed: ${forwarded.status} ${JSON.stringify(forwarded.body)}`);
  process.exit(1);
}

// The relayer answers with a transaction id and a null hash — it has accepted the request but
// not yet broadcast. Saying "submitted" is the honest report; the dashboard follows the rest.
console.log(`submitted — ${forwarded.body.status}, id ${forwarded.body.transactionId}`);
console.log("the asset appears on the dashboard once the indexer sees it confirmed.");
