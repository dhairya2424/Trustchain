#!/usr/bin/env node
/**
 * Forward Amoy POL from the deployer to the relayer's signer.
 *
 *   node tools/fund-amoy-relayer.mjs [amountPol] [signerAddress]
 *
 * Why this exists: bringing TrustChain up on Amoy needs gas in two different accounts —
 * the deployer, which pays once to put the contracts on chain, and the relayer signer,
 * which pays continuously for every forwarded user transaction afterwards. Asking whoever
 * holds the faucet POL to make two separate transfers to two addresses they have no other
 * reason to care about is a step that gets done wrong. So they fund the deployer only, and
 * this moves the relayer's share across.
 *
 * The signer address is read from the relayer service when it is reachable, because that
 * service is the authority on which key it will actually sign with; a hand-copied address
 * is exactly the kind of thing that silently funds the wrong account. Passing it explicitly
 * is supported for when the service is down.
 *
 * **Testnet guard.** This refuses any chain id other than 80002. The deployer key is a real
 * key on a real network, and the difference between Amoy and Polygon mainnet is one
 * environment variable — so the check is on the chain the RPC actually reports, not on what
 * the URL claims to be.
 */
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const AMOY_CHAIN_ID = 80002;
const AMOUNT = process.argv[2] ?? "2";
const EXPLICIT_SIGNER = process.argv[3];

/** Reads a .env without pulling in a dependency, and without logging any value. */
function env(file) {
  const out = {};
  for (const line of readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const contracts = env("packages/contracts/.env");
const backend = env("packages/backend/.env");

if (!contracts.DEPLOYER_PRIVATE_KEY || /replace-me/.test(contracts.DEPLOYER_PRIVATE_KEY)) {
  console.error("No deployer key in packages/contracts/.env.");
  process.exit(1);
}

const rpcUrl = contracts.AMOY_RPC_URL;
const publicClient = createPublicClient({ transport: http(rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== AMOY_CHAIN_ID) {
  console.error(
    `Refusing to send: RPC reports chain id ${chainId}, expected ${AMOY_CHAIN_ID} (Polygon Amoy).`,
  );
  process.exit(1);
}

/** The relayer service is the authority on which key it signs with. */
async function relayerSigner() {
  if (EXPLICIT_SIGNER) return EXPLICIT_SIGNER;
  const res = await fetch(`${backend.RELAYER_URL}/api/v1/relayers/${backend.RELAYER_ID}`, {
    headers: { Authorization: `Bearer ${backend.RELAYER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`relayer lookup failed: HTTP ${res.status}`);
  const body = await res.json();
  const address = body?.data?.address ?? body?.address;
  if (!address) throw new Error("relayer reported no address");
  return address;
}

let signer;
try {
  signer = await relayerSigner();
} catch (error) {
  console.error(`${error.message}\n`);
  console.error("Start the relayer, or pass the signer address explicitly:");
  console.error("  node tools/fund-amoy-relayer.mjs 2 0x<relayer signer>");
  process.exit(1);
}

const account = privateKeyToAccount(contracts.DEPLOYER_PRIVATE_KEY);
const wallet = createWalletClient({ account, chain: polygonAmoy, transport: http(rpcUrl) });

const before = await publicClient.getBalance({ address: account.address });
const value = parseEther(AMOUNT);

console.log(`deployer ${account.address}  holds ${formatEther(before)} POL`);
console.log(`relayer  ${signer}`);

if (before <= value) {
  console.error(
    `\nDeployer holds ${formatEther(before)} POL, which does not cover ${AMOUNT} POL plus gas.`,
  );
  process.exit(1);
}

console.log(`\nsending ${AMOUNT} POL…`);
const hash = await wallet.sendTransaction({ to: signer, value });
console.log(`  tx ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const after = await publicClient.getBalance({ address: signer });

console.log(`  ${receipt.status} in block ${receipt.blockNumber}`);
console.log(`  https://amoy.polygonscan.com/tx/${hash}`);
console.log(`\nrelayer signer now holds ${formatEther(after)} POL`);
