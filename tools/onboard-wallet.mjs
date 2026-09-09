#!/usr/bin/env node
/**
 * Give a wallet an identity on the platform.
 *
 *   node tools/onboard-wallet.mjs 0x<address> [ROLE]
 *
 * Roles: ADMIN, MANAGER, AUDITOR, USER (default USER).
 *
 * A wallet that has merely signed in holds nothing. It has no DID, so the contracts have
 * no identity to attach permissions to, and every role check refuses it — which is why a
 * newly connected wallet sees "permission required" everywhere rather than an empty
 * dashboard. That is the RBAC working, not a fault, but somebody has to perform the
 * onboarding and this is the first one: there is no signed-in admin yet to do it through
 * the UI, so it is done with the deployer key that already holds ADMIN from deployment.
 *
 * Two steps, in this order and not the other:
 *
 *   1. Register a DID for the address. Roles attach to a DID, not to an address, so
 *      granting first would have nothing to grant to.
 *   2. Grant the role to that DID.
 *
 * `registerDIDFor` is used rather than `registerDID` because the subject cannot call it
 * themselves — they hold no gas, and requiring them to would defeat the point of a platform
 * that relays. The admin registers on their behalf; the DID still resolves to their address,
 * so control remains theirs.
 *
 * Refuses any chain id but 80002.
 */
import { createPublicClient, createWalletClient, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const AMOY_CHAIN_ID = 80002;
const EXPLORER = "https://amoy.polygonscan.com";

const ROLES = ["ADMIN", "MANAGER", "AUDITOR", "USER"];

const [, , rawAddress, rawRole = "USER"] = process.argv;
const role = rawRole.toUpperCase();

if (!rawAddress || !/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
  console.error("usage: node tools/onboard-wallet.mjs 0x<address> [ADMIN|MANAGER|AUDITOR|USER]");
  process.exit(1);
}
if (!ROLES.includes(role)) {
  console.error(`unknown role "${rawRole}". The platform defines exactly: ${ROLES.join(", ")}.`);
  process.exit(1);
}

function env(file) {
  const out = {};
  for (const line of readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const contracts = env("packages/contracts/.env");
const deployment = JSON.parse(
  readFileSync(path.join(repoRoot, "packages/contracts/deployments/amoy.json"), "utf8"),
);
const ADDRESSES = Object.fromEntries(
  Object.entries(deployment.contracts).map(([name, info]) => [name, info.address]),
);

const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(contracts.AMOY_RPC_URL),
});

const chainId = await publicClient.getChainId();
if (chainId !== AMOY_CHAIN_ID) {
  console.error(`Refusing: RPC reports chain id ${chainId}, expected ${AMOY_CHAIN_ID}.`);
  process.exit(1);
}

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

/** Must match didHashFor() in scripts/seed.ts, or the API derives a different identity. */
const didHash = keccak256(toHex(`did:trustchain:amoy:${rawAddress.toLowerCase()}`));
const roleId = keccak256(toHex(`${role}_ROLE`));

const admin = privateKeyToAccount(contracts.DEPLOYER_PRIVATE_KEY);
const wallet = createWalletClient({
  account: admin,
  chain: polygonAmoy,
  transport: http(contracts.AMOY_RPC_URL),
});

console.log(`onboarding ${rawAddress} as ${role}`);
console.log(`admin      ${admin.address}\n`);

const controller = await publicClient.readContract({
  address: ADDRESSES.DIDRegistry,
  abi: DID_ABI,
  functionName: "controllerOf",
  args: [didHash],
});

if (controller === "0x0000000000000000000000000000000000000000") {
  const hash = await wallet.writeContract({
    address: ADDRESSES.DIDRegistry,
    abi: DID_ABI,
    functionName: "registerDIDFor",
    args: [didHash, rawAddress, keccak256(toHex(`key:${rawAddress}`))],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  DID registered   ${EXPLORER}/tx/${hash}`);
} else {
  console.log(`  DID already registered, controlled by ${controller}`);
}

const alreadyHas = await publicClient.readContract({
  address: ADDRESSES.RoleAccessControl,
  abi: ACL_ABI,
  functionName: "hasRole",
  args: [roleId, rawAddress],
});

if (alreadyHas) {
  console.log(`  ${role} already held`);
} else {
  const hash = await wallet.writeContract({
    address: ADDRESSES.RoleAccessControl,
    abi: ACL_ABI,
    functionName: "grantRoleToDID",
    args: [didHash, roleId],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ${role} granted      ${EXPLORER}/tx/${hash}`);
}

const held = [];
for (const name of ROLES) {
  const has = await publicClient.readContract({
    address: ADDRESSES.RoleAccessControl,
    abi: ACL_ABI,
    functionName: "hasRole",
    args: [keccak256(toHex(`${name}_ROLE`)), rawAddress],
  });
  if (has) held.push(name);
}

console.log(`\n${rawAddress} now holds: ${held.join(", ") || "(none)"}`);
console.log("Sign out and back in for the session to pick up the new roles.");
