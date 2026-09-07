// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Append-only ledger of every critical platform action.
interface IAuditTrail {
    /**
     * @param didHash    identity the action relates to, or bytes32(0) when not identity-scoped
     * @param actionCode see {ActionCodes}
     * @param refHash    opaque reference (token id, credential hash, role, ...) — never PII
     * @param actor      the identity that REQUESTED the action
     * @return entryId   index of the recorded entry; strictly increasing
     *
     * @dev `actor` is the account the calling contract resolved through {_msgSender}, which
     *      under ERC-2771 is the address that signed the meta-transaction request — not the
     *      relayer that submitted it. Recording it is what makes the trail answer "who asked
     *      for this?" rather than only "which contract wrote the row?".
     *
     *      The relayer that executed the transaction is deliberately NOT a parameter. It is
     *      already the transaction's sender, recorded by the chain itself and readable from
     *      the transaction record — putting it in calldata as well would let a caller state
     *      an executor that differs from the one that actually signed.
     */
    function logAction(
        bytes32 didHash,
        uint8 actionCode,
        bytes32 refHash,
        address actor
    ) external returns (uint256 entryId);

    function entryCount() external view returns (uint256);

    function isTrustedCaller(address caller) external view returns (bool);
}
