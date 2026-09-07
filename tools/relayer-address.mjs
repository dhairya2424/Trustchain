#!/usr/bin/env node
/**
 * Prints the address of the relayer's local signer keystore.
 *
 *   node tools/relayer-address.mjs
 *
 * This is the address that needs gas and on-chain roles, and the keystore does not record
 * it — a Web3 Secret Storage (V3) file stores only the encrypted key, so the address has
 * to be derived by decrypting and taking the public half.
 *
 * The private key is held in memory only long enough to derive the address and is **never
 * printed, logged or written**. The address is public information; the key is not, and a
 * key that reaches a terminal has reached a scrollback buffer and a shell history.
 *
 * Once the relayer service is running, the same address is available over its API
 * (`GET /api/v1/relayers/{id}`) without touching the keystore at all. This exists for the
 * step before that, when the service cannot start until the address has been funded.
 */
import { createDecipheriv, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const keystorePath = path.join(repoRoot, "infra", "relayer", "config", "keys", "local-signer.json");
const relayerEnv = path.join(repoRoot, "infra", "relayer", ".env");

function passphrase() {
  if (process.env.KEYSTORE_PASSPHRASE) return process.env.KEYSTORE_PASSPHRASE;
  if (!existsSync(relayerEnv)) return undefined;
  return /^KEYSTORE_PASSPHRASE=(.*)$/m.exec(readFileSync(relayerEnv, "utf8"))?.[1]?.trim();
}

/** Decrypts a V3 keystore. Supports the scrypt KDF, which is what the relayer emits. */
function decrypt(keystore, secret) {
  const { crypto: c } = keystore;

  if (c.kdf !== "scrypt") {
    throw new Error(`unsupported kdf "${c.kdf}" — only scrypt is handled`);
  }

  const { n: N, r, p, dklen, salt } = c.kdfparams;

  const derived = scryptSync(Buffer.from(secret, "utf8"), Buffer.from(salt, "hex"), dklen, {
    N,
    r,
    p,
    // scrypt with N=262144 exceeds Node's default 32MB budget; 128*N*r is the requirement.
    maxmem: 256 * N * r,
  });

  const ciphertext = Buffer.from(c.ciphertext, "hex");

  // The MAC authenticates the ciphertext under the second half of the derived key. A wrong
  // passphrase fails here rather than silently yielding garbage that looks like a key.
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
  const expected = Buffer.from(c.mac, "hex");
  const actual = Buffer.from(mac, "hex");

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("mac mismatch — wrong passphrase, or the keystore has been altered");
  }

  const decipher = createDecipheriv(
    c.cipher === "aes-128-ctr" ? "aes-128-ctr" : c.cipher,
    derived.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, "hex"),
  );

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function main() {
  if (!existsSync(keystorePath)) {
    console.error(
      `no keystore at ${path.relative(repoRoot, keystorePath)}\n` +
        `generate one first: npm run relayer:key`,
    );
    process.exitCode = 1;
    return;
  }

  const secret = passphrase();
  if (!secret) {
    console.error("KEYSTORE_PASSPHRASE not found in infra/relayer/.env or the environment");
    process.exitCode = 1;
    return;
  }

  const keystore = JSON.parse(readFileSync(keystorePath, "utf8"));

  let privateKey;
  try {
    privateKey = decrypt(keystore, secret);
  } catch (error) {
    console.error(`could not open the keystore: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const account = privateKeyToAccount(`0x${privateKey.toString("hex")}`);
  // Overwrite the buffer rather than waiting for the collector.
  privateKey.fill(0);

  console.log(account.address);
  console.error(`  keystore: ${path.relative(repoRoot, keystorePath)}`);
  console.error(`  id:       ${keystore.id}`);
  console.error(
    `  checksum: ${createHash("sha256").update(readFileSync(keystorePath)).digest("hex").slice(0, 16)}`,
  );
}

main();
