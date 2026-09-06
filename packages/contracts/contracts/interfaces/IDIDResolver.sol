// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal DID resolution surface, so consumers need not import the registry.
interface IDIDResolver {
    function controllerOf(bytes32 didHash) external view returns (address);

    /// @dev Reverse lookup. Returns bytes32(0) when the address controls no DID.
    function didOf(address controller) external view returns (bytes32);

    function isActive(bytes32 didHash) external view returns (bool);
}
