// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Foundry fuzz suite for RoleAccessControl. See DIDRegistry.t.sol for setup notes.
//
//   npm run test:foundry

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RoleAccessControl} from "../../contracts/access/RoleAccessControl.sol";
import {Permissions} from "../../contracts/libraries/Permissions.sol";
import {TrustChainRoles} from "../../contracts/libraries/TrustChainRoles.sol";

contract RoleAccessControlFuzzTest is Test {
    RoleAccessControl private acl;

    address private constant OWNER = address(0xA11CE);
    uint48 private constant DELAY = 3 days;

    bytes32 private constant DEFAULT_ADMIN_ROLE = 0x00;

    function setUp() public {
        RoleAccessControl implementation = new RoleAccessControl();
        bytes memory initData = abi.encodeCall(RoleAccessControl.initialize, (OWNER, DELAY));
        acl = RoleAccessControl(address(new ERC1967Proxy(address(implementation), initData)));
    }

    // -----------------------------------------------------------------
    // Authorisation
    // -----------------------------------------------------------------

    /// @dev No account without ADMIN_ROLE may ever grant an operational role.
    function testFuzz_NonAdminCannotGrantRole(address caller, address target) public {
        vm.assume(caller != address(0) && target != address(0));
        vm.assume(caller != OWNER);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                caller,
                TrustChainRoles.ADMIN_ROLE
            )
        );
        acl.grantRole(TrustChainRoles.MANAGER_ROLE, target);
    }

    /// @dev No account without ADMIN_ROLE may ever rewrite the permission matrix.
    function testFuzz_NonAdminCannotSetPermission(address caller, bool allowed) public {
        vm.assume(caller != address(0) && caller != OWNER);

        vm.prank(caller);
        vm.expectRevert();
        acl.setRolePermission(TrustChainRoles.USER_ROLE, Permissions.MINT_ASSET, allowed);
    }

    /// @dev DEFAULT_ADMIN_ROLE can never be granted directly, by anyone.
    function testFuzz_DefaultAdminRoleIsNeverGrantable(address caller, address target) public {
        vm.assume(caller != address(0) && target != address(0));

        vm.prank(caller);
        vm.expectRevert();
        acl.grantRole(DEFAULT_ADMIN_ROLE, target);
    }

    // -----------------------------------------------------------------
    // Permission semantics
    // -----------------------------------------------------------------

    /// @dev A MANAGER always mints and never manages roles, whoever they are.
    function testFuzz_ManagerMintsButNeverManagesRoles(address account) public {
        vm.assume(account != address(0) && account != OWNER);

        vm.prank(OWNER);
        acl.grantRole(TrustChainRoles.MANAGER_ROLE, account);

        assertTrue(acl.hasPermission(account, Permissions.MINT_ASSET));
        assertFalse(acl.hasPermission(account, Permissions.MANAGE_ROLES));

        vm.prank(account);
        vm.expectRevert();
        acl.grantRole(TrustChainRoles.USER_ROLE, address(0xDEAD));
    }

    /// @dev An AUDITOR holds exactly one read permission and no write permission.
    function testFuzz_AuditorIsReadOnly(address account) public {
        vm.assume(account != address(0) && account != OWNER);

        vm.prank(OWNER);
        acl.grantRole(TrustChainRoles.AUDITOR_ROLE, account);

        assertTrue(acl.hasPermission(account, Permissions.VIEW_AUDIT));
        assertFalse(acl.hasPermission(account, Permissions.MINT_ASSET));
        assertFalse(acl.hasPermission(account, Permissions.ASSIGN_ASSET));
        assertFalse(acl.hasPermission(account, Permissions.ISSUE_CREDENTIAL));
        assertFalse(acl.hasPermission(account, Permissions.REVOKE_CREDENTIAL));
        assertFalse(acl.hasPermission(account, Permissions.MANAGE_ROLES));
        assertFalse(acl.hasPermission(account, Permissions.REGISTER_DID));
    }

    /// @dev Revocation is immediate: permission is gone in the same block.
    function testFuzz_RevocationIsImmediate(address account) public {
        vm.assume(account != address(0) && account != OWNER);

        vm.startPrank(OWNER);
        acl.grantRole(TrustChainRoles.MANAGER_ROLE, account);
        assertTrue(acl.hasPermission(account, Permissions.MINT_ASSET));

        acl.revokeRole(TrustChainRoles.MANAGER_ROLE, account);
        vm.stopPrank();

        assertFalse(acl.hasRole(TrustChainRoles.MANAGER_ROLE, account));
        assertFalse(acl.hasPermission(account, Permissions.MINT_ASSET));
        assertEq(acl.roleCountOf(account), 0);
    }

    /// @dev An account's permissions are exactly the union over the roles it holds.
    function testFuzz_PermissionIsUnionOverRoles(bool asManager, bool asAuditor) public {
        address account = address(0xA0A0);

        vm.startPrank(OWNER);
        if (asManager) acl.grantRole(TrustChainRoles.MANAGER_ROLE, account);
        if (asAuditor) acl.grantRole(TrustChainRoles.AUDITOR_ROLE, account);
        vm.stopPrank();

        assertEq(acl.hasPermission(account, Permissions.MINT_ASSET), asManager);
        assertEq(acl.hasPermission(account, Permissions.VIEW_AUDIT), asAuditor);
    }

    // -----------------------------------------------------------------
    // Enumeration
    // -----------------------------------------------------------------

    /// @dev Enumeration and membership never disagree, over arbitrary grant/revoke.
    function testFuzz_EnumerationMatchesMembership(address account, bool revokeAgain) public {
        vm.assume(account != address(0) && account != OWNER);

        vm.prank(OWNER);
        acl.grantRole(TrustChainRoles.USER_ROLE, account);

        assertTrue(acl.hasRole(TrustChainRoles.USER_ROLE, account));
        assertEq(acl.roleCountOf(account), 1);
        assertEq(acl.rolesOf(account)[0], TrustChainRoles.USER_ROLE);
        assertEq(acl.roleMemberCount(TrustChainRoles.USER_ROLE), 1);
        assertEq(acl.roleMemberAt(TrustChainRoles.USER_ROLE, 0), account);

        if (revokeAgain) {
            vm.prank(OWNER);
            acl.revokeRole(TrustChainRoles.USER_ROLE, account);

            assertFalse(acl.hasRole(TrustChainRoles.USER_ROLE, account));
            assertEq(acl.roleCountOf(account), 0);
            assertEq(acl.roleMemberCount(TrustChainRoles.USER_ROLE), 0);
        }
    }

    /// @dev Granting the same role repeatedly must not duplicate enumeration entries.
    function testFuzz_GrantIsIdempotent(address account, uint8 times) public {
        vm.assume(account != address(0) && account != OWNER);
        times = uint8(bound(times, 1, 16));

        for (uint256 i = 0; i < times; i++) {
            vm.prank(OWNER);
            acl.grantRole(TrustChainRoles.MANAGER_ROLE, account);
        }

        assertEq(acl.roleCountOf(account), 1);
        assertEq(acl.roleMemberCount(TrustChainRoles.MANAGER_ROLE), 1);
    }

    // -----------------------------------------------------------------
    // Two-step default admin
    // -----------------------------------------------------------------

    /// @dev Acceptance before the delay elapses is impossible for any wait shorter than it.
    function testFuzz_DefaultAdminTransferRespectsDelay(address newAdmin, uint256 wait) public {
        vm.assume(newAdmin != address(0) && newAdmin != OWNER);
        wait = bound(wait, 0, uint256(DELAY) - 1);

        vm.prank(OWNER);
        acl.beginDefaultAdminTransfer(newAdmin);

        skip(wait);

        vm.prank(newAdmin);
        vm.expectRevert();
        acl.acceptDefaultAdminTransfer();

        assertEq(acl.defaultAdmin(), OWNER);

        // Once matured, the nominated account — and only it — can accept.
        // The rule is strictly-after: acceptance exactly AT the schedule still
        // reverts, so warp one second past it.
        (, uint48 schedule) = acl.pendingDefaultAdmin();
        vm.warp(uint256(schedule) + 1);

        vm.prank(newAdmin);
        acl.acceptDefaultAdminTransfer();
        assertEq(acl.defaultAdmin(), newAdmin);
    }
}
