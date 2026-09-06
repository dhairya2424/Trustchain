/**
 * Explicit response projection.
 *
 * Every field a client receives is listed here by hand. Nothing spreads a database row
 * or a domain object into a response, because that is how an internal column becomes a
 * public field the moment someone adds one — silently, with no code change at the API
 * boundary and nothing in review to notice.
 *
 * These functions are the API's contract. If a field is not written below, it does not
 * leave the server.
 */

export interface AssetRecord {
  tokenId: number;
  ownerDid: string;
  ownerAddress: string;
  tokenUri: string;
  gatewayUrl: string;
  soulbound: boolean;
  mintedAt: string;
  // Internal-only fields below. Present on the record, never on the wire.
  internalStoragePath?: string;
  uploaderIp?: string;
  scanSignature?: string | null;
  pinataJobId?: string;
}

export interface AssetDto {
  tokenId: number;
  ownerDid: string;
  ownerAddress: string;
  tokenUri: string;
  gatewayUrl: string;
  soulbound: boolean;
  mintedAt: string;
}

export function toAssetDto(record: AssetRecord): AssetDto {
  return {
    tokenId: record.tokenId,
    ownerDid: record.ownerDid,
    ownerAddress: record.ownerAddress,
    tokenUri: record.tokenUri,
    gatewayUrl: record.gatewayUrl,
    soulbound: record.soulbound,
    mintedAt: record.mintedAt,
  };
}

export interface ProfileRecord {
  didHash: string;
  address: string;
  displayName: string | null;
  bio: string | null;
  avatarUri: string | null;
  role: string | null;
  isPublic: boolean;
  emailEncrypted?: Buffer | null;
  kycRefEncrypted?: Buffer | null;
  email?: string | null;
  kycRef?: string | null;
}

export interface PublicProfileDto {
  didHash: string;
  address: string;
  displayName: string | null;
  bio: string | null;
  avatarUri: string | null;
  role: string | null;
}

/**
 * The profile shape any authenticated caller may see.
 *
 * Note what is not here: email, kycRef, and their encrypted columns. Decrypted personal
 * data is returned only by {@link toOwnProfileDto}, and only to the subject themselves.
 */
export function toPublicProfileDto(record: ProfileRecord): PublicProfileDto {
  return {
    didHash: record.didHash,
    address: record.address,
    displayName: record.displayName,
    bio: record.bio,
    avatarUri: record.avatarUri,
    role: record.role,
  };
}

export interface OwnProfileDto extends PublicProfileDto {
  email: string | null;
  kycRef: string | null;
}

/** Only ever returned to the subject of the profile. */
export function toOwnProfileDto(record: ProfileRecord): OwnProfileDto {
  return {
    ...toPublicProfileDto(record),
    email: record.email ?? null,
    kycRef: record.kycRef ?? null,
  };
}

export interface ProvenanceEvent {
  type: "mint" | "transfer" | "reclaim";
  fromDid: string | null;
  toDid: string;
  fromAddress: string | null;
  toAddress: string;
  blockNumber: number;
  transactionHash: string;
  occurredAt: string;
}

export interface ProvenanceDto {
  tokenId: number;
  currentOwnerDid: string;
  verified: boolean;
  timeline: ProvenanceEvent[];
}
