// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @dev Fine-grained access rights an ADMIN attaches to a role.
 *
 * Roles say who someone is; permissions say what that role may do. Keeping them
 * separate is what lets an ADMIN re-scope a role at runtime — "assign specific
 * access rights to each identity" — without deploying new code.
 */
library Permissions {
    bytes32 internal constant REGISTER_DID = keccak256("PERM_REGISTER_DID");
    bytes32 internal constant MINT_ASSET = keccak256("PERM_MINT_ASSET");
    bytes32 internal constant ASSIGN_ASSET = keccak256("PERM_ASSIGN_ASSET");
    bytes32 internal constant ISSUE_CREDENTIAL = keccak256("PERM_ISSUE_CREDENTIAL");
    bytes32 internal constant REVOKE_CREDENTIAL = keccak256("PERM_REVOKE_CREDENTIAL");
    bytes32 internal constant MANAGE_ROLES = keccak256("PERM_MANAGE_ROLES");
    bytes32 internal constant VIEW_AUDIT = keccak256("PERM_VIEW_AUDIT");
}
