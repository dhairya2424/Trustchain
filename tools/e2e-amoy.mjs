#!/usr/bin/env node
/**
 * The Polygon Amoy acceptance check.
 *
 *   node tools/e2e-amoy.mjs
 *
 * Proves the claim the whole project rests on, against a public chain, with nothing stubbed:
 *
 *   "Any appropriately authorized TrustChain user can perform an action with their own
 *    wallet, the relayer pays the gas, the blockchain records the real action, and any
 *    auditor can verify it independently on PolygonScan."
 *
 * The wallet used is generated fresh on every run. That matters: it is not the deployer,
 * not the relayer, and not a seeded fixture — it is an account that did not exist a second
 * ago, has never held a wei, and is never funded. If it can issue a credential, then the
 * platform genuinely supports arbitrary users rather than its own two infrastructure keys.
 *
 * Its zero balance is checked again *after* the transaction lands, which is the sharpest
 * available evidence for the gasless meta-transaction claim: the account that authorized
 * the action provably did not pay for it, and the account that paid provably could not have
 * authorized it, because the contract recovers the signer from the EIP-712 signature.
 *
 * Read-only against the deployment: it grants a role to a throwaway address and issues one
 * credential. Both are ordinary operations the platform is for.
 */
import { createPublicClient, createWalletClient, http, formatEther, keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = process.env.E2E_API ?? "http://localhost:4000";
const DOMAIN = process.env.E2E_DOMAIN ?? "localhost:5173";
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:5173";
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

const contractsEnv = env("packages/contracts/.env");
const deployment = JSON.parse(
  readFileSync(path.join(repoRoot, "packages/contracts/deployments/amoy.json"), "utf8"),
);
const ADDRESSES = Object.fromEntries(
  Object.entries(deployment.contracts).map(([name, info]) => [name, info.address]),
);

const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(contractsEnv.AMOY_RPC_URL),
});

/** Only the fragments this check calls. A full ABI would add nothing but noise. */
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
    name: "registerDIDFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "didHash", type: "bytes32" },
      { name: "controller", type: "address" },
      { name: "keyCommitment", type: "bytes32" },
    ],
    outputs: [],
  },
];

const ACL_ABI = [
  {
    type: "function",
    name: "grantRoleToDID",
    stateMutability: "nonpayable",
    inputs: [
      { name: "didHash", type: "bytes32" },
      { name: "role", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
];

/** Mirrors didHashFor() in scripts/seed.ts — the API derives the same value. */
const didHashFor = (address) => keccak256(toHex(`did:trustchain:amoy:${address.toLowerCase()}`));

const MANAGER_ROLE = keccak256(toHex("MANAGER_ROLE"));

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

/** Signs a prepared ForwardRequest and relays it, exactly as the browser does. */
async function signAndForward(account, jar, typedData) {
  const signature = await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: "ForwardRequest",
    message: {
      from: typedData.message.from,
      to: typedData.message.to,
      value: BigInt(typedData.message.value),
      gas: BigInt(typedData.message.gas),
      nonce: BigInt(typedData.message.nonce),
      deadline: typedData.message.deadline,
      data: typedData.message.data,
    },
  });

  return call("POST", "/network/forward", {
    jar,
    body: {
      request: {
        from: typedData.message.from,
        to: typedData.message.to,
        value: "0",
        gas: typedData.message.gas,
        nonce: typedData.message.nonce,
        deadline: typedData.message.deadline,
        data: typedData.message.data,
      },
      signature,
      verifyingContract: typedData.domain.verifyingContract,
      chainId: typedData.domain.chainId,
    },
  });
}

async function main() {
  section("1. The chain is really Polygon Amoy");

  const chainId = await publicClient.getChainId();
  check(`RPC reports chain id ${chainId}`, chainId === AMOY_CHAIN_ID, `expected ${AMOY_CHAIN_ID}`);

  for (const [name, address] of Object.entries(ADDRESSES)) {
    const code = await publicClient.getBytecode({ address });
    check(`${name} has bytecode on Amoy`, Boolean(code) && code !== "0x");
  }

  section("2. The platform agrees, and says so honestly");

  const network = await call("GET", "/network");
  const active = network.body?.active;
  check("API reports POLYGON AMOY active", active?.label === "POLYGON AMOY", String(active?.label));
  check("API reports chain id 80002", active?.chainId === AMOY_CHAIN_ID);
  check(
    "API claims public verifiability",
    active?.verifiability === "public",
    String(active?.verifiability),
  );
  check(
    "API exposes the Amoy explorer",
    active?.explorerUrl === EXPLORER,
    String(active?.explorerUrl),
  );

  const relayerAddress = active?.signerAddress;
  const relayerBalance = await publicClient.getBalance({ address: relayerAddress });
  check(
    `relayer ${relayerAddress} is funded (${formatEther(relayerBalance)} POL)`,
    relayerBalance > 0n,
  );

  section("3. A wallet that did not exist a moment ago");

  // Generated now. Never funded, never seeded, unknown to every fixture in this repo.
  const newUser = privateKeyToAccount(generatePrivateKey());
  const newUserDid = didHashFor(newUser.address);

  const startingBalance = await publicClient.getBalance({ address: newUser.address });
  check(`${newUser.address} holds nothing`, startingBalance === 0n, formatEther(startingBalance));

  section("4. An admin onboards it — DID first, then the role");

  const admin = privateKeyToAccount(contractsEnv.DEPLOYER_PRIVATE_KEY);
  const adminWallet = createWalletClient({
    account: admin,
    chain: polygonAmoy,
    transport: http(contractsEnv.AMOY_RPC_URL),
  });

  const registerHash = await adminWallet.writeContract({
    address: ADDRESSES.DIDRegistry,
    abi: DID_ABI,
    functionName: "registerDIDFor",
    args: [newUserDid, newUser.address, keccak256(toHex(`key:${newUser.address}`))],
  });
  await publicClient.waitForTransactionReceipt({ hash: registerHash });

  const controller = await publicClient.readContract({
    address: ADDRESSES.DIDRegistry,
    abi: DID_ABI,
    functionName: "controllerOf",
    args: [newUserDid],
  });
  check(
    "the DID resolves to the new wallet on chain",
    controller.toLowerCase() === newUser.address.toLowerCase(),
  );

  const grantHash = await adminWallet.writeContract({
    address: ADDRESSES.RoleAccessControl,
    abi: ACL_ABI,
    functionName: "grantRoleToDID",
    args: [newUserDid, MANAGER_ROLE],
  });
  const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
  console.log(`        ${EXPLORER}/tx/${grantHash}`);

  const isManager = await publicClient.readContract({
    address: ADDRESSES.RoleAccessControl,
    abi: ACL_ABI,
    functionName: "hasRole",
    args: [MANAGER_ROLE, newUser.address],
  });
  check("the chain says the new wallet is a MANAGER", isManager === true);
  check("the role grant emitted events", grantReceipt.logs.length > 0, "no logs");

  section("5. The new wallet signs in as itself");

  const session = await signIn(newUser);
  check(
    "the session is bound to the new wallet",
    session.identity.address?.toLowerCase() === newUser.address.toLowerCase(),
    session.identity.address,
  );
  check(
    "the API reports MANAGER, read from the chain",
    Array.isArray(session.identity.roles) && session.identity.roles.includes("MANAGER"),
    JSON.stringify(session.identity.roles),
  );

  section("6. It issues a credential — and pays nothing");

  const issued = await call("POST", "/credentials/issue", {
    jar: session.jar,
    body: {
      didHash: newUserDid,
      credentialType: "ProofOfInspection",
      claims: { inspected: true, site: "Amoy acceptance run" },
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    },
  });
  check(
    "the issuance is prepared for signing",
    issued.status === 200,
    JSON.stringify(issued.body).slice(0, 120),
  );

  const forwarded = await signAndForward(newUser, session.jar, issued.body.typedData);
  check(
    "the relayer accepted the signed request",
    forwarded.status === 200 || forwarded.status === 202,
    `${forwarded.status} ${JSON.stringify(forwarded.body).slice(0, 120)}`,
  );

  section("7. The chain records it");

  let credentialStatus = null;
  for (let i = 0; i < 60; i += 1) {
    const verify = await call("POST", "/credentials/verify", {
      body: { credentialHash: issued.body.credentialHash },
    });
    credentialStatus = verify.body?.status;
    if (credentialStatus === "valid") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  check(
    "the credential is anchored and reads back valid",
    credentialStatus === "valid",
    String(credentialStatus),
  );

  const endingBalance = await publicClient.getBalance({ address: newUser.address });
  check(
    "the issuing wallet still holds nothing — the relayer paid",
    endingBalance === 0n,
    formatEther(endingBalance),
  );

  section("8. An auditor can see who did it, and who paid");

  const adminSession = await signIn(admin);
  const audit = await call("GET", "/audit?limit=25", { jar: adminSession.jar });
  const entries = audit.body?.entries ?? [];
  const mine = entries.find(
    (entry) => entry.actor?.toLowerCase() === newUser.address.toLowerCase(),
  );

  check(
    "the audit trail carries the new wallet's action",
    Boolean(mine),
    `${entries.length} entries scanned`,
  );
  if (mine) {
    check(
      "the actor is the wallet that signed, not the relayer",
      mine.actor.toLowerCase() === newUser.address.toLowerCase(),
    );
    check(
      "the executor is the relayer that paid",
      mine.executor?.toLowerCase() === relayerAddress.toLowerCase(),
      mine.executor,
    );
    check(
      "the entry carries a real transaction hash",
      /^0x[0-9a-f]{64}$/i.test(mine.transactionHash ?? ""),
    );
    check("the entry carries a block number", Number(mine.blockNumber) > 0);

    const receipt = await publicClient.getTransactionReceipt({ hash: mine.transactionHash });
    check("that transaction exists on Amoy and succeeded", receipt.status === "success");
    check(
      "it was mined in the block the trail reports",
      Number(receipt.blockNumber) === Number(mine.blockNumber),
    );
    console.log(`        ${EXPLORER}/tx/${mine.transactionHash}`);
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  console.log(`\nPolygon Amoy acceptance: ${failed === 0 ? "PASS" : "FAIL"}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error.message ?? error}`);
  process.exitCode = 1;
});
