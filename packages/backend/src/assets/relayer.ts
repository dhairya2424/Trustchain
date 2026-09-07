/**
 * The asset-side of the transaction relaying boundary.
 *
 * This file holds the interface and nothing else. The concrete client lives in
 * `src/chain/relayerClient.ts`, and the routes depend only on what is declared here — so
 * changing how transactions are signed and submitted does not reach the business logic.
 * That separation is what makes a signer migration (local keystore today, AWS KMS later)
 * a configuration change rather than a code change.
 */

export interface MintRequest {
  toDID: string;
  tokenURI: string;
  soulbound: boolean;
}

export interface RelayedTransaction {
  /** Identifier assigned by the relayer, for status polling. */
  transactionId: string;
  /** Chain transaction hash, once the relayer has one. */
  hash?: string;
  status: "pending" | "mined" | "failed";
}

export interface TransactionRelayer {
  relayMint(request: MintRequest): Promise<RelayedTransaction>;
}

export class RelayerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}
