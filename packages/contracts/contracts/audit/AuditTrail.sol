// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAuditTrail} from "../interfaces/IAuditTrail.sol";
import {IRoleAccessControl} from "../interfaces/IRoleAccessControl.sol";
import {TrustChainRoles} from "../libraries/TrustChainRoles.sol";

/**
 * @title AuditTrail
 * @notice Append-only ledger of every critical platform action.
 *
 * @dev Two design decisions carry the tamper-proofing, and both are deliberate:
 *
 *      1. There is NO update and NO delete function. Not restricted ones — absent
 *         ones. Entries are pushed and never touched again, so there is no code path
 *         to audit, gate, or get wrong.
 *
 *      2. This contract is NOT upgradeable, unlike its siblings. An append-only log
 *         whose implementation can be swapped is not append-only: whoever controls
 *         the upgrade controls history. Immutability is the entire product here, so
 *         it is bought at the cost of upgradeability rather than the other way round.
 *
 *      Writes are restricted to sibling system contracts through an allowlist, so a
 *      user cannot forge entries. The allowlist itself is ADMIN-managed and every
 *      change emits an event, which keeps the trust boundary auditable too.
 *
 *      Entries hold hashes and codes only — never PII.
 */
contract AuditTrail is IAuditTrail {
    struct Entry {
        bytes32 didHash;
        bytes32 refHash;
        address caller;
        uint8 actionCode;
        uint64 timestamp;
        uint64 blockNumber;
    }

    IRoleAccessControl public immutable ACCESS_CONTROL;

    Entry[] private _entries;
    mapping(address caller => bool trusted) private _trustedCallers;

    event ActionLogged(
        uint256 indexed entryId,
        bytes32 indexed didHash,
        uint8 indexed actionCode,
        bytes32 refHash,
        address caller,
        uint64 timestamp
    );
    event TrustedCallerUpdated(address indexed caller, bool trusted, address indexed updatedBy);

    error ZeroAddress();
    error NotAdmin(address caller);
    error NotTrustedCaller(address caller);
    error IndexOutOfBounds(uint256 index, uint256 length);
    error InvalidRange(uint256 start, uint256 length);

    constructor(address accessControl_) {
        if (accessControl_ == address(0)) revert ZeroAddress();
        ACCESS_CONTROL = IRoleAccessControl(accessControl_);
    }

    modifier onlyAdmin() {
        if (!ACCESS_CONTROL.hasRole(TrustChainRoles.ADMIN_ROLE, msg.sender)) {
            revert NotAdmin(msg.sender);
        }
        _;
    }

    /// @notice Allow or disallow a sibling contract to append entries.
    function setTrustedCaller(address caller, bool trusted) external onlyAdmin {
        if (caller == address(0)) revert ZeroAddress();

        _trustedCallers[caller] = trusted;
        emit TrustedCallerUpdated(caller, trusted, msg.sender);
    }

    /// @inheritdoc IAuditTrail
    function logAction(
        bytes32 didHash,
        uint8 actionCode,
        bytes32 refHash
    ) external returns (uint256 entryId) {
        if (!_trustedCallers[msg.sender]) revert NotTrustedCaller(msg.sender);

        entryId = _entries.length;

        _entries.push(
            Entry({
                didHash: didHash,
                refHash: refHash,
                caller: msg.sender,
                actionCode: actionCode,
                timestamp: uint64(block.timestamp),
                blockNumber: uint64(block.number)
            })
        );

        emit ActionLogged(entryId, didHash, actionCode, refHash, msg.sender, uint64(block.timestamp));
    }

    /// @inheritdoc IAuditTrail
    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function entryAt(uint256 index) external view returns (Entry memory) {
        if (index >= _entries.length) revert IndexOutOfBounds(index, _entries.length);
        return _entries[index];
    }

    /// @notice Paginated read for the audit dashboard and for indexer backfill.
    function entriesInRange(uint256 start, uint256 count) external view returns (Entry[] memory page) {
        uint256 total = _entries.length;
        if (start > total) revert InvalidRange(start, total);

        uint256 end = start + count;
        if (end > total) end = total;

        page = new Entry[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = _entries[i];
        }
    }

    /// @inheritdoc IAuditTrail
    function isTrustedCaller(address caller) external view returns (bool) {
        return _trustedCallers[caller];
    }
}
