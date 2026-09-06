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

export const issueCredentialRequest = z
  .object({
    credentialHash: nonZeroBytes32,
    didHash: nonZeroBytes32,
    schemaId: nonZeroBytes32,
    expiresAt: unixSeconds.default(0),
  })
  .strict();

export const revokeCredentialRequest = z
  .object({
    credentialHash: nonZeroBytes32,
    reasonCode: revocationReason,
  })
  .strict();

export const verifyCredentialRequest = z.object({ credentialHash: nonZeroBytes32 }).strict();

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
export type RevokeCredentialRequest = z.infer<typeof revokeCredentialRequest>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequest>;
export type AuditQuery = z.infer<typeof auditQuery>;
