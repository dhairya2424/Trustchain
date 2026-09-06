// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {AssetRegistry} from "../assets/AssetRegistry.sol";

/**
 * @dev Reentrancy probe.
 *
 * _safeMint hands control to the recipient via onERC721Received while the mint is still
 * in flight. This receiver uses that window to call mint again. It holds MANAGER in the
 * test, so the permission check passes and the ONLY thing standing in the way is the
 * reentrancy guard — which is what the probe is meant to exercise.
 *
 * The reentrant call is wrapped in try/catch so the outer mint still completes; the test
 * then asserts `attackSucceeded` is false and exactly one token exists.
 */
contract ReentrantReceiverMock is IERC721Receiver {
    AssetRegistry public immutable REGISTRY;

    bytes32 public targetDID;
    string public reentryURI;
    bool public attempted;
    bool public attackSucceeded;
    /// @dev Raw revert data from the reentrant call, so a test can prove WHICH guard fired.
    bytes public lastRevertData;

    constructor(address registry) {
        REGISTRY = AssetRegistry(registry);
    }

    function arm(bytes32 didHash, string calldata uri) external {
        targetDID = didHash;
        reentryURI = uri;
        attempted = false;
        attackSucceeded = false;
        lastRevertData = "";
    }

    function onERC721Received(address, address, uint256, bytes calldata) external override returns (bytes4) {
        if (!attempted) {
            attempted = true;

            try REGISTRY.mint(targetDID, reentryURI, false) returns (uint256) {
                attackSucceeded = true;
            } catch (bytes memory revertData) {
                attackSucceeded = false;
                lastRevertData = revertData;
            }
        }

        return IERC721Receiver.onERC721Received.selector;
    }
}
