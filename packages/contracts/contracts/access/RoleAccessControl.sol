// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IAuditTrail} from "../interfaces/IAuditTrail.sol";
import {IDIDResolver} from "../interfaces/IDIDResolver.sol";
import {ActionCodes} from "../libraries/ActionCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {TrustChainRoles} from "../libraries/TrustChainRoles.sol";

/**
 * @title RoleAccessControl
 * @notice The platform's single authorization authority. Every sibling contract asks
 *         this contract whether a caller may act, so authorization lives on-chain and
 *         a compromised backend cannot forge it.
 *
 * @dev Two layers:
 *
 *      Roles      — ADMIN, MANAGER, AUDITOR, USER, exactly per the problem statement.
 *                   Who someone is.
 *      Permissions — fine-grained rights attached to a role by an ADMIN at runtime.
 *                   What that role may do.
 *
 *      Splitting them is what makes "administrators define roles and assign specific
 *      access rights" a runtime operation rather than a redeployment. Sibling contracts
 *      gate on a permission, never on a hardcoded role, so re-scoping MANAGER changes
 *      behaviour everywhere without touching their code.
 *
 *      DEFAULT_ADMIN_ROLE is governed by AccessControlDefaultAdminRules: it is unique,
 *      cannot be granted directly, and transferring or renouncing it requires a two-step
 *      flow with an enforced delay. That is what stops a single compromised key from
 *      instantly and irreversibly seizing or abandoning the platform.
 */
contract RoleAccessControl is Initializable, AccessControlDefaultAdminRulesUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant ADMIN_ROLE = TrustChainRoles.ADMIN_ROLE;
    bytes32 public constant MANAGER_ROLE = TrustChainRoles.MANAGER_ROLE;
    bytes32 public constant AUDITOR_ROLE = TrustChainRoles.AUDITOR_ROLE;
    bytes32 public constant USER_ROLE = TrustChainRoles.USER_ROLE;

    /// @dev role => permission => allowed
    mapping(bytes32 role => mapping(bytes32 permission => bool allowed)) private _rolePermissions;
    /// @dev role => permissions, kept only so the matrix can be enumerated off-chain
    mapping(bytes32 role => EnumerableSet.Bytes32Set permissions) private _rolePermissionSet;
    /// @dev account => roles held
    mapping(address account => EnumerableSet.Bytes32Set roles) private _accountRoles;
    /// @dev role => accounts holding it
    mapping(bytes32 role => EnumerableSet.AddressSet members) private _roleMembers;

    IDIDResolver public didRegistry;
    IAuditTrail public auditTrail;

    /// @dev Reserved so future versions can add storage without shifting existing slots.
    uint256[43] private __gap;

    event PermissionUpdated(
        bytes32 indexed role,
        bytes32 indexed permission,
        bool allowed,
        address indexed updatedBy
    );
    event RoleGrantedToDID(
        bytes32 indexed didHash,
        bytes32 indexed role,
        address indexed controller,
        address grantedBy
    );
    event RoleRevokedFromDID(
        bytes32 indexed didHash,
        bytes32 indexed role,
        address indexed controller,
        address revokedBy
    );
    event DIDRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);
    event AuditTrailUpdated(address indexed previousTrail, address indexed newTrail);

    error ZeroAddress();
    error InvalidPermission();
    error UnmanageableRole(bytes32 role);
    error DIDRegistryNotSet();
    error UnknownDID(bytes32 didHash);
    error DIDNotActive(bytes32 didHash);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param initialDefaultAdmin holder of DEFAULT_ADMIN_ROLE — a Safe multisig in
     *        production, never an EOA (see docs/DEPLOY.md).
     * @param initialDelay seconds that must elapse before a DEFAULT_ADMIN_ROLE transfer
     *        or renouncement can be accepted.
     */
    function initialize(address initialDefaultAdmin, uint48 initialDelay) external initializer {
        if (initialDefaultAdmin == address(0)) revert ZeroAddress();

        __AccessControlDefaultAdminRules_init(initialDelay, initialDefaultAdmin);

        // ADMIN is administered by DEFAULT_ADMIN; every operational role is
        // administered by ADMIN. So an ADMIN can shape the workforce but cannot
        // promote itself to platform owner.
        _setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(MANAGER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(AUDITOR_ROLE, ADMIN_ROLE);
        _setRoleAdmin(USER_ROLE, ADMIN_ROLE);

        _grantRole(ADMIN_ROLE, initialDefaultAdmin);

        _seedDefaultPermissions();
    }

    /// @dev Starting matrix. An ADMIN may re-scope any of it later.
    function _seedDefaultPermissions() private {
        _setPermission(ADMIN_ROLE, Permissions.MANAGE_ROLES, true);
        _setPermission(ADMIN_ROLE, Permissions.REGISTER_DID, true);
        _setPermission(ADMIN_ROLE, Permissions.VIEW_AUDIT, true);
        _setPermission(ADMIN_ROLE, Permissions.MINT_ASSET, true);
        _setPermission(ADMIN_ROLE, Permissions.ASSIGN_ASSET, true);
        _setPermission(ADMIN_ROLE, Permissions.ISSUE_CREDENTIAL, true);
        _setPermission(ADMIN_ROLE, Permissions.REVOKE_CREDENTIAL, true);

        _setPermission(MANAGER_ROLE, Permissions.MINT_ASSET, true);
        _setPermission(MANAGER_ROLE, Permissions.ASSIGN_ASSET, true);
        _setPermission(MANAGER_ROLE, Permissions.ISSUE_CREDENTIAL, true);
        _setPermission(MANAGER_ROLE, Permissions.REVOKE_CREDENTIAL, true);
        _setPermission(MANAGER_ROLE, Permissions.REGISTER_DID, true);

        // AUDITOR is read-only by design: verification only, no write permission.
        _setPermission(AUDITOR_ROLE, Permissions.VIEW_AUDIT, true);

        // USER holds an identity and owns assets; it carries no platform permission.
    }

    // ---------------------------------------------------------------------
    // Access rights
    // ---------------------------------------------------------------------

    /// @notice Attach or detach an access right on a role.
    function setRolePermission(bytes32 role, bytes32 permission, bool allowed) public onlyRole(ADMIN_ROLE) {
        if (permission == bytes32(0)) revert InvalidPermission();
        // DEFAULT_ADMIN authority comes from the two-step rules, not this matrix;
        // letting an ADMIN write to it would be a privilege-escalation path.
        if (role == DEFAULT_ADMIN_ROLE) revert UnmanageableRole(role);

        _setPermission(role, permission, allowed);
    }

    /// @notice Batch form of {setRolePermission}, for one-transaction re-scoping.
    function setRolePermissions(
        bytes32 role,
        bytes32[] calldata permissions,
        bool allowed
    ) external onlyRole(ADMIN_ROLE) {
        for (uint256 i = 0; i < permissions.length; ++i) {
            setRolePermission(role, permissions[i], allowed);
        }
    }

    function _setPermission(bytes32 role, bytes32 permission, bool allowed) private {
        if (_rolePermissions[role][permission] == allowed) return; // idempotent, no event

        _rolePermissions[role][permission] = allowed;

        if (allowed) {
            _rolePermissionSet[role].add(permission);
        } else {
            _rolePermissionSet[role].remove(permission);
        }

        emit PermissionUpdated(role, permission, allowed, msg.sender);
        _audit(bytes32(0), ActionCodes.PERMISSION_UPDATED, permission);
    }

    /// @notice True when any role held by `account` carries `permission`.
    function hasPermission(address account, bytes32 permission) public view returns (bool) {
        EnumerableSet.Bytes32Set storage roles = _accountRoles[account];
        uint256 count = roles.length();

        for (uint256 i = 0; i < count; ++i) {
            if (_rolePermissions[roles.at(i)][permission]) return true;
        }
        return false;
    }

    function roleHasPermission(bytes32 role, bytes32 permission) external view returns (bool) {
        return _rolePermissions[role][permission];
    }

    function permissionsOf(bytes32 role) external view returns (bytes32[] memory) {
        return _rolePermissionSet[role].values();
    }

    // ---------------------------------------------------------------------
    // Identity-scoped grants
    // ---------------------------------------------------------------------

    function setDIDRegistry(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry == address(0)) revert ZeroAddress();

        emit DIDRegistryUpdated(address(didRegistry), registry);
        didRegistry = IDIDResolver(registry);
    }

    /// @notice Wire the append-only audit ledger. This contract must also be allowlisted there.
    function setAuditTrail(address trail) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (trail == address(0)) revert ZeroAddress();

        emit AuditTrailUpdated(address(auditTrail), trail);
        auditTrail = IAuditTrail(trail);
    }

    /**
     * @notice Grant a role to the identity behind `didHash`.
     * @dev The problem statement assigns access rights to identities, not to raw
     *      wallets. Authorisation is unchanged: {grantRole} still enforces that the
     *      caller administers the role.
     */
    function grantRoleToDID(bytes32 didHash, bytes32 role) external {
        address controller = _resolveActiveController(didHash);
        grantRole(role, controller);
        emit RoleGrantedToDID(didHash, role, controller, msg.sender);
    }

    function revokeRoleFromDID(bytes32 didHash, bytes32 role) external {
        address controller = _resolveActiveController(didHash);
        revokeRole(role, controller);
        emit RoleRevokedFromDID(didHash, role, controller, msg.sender);
    }

    function _resolveActiveController(bytes32 didHash) private view returns (address controller) {
        if (address(didRegistry) == address(0)) revert DIDRegistryNotSet();

        controller = didRegistry.controllerOf(didHash);
        if (controller == address(0)) revert UnknownDID(didHash);
        if (!didRegistry.isActive(didHash)) revert DIDNotActive(didHash);
    }

    // ---------------------------------------------------------------------
    // Enumeration
    // ---------------------------------------------------------------------

    function rolesOf(address account) external view returns (bytes32[] memory) {
        return _accountRoles[account].values();
    }

    function roleCountOf(address account) external view returns (uint256) {
        return _accountRoles[account].length();
    }

    function roleMembers(bytes32 role) external view returns (address[] memory) {
        return _roleMembers[role].values();
    }

    function roleMemberCount(bytes32 role) external view returns (uint256) {
        return _roleMembers[role].length();
    }

    function roleMemberAt(bytes32 role, uint256 index) external view returns (address) {
        return _roleMembers[role].at(index);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _grantRole(bytes32 role, address account) internal virtual override returns (bool granted) {
        granted = super._grantRole(role, account);

        if (granted) {
            _accountRoles[account].add(role);
            _roleMembers[role].add(account);
            _audit(_didOf(account), ActionCodes.ROLE_GRANTED, role);
        }
    }

    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool revoked) {
        revoked = super._revokeRole(role, account);

        if (revoked) {
            _accountRoles[account].remove(role);
            _roleMembers[role].remove(account);
            _audit(_didOf(account), ActionCodes.ROLE_REVOKED, role);
        }
    }

    /// @dev Scope an audit entry to the account's identity when one is resolvable.
    function _didOf(address account) private view returns (bytes32) {
        if (address(didRegistry) == address(0)) return bytes32(0);
        return didRegistry.didOf(account);
    }

    /**
     * @dev Records to the audit trail when one is wired.
     *
     * Skipping while unset matters more here than elsewhere: {initialize} grants roles
     * before any trail can exist. Once wired, a rejected log reverts the whole action —
     * a permission change that escaped the audit trail is worse than one that never
     * happened.
     */
    function _audit(bytes32 didHash, uint8 actionCode, bytes32 refHash) private {
        if (address(auditTrail) == address(0)) return;
        auditTrail.logAction(didHash, actionCode, refHash);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert ZeroAddress();
    }
}
