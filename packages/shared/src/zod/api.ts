import { z } from "zod";
import {
  bytes32,
  evmAddress,
  hexSignature,
  ipfsUri,
  longText,
  nonZeroBytes32,
  pagination,
  revocationReason,
  shortText,
  unixSeconds,
} from "./primitives";

/**
 * Request DTOs.
 *
 * Every schema is `.strict()`, so an unexpected property is a 400 rather than a silently
 * ignored field. That is what turns mass assignment from "hopefully filtered somewhere"
 * into a rejection at the edge.
 */

export const authVerifyRequest = z
  .object({
    message: z.string().min(1).max(4096),
    signature: hexSignature,
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const registerDidRequest = z
  .object({
    didHash: nonZeroBytes32,
    keyCommitment: nonZeroBytes32,
    controller: evmAddress.optional(),
  })
  .strict();

export const mintAssetRequest = z
  .object({
    toDID: nonZeroBytes32,
    tokenURI: ipfsUri,
    soulbound: z.boolean().default(false),
  })
  .strict();

export const transferAssetRequest = z
  .object({
    tokenId: z.coerce.number().int().positive(),
    toDID: nonZeroBytes32,
  })
  .strict();

/**
 * Low-level anchor request: the caller has already built and hashed a credential.
 *
 * Retained for the case where a credential is minted by another issuer implementation and
 * only needs anchoring. The API's own issuance endpoint uses
 * {@link issueCredentialPayloadRequest}, which builds the credential itself so the hash
 * and the document cannot disagree.
 */
export const issueCredentialRequest = z
  .object({
    credentialHash: nonZeroBytes32,
    didHash: nonZeroBytes32,
    schemaId: nonZeroBytes32,
    expiresAt: unixSeconds.default(0),
  })
  .strict();

/**
 * Claims carried by a credential.
 *
 * Flat scalars only, and bounded in both key count and value length. A credential is
 * signed, pinned and effectively permanent, so an unbounded claim bag is a permanent
 * unbounded claim bag. `id` is refused because the subject identifier is derived from the
 * DID — accepting one would let an issuer point a credential at a subject other than the
 * one it was authorised for.
 */
export const credentialClaims = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(512), z.number().finite(), z.boolean()]),
  )
  .refine((claims) => Object.keys(claims).length <= 32, "a credential may carry at most 32 claims")
  .refine((claims) => !("id" in claims), "`id` is derived from the subject DID and may not be set");

export const issueCredentialPayloadRequest = z
  .object({
    didHash: nonZeroBytes32,
    credentialType: z
      .string()
      .trim()
      .min(1)
      .max(64)
      // A type name becomes a JSON-LD type and an on-chain schema id, so it is restricted
      // to an identifier shape rather than free text.
      .regex(
        /^[A-Za-z][A-Za-z0-9]*$/,
        "must be an alphanumeric type name, e.g. EmploymentCredential",
      ),
    claims: credentialClaims,
    expiresAt: unixSeconds.default(0),
  })
  .strict();

export const revokeCredentialRequest = z
  .object({
    credentialHash: nonZeroBytes32,
    reasonCode: revocationReason,
  })
  .strict();

/**
 * Verification accepts either the credential itself or just its hash.
 *
 * Presenting the JWT proves the holder actually has the document and lets the API check
 * the signature as well as the chain. Presenting only the hash still answers the
 * revocation question, which is what a verifier needs when they have already validated
 * the signature themselves. Exactly one must be supplied.
 */
export const verifyCredentialRequest = z
  .object({
    credentialHash: nonZeroBytes32.optional(),
    jwt: z.string().min(16).max(8192).optional(),
  })
  .strict()
  .refine(
    (body) => Boolean(body.credentialHash) !== Boolean(body.jwt),
    "supply exactly one of `credentialHash` or `jwt`",
  );

/**
 * The only fields a user may change about themselves.
 *
 * Note what is absent: role, did, address. Those are on-chain facts, and a PATCH body is
 * not how they change. See {@link profileMutableFields} — the allowlist is derived from
 * this schema rather than written twice, so the two cannot drift apart.
 */
export const updateProfileRequest = z
  .object({
    displayName: shortText.optional(),
    bio: longText.optional(),
    avatarUri: ipfsUri.optional(),
  })
  .strict();

/** Single source of truth for the mass-assignment allowlist. */
export const profileMutableFields = Object.keys(updateProfileRequest.shape) as ReadonlyArray<
  keyof z.infer<typeof updateProfileRequest>
>;

export const auditQuery = pagination
  .extend({
    actor: evmAddress.optional(),
    didHash: bytes32.optional(),
    actionCode: z.coerce.number().int().min(1).max(255).optional(),
    /**
     * Action filter by name, e.g. `CREDENTIAL_REVOKED`.
     *
     * A readable alternative to `actionCode` — a dashboard link should not have to encode
     * the numeric constant. Bounded to an identifier shape so it cannot carry anything but
     * a name; the API resolves it to a code and rejects one it does not recognise.
     */
    action: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must be an action name, e.g. CREDENTIAL_ISSUED")
      .optional(),
    from: unixSeconds.optional(),
    to: unixSeconds.optional(),
  })
  .strict()
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

export type AuthVerifyRequest = z.infer<typeof authVerifyRequest>;
export type RegisterDidRequest = z.infer<typeof registerDidRequest>;
export type MintAssetRequest = z.infer<typeof mintAssetRequest>;
export type TransferAssetRequest = z.infer<typeof transferAssetRequest>;
export type IssueCredentialRequest = z.infer<typeof issueCredentialRequest>;
export type IssueCredentialPayloadRequest = z.infer<typeof issueCredentialPayloadRequest>;
export type CredentialClaims = z.infer<typeof credentialClaims>;
export type RevokeCredentialRequest = z.infer<typeof revokeCredentialRequest>;
export type VerifyCredentialRequest = z.infer<typeof verifyCredentialRequest>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequest>;
export type AuditQuery = z.infer<typeof auditQuery>;
