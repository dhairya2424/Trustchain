// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Foundry fuzz suite for AssetRegistry. See DIDRegistry.t.sol for setup notes.
//
//   npm run test:foundry

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {AssetRegistry} from "../../contracts/assets/AssetRegistry.sol";
import {DIDRegistry} from "../../contracts/identity/DIDRegistry.sol";
import {RoleAccessControl} from "../../contracts/access/RoleAccessControl.sol";
import {Permissions} from "../../contracts/libraries/Permissions.sol";
import {TrustChainRoles} from "../../contracts/libraries/TrustChainRoles.sol";

contract AssetRegistryFuzzTest is Test {
    RoleAccessControl private acl;
    DIDRegistry private did;
    AssetRegistry private assets;

    address private constant OWNER = address(0xA11CE);
    address private constant MANAGER = address(0xF00D);
    uint48 private constant DELAY = 3 days;

    string private constant URI = "ipfs://bafkreiasset/metadata.json";

    bytes32 private constant ALICE_DID = keccak256("did:trustchain:alice");
    bytes32 private constant BOB_DID = keccak256("did:trustchain:bob");

    address private alice = address(0xA1);
    address private bob = address(0xB0);

    function setUp() public {
        acl = RoleAccessControl(
            address(
                new ERC1967Proxy(
                    address(new RoleAccessControl()),
                    abi.encodeCall(RoleAccessControl.initialize, (OWNER, DELAY))
                )
            )
        );

        did = DIDRegistry(
            address(
                new ERC1967Proxy(address(new DIDRegistry()), abi.encodeCall(DIDRegistry.initialize, (OWNER)))
            )
        );

        assets = AssetRegistry(
            address(
                new ERC1967Proxy(
                    address(new AssetRegistry()),
                    abi.encodeCall(
                        AssetRegistry.initialize,
                        ("TrustChain Asset", "TCA", address(acl), address(did))
                    )
                )
            )
        );

        vm.prank(OWNER);
        acl.grantRole(TrustChainRoles.MANAGER_ROLE, MANAGER);

        vm.startPrank(OWNER);
        did.registerDIDFor(ALICE_DID, alice, keccak256("k1"));
        did.registerDIDFor(BOB_DID, bob, keccak256("k2"));
        vm.stopPrank();
    }

    function _assumeUsableEOA(address account) private view {
        vm.assume(account != address(0));
        vm.assume(account.code.length == 0);
        vm.assume(account != alice && account != bob);
        vm.assume(account != address(acl) && account != address(did) && account != address(assets));
    }

    // -----------------------------------------------------------------
    // Authorisation
    // -----------------------------------------------------------------

    /// @dev No account lacking MINT_ASSET may ever mint, whoever it is.
    function testFuzz_UnauthorizedMintAlwaysReverts(address caller) public {
        _assumeUsableEOA(caller);
        vm.assume(caller != OWNER && caller != MANAGER);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.NotPermitted.selector, caller, Permissions.MINT_ASSET)
        );
        assets.mint(ALICE_DID, URI, false);

        assertEq(assets.totalMinted(), 0);
    }

    /// @dev Withdrawing the permission stops minting for every holder of the role.
    function testFuzz_PermissionWithdrawalStopsMinting(uint8 mintsBefore) public {
        mintsBefore = uint8(bound(mintsBefore, 1, 8));

        for (uint256 i = 0; i < mintsBefore; i++) {
            vm.prank(MANAGER);
            assets.mint(ALICE_DID, URI, false);
        }
        assertEq(assets.totalMinted(), mintsBefore);

        vm.prank(OWNER);
        acl.setRolePermission(TrustChainRoles.MANAGER_ROLE, Permissions.MINT_ASSET, false);

        vm.prank(MANAGER);
        vm.expectRevert();
        assets.mint(ALICE_DID, URI, false);

        assertEq(assets.totalMinted(), mintsBefore);
    }

    // -----------------------------------------------------------------
    // The core invariant
    // -----------------------------------------------------------------

    /// @dev For every token, ownerDID always resolves back to the address holding it.
    function testFuzz_BindingAlwaysMatchesHolder(uint8 hops) public {
        hops = uint8(bound(hops, 1, 24));

        vm.prank(MANAGER);
        uint256 tokenId = assets.mint(ALICE_DID, URI, false);

        address holder = alice;
        bytes32 holderDID = ALICE_DID;

        for (uint256 i = 0; i < hops; i++) {
            (address next, bytes32 nextDID) = holder == alice ? (bob, BOB_DID) : (alice, ALICE_DID);

            vm.prank(holder);
            assets.transferFrom(holder, next, tokenId);

            assertEq(assets.ownerOf(tokenId), next);
            assertEq(assets.ownerDIDOf(tokenId), nextDID);
            assertEq(did.didOf(assets.ownerOf(tokenId)), assets.ownerDIDOf(tokenId));

            holder = next;
            holderDID = nextDID;
        }
    }

    /// @dev An asset can never land on an address that controls no identity.
    function testFuzz_TransferToNonIdentityAlwaysReverts(address stranger) public {
        _assumeUsableEOA(stranger);

        vm.prank(MANAGER);
        uint256 tokenId = assets.mint(ALICE_DID, URI, false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.RecipientHasNoDID.selector, stranger));
        assets.transferFrom(alice, stranger, tokenId);

        assertEq(assets.ownerDIDOf(tokenId), ALICE_DID);
    }

    // -----------------------------------------------------------------
    // Soulbound
    // -----------------------------------------------------------------

    /// @dev A soulbound token never moves between identities, however many attempts.
    function testFuzz_SoulboundNeverMovesBetweenIdentities(uint8 attempts) public {
        attempts = uint8(bound(attempts, 1, 16));

        vm.prank(MANAGER);
        uint256 tokenId = assets.mint(ALICE_DID, URI, true);

        for (uint256 i = 0; i < attempts; i++) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(AssetRegistry.SoulboundToken.selector, tokenId));
            assets.transferFrom(alice, bob, tokenId);
        }

        assertEq(assets.ownerOf(tokenId), alice);
        assertEq(assets.ownerDIDOf(tokenId), ALICE_DID);
    }

    // -----------------------------------------------------------------
    // Key rotation
    // -----------------------------------------------------------------

    /// @dev A rotated-out key loses the power to move the asset, but the identity
    ///      keeps it: the new controller can always reclaim.
    function testFuzz_RotatedKeyCannotTransferButControllerReclaims(address newKey) public {
        _assumeUsableEOA(newKey);
        vm.assume(newKey != OWNER && newKey != MANAGER);

        vm.prank(MANAGER);
        uint256 tokenId = assets.mint(ALICE_DID, URI, false);

        vm.prank(alice);
        did.rotateControllerDirect(ALICE_DID, newKey);

        // The old key still physically holds the token but no longer controls the DID.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.StaleHolder.selector, alice, ALICE_DID));
        assets.transferFrom(alice, bob, tokenId);

        // The identity's current controller recovers it.
        vm.prank(newKey);
        assets.reclaim(tokenId);

        assertEq(assets.ownerOf(tokenId), newKey);
        assertEq(assets.ownerDIDOf(tokenId), ALICE_DID);
    }

    /// @dev Only the DID's current controller may reclaim.
    function testFuzz_ReclaimRestrictedToController(address caller) public {
        _assumeUsableEOA(caller);

        vm.prank(MANAGER);
        uint256 tokenId = assets.mint(ALICE_DID, URI, false);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotDIDController.selector, caller, ALICE_DID));
        assets.reclaim(tokenId);
    }

    // -----------------------------------------------------------------
    // Pause
    // -----------------------------------------------------------------

    function testFuzz_PauseBlocksMintAndTransfer(bool soulbound) public {
        vm.prank(MANAGER);
        uint256 tokenId = assets.mint(ALICE_DID, URI, soulbound);

        vm.prank(OWNER);
        assets.pause();

        vm.prank(MANAGER);
        vm.expectRevert();
        assets.mint(BOB_DID, URI, soulbound);

        vm.prank(alice);
        vm.expectRevert();
        assets.transferFrom(alice, bob, tokenId);

        // Reads still work while paused.
        assertEq(assets.ownerDIDOf(tokenId), ALICE_DID);
    }
}
