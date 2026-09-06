// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IRoleAccessControl} from "../interfaces/IRoleAccessControl.sol";
import {Permissions} from "../libraries/Permissions.sol";

/**
 * @dev Stand-in for a sibling contract such as AssetRegistry.
 *
 * Exists so the tests prove permissions are *enforced* across a contract boundary,
 * rather than only that a boolean reads back correctly. It gates on a permission,
 * never on a hardcoded role — the pattern every real sibling follows.
 */
contract PermissionedConsumerMock {
    IRoleAccessControl public immutable ACL;

    uint256 public mintCount;
    uint256 public issueCount;

    error NotPermitted(address caller, bytes32 permission);

    constructor(address acl) {
        ACL = IRoleAccessControl(acl);
    }

    modifier requiresPermission(bytes32 permission) {
        if (!ACL.hasPermission(msg.sender, permission)) {
            revert NotPermitted(msg.sender, permission);
        }
        _;
    }

    function mint() external requiresPermission(Permissions.MINT_ASSET) {
        mintCount += 1;
    }

    function issueCredential() external requiresPermission(Permissions.ISSUE_CREDENTIAL) {
        issueCount += 1;
    }
}
