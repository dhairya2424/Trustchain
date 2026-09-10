import { z } from "zod";

/**
 * What every response is allowed to contain, so nothing internal leaks by accident.
 *
 * This is the "trim API responses" contract. A handler that assembles a DTO from a richer
 * internal record — a database row, a chain read, a token payload — can spread one field too
 * many and quietly ship an internal value to the client. The response-validation middleware
 * (see responseValidation.ts) enforces the shapes here in development and test, and throws
 * when a response carries a field the contract does not name.
 *
 * ## Strict on keys, deliberately loose on values
 *
 * Each contract is an **allowlist of field names**, not a re-statement of every value's type.
 * The objects are `.strict()`, so an unexpected *key* throws — which is exactly the property
 * asked for ("throws on extra fields"). The values are typed loosely (mostly `unknown`),
 * because the value types are already guaranteed by the serializers that produce them, and a
 * too-tight value type here would break a correct response in development for no security
 * gain. The contract exists to catch a leaked field, not to re-validate a block number.
 *
 * ## Why only some endpoints have a strict contract
 *
 * The strict contracts cover the read endpoints whose body is assembled from an internal
 * record — the ones where an extra field is a realistic leak. The prepare/verify/forward
 * endpoints return signing payloads whose shape varies by outcome; pinning them to a strict
 * object would be brittle without adding leak protection those payloads do not need. Every
 * response, contracted or not, is still held to the forbidden-key denylist below.
 */

/** A strict object whose values are accepted as-is. The key set is the contract. */
function dto<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

const any = z.unknown();

/** The network DTO as `toNetworkDto` emits it, plus the fields the resolver adds inline. */
const networkShape = {
  id: any,
  label: any,
  chainId: any,
  explorerUrl: any,
  verifiability: any,
  verifiabilityLabel: any.optional(),
  isPrimary: any.optional(),
  isFallback: any.optional(),
};

export interface ResponseContract {
  method: string;
  /** Matched against `req.path` (the path after any mount prefix is already resolved). */
  pattern: RegExp;
  name: string;
  schema: z.ZodTypeAny;
}

/**
 * The strict contracts, most specific first. `req.path` on the mounted app is the full path
 * (e.g. `/auth/session`), so the patterns are anchored to that.
 */
export const RESPONSE_CONTRACTS: ResponseContract[] = [
  {
    method: "GET",
    pattern: /^\/auth\/nonce$/,
    name: "auth.nonce",
    schema: dto({ nonce: any, expiresAt: any }),
  },
  {
    method: "GET",
    pattern: /^\/auth\/session$/,
    name: "auth.session",
    // The session boundary: an address, a DID or null, and role *names*. The token carries
    // more (issuer, audience, raw role ids); none of it may cross into the body.
    schema: dto({ address: any, did: any, roles: any }),
  },
  {
    method: "GET",
    pattern: /^\/assets\/owned$/,
    name: "assets.owned",
    schema: dto({
      owner: any,
      balance: any,
      tokens: z.array(dto({ tokenId: any, tokenURI: any, ownerDidHash: any, soulbound: any })),
      truncated: any,
      totalMinted: any,
      network: any,
      explorerUrl: any,
      assetRegistry: any,
    }),
  },
  {
    method: "GET",
    pattern: /^\/audit$/,
    name: "audit.page",
    schema: dto({
      entries: z.array(
        dto({
          entryId: any,
          action: any,
          actionCode: any,
          actor: any,
          executor: any,
          didHash: any,
          refHash: any,
          via: any,
          blockNumber: any,
          transactionHash: any,
          occurredAt: any,
        }),
      ),
      nextCursor: any,
      source: any,
    }),
  },
  {
    method: "GET",
    // The public DID resolver, e.g. /identity/0x<64 hex>.
    pattern: /^\/identity\/0x[0-9a-fA-F]+$/,
    name: "identity.resolve",
    schema: dto({
      didHash: any,
      registered: any,
      controller: any,
      active: any,
      roles: any,
      assets: z.union([dto({ balance: any, tokenIds: any }), z.null()]),
      network: dto(networkShape),
    }),
  },
];

/**
 * Field names that must never appear anywhere in a response body, at any depth.
 *
 * The floor beneath the strict contracts: even an endpoint with no contract of its own is
 * held to this. These are the names of things that live server-side only — private keys,
 * password material, database internals, raw session secrets. If one ever surfaces in a
 * response it is a leak regardless of which endpoint produced it.
 *
 * Keys are normalised (lower-cased, `_`/`-` stripped) before matching, so `jwtPrivateKey`,
 * `refresh_token_secret` and `db-password` all reduce to a form these entries catch.
 *
 * ## Two lists, because substring matching is a trap for short names
 *
 * The distinctive compounds below match as **substrings** — that is the point, so a field
 * named `refreshTokenSecret` is caught by `secret`. But a two- or three-letter name matched
 * as a substring is a disaster: `iv` (an encryption initialisation vector) as a substring
 * flags `active`, `derivative`, `receiver`. Those short, real field names are matched
 * **exactly** instead, so `iv` catches a field literally called `iv` and nothing else.
 */
export const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = [
  "password",
  "passwordhash",
  "privatekey",
  "secret",
  "mnemonic",
  "seedphrase",
  "apikey",
  "pinatajwt",
  "encryptionkey",
  "fieldencryptionkey",
  "postgrespassword",
  "keycommitment", // a commitment is a hash, but the raw key material must never ride along
  "ciphertext",
  "authtag",
];

/**
 * Short, ambiguous names matched exactly — never as a substring.
 *
 * `nonce` is deliberately absent: the SIWE nonce is the public payload of `/auth/nonce`,
 * handed to the client precisely so it can be signed. A cryptographic IV or salt, by
 * contrast, has no business in any response.
 */
export const FORBIDDEN_KEY_EXACT: readonly string[] = ["iv", "salt", "seed"];

/**
 * The error envelope. Every non-2xx JSON response is one of these shapes; the middleware
 * checks errors against this so an error path cannot leak an internal field either.
 *
 * Loose on values, strict on the key set — the union of every field the error responses in
 * this codebase actually use.
 */
export const ERROR_ENVELOPE = dto({
  error: any,
  requestId: any.optional(),
  issues: any.optional(),
  reason: any.optional(),
  retryAfterSeconds: any.optional(),
  didHash: any.optional(),
  controller: any.optional(),
});
