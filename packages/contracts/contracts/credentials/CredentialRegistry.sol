// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IAuditTrail} from "../interfaces/IAuditTrail.sol";
import {IDIDResolver} from "../interfaces/IDIDResolver.sol";
import {IRoleAccessControl} from "../interfaces/IRoleAccessControl.sol";
import {ActionCodes} from "../libraries/ActionCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {TrustChainRoles} from "../libraries/TrustChainRoles.sol";

/**
 * @title CredentialRegistry
 * @notice On-chain anchor and revocation registry for verifiable credentials.
 *
 * @dev Only the keccak256 of a credential payload is stored. The payload itself — which
 *      carries the personal data — never touches the chain. A verifier hashes the
 *      credential it was shown and asks this contract whether that hash was issued and
 *      is still valid. So the chain answers "is this credential genuine and live?"
 *      without ever learning what the credential says.
 *
 *      Revocation demands a non-zero reason code. A bare boolean tells an auditor that
 *      something was revoked; a reason code tells them why, which is the difference
 *      between a log and an audit.
 *
 *      Authorization delegates to RoleAccessControl — issuing needs
 *      PERM_ISSUE_CREDENTIAL and revoking needs PERM_REVOKE_CREDENTIAL, both held by
 *      ADMIN and MANAGER in the default matrix.
 */
contract CredentialRegistry is Initializable, PausableUpgradeable, UUPSUpgradeable {
    enum CredentialStatus {
        Unknown,
        Valid,
        Expired,
        Revoked
    }

    struct Credential {
        bytes32 didHash;
        bytes32 schemaId;
        address issuer;
        uint64 issuedAt;
        uint64 expiresAt; // 0 means it never expires
        uint64 revokedAt;
        uint16 revocationReason;
        bool revoked;
    }

    IRoleAccessControl public accessControl;
    IDIDResolver public didRegistry;
    IAuditTrail public auditTrail;

    mapping(bytes32 credentialHash => Credential credential) private _credentials;
    mapping(bytes32 didHash => uint256 count) private _issuedCount;

    /// @dev Reserved so future versions can add storage without shifting existing slots.
    uint256[45] private __gap;

    event CredentialIssued(
        bytes32 indexed credentialHash,
        bytes32 indexed didHash,
        bytes32 indexed schemaId,
        address issuer,
        uint64 issuedAt,
        uint64 expiresAt
    );
    event CredentialRevoked(
        bytes32 indexed credentialHash,
        bytes32 indexed didHash,
        uint16 indexed reasonCode,
        address revokedBy,
        uint64 revokedAt
    );
    event AuditTrailUpdated(address indexed previousTrail, address indexed newTrail);

    error ZeroAddress();
    error NotPermitted(address caller, bytes32 permission);
    error NotAdmin(address caller);
    error InvalidCredentialHash();
    error InvalidSchemaId();
    error InvalidReasonCode();
    error CredentialAlreadyIssued(bytes32 credentialHash);
    error CredentialNotFound(bytes32 credentialHash);
    error CredentialAlreadyRevoked(bytes32 credentialHash);
    error ExpiryInThePast(uint64 expiresAt, uint64 nowTimestamp);
    error UnknownDID(bytes32 didHash);
    error DIDNotActive(bytes32 didHash);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address accessControl_, address didRegistry_) external initializer {
        if (accessControl_ == address(0) || didRegistry_ == address(0)) revert ZeroAddress();

        __Pausable_init();

        accessControl = IRoleAccessControl(accessControl_);
        didRegistry = IDIDResolver(didRegistry_);
    }

    modifier onlyPermission(bytes32 permission) {
        if (!accessControl.hasPermission(msg.sender, permission)) {
            revert NotPermitted(msg.sender, permission);
        }
        _;
    }

    modifier onlyAdmin() {
        if (!accessControl.hasRole(TrustChainRoles.ADMIN_ROLE, msg.sender)) {
            revert NotAdmin(msg.sender);
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Issuance and revocation
    // ---------------------------------------------------------------------

    /**
     * @notice Anchor a credential to an identity.
     * @param credentialHash keccak256 of the verifiable-credential payload — never the payload
     * @param didHash        subject identity
     * @param schemaId       credential type identifier
     * @param expiresAt      unix seconds, or 0 for a credential that never expires
     */
    function issue(
        bytes32 credentialHash,
        bytes32 didHash,
        bytes32 schemaId,
        uint64 expiresAt
    ) external whenNotPaused onlyPermission(Permissions.ISSUE_CREDENTIAL) {
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (schemaId == bytes32(0)) revert InvalidSchemaId();
        if (_credentials[credentialHash].issuedAt != 0) {
            revert CredentialAlreadyIssued(credentialHash);
        }
        if (expiresAt != 0 && expiresAt <= block.timestamp) {
            revert ExpiryInThePast(expiresAt, uint64(block.timestamp));
        }

        if (didRegistry.controllerOf(didHash) == address(0)) revert UnknownDID(didHash);
        if (!didRegistry.isActive(didHash)) revert DIDNotActive(didHash);

        uint64 issuedAt = uint64(block.timestamp);

        _credentials[credentialHash] = Credential({
            didHash: didHash,
            schemaId: schemaId,
            issuer: msg.sender,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            revokedAt: 0,
            revocationReason: 0,
            revoked: false
        });
        _issuedCount[didHash] += 1;

        emit CredentialIssued(credentialHash, didHash, schemaId, msg.sender, issuedAt, expiresAt);
        _audit(didHash, ActionCodes.CREDENTIAL_ISSUED, credentialHash);
    }

    /**
     * @notice Revoke a credential.
     * @param reasonCode non-zero; see {RevocationReasons}.
     */
    function revoke(
        bytes32 credentialHash,
        uint16 reasonCode
    ) external whenNotPaused onlyPermission(Permissions.REVOKE_CREDENTIAL) {
        if (reasonCode == 0) revert InvalidReasonCode();

        Credential storage credential = _credentials[credentialHash];
        if (credential.issuedAt == 0) revert CredentialNotFound(credentialHash);
        if (credential.revoked) revert CredentialAlreadyRevoked(credentialHash);

        credential.revoked = true;
        credential.revocationReason = reasonCode;
        credential.revokedAt = uint64(block.timestamp);

        emit CredentialRevoked(
            credentialHash,
            credential.didHash,
            reasonCode,
            msg.sender,
            credential.revokedAt
        );
        _audit(credential.didHash, ActionCodes.CREDENTIAL_REVOKED, credentialHash);
    }

    // ---------------------------------------------------------------------
    // Verification
    // ---------------------------------------------------------------------

    /// @notice Status of a credential. Public: verification needs no account.
    function statusOf(bytes32 credentialHash) public view returns (CredentialStatus) {
        Credential storage credential = _credentials[credentialHash];

        if (credential.issuedAt == 0) return CredentialStatus.Unknown;
        if (credential.revoked) return CredentialStatus.Revoked;
        if (credential.expiresAt != 0 && credential.expiresAt <= block.timestamp) {
            return CredentialStatus.Expired;
        }
        return CredentialStatus.Valid;
    }

    function isValid(bytes32 credentialHash) external view returns (bool) {
        return statusOf(credentialHash) == CredentialStatus.Valid;
    }

    function credentialOf(bytes32 credentialHash) external view returns (Credential memory) {
        Credential memory credential = _credentials[credentialHash];
        if (credential.issuedAt == 0) revert CredentialNotFound(credentialHash);
        return credential;
    }

    function issuedCountOf(bytes32 didHash) external view returns (uint256) {
        return _issuedCount[didHash];
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    function setAuditTrail(address trail) external onlyAdmin {
        if (trail == address(0)) revert ZeroAddress();

        emit AuditTrailUpdated(address(auditTrail), trail);
        auditTrail = IAuditTrail(trail);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * @dev Records to the audit trail when one is wired.
     *
     * Skipping when unset keeps deployment ordering workable — the trail is deployed
     * after this contract and registered afterwards. Once wired, a failed log reverts
     * the whole action rather than being swallowed: an action that silently escaped the
     * audit trail is worse than an action that did not happen.
     */
    function _audit(bytes32 didHash, uint8 actionCode, bytes32 refHash) private {
        if (address(auditTrail) == address(0)) return;
        auditTrail.logAction(didHash, actionCode, refHash);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
    }
}
