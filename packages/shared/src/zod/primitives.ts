import { z } from "zod";

/**
 * Shared value types.
 *
 * Defined once and imported by both the API and the frontend so a field cannot be
 * validated strictly on one side and loosely on the other — a drift that produces
 * exactly the requests nobody wrote a test for.
 */

/** 0x-prefixed 20-byte address. Normalised to lowercase so comparisons are total. */
export const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** 0x-prefixed 32-byte hash: DID hashes, credential hashes, role identifiers. */
export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hash")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** A 32-byte hash that must not be the zero value. */
export const nonZeroBytes32 = bytes32.refine(
  (value) => value !== `0x${"0".repeat(64)}`,
  "must not be the zero hash",
);

export const hexSignature = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "must be 0x-prefixed hex")
  .max(1024, "signature is implausibly long");

/**
 * IPFS URI for asset metadata.
 *
 * Restricted to ipfs:// on purpose. Accepting arbitrary https URIs would let an issuer
 * point an asset at content they can silently change later, which defeats the point of
 * anchoring it on-chain.
 */
export const ipfsUri = z
  .string()
  .regex(/^ipfs:\/\/[A-Za-z0-9]{46,}(\/[\w.-]+)*$/, "must be an ipfs:// URI with a valid CID")
  .max(512);

/** Unix seconds. 0 means "never expires" wherever an expiry is optional. */
export const unixSeconds = z.coerce.number().int().nonnegative().max(4_102_444_800); // year 2100

export const revocationReason = z.coerce
  .number()
  .int()
  .min(1, "a revocation must carry a non-zero reason code")
  .max(65_535);

/** Cursor pagination. Offsets drift when rows are inserted mid-scan; cursors do not. */
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(256).optional(),
});

export const isoDateTime = z.string().datetime({ offset: true });

/** Free text that will be rendered. Bounded so a body cannot be used as a memory bomb. */
export const shortText = z.string().trim().min(1).max(200);
export const longText = z.string().trim().max(2000);
