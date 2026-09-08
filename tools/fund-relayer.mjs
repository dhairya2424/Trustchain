#!/usr/bin/env node
/**
 * Fund the relayer's signer on the local Hardhat chain.
 *
 *   node tools/fund-relayer.mjs [amountEth]
 *
 * The relayer pays the gas for every forwarded transaction, so a relayer with a zero
 * balance accepts requests and then silently never lands them — the API returns 202, the
 * queue accepts the job, and the only evidence is a `insufficient balance` warning in the
 * relayer's own log. That failure is easy to mistake for a broken contract call, so this
 * exists to remove it as a possibility in one command.
 *
 * It is needed after every Hardhat restart, because the container's chain state is
 * ephemeral: the deployment addresses come back identical (deterministic nonces) but every
 * balance is reset, and the relayer's keystore address is not one of Hardhat's pre-funded
 * accounts.
 *
 * Local only, by construction. It signs with a Hardhat development key that is printed in
 * that node's own startup banner and funds nothing on any other chain; the guard below
 * refuses to run against a chain id other than 31337 so a stray RPC URL cannot turn this
 * into a mainnet transfer.
 */
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Hardhat account #0 — a public test key, printed by every `hardhat node` banner. */
const FUNDER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secrets-scan:allow public Hardhat test key

const RPC_URL = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const AMOUNT = process.argv[2] ?? "10";

/**
 * Asks `relayer-address.mjs` rather than reading the keystore here.
 *
 * A Web3 Secret Storage V3 file records only the encrypted key — there is no address field
 * — so the address has to be derived by decrypting. That derivation already exists, is
 * already tested, and handles the private key carefully; duplicating it in a funding script
 * would be a second place for a key to end up somewhere it should not.
 */
function relayerAddress() {
  const script = path.join(repoRoot, "tools", "relayer-address.mjs");
  const output = execFileSync(process.execPath, [script], { encoding: "utf8" });

  const address = output.trim().split(/\r?\n/)[0]?.trim();
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`Could not read the relayer address from ${script}`);
  }

  return address;
}

async function main() {
  const publicClient = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });

  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) {
    console.error(
      `Refusing to run: connected chain id is ${chainId}, not 31337.\n` +
        "This script signs with a public Hardhat development key and is for the local node only.",
    );
    process.exit(1);
  }

  const to = relayerAddress();
  const before = await publicClient.getBalance({ address: to });

  const wallet = createWalletClient({
    account: privateKeyToAccount(FUNDER),
    chain: hardhat,
    transport: http(RPC_URL),
  });

  const hash = await wallet.sendTransaction({ to, value: parseEther(AMOUNT) });
  await publicClient.waitForTransactionReceipt({ hash });

  const after = await publicClient.getBalance({ address: to });

  console.log(`relayer   ${to}`);
  console.log(`before    ${formatEther(before)} ETH`);
  console.log(`sent      ${AMOUNT} ETH  (${hash})`);
  console.log(`after     ${formatEther(after)} ETH`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
