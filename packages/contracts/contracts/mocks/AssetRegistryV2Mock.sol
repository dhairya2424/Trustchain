// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AssetRegistry} from "../assets/AssetRegistry.sol";

/// @dev Upgrade target used to prove UUPS authorisation and storage preservation.
contract AssetRegistryV2Mock is AssetRegistry {
    event UpgradedToV2();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() AssetRegistry() {}

    function initializeV2() external reinitializer(2) {
        emit UpgradedToV2();
    }

    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}
