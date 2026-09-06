import { generateSiweNonce } from "viem/siwe";
import type { KeyValueStore } from "../store/kv";

const KEY_PREFIX = "siwe:nonce:";

export interface IssuedNonce {
  nonce: string;
  expiresAt: string;
}

/**
 * Single-use SIWE nonces.
 *
 * The nonce is what makes a captured login message worthless: the signature stays
 * cryptographically valid forever, so replay protection has to come from the server
 * refusing to accept the same nonce twice. {@link consume} therefore deletes
 * atomically — a read-then-delete would let two concurrent requests both pass.
 */
export class NonceService {
  constructor(
    private readonly store: KeyValueStore,
    private readonly ttlSeconds: number,
  ) {}

  async issue(): Promise<IssuedNonce> {
    // viem's generateSiweNonce uses crypto-grade randomness and the EIP-4361 alphabet.
    const nonce = generateSiweNonce();

    await this.store.set(`${KEY_PREFIX}${nonce}`, "1", this.ttlSeconds);

    return {
      nonce,
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString(),
    };
  }

  /** True only the first time a given nonce is presented, and only before it expires. */
  async consume(nonce: string): Promise<boolean> {
    if (!nonce) return false;
    return (await this.store.take(`${KEY_PREFIX}${nonce}`)) !== null;
  }
}
