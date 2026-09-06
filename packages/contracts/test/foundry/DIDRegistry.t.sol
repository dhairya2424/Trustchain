// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Foundry fuzz suite for DIDRegistry.
//
// Requires Foundry and forge-std, which are NOT part of the npm install:
//   curl -L https://foundry.paradigm.xyz | bash && foundryup
//   forge install foundry-rs/forge-std --no-git
//   forge test --fuzz-runs 1000
//
// The same invariants are covered by randomised tests in test/DIDRegistry.test.ts,
// which run under Hardhat with no extra toolchain.

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {DIDRegistry} from "../../contracts/identity/DIDRegistry.sol";

contract DIDRegistryFuzzTest is Test {
    DIDRegistry private registry;
    address private constant ADMIN = address(0xA11CE);

    function setUp() public {
        DIDRegistry implementation = new DIDRegistry();
        bytes memory initData = abi.encodeCall(DIDRegistry.initialize, (ADMIN));
        registry = DIDRegistry(address(new ERC1967Proxy(address(implementation), initData)));
    }

    // -----------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------

    function testFuzz_RegistrationResolvesBothWays(
        bytes32 didHash,
        address controller,
        bytes32 keyCommitment
    ) public {
        vm.assume(didHash != bytes32(0));
        vm.assume(keyCommitment != bytes32(0));
        vm.assume(controller != address(0));

        vm.prank(ADMIN);
        registry.registerDIDFor(didHash, controller, keyCommitment);

        assertEq(registry.controllerOf(didHash), controller);
        assertEq(registry.didOf(controller), didHash);
        assertEq(registry.rotationNonceOf(didHash), 0);
        assertTrue(registry.isActive(didHash));
    }

    function testFuzz_DuplicateDIDHashAlwaysReverts(
        bytes32 didHash,
        address first,
        address second,
        bytes32 keyCommitment
    ) public {
        vm.assume(didHash != bytes32(0));
        vm.assume(keyCommitment != bytes32(0));
        vm.assume(first != address(0) && second != address(0) && first != second);

        vm.startPrank(ADMIN);
        registry.registerDIDFor(didHash, first, keyCommitment);

        vm.expectRevert(abi.encodeWithSelector(DIDRegistry.DIDAlreadyRegistered.selector, didHash));
        registry.registerDIDFor(didHash, second, keyCommitment);
        vm.stopPrank();
    }

    function testFuzz_ControllerCannotHoldTwoDIDs(
        bytes32 firstDid,
        bytes32 secondDid,
        address controller,
        bytes32 keyCommitment
    ) public {
        vm.assume(firstDid != bytes32(0) && secondDid != bytes32(0) && firstDid != secondDid);
        vm.assume(keyCommitment != bytes32(0));
        vm.assume(controller != address(0));

        vm.startPrank(ADMIN);
        registry.registerDIDFor(firstDid, controller, keyCommitment);

        vm.expectRevert(abi.encodeWithSelector(DIDRegistry.ControllerAlreadyHasDID.selector, controller));
        registry.registerDIDFor(secondDid, controller, keyCommitment);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Rotation and replay
    // -----------------------------------------------------------------

    /// @dev A signature valid at nonce N must never be accepted once the nonce moves on.
    function testFuzz_RotationSignatureIsSingleUse(uint256 controllerKey, address newController) public {
        controllerKey = bound(controllerKey, 1, type(uint128).max);
        address controller = vm.addr(controllerKey);

        vm.assume(newController != address(0));
        vm.assume(newController != controller);

        bytes32 didHash = keccak256(abi.encodePacked("did", controllerKey));
        vm.prank(ADMIN);
        registry.registerDIDFor(didHash, controller, keccak256("key"));

        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = _signRotation(controllerKey, didHash, newController, 0, deadline);

        registry.rotateController(didHash, newController, 0, deadline, signature);
        assertEq(registry.controllerOf(didHash), newController);
        assertEq(registry.rotationNonceOf(didHash), 1);

        // Replaying the identical signature must fail on the consumed nonce.
        vm.expectRevert(abi.encodeWithSelector(DIDRegistry.InvalidNonce.selector, 1, 0));
        registry.rotateController(didHash, newController, 0, deadline, signature);
    }

    function testFuzz_StaleNonceNeverAccepted(uint256 controllerKey, uint256 staleNonce) public {
        controllerKey = bound(controllerKey, 1, type(uint128).max);
        staleNonce = bound(staleNonce, 1, type(uint64).max);

        address controller = vm.addr(controllerKey);
        address newController = address(0xBEEF);
        vm.assume(controller != newController);

        bytes32 didHash = keccak256(abi.encodePacked("did", controllerKey));
        vm.prank(ADMIN);
        registry.registerDIDFor(didHash, controller, keccak256("key"));

        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = _signRotation(controllerKey, didHash, newController, staleNonce, deadline);

        // Current nonce is 0; anything else must be rejected before signature checks.
        vm.expectRevert(abi.encodeWithSelector(DIDRegistry.InvalidNonce.selector, 0, staleNonce));
        registry.rotateController(didHash, newController, staleNonce, deadline, signature);
    }

    function testFuzz_ForgedSignatureNeverAccepted(uint256 controllerKey, uint256 attackerKey) public {
        controllerKey = bound(controllerKey, 1, type(uint128).max);
        attackerKey = bound(attackerKey, 1, type(uint128).max);
        vm.assume(controllerKey != attackerKey);

        address controller = vm.addr(controllerKey);
        address attacker = vm.addr(attackerKey);
        vm.assume(controller != attacker);

        bytes32 didHash = keccak256(abi.encodePacked("did", controllerKey));
        vm.prank(ADMIN);
        registry.registerDIDFor(didHash, controller, keccak256("key"));

        uint256 deadline = block.timestamp + 1 days;
        bytes memory forged = _signRotation(attackerKey, didHash, attacker, 0, deadline);

        vm.expectRevert(DIDRegistry.InvalidSignature.selector);
        registry.rotateController(didHash, attacker, 0, deadline, forged);

        assertEq(registry.controllerOf(didHash), controller);
    }

    /// @dev The nonce must increase by exactly one per rotation, never wrap or stall.
    function testFuzz_NonceIsStrictlyMonotonic(uint8 rotations) public {
        rotations = uint8(bound(rotations, 1, 32));

        bytes32 didHash = keccak256("monotonic");
        address current = address(0x1000);

        vm.prank(ADMIN);
        registry.registerDIDFor(didHash, current, keccak256("key"));

        for (uint256 i = 0; i < rotations; i++) {
            address next = address(uint160(0x2000 + i));

            vm.prank(current);
            registry.rotateControllerDirect(didHash, next);

            assertEq(registry.rotationNonceOf(didHash), i + 1);
            assertEq(registry.controllerOf(didHash), next);
            current = next;
        }
    }

    // -----------------------------------------------------------------
    // Pause
    // -----------------------------------------------------------------

    function testFuzz_PauseBlocksRegistration(bytes32 didHash, address controller) public {
        vm.assume(didHash != bytes32(0));
        vm.assume(controller != address(0));

        vm.prank(ADMIN);
        registry.pause();

        vm.prank(ADMIN);
        vm.expectRevert();
        registry.registerDIDFor(didHash, controller, keccak256("key"));
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function _signRotation(
        uint256 privateKey,
        bytes32 didHash,
        address newController,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes memory) {
        bytes32 digest = registry.rotationDigest(didHash, newController, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
