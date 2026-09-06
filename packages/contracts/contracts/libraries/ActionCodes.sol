// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @dev Action codes written to the audit trail.
 *
 * Append new codes only. A code is part of the permanent record: reusing or
 * renumbering one would silently rewrite the meaning of history already logged.
 */
library ActionCodes {
    uint8 internal constant DID_REGISTERED = 1;
    uint8 internal constant DID_CONTROLLER_ROTATED = 2;
    uint8 internal constant DID_KEY_ROTATED = 3;
    uint8 internal constant DID_STATUS_CHANGED = 4;

    uint8 internal constant ROLE_GRANTED = 5;
    uint8 internal constant ROLE_REVOKED = 6;
    uint8 internal constant PERMISSION_UPDATED = 7;

    uint8 internal constant ASSET_MINTED = 8;
    uint8 internal constant ASSET_TRANSFERRED = 9;
    uint8 internal constant ASSET_RECLAIMED = 10;

    uint8 internal constant CREDENTIAL_ISSUED = 11;
    uint8 internal constant CREDENTIAL_REVOKED = 12;
}
