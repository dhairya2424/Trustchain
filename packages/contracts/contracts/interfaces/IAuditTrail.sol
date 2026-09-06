// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Append-only ledger of every critical platform action.
interface IAuditTrail {
    /**
     * @param didHash    identity the action relates to, or bytes32(0) when not identity-scoped
     * @param actionCode see {ActionCodes}
     * @param refHash    opaque reference (token id, credential hash, role, ...) — never PII
     * @return entryId   index of the recorded entry; strictly increasing
     */
    function logAction(bytes32 didHash, uint8 actionCode, bytes32 refHash) external returns (uint256 entryId);

    function entryCount() external view returns (uint256);

    function isTrustedCaller(address caller) external view returns (bool);
}
