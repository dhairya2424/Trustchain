#!/usr/bin/env node
/**
 * The P2.6 exit check, as an executable script.
 *
 *   node tools/e2e-flow.mjs
 *
 * Drives the real HTTP API against a real chain:
 *
 *   nonce -> verify (with Turnstile) -> cookie session -> mint -> audit shows the mint
 *
 * plus the credential lifecycle (issue -> verify -> revoke -> verify) and the negative
 * cases that prove the controls actually refuse. It is written against the API over HTTP
 * with nothing stubbed, so it fails if any layer is wrong — which is the entire point of
 * an exit check that unit tests cannot replace.
 *
 * Prerequisites: docker compose up postgres redis; a hardhat node; npm run deploy:local;
 * the seed script; tools/gen-dev-env.mjs; and the backend running.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { keccak256, toBytes } from "viem";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = process.env.E2E_API ?? "http://localhost:4000";
const DOMAIN = "localhost:5173";
const ORIGIN = "http://localhost:5173";

/** Hardhat account #1 — public test key, granted MANAGER by scripts/seed.ts. */
const MANAGER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // secrets-scan:allow public Hardhat test key, printed by every node banner
/** Hardhat account #3 — granted only USER, so it must be refused where MANAGER is needed. */
const USER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // secrets-scan:allow public Hardhat test key, printed by every node banner
/** Hardhat account #0 — the deployer, and therefore ADMIN. */
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secrets-scan:allow public Hardhat test key, printed by every node banner

/** Cloudflare's documented always-passes test token. */
const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Collects Set-Cookie across a session, the way a browser would. */
function cookieJar() {
  const jar = new Map();
  return {
    absorb(response) {
      const raw = response.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(";");
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    has(name) {
      return jar.has(name);
    },
    get(name) {
      return jar.get(name);
    },
  };
}

async function call(method, url, { body, jar, json = true, headers = {} } = {}) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      ...(json && body ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    ...(body ? { body: json ? JSON.stringify(body) : body } : {}),
  });

  jar?.absorb(response);

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed, headers: response.headers };
}

/** Full sign-in: nonce, SIWE message, signature, Turnstile, cookie session. */
async function signIn(privateKey, { turnstileToken = TURNSTILE_TEST_TOKEN } = {}) {
  const account = privateKeyToAccount(privateKey);
  const jar = cookieJar();

  const nonceResponse = await call("GET", "/auth/nonce", { jar });
  const nonce = nonceResponse.body?.nonce;
  if (!nonce) throw new Error(`no nonce in response: ${JSON.stringify(nonceResponse.body)}`);

  const message = createSiweMessage({
    address: account.address,
    chainId: 31337,
    domain: DOMAIN,
    nonce,
    uri: ORIGIN,
    version: "1",
    statement: "Sign in to TrustChain.",
  });

  const signature = await account.signMessage({ message });

  const verify = await call("POST", "/auth/verify", {
    jar,
    body: { message, signature, turnstileToken },
  });

  return { account, jar, verify, nonce };
}

/**
 * The highest audit entry id currently on chain.
 *
 * Captured before an action so the wait below can tell a NEW entry from one left by an
 * earlier run. The chain persists between runs, so "is there a CREDENTIAL_ISSUED entry?"
 * is almost always true and answers the wrong question.
 */
async function latestEntryId(jar) {
  const res = await call("GET", "/audit?limit=1", { jar });
  return res.body?.entries?.[0]?.entryId ?? -1;
}

/**
 * Waits for an action to be recorded *after* a given entry id.
 *
 * The relayer is asynchronous: it accepts a transaction, queues it, and submits it on its
 * own workers, so a 202 means "accepted for submission" and not "mined". Asserting the
 * audit trail immediately afterwards would be a race that passes or fails depending on how
 * fast the machine is. Polling to a deadline is what a real client would do.
 */
async function waitForAction(jar, action, since, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await call("GET", `/audit?action=${action}&limit=10`, { jar });
    const fresh = (res.body?.entries ?? []).find((e) => e.entryId > since);
    if (fresh) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return null;
}

/**
 * Signs a prepared request and forwards it.
 *
 * This is the half of an attributed write the server cannot perform: the signature must
 * come from the requester's own key, which is precisely why a relayer cannot forge an
 * actor. The server described the action; here the user authorises it.
 */
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
        value: 0,
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

function didHashFor(address) {
  return keccak256(toBytes(`did:trustchain:local:${address.toLowerCase()}`));
}

async function main() {
  console.log(`TrustChain P2.6 exit check\napi: ${API}\n`);

  /*
   * Same guard as the other local-chain tools: this signs in with published Hardhat keys and
   * declares chain 31337, so against an Amoy-bound backend every privileged step returns 403
   * — correct RBAC, mistakable for a broken tool.
   */
  const network = await call("GET", "/network");
  const active = network.body?.active;
  if (active && active.chainId !== 31337) {
    console.error(
      `This tool targets the local Hardhat chain (31337) with published test keys.\n` +
        `The backend is on ${active.label} (${active.chainId}).\n\n` +
        `For that network, run instead:\n` +
        `  node tools/e2e-amoy.mjs\n` +
        `  node tools/e2e-gaps.mjs\n`,
    );
    process.exit(1);
  }

  const health = await call("GET", "/health");
  if (health.status !== 200) {
    console.error(`backend is not answering at ${API} — start it first`);
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------- auth
  section("1. Authentication: nonce -> SIWE verify -> cookie session");

  const manager = await signIn(MANAGER_KEY);
  check(
    "POST /auth/verify returns 200",
    manager.verify.status === 200,
    `got ${manager.verify.status}`,
  );
  check("session cookie is set", manager.jar.has("trustchain_session"));
  check("refresh cookie is set", manager.jar.has("trustchain_refresh"));
  check(
    "response reports the signing address",
    manager.verify.body?.address?.toLowerCase() === manager.account.address.toLowerCase(),
  );
  check(
    "roles were read from the chain, not from the client",
    Array.isArray(manager.verify.body?.roles) && manager.verify.body.roles.length > 0,
    JSON.stringify(manager.verify.body?.roles),
  );
  check(
    "the DID registered by the seed is bound to the session",
    manager.verify.body?.did === didHashFor(manager.account.address),
  );

  section("2. Authentication refuses what it should");

  const replay = await (async () => {
    // Re-present a nonce that has already been consumed.
    const account = privateKeyToAccount(MANAGER_KEY);
    const jar = cookieJar();
    const { body } = await call("GET", "/auth/nonce", { jar });
    const message = createSiweMessage({
      address: account.address,
      chainId: 31337,
      domain: DOMAIN,
      nonce: body.nonce,
      uri: ORIGIN,
      version: "1",
    });
    const signature = await account.signMessage({ message });
    const first = await call("POST", "/auth/verify", {
      jar,
      body: { message, signature, turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    const second = await call("POST", "/auth/verify", {
      jar,
      body: { message, signature, turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    return { first, second };
  })();

  check("a fresh nonce succeeds", replay.first.status === 200);
  check(
    "the same nonce replayed is refused",
    replay.second.status === 401,
    `got ${replay.second.status}`,
  );

  const tampered = await (async () => {
    const account = privateKeyToAccount(MANAGER_KEY);
    const jar = cookieJar();
    const { body } = await call("GET", "/auth/nonce", { jar });
    const message = createSiweMessage({
      address: account.address,
      chainId: 31337,
      domain: DOMAIN,
      nonce: body.nonce,
      uri: ORIGIN,
      version: "1",
    });
    const signature = await account.signMessage({ message });
    // Claim to be someone else while presenting a signature from this key.
    const forged = message.replace(account.address, privateKeyToAccount(USER_KEY).address);
    return call("POST", "/auth/verify", {
      jar,
      body: { message: forged, signature, turnstileToken: TURNSTILE_TEST_TOKEN },
    });
  })();

  check(
    "a signature that does not match the claimed address is refused",
    tampered.status === 401,
    `got ${tampered.status}`,
  );

  const noBotToken = await (async () => {
    const account = privateKeyToAccount(MANAGER_KEY);
    const jar = cookieJar();
    const { body } = await call("GET", "/auth/nonce", { jar });
    const message = createSiweMessage({
      address: account.address,
      chainId: 31337,
      domain: DOMAIN,
      nonce: body.nonce,
      uri: ORIGIN,
      version: "1",
    });
    const signature = await account.signMessage({ message });
    return call("POST", "/auth/verify", { jar, body: { message, signature } });
  })();

  check(
    "a missing Turnstile token is refused with 403",
    noBotToken.status === 403,
    `got ${noBotToken.status}`,
  );

  // ---------------------------------------------------------------- audit authz
  section("3. Audit is gated on the on-chain permission");

  const anonymousAudit = await call("GET", "/audit");
  check(
    "GET /audit without a session is 401",
    anonymousAudit.status === 401,
    `got ${anonymousAudit.status}`,
  );

  const user = await signIn(USER_KEY);
  check("a USER can sign in", user.verify.status === 200, `got ${user.verify.status}`);

  const userAudit = await call("GET", "/audit", { jar: user.jar });
  check(
    "a USER without PERM_VIEW_AUDIT is refused with 403",
    userAudit.status === 403,
    `got ${userAudit.status}`,
  );

  const userExport = await call("GET", "/audit/export.csv", { jar: user.jar });
  check(
    "a USER cannot export the audit log",
    userExport.status === 403,
    `got ${userExport.status}`,
  );

  // ---------------------------------------------------------------- mint
  section("4. Mint through the API");

  // Audit reads use the ADMIN session. MANAGER deliberately does NOT hold PERM_VIEW_AUDIT
  // in the contract's default matrix — minting and reading the ledger are different
  // authorities, and the seed asserts exactly that split.
  const admin = await signIn(ADMIN_KEY);
  check("an ADMIN can sign in", admin.verify.status === 200, `got ${admin.verify.status}`);

  const managerAudit = await call("GET", "/audit?limit=1", { jar: manager.jar });
  check(
    "a MANAGER is refused the audit log, since it does not hold PERM_VIEW_AUDIT",
    managerAudit.status === 403,
    `got ${managerAudit.status}`,
  );

  const before = await call("GET", "/audit?limit=100", { jar: admin.jar });
  check(
    "an ADMIN can read the audit log",
    before.status === 200,
    `got ${before.status} ${JSON.stringify(before.body).slice(0, 200)}`,
  );
  const entriesBefore = before.body?.entries?.length ?? 0;
  console.log(`        audit source: ${before.body?.source}, entries before: ${entriesBefore}`);

  const form = new FormData();
  form.append("toDID", didHashFor(manager.account.address));
  form.append("name", "Exit check asset");
  form.append("description", "Minted by tools/e2e-flow.mjs");
  form.append("soulbound", "false");
  // A 1x1 PNG. Content decides the type, so this must be genuinely a PNG.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
      "05fe02fa0000000049454e44ae426082",
    "hex",
  );
  form.append("file", new Blob([png], { type: "image/png" }), "pixel.png");

  const beforeMintId = await latestEntryId(admin.jar);
  const mint = await call("POST", "/assets/mint", { jar: manager.jar, body: form, json: false });
  check(
    "POST /assets/mint is accepted",
    mint.status === 200,
    `got ${mint.status} ${JSON.stringify(mint.body).slice(0, 300)}`,
  );
  // 200, not 202: the server prepares a request and does NOT submit it. Submitting on the
  // caller's behalf is what made every action look like the relayer's.
  check(
    "the mint is prepared for signing rather than submitted by the server",
    mint.body?.typedData?.primaryType === "ForwardRequest",
    JSON.stringify(mint.body?.typedData?.primaryType),
  );
  check(
    "the prepared request names the caller as the actor",
    mint.body?.typedData?.message?.from?.toLowerCase() === manager.account.address.toLowerCase(),
    mint.body?.typedData?.message?.from,
  );

  const forwarded = await signAndForward(manager.account, manager.jar, mint.body.typedData);
  check(
    "the signed request is accepted and relayed",
    forwarded.status === 202,
    `got ${forwarded.status} ${JSON.stringify(forwarded.body).slice(0, 200)}`,
  );
  check(
    "the forward response attributes the action to the signer",
    forwarded.body?.actor?.toLowerCase() === manager.account.address.toLowerCase(),
    forwarded.body?.actor,
  );
  check(
    "an ipfs:// tokenURI was recorded",
    String(mint.body?.tokenURI ?? "").startsWith("ipfs://"),
  );

  const userMint = await (async () => {
    const f = new FormData();
    f.append("toDID", didHashFor(user.account.address));
    f.append("name", "Should not mint");
    f.append("soulbound", "false");
    f.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
    return call("POST", "/assets/mint", { jar: user.jar, body: f, json: false });
  })();
  check(
    "a USER without PERM_MINT_ASSET cannot mint",
    userMint.status >= 400,
    `got ${userMint.status}`,
  );

  // ---------------------------------------------------------------- audit shows it
  section("5. The audit trail shows the mint");

  // The relayer submits asynchronously, so wait for the mint to land before asserting.
  const mintEntryPolled = await waitForAction(admin.jar, "ASSET_MINTED", beforeMintId);
  check("the mint reached the chain within the timeout", mintEntryPolled !== null);

  const after = await call("GET", "/audit?limit=100", { jar: admin.jar });
  check("GET /audit still succeeds", after.status === 200);

  const entries = after.body?.entries ?? [];
  const mintEntry = entries.find((e) => e.action === "ASSET_MINTED");

  check(
    "an ASSET_MINTED entry is present",
    Boolean(mintEntry),
    `actions seen: ${[...new Set(entries.map((e) => e.action))].join(", ") || "none"}`,
  );
  /*
   * The point of actor attribution, checked against real chain data.
   *
   * The relayer submitted the transaction and paid for it; the manager signed the request.
   * The trail must name the manager, and must NOT name the relayer — otherwise the ledger
   * cannot tell one administrator from another, which is what the problem statement asks
   * an audit trail to do.
   */
  const relayerAddress = (await call("GET", "/network")).body?.active?.signerAddress ?? "";
  check(
    "the entry attributes the identity that REQUESTED the mint",
    mintEntry?.actor?.toLowerCase() === privateKeyToAccount(MANAGER_KEY).address.toLowerCase(),
    `actor=${mintEntry?.actor}`,
  );
  check(
    "the entry does NOT attribute the mint to the relayer that paid for it",
    mintEntry?.actor?.toLowerCase() !== relayerAddress.toLowerCase(),
    `actor=${mintEntry?.actor} relayer=${relayerAddress}`,
  );
  check(
    "the executor is reported separately, and is the relayer",
    mintEntry?.executor?.toLowerCase() === relayerAddress.toLowerCase(),
    `executor=${mintEntry?.executor}`,
  );
  check(
    "`via` is the AssetRegistry contract, distinct from the actor",
    Boolean(mintEntry?.via) && mintEntry?.via?.toLowerCase() !== mintEntry?.actor?.toLowerCase(),
    `via=${mintEntry?.via}`,
  );
  check("the entry carries a block number", Number(mintEntry?.blockNumber) > 0);
  check(
    "the audit read fell back to the chain, since no subgraph runs locally",
    after.body?.source === "chain",
    `source=${after.body?.source}`,
  );

  const filtered = await call("GET", "/audit?action=ASSET_MINTED&limit=100", { jar: admin.jar });
  check(
    "filtering by action name returns only mints",
    filtered.status === 200 &&
      (filtered.body?.entries ?? []).length > 0 &&
      (filtered.body?.entries ?? []).every((e) => e.action === "ASSET_MINTED"),
  );

  const badFilter = await call("GET", "/audit?action=NOT_A_REAL_ACTION", { jar: admin.jar });
  check(
    "an unknown action name is refused rather than ignored",
    badFilter.status === 400,
    `got ${badFilter.status}`,
  );

  // ---------------------------------------------------------------- credentials
  section("6. Credential lifecycle");

  const beforeIssueId = await latestEntryId(admin.jar);
  const issue = await call("POST", "/credentials/issue", {
    jar: manager.jar,
    body: {
      didHash: didHashFor(user.account.address),
      credentialType: "EmploymentCredential",
      claims: { role: "Engineer", name: "Ada Lovelace", level: 3 },
      expiresAt: 0,
    },
  });

  check(
    "POST /credentials/issue is prepared for a MANAGER",
    issue.status === 200,
    `got ${issue.status} ${JSON.stringify(issue.body).slice(0, 300)}`,
  );
  check("a credential JWT is returned", typeof issue.body?.jwt === "string");
  check("a content key is returned exactly once", typeof issue.body?.contentKey === "string");
  check(
    "an encrypted envelope was pinned",
    String(issue.body?.envelopeUri ?? "").startsWith("ipfs://"),
  );

  // The privacy property, checked against what is actually stored.
  if (issue.body?.envelopeUri) {
    const cid = issue.body.envelopeUri.replace("ipfs://", "");
    const stored = (() => {
      try {
        return readFileSync(
          path.join(repoRoot, "packages", "backend", ".local-ipfs", `${cid}.json`),
          "utf8",
        );
      } catch {
        return null;
      }
    })();

    check("the pinned envelope exists on disk", stored !== null);
    check(
      "the pinned envelope does not contain the claim text",
      stored !== null && !stored.includes("Ada Lovelace"),
    );
    check(
      "the pinned envelope does not contain the credential JWT",
      stored !== null && !stored.includes(issue.body.jwt),
    );
  }

  const userIssue = await call("POST", "/credentials/issue", {
    jar: user.jar,
    body: {
      didHash: didHashFor(user.account.address),
      credentialType: "SelfIssued",
      claims: { role: "Admin" },
      expiresAt: 0,
    },
  });
  check("a USER cannot issue a credential", userIssue.status === 403, `got ${userIssue.status}`);

  const issueForward = await signAndForward(manager.account, manager.jar, issue.body.typedData);
  check(
    "the signed issuance is accepted and relayed",
    issueForward.status === 202,
    `got ${issueForward.status} ${JSON.stringify(issueForward.body).slice(0, 200)}`,
  );

  // Relayed asynchronously; the credential is not anchored until it lands.
  const issuedEntry = await waitForAction(admin.jar, "CREDENTIAL_ISSUED", beforeIssueId);
  check("the issuance reached the chain within the timeout", issuedEntry !== null);

  const verifyPublic = await call("POST", "/credentials/verify", {
    body: { jwt: issue.body?.jwt },
  });
  check(
    "verification needs no session at all",
    verifyPublic.status === 200,
    `got ${verifyPublic.status}`,
  );
  check(
    "the credential verifies as valid",
    verifyPublic.body?.valid === true,
    JSON.stringify(verifyPublic.body?.status),
  );
  check("the signature was checked", verifyPublic.body?.proof?.signatureValid === true);
  check("the on-chain issuer is reported", typeof verifyPublic.body?.proof?.issuer === "string");

  const forged = await call("POST", "/credentials/verify", {
    body: { jwt: `${issue.body?.jwt?.split(".").slice(0, 2).join(".")}.bm90LWEtc2ln` },
  });
  check(
    "a credential with a broken signature does not verify",
    forged.body?.proof?.signatureValid === false && forged.body?.valid === false,
    JSON.stringify(forged.body?.proof?.signatureValid),
  );

  const beforeRevokeId = await latestEntryId(admin.jar);
  const revoke = await call("POST", "/credentials/revoke", {
    jar: manager.jar,
    body: { credentialHash: issue.body?.credentialHash, reasonCode: 1 },
  });
  check("revocation is prepared", revoke.status === 200, `got ${revoke.status}`);

  const revokeForward = await signAndForward(manager.account, manager.jar, revoke.body.typedData);
  check(
    "the signed revocation is accepted and relayed",
    revokeForward.status === 202,
    `got ${revokeForward.status}`,
  );

  const revokedEntry = await waitForAction(admin.jar, "CREDENTIAL_REVOKED", beforeRevokeId);
  check("the revocation reached the chain within the timeout", revokedEntry !== null);
  const afterRevoke = await call("POST", "/credentials/verify", {
    body: { jwt: issue.body?.jwt },
  });
  check(
    "the same credential now verifies as revoked",
    afterRevoke.body?.valid === false && afterRevoke.body?.status === "revoked",
    `valid=${afterRevoke.body?.valid} status=${afterRevoke.body?.status}`,
  );
  check("the revocation reason is reported", afterRevoke.body?.proof?.revocationReason === 1);

  const doubleRevoke = await call("POST", "/credentials/revoke", {
    jar: manager.jar,
    body: { credentialHash: issue.body?.credentialHash, reasonCode: 1 },
  });
  check(
    "revoking twice is refused with 409",
    doubleRevoke.status === 409,
    `got ${doubleRevoke.status}`,
  );

  const zeroReason = await call("POST", "/credentials/revoke", {
    jar: manager.jar,
    body: { credentialHash: issue.body?.credentialHash, reasonCode: 0 },
  });
  check("a zero revocation reason is refused", zeroReason.status === 400);

  // ---------------------------------------------------------------- audit again
  section("7. The audit trail shows the credential lifecycle");

  const finalAudit = await call("GET", "/audit?limit=100", { jar: admin.jar });
  const actions = (finalAudit.body?.entries ?? []).map((e) => e.action);

  check("CREDENTIAL_ISSUED is recorded", actions.includes("CREDENTIAL_ISSUED"), actions.join(", "));
  check("CREDENTIAL_REVOKED is recorded", actions.includes("CREDENTIAL_REVOKED"));
  check("ASSET_MINTED is still recorded", actions.includes("ASSET_MINTED"));
  check("DID_REGISTERED from the seed is recorded", actions.includes("DID_REGISTERED"));

  // ---------------------------------------------------------------- export
  section("8. CSV export");

  const anonExport = await call("GET", "/audit/export.csv");
  check("export without a session is 401", anonExport.status === 401, `got ${anonExport.status}`);

  const csv = await call("GET", "/audit/export.csv", { jar: admin.jar });

  check("an ADMIN can export", csv.status === 200, `got ${csv.status}`);
  check(
    "the export is served as CSV with a download filename",
    String(csv.headers.get("content-type")).includes("text/csv") &&
      String(csv.headers.get("content-disposition")).includes("attachment"),
  );
  check("the export is not cached", csv.headers.get("cache-control") === "no-store");

  const csvText = typeof csv.body === "string" ? csv.body : JSON.stringify(csv.body);
  check("the export has a header row", csvText.startsWith('"entryId"'));
  check("the export contains the mint", csvText.includes("ASSET_MINTED"));
  check(
    "every field is quoted, so no value can forge a row",
    csvText
      .split("\r\n")
      .filter(Boolean)
      .every((line) => line.startsWith('"')),
  );

  // ---------------------------------------------------------------- headers
  section("9. Security headers on a real response");

  const headers = (await call("GET", "/health")).headers;
  check("X-Content-Type-Options: nosniff", headers.get("x-content-type-options") === "nosniff");
  check("Content-Security-Policy is set", Boolean(headers.get("content-security-policy")));
  check(
    "CSP denies everything for a JSON API",
    String(headers.get("content-security-policy")).includes("default-src 'none'"),
  );
  check(
    "frame-ancestors 'none'",
    String(headers.get("content-security-policy")).includes("frame-ancestors 'none'"),
  );
  check("Referrer-Policy: no-referrer", headers.get("referrer-policy") === "no-referrer");
  check("Permissions-Policy is set", Boolean(headers.get("permissions-policy")));
  check("X-Powered-By is absent", headers.get("x-powered-by") === null);
  check("a request id is echoed", Boolean(headers.get("x-request-id")));

  // ---------------------------------------------------------------- cors
  section("10. CORS lets the app in and keeps everyone else out");

  /*
   * The browser boundary, checked over real HTTP because that is the only place it exists:
   * CORS is enforced by the browser against headers the server sends, so a unit test can
   * only assert the headers and this asserts the server actually emits them in production
   * shape. Uses /health, which is outside the /auth rate limiter exercised below.
   */
  const preflight = await call("OPTIONS", "/health", {
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type",
    },
  });

  check("a preflight from the app origin is answered 204", preflight.status === 204);
  check(
    "the response names the app origin rather than a wildcard",
    preflight.headers.get("access-control-allow-origin") === ORIGIN,
  );
  check(
    "credentials are allowed, without which the session cookie never travels",
    preflight.headers.get("access-control-allow-credentials") === "true",
  );
  check(
    "the app may send content-type",
    String(preflight.headers.get("access-control-allow-headers")).includes("content-type"),
  );
  check(
    "the app may not send Authorization, keeping the cookie the only session path",
    !String(preflight.headers.get("access-control-allow-headers"))
      .toLowerCase()
      .includes("authorization"),
  );
  check(
    "the client can read the request id back",
    String(preflight.headers.get("access-control-expose-headers")).includes("x-request-id"),
  );
  check(
    "preflights are cached, so every mutation does not cost two round trips",
    Number(preflight.headers.get("access-control-max-age")) > 0,
  );

  const allowed = await call("GET", "/health", { headers: { origin: ORIGIN } });
  check(
    "a real request from the app origin carries the header",
    allowed.headers.get("access-control-allow-origin") === ORIGIN,
  );
  check(
    "Vary: Origin is set, so a cache cannot leak one origin's approval to another",
    String(allowed.headers.get("vary")).toLowerCase().includes("origin"),
  );

  const hostile = await call("GET", "/health", { headers: { origin: "https://evil.test" } });
  check(
    "an unlisted origin gets no CORS header at all",
    hostile.headers.get("access-control-allow-origin") === null,
  );
  check(
    "and is refused rather than erroring, so refusals do not read as outages",
    hostile.status === 200,
  );

  const lookalike = await call("GET", "/health", {
    headers: { origin: `${ORIGIN}.evil.test` },
  });
  check(
    "an origin that merely ends with an allowed one is refused",
    lookalike.headers.get("access-control-allow-origin") === null,
  );

  const noOrigin = await call("GET", "/health");
  check(
    "a request with no Origin still works, because CORS is a browser mechanism",
    noOrigin.status === 200,
  );

  // ---------------------------------------------------------------- rate limit
  section("11. Login rate limiting still fires");

  /*
   * The local .env raises AUTH_RATE_LIMIT_POINTS so this script's own breadth does not
   * throttle it. That would be a hollow exit check if the limiter were never exercised,
   * so it is deliberately exhausted here — last, because once it trips every further
   * /auth/* call from this IP is refused for the rest of the window.
   */
  let limited = false;
  let attempts = 0;
  for (let i = 0; i < 120 && !limited; i += 1) {
    attempts += 1;
    const response = await call("GET", "/auth/nonce");
    if (response.status === 429) {
      limited = true;
      check("a burst of login attempts is eventually rate limited", true);
      check(
        "the 429 carries Retry-After, so a client knows when to come back",
        Boolean(response.headers.get("retry-after")),
      );
    }
  }

  if (!limited) {
    check("a burst of login attempts is eventually rate limited", false, `${attempts} allowed`);
  } else {
    console.log(`        limiter tripped after ${attempts} requests`);
  }

  // ---------------------------------------------------------------- summary
  console.log(`\n${"-".repeat(60)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  if (failures.length > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\nP2.6 exit check: PASS");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
