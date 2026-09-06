// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Stateful invariant suite for AuditTrail.
//
//   npm run test:foundry
//
// The fuzzer drives AuditTrailHandler through random call sequences; the invariant_*
// functions must hold after every sequence. This is the property the plan asks for:
// the audit count is monotonically increasing.

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {AuditTrail} from "../../contracts/audit/AuditTrail.sol";
import {RoleAccessControl} from "../../contracts/access/RoleAccessControl.sol";
import {TrustChainRoles} from "../../contracts/libraries/TrustChainRoles.sol";

/// @dev Not on the allowlist. Every write it attempts must be refused.
contract UntrustedWriter {
    AuditTrail private immutable TRAIL;

    constructor(AuditTrail trail) {
        TRAIL = trail;
    }

    function log(bytes32 didHash, uint8 actionCode, bytes32 refHash) external {
        TRAIL.logAction(didHash, actionCode, refHash);
    }
}

/// @dev The only contract the fuzzer calls directly.
contract AuditTrailHandler {
    AuditTrail public immutable TRAIL;
    UntrustedWriter public immutable IMPOSTOR;

    uint256 public successfulLogs;
    uint256 public refusedWrites;
    bool public untrustedWriteEverSucceeded;

    constructor(AuditTrail trail, UntrustedWriter impostor) {
        TRAIL = trail;
        IMPOSTOR = impostor;
    }

    /// @dev This handler IS allowlisted, so these writes are expected to succeed.
    function log(bytes32 didHash, uint8 actionCode, bytes32 refHash) external {
        TRAIL.logAction(didHash, actionCode, refHash);
        successfulLogs += 1;
    }

    /// @dev Writes routed through a contract that is not allowlisted.
    function logViaUntrusted(bytes32 didHash, uint8 actionCode, bytes32 refHash) external {
        try IMPOSTOR.log(didHash, actionCode, refHash) {
            untrustedWriteEverSucceeded = true;
        } catch {
            refusedWrites += 1;
        }
    }

    /// @dev Reads must never disturb the ledger.
    function readBack(uint256 seed) external view {
        uint256 count = TRAIL.entryCount();
        if (count == 0) return;
        TRAIL.entryAt(seed % count);
    }
}

contract AuditTrailInvariantTest is Test {
    AuditTrail private trail;
    AuditTrailHandler private handler;

    address private constant OWNER = address(0xA11CE);

    uint256 private lastObservedCount;
    bytes32 private firstEntryFingerprint;
    bool private firstEntryCaptured;

    function setUp() public {
        RoleAccessControl acl = RoleAccessControl(
            address(
                new ERC1967Proxy(
                    address(new RoleAccessControl()),
                    abi.encodeCall(RoleAccessControl.initialize, (OWNER, 3 days))
                )
            )
        );

        trail = new AuditTrail(address(acl));

        UntrustedWriter impostor = new UntrustedWriter(trail);
        handler = new AuditTrailHandler(trail, impostor);

        vm.prank(OWNER);
        trail.setTrustedCaller(address(handler), true);

        // Confine the fuzzer to the handler; nothing else is a valid entry point.
        targetContract(address(handler));
    }

    /// @notice THE property: the entry count never decreases, over any call sequence.
    function invariant_CountIsMonotonicallyIncreasing() public {
        uint256 current = trail.entryCount();

        assertGe(current, lastObservedCount, "audit count decreased");
        lastObservedCount = current;
    }

    /// @notice Every recorded entry corresponds to an accepted write — no phantoms.
    function invariant_CountEqualsAcceptedWrites() public view {
        assertEq(trail.entryCount(), handler.successfulLogs());
    }

    /// @notice The allowlist holds: an un-allowlisted contract never writes.
    function invariant_UntrustedWritesAlwaysRefused() public view {
        assertFalse(handler.untrustedWriteEverSucceeded());
    }

    /// @notice Entry 0, once written, is never altered by any later activity.
    function invariant_ExistingEntriesAreImmutable() public {
        if (trail.entryCount() == 0) return;

        AuditTrail.Entry memory entry = trail.entryAt(0);
        bytes32 fingerprint = keccak256(
            abi.encode(
                entry.didHash,
                entry.refHash,
                entry.caller,
                entry.actionCode,
                entry.timestamp,
                entry.blockNumber
            )
        );

        if (!firstEntryCaptured) {
            firstEntryFingerprint = fingerprint;
            firstEntryCaptured = true;
            return;
        }

        assertEq(fingerprint, firstEntryFingerprint, "an existing audit entry changed");
    }
}
