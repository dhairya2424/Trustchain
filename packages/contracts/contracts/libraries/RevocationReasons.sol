// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @dev Reason codes recorded against a revoked credential.
 *
 * Code 0 is deliberately left undefined so that {CredentialRegistry.revoke} can
 * reject it: every revocation must carry an attributable reason, which is what
 * makes the revocation registry useful to an auditor rather than just a boolean.
 */
library RevocationReasons {
    uint16 internal constant KEY_COMPROMISED = 1;
    uint16 internal constant SUPERSEDED = 2;
    uint16 internal constant SUBJECT_TERMINATED = 3;
    uint16 internal constant ISSUED_IN_ERROR = 4;
    uint16 internal constant POLICY_VIOLATION = 5;
    uint16 internal constant SUBJECT_REQUESTED = 6;
    uint16 internal constant ISSUER_DECOMMISSIONED = 7;
}
