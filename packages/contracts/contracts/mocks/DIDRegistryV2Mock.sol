// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DIDRegistry} from "../identity/DIDRegistry.sol";

/// @dev Upgrade target used to prove UUPS authorisation and storage preservation.
contract DIDRegistryV2Mock is DIDRegistry {
    event UpgradedToV2();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() DIDRegistry() {}

    /// @notice Migration hook for the V2 upgrade. Version 1 state carries over untouched.
    function initializeV2() external reinitializer(2) {
        emit UpgradedToV2();
    }

    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}
