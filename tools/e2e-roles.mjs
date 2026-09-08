#!/usr/bin/env node
/**
 * Live check for role grant and revoke.
 *
 *   node tools/e2e-roles.mjs
 *
 * Drives the real two-phase flow against a real chain: an ADMIN signs in, prepares a grant,
 * signs the EIP-712 payload in their own key, forwards it, and the role is then read back
 * from the chain. Then the same for a revoke.
 *
 * The point of running this rather than trusting the unit tests is that the unit tests stub
 * the chain. Only an end-to-end run proves the encoded calldata actually matches the
 * deployed contract's ABI, that the forwarder accepts the signature, and — the claim that
 * matters — that the audit trail attributes the change to the ADMIN who signed rather than
 * to the relayer that paid for it.
 *
 * Prerequisites: the compose stack, `npm run deploy:local`, `npm run seed`,
 * `node tools/fund-relayer.mjs`, and the backend running.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = process.env.E2E_API ?? "http://localhost:4000";
const DOMAIN = "localhost:5173";
const ORIGIN = "http://localhost:5173";

/** Hardhat #0 — the deployer, and therefore ADMIN. Public test key. */
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secrets-scan:allow public Hardhat test key
/** Hardhat #1 — MANAGER. Has no MANAGE_ROLES, so it must be refused. */
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

function section(title) {
  console.log(`\n${title}`);
}

function cookieJar() {
  const jar = new Map();
  return {
    absorb(response) {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function call(method, url, { body, jar, headers = {} } = {}) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
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

async function signIn(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const jar = cookieJar();

  const nonceRes = await call("GET", "/auth/nonce", { jar });
  const message = createSiweMessage({
    address: account.address,
    chainId: 31337,
    domain: DOMAIN,
    nonce: nonceRes.body.nonce,
    uri: ORIGIN,
    version: "1",
  });

  const signature = await account.signMessage({ message });

  const verified = await call("POST", "/auth/verify", {
    jar,
    body: { message, signature, turnstileToken: TURNSTILE_TEST_TOKEN },
  });

  if (verified.status === 429) {
    // Not a failure of anything under test. tools/e2e-flow.mjs deliberately exhausts the
    // per-IP auth limiter as its last step, so running these back to back hits it.
    throw new Error(
      `sign-in rate limited (retry in ${verified.body?.retryAfterSeconds ?? "~60"}s). ` +
        "Run this before tools/e2e-flow.mjs, or wait for the window to clear.",
    );
  }

  if (verified.status !== 200) {
    throw new Error(`sign-in failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }

  return { account, jar, identity: verified.body };
}

/** Signs a prepared ForwardRequest and relays it, exactly as the browser does. */
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

/** Polls the chain until `predicate` holds, or gives up. */
async function waitFor(read, predicate, { attempts = 25, delayMs = 600 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function main() {
  const seed = JSON.parse(
    readFileSync(
      path.join(repoRoot, "packages", "contracts", "deployments", "localhost.seed.json"),
      "utf8",
    ),
  );

  const subject = seed.seeded.find((s) => s.label === "user");
  if (!subject) throw new Error("no seeded 'user' identity — run npm run seed");

  console.log("Role grant / revoke — live");
  console.log(`  subject ${subject.address}`);
  console.log(`  did     ${subject.didHash}`);

  const admin = await signIn(ADMIN_KEY);
  const manager = await signIn(MANAGER_KEY);

  const rolesOf = async (jar, address) => {
    const res = await call("GET", `/roles/${address}`, { jar });
    return res.body;
  };

  // ---------------------------------------------------------------- read
  section("1. Reading roles");

  const before = await rolesOf(admin.jar, subject.address);
  check("the API reports the subject's roles", Array.isArray(before.roles), JSON.stringify(before));
  check("the subject has a DID, so it can hold a role", Boolean(before.did));
  check(
    "the subject starts without AUDITOR",
    !before.roles.includes("AUDITOR"),
    JSON.stringify(before.roles),
  );

  const anonymous = await call("GET", `/roles/${subject.address}`);
  check("an anonymous read is refused", anonymous.status === 401);

  // ---------------------------------------------------------------- refusal
  section("2. A caller without MANAGE_ROLES is refused");

  const refused = await call("POST", "/roles/prepare-grant", {
    jar: manager.jar,
    body: { didHash: subject.didHash, role: "AUDITOR" },
  });
  check("a MANAGER cannot prepare a grant", refused.status === 403, `got ${refused.status}`);

  const badRole = await call("POST", "/roles/prepare-grant", {
    jar: admin.jar,
    body: { didHash: subject.didHash, role: `0x${"0".repeat(64)}` },
  });
  check(
    "a raw role hash is refused, so DEFAULT_ADMIN_ROLE cannot be asked for",
    badRole.status === 400,
    `got ${badRole.status}`,
  );

  // ---------------------------------------------------------------- grant
  section("3. Granting AUDITOR");

  const preparedGrant = await call("POST", "/roles/prepare-grant", {
    jar: admin.jar,
    body: { didHash: subject.didHash, role: "AUDITOR" },
  });
  check(
    "the grant is prepared for an ADMIN",
    preparedGrant.status === 200,
    `got ${preparedGrant.status} ${JSON.stringify(preparedGrant.body).slice(0, 160)}`,
  );

  if (preparedGrant.status !== 200) {
    console.log("\ncannot continue without a prepared request");
    return;
  }

  check(
    "the prepared request is attributed to the ADMIN, not the relayer",
    preparedGrant.body.typedData.message.from.toLowerCase() === admin.account.address.toLowerCase(),
  );
  check("it carries no value", String(preparedGrant.body.typedData.message.value) === "0");

  const forwardedGrant = await signAndForward(
    admin.account,
    admin.jar,
    preparedGrant.body.typedData,
  );
  check(
    "the signed grant is accepted and relayed",
    forwardedGrant.status === 202,
    `got ${forwardedGrant.status} ${JSON.stringify(forwardedGrant.body).slice(0, 200)}`,
  );

  const granted = await waitFor(
    () => rolesOf(admin.jar, subject.address),
    (r) => r?.roles?.includes("AUDITOR"),
  );
  check(
    "AUDITOR appears on-chain for the subject",
    Boolean(granted),
    granted ? "" : "role never appeared within the timeout",
  );

  // ---------------------------------------------------------------- attribution
  section("4. The audit trail attributes it to the ADMIN who signed");

  const audit = await waitFor(
    async () => {
      const res = await call("GET", "/audit?action=ROLE_GRANTED&limit=10", { jar: admin.jar });
      return res.body;
    },
    (page) =>
      page?.entries?.some(
        (e) => e.actor && e.actor.toLowerCase() === admin.account.address.toLowerCase(),
      ),
  );

  check("a ROLE_GRANTED entry names the ADMIN as actor", Boolean(audit));

  if (audit) {
    const entry = audit.entries.find(
      (e) => e.actor && e.actor.toLowerCase() === admin.account.address.toLowerCase(),
    );
    check(
      "the executor is recorded separately from the actor",
      Boolean(entry.executor) && entry.executor.toLowerCase() !== entry.actor.toLowerCase(),
      `actor=${entry.actor} executor=${entry.executor}`,
    );
    check(
      "the entry carries a block number",
      typeof entry.blockNumber === "number" && entry.blockNumber > 0,
    );
  }

  // ---------------------------------------------------------------- revoke
  section("5. Revoking it again");

  const preparedRevoke = await call("POST", "/roles/prepare-revoke", {
    jar: admin.jar,
    body: { didHash: subject.didHash, role: "AUDITOR" },
  });
  check("the revoke is prepared", preparedRevoke.status === 200, `got ${preparedRevoke.status}`);

  if (preparedRevoke.status === 200) {
    const forwardedRevoke = await signAndForward(
      admin.account,
      admin.jar,
      preparedRevoke.body.typedData,
    );
    check(
      "the signed revoke is accepted and relayed",
      forwardedRevoke.status === 202,
      `got ${forwardedRevoke.status}`,
    );

    const revoked = await waitFor(
      () => rolesOf(admin.jar, subject.address),
      (r) => r?.roles && !r.roles.includes("AUDITOR"),
    );
    check("AUDITOR is gone from the subject on-chain", Boolean(revoked));
    check(
      "the subject keeps its other roles",
      revoked?.roles?.includes("USER"),
      JSON.stringify(revoked?.roles),
    );
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  console.log(`\nRole administration: ${failed === 0 ? "PASS" : "FAIL"}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
