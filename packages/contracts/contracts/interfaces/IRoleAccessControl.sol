// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Authorization surface every sibling contract consults before mutating state.
interface IRoleAccessControl {
    function hasRole(bytes32 role, address account) external view returns (bool);

    /// @dev True when any role held by `account` carries `permission`.
    function hasPermission(address account, bytes32 permission) external view returns (bool);

    function rolesOf(address account) external view returns (bytes32[] memory);
}
