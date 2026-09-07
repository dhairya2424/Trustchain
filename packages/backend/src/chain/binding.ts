import type { TransactionRelayer } from "../assets/relayer";
import type { CredentialRelayer } from "../credentials/registry";
import type { NetworkDescriptor } from "./networks";

/**
 * A relayer together with the network it submits to.
 *
 * The two travel as one object on purpose. The requirement is that the system must never
 * report a transaction as written to Amoy when it actually executed locally, and the way
 * to make that true structurally — rather than by remembering to keep two variables in
 * step — is to make it impossible to obtain one without the other.
 *
 * Routes therefore resolve a binding, submit through `binding.relayer`, and label the
 * response from `binding.network`. There is no code path that can label a response with a
 * network it did not submit through, because there is no second source for either.
 */
export interface ChainBinding {
  network: NetworkDescriptor;
  relayer: TransactionRelayer & CredentialRelayer;
}

/**
 * Supplies the current binding.
 *
 * Asynchronous because selection involves probing a chain, and resolved per request rather
 * than once at boot: the whole point of the fallback design is that Amoy becomes usable the
 * moment its signer is funded, without a restart. The selector caches, so this is cheap.
 */
export interface ChainResolver {
  active(): Promise<ChainBinding>;
}

/** A fixed binding, for tests and for any caller that already knows its network. */
export function staticResolver(binding: ChainBinding): ChainResolver {
  return { active: async () => binding };
}
