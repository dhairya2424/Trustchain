// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Foundry fuzz suite for CredentialRegistry. See DIDRegistry.t.sol for setup notes.
//
//   npm run test:foundry

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {CredentialRegistry} from "../../contracts/credentials/CredentialRegistry.sol";
import {DIDRegistry} from "../../contracts/identity/DIDRegistry.sol";
import {RoleAccessControl} from "../../contracts/access/RoleAccessControl.sol";
import {Permissions} from "../../contracts/libraries/Permissions.sol";
import {TrustChainRoles} from "../../contracts/libraries/TrustChainRoles.sol";

contract CredentialRegistryFuzzTest is Test {
    RoleAccessControl private acl;
    DIDRegistry private did;
    CredentialRegistry private credentials;

    address private constant OWNER = address(0xA11CE);
    address private constant MANAGER = address(0xF00D);
    address private constant ALICE = address(0xA1);

    bytes32 private constant ALICE_DID = keccak256("did:trustchain:alice");
    bytes32 private constant SCHEMA = keccak256("schema:kyc:v1");

    function setUp() public {
        acl = RoleAccessControl(
            address(
                new ERC1967Proxy(
                    address(new RoleAccessControl()),
                    abi.encodeCall(RoleAccessControl.initialize, (OWNER, 3 days))
                )
            )
        );

        did = DIDRegistry(
            address(
                new ERC1967Proxy(address(new DIDRegistry()), abi.encodeCall(DIDRegistry.initialize, (OWNER)))
            )
        );

        credentials = CredentialRegistry(
            address(
                new ERC1967Proxy(
                    address(new CredentialRegistry()),
                    abi.encodeCall(CredentialRegistry.initialize, (address(acl), address(did)))
                )
            )
        );

        vm.startPrank(OWNER);
        acl.grantRole(TrustChainRoles.MANAGER_ROLE, MANAGER);
        did.registerDIDFor(ALICE_DID, ALICE, keccak256("k"));
        vm.stopPrank();
    }

    /// @dev No account lacking ISSUE_CREDENTIAL may anchor a credential.
    function testFuzz_UnauthorizedIssueAlwaysReverts(address caller, bytes32 hash) public {
        vm.assume(caller != address(0) && caller.code.length == 0);
        vm.assume(caller != OWNER && caller != MANAGER);
        vm.assume(hash != bytes32(0));

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                CredentialRegistry.NotPermitted.selector,
                caller,
                Permissions.ISSUE_CREDENTIAL
            )
        );
        credentials.issue(hash, ALICE_DID, SCHEMA, 0);

        assertEq(uint256(credentials.statusOf(hash)), uint256(CredentialRegistry.CredentialStatus.Unknown));
    }

    /// @dev Any non-zero hash issues once and reports Valid; a second issue always fails.
    function testFuzz_IssueIsIdempotentlyRejectedOnRepeat(bytes32 hash) public {
        vm.assume(hash != bytes32(0));

        vm.startPrank(MANAGER);
        credentials.issue(hash, ALICE_DID, SCHEMA, 0);

        assertEq(uint256(credentials.statusOf(hash)), uint256(CredentialRegistry.CredentialStatus.Valid));

        vm.expectRevert(abi.encodeWithSelector(CredentialRegistry.CredentialAlreadyIssued.selector, hash));
        credentials.issue(hash, ALICE_DID, SCHEMA, 0);
        vm.stopPrank();
    }

    /// @dev Revocation preserves whatever non-zero reason code it was given.
    function testFuzz_RevocationPreservesReason(bytes32 hash, uint16 reason) public {
        vm.assume(hash != bytes32(0));
        reason = uint16(bound(uint256(reason), 1, type(uint16).max));

        vm.startPrank(MANAGER);
        credentials.issue(hash, ALICE_DID, SCHEMA, 0);
        credentials.revoke(hash, reason);
        vm.stopPrank();

        assertEq(uint256(credentials.statusOf(hash)), uint256(CredentialRegistry.CredentialStatus.Revoked));
        assertEq(credentials.credentialOf(hash).revocationReason, reason);
        assertFalse(credentials.isValid(hash));
    }

    /// @dev Reason code zero is never accepted, so every revocation is attributable.
    function testFuzz_ZeroReasonNeverAccepted(bytes32 hash) public {
        vm.assume(hash != bytes32(0));

        vm.startPrank(MANAGER);
        credentials.issue(hash, ALICE_DID, SCHEMA, 0);

        vm.expectRevert(CredentialRegistry.InvalidReasonCode.selector);
        credentials.revoke(hash, 0);
        vm.stopPrank();

        assertTrue(credentials.isValid(hash));
    }

    /// @dev A credential is Valid up to its deadline and Expired from it onwards.
    function testFuzz_ExpiryBoundary(bytes32 hash, uint32 lifetime) public {
        vm.assume(hash != bytes32(0));
        uint64 span = uint64(bound(uint256(lifetime), 1, 3650 days));
        uint64 expiresAt = uint64(block.timestamp) + span;

        vm.prank(MANAGER);
        credentials.issue(hash, ALICE_DID, SCHEMA, expiresAt);

        vm.warp(expiresAt - 1);
        assertTrue(credentials.isValid(hash));

        vm.warp(expiresAt);
        assertEq(uint256(credentials.statusOf(hash)), uint256(CredentialRegistry.CredentialStatus.Expired));
    }

    /// @dev Anything never issued reads as Unknown, for any caller.
    function testFuzz_UnissuedIsAlwaysUnknown(bytes32 hash, address reader) public view {
        vm.assume(hash != bytes32(0));
        vm.assume(reader != address(0));

        assertEq(uint256(credentials.statusOf(hash)), uint256(CredentialRegistry.CredentialStatus.Unknown));
        assertFalse(credentials.isValid(hash));
    }
}
