// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal DID resolution surface, so consumers need not import the registry.
interface IDIDResolver {
    function controllerOf(bytes32 didHash) external view returns (address);

    function isActive(bytes32 didHash) external view returns (bool);
}
