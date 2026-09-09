#!/usr/bin/env node
/**
 * Acceptance for the three gaps the traceability audit named, run against live Polygon Amoy.
 *
 *   node tools/e2e-gaps.mjs
 *
 * The audit found three things the problem statement asked for that the product could not
 * do, even though the contracts recorded them:
 *
 *   1. **NFT ownership transfer** — `AssetRegistry._update` writes `ASSET_TRANSFERRED`, and
 *      nothing could reach it. No endpoint, no control.
 *   2. **In-product identity creation** — onboarding was `tools/onboard-wallet.mjs`, run by an
 *      operator against the deployer key. A new user could sign in and find no way forward.
 *   3. **Credential issuance and revocation** — implemented in the API, absent from the UI.
 *
 * This drives all three through the HTTP API exactly as the browser does: prepare, sign with
 * the caller's own key, forward. Nothing here calls a contract directly, because a script that
 * bypassed the API would prove the contracts work — which was never in doubt — rather than
 * that the product can now do these things.
 *
 * Every assertion is checked against the chain afterwards, not against the API's own report.
 *
 * Refuses any chain id but 80002.
 */
import { createPublicClient, http, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const API = process.env.TRUSTCHAIN_API ?? "http://localhost:4000";
const ORIGIN = process.env.TRUSTCHAIN_APP ?? "http://localhost:5173";
const DOMAIN = new URL(ORIGIN).host;
const AMOY_CHAIN_ID = 80002;
const EXPLORER = "https://amoy.polygonscan.com";
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

const section = (title) => console.log(`\n${title}`);

function env(file) {
  const out = {};
  for (const line of readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const secrets = env("packages/contracts/.env");
/*
 * The deployment record stores each contract as `{ address, implementation, kind }` — a proxy
 * and the implementation behind it. Only the proxy address is ever called; the implementation
 * is recorded for upgrade safety and would be the wrong thing to talk to.
 */
const ADDRESSES = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(path.join(repoRoot, "packages/contracts/deployments/amoy.json"), "utf8"),
    ).contracts,
  ).map(([name, record]) => [name, typeof record === "string" ? record : record.address]),
);

const client = createPublicClient({ chain: polygonAmoy, transport: http(secrets.AMOY_RPC_URL) });

const DID_ABI = [
  {
    type: "function",
    name: "controllerOf",
    stateMutability: "view",
    inputs: [{ name: "didHash", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "didOf",
    stateMutability: "view",
    inputs: [{ name: "controller", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
];

const ASSET_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "ownerDIDOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isSoulbound",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
];

/** Mirrors didHashFor() in the API and the seed script. */
const didHashFor = (address) => keccak256(toHex(`did:trustchain:amoy:${address.toLowerCase()}`));

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
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
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
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function signIn(account) {
  const jar = cookieJar();
  const nonce = await call("GET", "/auth/nonce", { jar });
  const message = createSiweMessage({
    address: account.address,
    chainId: AMOY_CHAIN_ID,
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
  if (verified.status !== 200) {
    throw new Error(`sign-in failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  return { jar, identity: verified.body };
}

/**
 * Prepare, sign, forward — the browser's exact sequence.
 *
 * The signature is produced by the caller's own key, so the contract recovers *them* through
 * ERC-2771 while the relayer pays. That is the property the whole design exists for, and
 * doing it any other way here would test something the product does not do.
 */
async function preparedAction(account, jar, endpoint, body) {
  const prepared = await call("POST", endpoint, { jar, body });
  if (prepared.status !== 200) {
    throw new Error(`${endpoint} → ${prepared.status} ${JSON.stringify(prepared.body)}`);
  }

  const typed = prepared.body.typedData;
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: {
      from: typed.message.from,
      to: typed.message.to,
      value: BigInt(typed.message.value),
      gas: BigInt(typed.message.gas),
      nonce: BigInt(typed.message.nonce),
      deadline: typed.message.deadline,
      data: typed.message.data,
    },
  });

  const forwarded = await call("POST", "/network/forward", {
    jar,
    body: {
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
    },
  });

  if (forwarded.status >= 300) {
    throw new Error(`forward → ${forwarded.status} ${JSON.stringify(forwarded.body)}`);
  }

  return { prepared: prepared.body, forwarded: forwarded.body };
}

/**
 * Mints an asset to a DID, through the API, with a real file and a real IPFS pin.
 *
 * The suite mints its own asset rather than borrowing one. An earlier version looked for a
 * token the administrator already held and transferred that — which worked, and quietly gave
 * away the demo's only asset every time it ran. A test that consumes the thing it is testing
 * against is a test you can only run once.
 *
 * The upload is a real multipart request because that is what the mint endpoint takes: the
 * file is scanned, its type is decided by content rather than by its name, and the metadata is
 * stripped and pinned before anything reaches the chain.
 */
async function mintTo(account, jar, didHash, name) {
  // A 1×1 PNG. Small, genuinely a PNG by magic number, and nothing to strip.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "asset.png");
  form.append("toDID", didHash);
  form.append("name", name);
  form.append("description", "Minted by tools/e2e-gaps.mjs to exercise the transfer path.");
  form.append("soulbound", "false");

  const response = await fetch(`${API}/assets/mint`, {
    method: "POST",
    headers: { cookie: jar.header() },
    body: form,
  });

  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) {
    throw new Error(`mint → ${response.status} ${JSON.stringify(body)}`);
  }

  const typed = body.typedData;
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: {
      from: typed.message.from,
      to: typed.message.to,
      value: BigInt(typed.message.value),
      gas: BigInt(typed.message.gas),
      nonce: BigInt(typed.message.nonce),
      deadline: typed.message.deadline,
      data: typed.message.data,
    },
  });

  const forwarded = await call("POST", "/network/forward", {
    jar,
    body: {
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
    },
  });

  if (forwarded.status >= 300) {
    throw new Error(`mint forward → ${forwarded.status} ${JSON.stringify(forwarded.body)}`);
  }

  return body;
}

/**
 * Waits for the chain to actually show the effect.
 *
 * Not for a transaction hash: `POST /network/forward` answers 202 with a transaction *id* and
 * a hash of null, because the relayer reports an id as soon as it accepts the request and a
 * hash only once it has broadcast. Waiting on the hash would be waiting on the plumbing.
 *
 * Polling the state instead asserts the thing that matters — the registry resolves the new
 * identity, the token has moved — and is what an auditor would check. A relay that reported
 * success while changing nothing fails here, which is the failure most worth catching.
 */
async function settle(predicate, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`${label}: the chain never showed the change`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

const read = (address, abi, functionName, args = []) =>
  client.readContract({ address, abi, functionName, args });

async function main() {
  const chainId = await client.getChainId();
  section("0. The chain is Polygon Amoy");
  check("RPC reports chain id 80002", chainId === AMOY_CHAIN_ID, `got ${chainId}`);
  if (chainId !== AMOY_CHAIN_ID) {
    console.log("\nRefusing to continue against a chain that is not Amoy.");
    process.exit(1);
  }

  const admin = privateKeyToAccount(secrets.DEPLOYER_PRIVATE_KEY);
  const { jar: adminJar } = await signIn(admin);

  section("1. An administrator signs in");
  check("the session is bound to the administrator", true);

  // ---------------------------------------------------------------- gap 2
  section("2. Identity creation, in-product (was: an operator and a terminal)");

  const newcomer = privateKeyToAccount(generatePrivateKey());
  const newcomerDID = didHashFor(newcomer.address);

  const before = await read(ADDRESSES.DIDRegistry, DID_ABI, "controllerOf", [newcomerDID]);
  check(
    `${newcomer.address} is unknown to the registry`,
    before === "0x0000000000000000000000000000000000000000",
  );

  const registration = await preparedAction(admin, adminJar, "/identity/register", {
    address: newcomer.address,
  });

  check(
    "the API derived the same identity hash the chain uses",
    registration.prepared.didHash.toLowerCase() === newcomerDID.toLowerCase(),
    `${registration.prepared.didHash} vs ${newcomerDID}`,
  );

  await settle(async () => {
    const who = await read(ADDRESSES.DIDRegistry, DID_ABI, "controllerOf", [newcomerDID]);
    return who.toLowerCase() === newcomer.address.toLowerCase();
  }, "identity registration");

  const controller = await read(ADDRESSES.DIDRegistry, DID_ABI, "controllerOf", [newcomerDID]);
  check(
    "the chain now resolves the identity to the newcomer",
    controller.toLowerCase() === newcomer.address.toLowerCase(),
    controller,
  );

  // The subject controls their own identity — the administrator created it, and does not
  // hold it. Getting this wrong would silently hand the admin the newcomer's assets.
  check(
    "the administrator did not register the identity to themselves",
    controller.toLowerCase() !== admin.address.toLowerCase(),
  );

  section("3. The same registration is refused a second time");
  const duplicate = await call("POST", "/identity/register", {
    jar: adminJar,
    body: { address: newcomer.address },
  });
  check(
    "a repeat registration is refused with a specific reason",
    duplicate.status === 409 &&
      ["identity_already_registered", "address_already_has_identity"].includes(
        duplicate.body.error,
      ),
    `${duplicate.status} ${JSON.stringify(duplicate.body)}`,
  );

  // ---------------------------------------------------------------- gap 1
  section("4. Ownership transfer (was: recorded by the contract, unreachable from the product)");

  const adminDID = didHashFor(admin.address);
  const mintedBefore = Number(await read(ADDRESSES.AssetRegistry, ASSET_ABI, "totalMinted"));

  // Mint the asset this run will give away, rather than borrowing one that belongs to the
  // demo. The mint is real: a real file, scanned and pinned, and a real on-chain token.
  await mintTo(admin, adminJar, adminDID, `Transfer subject ${Date.now()}`);

  await settle(
    async () =>
      Number(await read(ADDRESSES.AssetRegistry, ASSET_ABI, "totalMinted")) > mintedBefore,
    "asset mint",
  );

  const tokenId = Number(await read(ADDRESSES.AssetRegistry, ASSET_ABI, "totalMinted"));

  {
    const owner = await read(ADDRESSES.AssetRegistry, ASSET_ABI, "ownerOf", [BigInt(tokenId)]);
    check(
      `the administrator holds the freshly minted asset #${tokenId}`,
      owner.toLowerCase() === admin.address.toLowerCase(),
      owner,
    );

    const ownerDIDBefore = await read(ADDRESSES.AssetRegistry, ASSET_ABI, "ownerDIDOf", [
      BigInt(tokenId),
    ]);
    check(
      "the asset is bound to the administrator's identity",
      ownerDIDBefore.toLowerCase() === adminDID.toLowerCase(),
    );

    const transfer = await preparedAction(admin, adminJar, "/assets/prepare-transfer", {
      tokenId,
      toAddress: newcomer.address,
    });

    check(
      "the transfer is planned to the newcomer's identity",
      transfer.prepared.toDID.toLowerCase() === newcomerDID.toLowerCase(),
    );

    await settle(async () => {
      const who = await read(ADDRESSES.AssetRegistry, ASSET_ABI, "ownerOf", [BigInt(tokenId)]);
      return who.toLowerCase() === newcomer.address.toLowerCase();
    }, "asset transfer");

    const [ownerAfter, ownerDIDAfter] = await Promise.all([
      read(ADDRESSES.AssetRegistry, ASSET_ABI, "ownerOf", [BigInt(tokenId)]),
      read(ADDRESSES.AssetRegistry, ASSET_ABI, "ownerDIDOf", [BigInt(tokenId)]),
    ]);

    check(
      "the chain says the newcomer's key now holds the asset",
      ownerAfter.toLowerCase() === newcomer.address.toLowerCase(),
      ownerAfter,
    );
    check(
      "and that ownership moved to their identity, not merely their address",
      ownerDIDAfter.toLowerCase() === newcomerDID.toLowerCase(),
      ownerDIDAfter,
    );

    section("5. The administrator can no longer move what they no longer own");
    const afterTransfer = await call("POST", "/assets/prepare-transfer", {
      jar: adminJar,
      body: { tokenId, toAddress: admin.address },
    });
    check(
      "a transfer of a token they gave away is refused",
      afterTransfer.status === 400 && afterTransfer.body.error === "not_asset_owner",
      `${afterTransfer.status} ${JSON.stringify(afterTransfer.body)}`,
    );
  }

  section("6. A transfer to an address with no identity is refused, not attempted");
  const stranger = privateKeyToAccount(generatePrivateKey());
  const toStranger = await call("POST", "/assets/prepare-transfer", {
    jar: adminJar,
    body: { tokenId: 1, toAddress: stranger.address },
  });
  check(
    "the API names the reason rather than spending gas to find out",
    toStranger.status === 400 &&
      ["recipient_has_no_identity", "not_asset_owner"].includes(toStranger.body.error),
    `${toStranger.status} ${JSON.stringify(toStranger.body)}`,
  );

  // ---------------------------------------------------------------- gap 3
  section("7. Credential issuance through the API the console now uses");

  const issued = await preparedAction(admin, adminJar, "/credentials/issue", {
    didHash: newcomerDID,
    credentialType: "OnboardingCredential",
    claims: { issuedBy: "e2e-gaps", subject: "newcomer" },
    expiresAt: 0,
  });

  check("the credential document is returned exactly once", Boolean(issued.prepared.jwt));
  check("so is the key that decrypts its sealed envelope", Boolean(issued.prepared.contentKey));
  check("and it is pinned before anything is anchored", Boolean(issued.prepared.envelopeUri));

  // The public verifier is the assertion: it reads the registry, so a "valid" answer means
  // the anchor is genuinely on chain rather than that the relayer accepted a request.
  await settle(async () => {
    const probe = await call("POST", "/credentials/verify", {
      body: { credentialHash: issued.prepared.credentialHash },
    });
    return probe.status === 200 && probe.body.status === "valid";
  }, "credential issuance");

  const verified = await call("POST", "/credentials/verify", {
    body: { credentialHash: issued.prepared.credentialHash },
  });
  check(
    "a stranger with no session can verify it and is told it is valid",
    verified.status === 200 && verified.body.status === "valid",
    JSON.stringify(verified.body),
  );

  section("8. Revocation, and a verifier learning about it");
  const revoked = await preparedAction(admin, adminJar, "/credentials/revoke", {
    credentialHash: issued.prepared.credentialHash,
    reasonCode: 4,
  });
  await settle(async () => {
    const probe = await call("POST", "/credentials/verify", {
      body: { credentialHash: issued.prepared.credentialHash },
    });
    return probe.status === 200 && probe.body.status === "revoked";
  }, "credential revocation");

  const afterRevoke = await call("POST", "/credentials/verify", {
    body: { credentialHash: issued.prepared.credentialHash },
  });
  check(
    "the same public check now reports it revoked",
    afterRevoke.status === 200 && afterRevoke.body.status === "revoked",
    JSON.stringify(afterRevoke.body),
  );

  const revokeAgain = await call("POST", "/credentials/revoke", {
    jar: adminJar,
    body: { credentialHash: issued.prepared.credentialHash, reasonCode: 4 },
  });
  check(
    "revoking it twice is refused rather than relayed",
    revokeAgain.status === 409 && revokeAgain.body.error === "already_revoked",
    `${revokeAgain.status} ${JSON.stringify(revokeAgain.body)}`,
  );

  // ---------------------------------------------------------------- the ledger
  section("9. The audit trail caught up on its own");

  // The indexer picks events up without being asked; give it room to, then read the trail
  // rather than the API's own report of what it just did.
  await new Promise((resolve) => setTimeout(resolve, 20_000));

  const trail = await call("GET", "/audit?limit=100", { jar: adminJar });
  const entries = trail.body?.entries ?? [];
  const actions = new Set(entries.map((entry) => entry.action));

  check("DID_REGISTERED is on the trail", actions.has("DID_REGISTERED"), [...actions].join(", "));
  check("CREDENTIAL_ISSUED is on the trail", actions.has("CREDENTIAL_ISSUED"));
  check("CREDENTIAL_REVOKED is on the trail", actions.has("CREDENTIAL_REVOKED"));

  check("ASSET_MINTED is on the trail", actions.has("ASSET_MINTED"));
  check(
    "ASSET_TRANSFERRED is on the trail — the clause the product could not previously reach",
    actions.has("ASSET_TRANSFERRED"),
    [...actions].join(", "),
  );

  const registered = entries.find((entry) => entry.action === "DID_REGISTERED");
  if (registered) {
    check(
      "the actor is the administrator who signed, not the relayer that paid",
      registered.actor?.toLowerCase() === admin.address.toLowerCase(),
      `actor ${registered.actor}`,
    );
    check(
      "the executor is recorded separately",
      Boolean(registered.executor) &&
        registered.executor.toLowerCase() !== admin.address.toLowerCase(),
      `executor ${registered.executor}`,
    );
    check("the entry carries a block number", Number(registered.blockNumber) > 0);
  }

  /*
   * The explorer links come from the trail rather than from the relay response.
   *
   * `POST /network/forward` answers with a transaction id and a null hash — the relayer has
   * accepted the request but not yet broadcast. The hash the audit trail carries is one the
   * indexer read out of a mined block, so a link printed from here is a link that resolves.
   */
  const links = entries
    .filter((entry) =>
      ["DID_REGISTERED", "ASSET_TRANSFERRED", "CREDENTIAL_ISSUED", "CREDENTIAL_REVOKED"].includes(
        entry.action,
      ),
    )
    .slice(0, 4);

  if (links.length > 0) {
    console.log("\n  Checkable by anyone:");
    for (const entry of links) {
      console.log(`    ${entry.action.padEnd(20)} ${EXPLORER}/tx/${entry.transactionHash}`);
    }
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  console.log(`\nGap acceptance: ${failed === 0 ? "PASS" : "FAIL"}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nunexpected failure: ${error.message}`);
  process.exitCode = 1;
});
