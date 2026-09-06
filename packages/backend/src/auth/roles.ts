import { keccak256, toBytes } from "viem";

/**
 * Role and permission identifiers, mirrored from the contract libraries.
 *
 * The contracts declare these as `keccak256("ADMIN_ROLE")` and so on. Rather than
 * hard-coding the resulting hashes — which would be 32 bytes of unreviewable hex that
 * nobody could check against the Solidity by eye — they are derived here from the same
 * strings. A test asserts the derived values against the compiled contract artifacts, so
 * a rename on either side fails the build instead of silently un-gating a route.
 *
 * The role set is fixed at four by the problem statement:
 *
 *   ADMIN    governs the platform, defines roles, assigns access rights
 *   MANAGER  mints assets and issues credentials
 *   AUDITOR  read-only verification of ownership, authenticity and history
 *   USER     holds a DID, owns assets, authenticates with cryptographic proofs
 *
 * There is deliberately no ISSUER or VERIFIER role. Some planning documents use those
 * names; the chain does not implement them, and a middleware that gated on a role
 * `rolesOf` can never return would be a permanently closed door rather than a control.
 * Issuing is MANAGER (it needs PERM_ISSUE_CREDENTIAL) and verification needs no role at
 * all, because a credential must be checkable by a stranger.
 */

export const ROLE_NAMES = ["ADMIN", "MANAGER", "AUDITOR", "USER"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

const hash = (label: string): `0x${string}` => keccak256(toBytes(label));

export const ROLE_IDS: Readonly<Record<RoleName, `0x${string}`>> = Object.freeze({
  ADMIN: hash("ADMIN_ROLE"),
  MANAGER: hash("MANAGER_ROLE"),
  AUDITOR: hash("AUDITOR_ROLE"),
  USER: hash("USER_ROLE"),
});

export const PERMISSION_NAMES = [
  "REGISTER_DID",
  "MINT_ASSET",
  "ASSIGN_ASSET",
  "ISSUE_CREDENTIAL",
  "REVOKE_CREDENTIAL",
  "MANAGE_ROLES",
  "VIEW_AUDIT",
] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const PERMISSION_IDS: Readonly<Record<PermissionName, `0x${string}`>> = Object.freeze({
  REGISTER_DID: hash("PERM_REGISTER_DID"),
  MINT_ASSET: hash("PERM_MINT_ASSET"),
  ASSIGN_ASSET: hash("PERM_ASSIGN_ASSET"),
  ISSUE_CREDENTIAL: hash("PERM_ISSUE_CREDENTIAL"),
  REVOKE_CREDENTIAL: hash("PERM_REVOKE_CREDENTIAL"),
  MANAGE_ROLES: hash("PERM_MANAGE_ROLES"),
  VIEW_AUDIT: hash("PERM_VIEW_AUDIT"),
});

/** Reverse lookup, so a log line can say "MANAGER" instead of 32 bytes of hex. */
const ID_TO_ROLE = new Map<string, RoleName>(
  ROLE_NAMES.map((name) => [ROLE_IDS[name].toLowerCase(), name]),
);

export function roleNameOf(roleId: string): RoleName | null {
  return ID_TO_ROLE.get(roleId.toLowerCase()) ?? null;
}

/** Maps a set of on-chain role ids to readable names, dropping any that are unknown. */
export function roleNames(roleIds: readonly string[]): RoleName[] {
  const names: RoleName[] = [];
  for (const id of roleIds) {
    const name = roleNameOf(id);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function hasRole(roleIds: readonly string[], role: RoleName): boolean {
  const target = ROLE_IDS[role].toLowerCase();
  return roleIds.some((id) => id.toLowerCase() === target);
}

export function hasAnyRole(roleIds: readonly string[], roles: readonly RoleName[]): boolean {
  return roles.some((role) => hasRole(roleIds, role));
}
