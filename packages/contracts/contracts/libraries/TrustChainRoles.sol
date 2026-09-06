// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @dev Role identifiers, fixed by the problem statement.
 *
 * ADMIN   defines roles, assigns access rights, governs the platform
 * MANAGER creates (mints) NFTs and allocates them to identities
 * AUDITOR read-only verification of ownership, authenticity and access history
 * USER    holds a DID, owns NFT assets, authenticates with cryptographic proofs
 */
library TrustChainRoles {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 internal constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 internal constant USER_ROLE = keccak256("USER_ROLE");
}
