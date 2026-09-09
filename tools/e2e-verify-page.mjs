#!/usr/bin/env node
/**
 * Live check for the public verifier's own data path.
 *
 *   node tools/e2e-verify-page.mjs
 *
 * Issues a real credential, anchors it on-chain, then verifies it the way the /verify page
 * does — anonymously, with no cookie — and checks that each of the four outcomes the page
 * renders comes back in the shape it expects.
 *
 * The unit tests cover the verdict logic against fixtures. This covers the thing fixtures
 * cannot: that the API actually returns those fields, with those names, to a caller holding
 * no session at all. A verifier portal that only works for signed-in users is not a verifier
 * portal.
 *
 * Prerequisites: the compose stack, deploy:local, seed, fund-relayer, backend running.
 * Run before tools/e2e-flow.mjs — that script exhausts the auth rate limiter.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The subject DID, read from the seed rather than pasted in.
 *
 * Hard-coding the hash meant a literal 32-byte hex value in the source, which the secret
 * scanner correctly cannot distinguish from a private key — and it would go stale the
 * moment the seed changed.
 */
function seededDidHash(label) {
  const seed = JSON.parse(
    readFileSync(
      path.join(repoRoot, "packages", "contracts", "deployments", "localhost.seed.json"),
      "utf8",
    ),
  );

  const entry = seed.seeded.find((s) => s.label === label);
  if (!entry) throw new Error(`no seeded '${label}' identity — run npm run seed`);
  return entry.didHash;
}

const API = process.env.E2E_API ?? "http://localhost:4000";
const DOMAIN = "localhost:5173";
const ORIGIN = "http://localhost:5173";

/** Hardhat #1 — MANAGER, so it may issue. Public test key. */
const MANAGER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // secrets-scan:allow public Hardhat test key
const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function cookieJar() {
  const jar = new Map();
  return {
    absorb(response) {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const i = pair.indexOf("=");
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function call(method, url, { body, jar } = {}) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  jar?.absorb(response);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/** Verifies with no cookie jar at all — a stranger, exactly as the page does. */
function verifyAnonymously(body) {
  return call("POST", "/credentials/verify", { body });
}

async function signIn(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const jar = cookieJar();

  const nonce = await call("GET", "/auth/nonce", { jar });
  const message = createSiweMessage({
    address: account.address,
    chainId: 31337,
    domain: DOMAIN,
    nonce: nonce.body.nonce,
    uri: ORIGIN,
    version: "1",
  });

  const signature = await account.signMessage({ message });
  const verified = await call("POST", "/auth/verify", {
    jar,
    body: { message, signature, turnstileToken: TURNSTILE_TEST_TOKEN },
  });

  if (verified.status === 429) {
    throw new Error(
      `sign-in rate limited (retry in ${verified.body?.retryAfterSeconds ?? "~60"}s). ` +
        "Run this before tools/e2e-flow.mjs.",
    );
  }
  if (verified.status !== 200) {
    throw new Error(`sign-in failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }

  return { account, jar };
}

async function signAndForward(account, jar, typedData) {
  const message = {
    from: typedData.message.from,
    to: typedData.message.to,
    value: BigInt(typedData.message.value),
    gas: BigInt(typedData.message.gas),
    nonce: BigInt(typedData.message.nonce),
    deadline: typedData.message.deadline,
    data: typedData.message.data,
  };

  const signature = await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: "ForwardRequest",
    message,
  });

  return call("POST", "/network/forward", {
    jar,
    body: {
      request: {
        from: message.from,
        to: message.to,
        value: "0",
        gas: message.gas.toString(),
        nonce: message.nonce.toString(),
        deadline: message.deadline,
        data: message.data,
      },
      signature,
      verifyingContract: typedData.domain.verifyingContract,
      chainId: typedData.domain.chainId,
    },
  });
}

async function waitFor(read, predicate, { attempts = 25, delayMs = 600 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function main() {
  console.log("Public verifier — live");

  // -------------------------------------------------------------- unregistered
  console.log("\n1. A hash the chain has never seen");

  const unknown = await verifyAnonymously({
    credentialHash: `0x${"a".repeat(64)}`,
  });

  check("answers without any session", unknown.status === 200, `got ${unknown.status}`);
  check("reports status 'unknown'", unknown.body.status === "unknown");
  check("does not claim validity", unknown.body.valid === false);
  check(
    "reports that no signature was checked, since only a hash was given",
    unknown.body.proof?.signatureChecked === false,
  );

  // -------------------------------------------------------------- issue
  console.log("\n2. Issuing a real credential");

  const manager = await signIn(MANAGER_KEY);

  const issued = await call("POST", "/credentials/issue", {
    jar: manager.jar,
    body: {
      didHash: seededDidHash("user"),
      credentialType: "ProofOfInspection",
      claims: { inspected: true, site: "Turbine 4" },
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    },
  });

  check(
    "the credential is issued and prepared",
    issued.status === 200,
    `got ${issued.status} ${JSON.stringify(issued.body).slice(0, 200)}`,
  );

  if (issued.status !== 200) {
    console.log("\ncannot continue without an issued credential");
    process.exitCode = 1;
    return;
  }

  const forwarded = await signAndForward(manager.account, manager.jar, issued.body.typedData);
  check("the anchor is relayed", forwarded.status === 202, `got ${forwarded.status}`);

  const anchored = await waitFor(
    () => verifyAnonymously({ credentialHash: issued.body.credentialHash }),
    (r) => r.body?.status === "valid",
  );
  check("the anchor reaches the chain", Boolean(anchored));

  // -------------------------------------------------------------- authentic
  console.log("\n3. Verifying it as a stranger");

  const byHash = await verifyAnonymously({ credentialHash: issued.body.credentialHash });
  check("a hash alone verifies against the chain", byHash.body.status === "valid");
  check("and says the signature was not checked", byHash.body.proof.signatureChecked === false);

  const byJwt = await verifyAnonymously({ jwt: issued.body.jwt });
  check(
    "the full credential verifies",
    byJwt.body.valid === true,
    JSON.stringify(byJwt.body).slice(0, 200),
  );
  check("the signature was checked this time", byJwt.body.proof.signatureChecked === true);
  check("and it passed", byJwt.body.proof.signatureValid === true);
  check("the issuer is reported", Boolean(byJwt.body.proof.issuer));
  check(
    "an issuance timestamp is reported, so the timeline has a node",
    Boolean(byJwt.body.proof.issuedAt),
  );

  // -------------------------------------------------------------- tampered
  console.log("\n4. A tampered credential");

  const [header, payload, signature] = String(issued.body.jwt).split(".");
  // Flip one character of the payload: same shape, different content, same signature.
  const flipped = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
  const tampered = await verifyAnonymously({ jwt: `${header}.${flipped}.${signature}` });

  check(
    "a tampered credential is answered, not rejected as malformed",
    tampered.status === 200,
    `got ${tampered.status}`,
  );
  check("its signature does not verify", tampered.body.proof?.signatureValid === false);
  check("and it is not reported valid", tampered.body.valid === false);
  check(
    "the altered document hashes differently, so the chain has no record of it",
    tampered.body.credentialHash !== issued.body.credentialHash,
  );

  console.log(`\n${"-".repeat(60)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  console.log(`\nPublic verifier: ${failed === 0 ? "PASS" : "FAIL"}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
