// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title DIDRegistry
 * @notice Registry of decentralized identifiers. Holds the cryptographic root of every
 *         identity on the platform: who controls a DID, and a commitment to its key
 *         material.
 *
 * @dev No personally identifying data is stored. A DID is referenced only by
 *      `didHash` (keccak256 of the DID string) and its key material only by
 *      `keyCommitment` (a hash). Neither is reversible on-chain.
 *
 *      Controller rotation is authorised by an EIP-712 signature from the current
 *      controller, so a lost-key recovery can be relayed by a third party without the
 *      controller holding gas. Each DID carries its own `rotationNonce`, which makes a
 *      captured rotation signature single-use.
 */
contract DIDRegistry is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev EIP-712 type of a controller rotation authorisation.
    bytes32 private constant ROTATION_TYPEHASH =
        keccak256("ControllerRotation(bytes32 didHash,address newController,uint256 nonce,uint256 deadline)");

    struct DIDRecord {
        address controller;
        bytes32 keyCommitment;
        uint64 createdAt;
        uint64 updatedAt;
        uint256 rotationNonce;
        bool active;
    }

    mapping(bytes32 didHash => DIDRecord record) private _records;
    mapping(address controller => bytes32 didHash) private _didByController;

    /// @dev Reserved so future versions can add storage without shifting existing slots.
    uint256[47] private __gap;

    event DIDRegistered(
        bytes32 indexed didHash,
        address indexed controller,
        bytes32 keyCommitment,
        address registeredBy,
        uint64 createdAt
    );
    event ControllerRotated(
        bytes32 indexed didHash,
        address indexed previousController,
        address indexed newController,
        uint256 consumedNonce,
        bool viaSignature
    );
    event KeyCommitmentRotated(
        bytes32 indexed didHash,
        bytes32 previousKeyCommitment,
        bytes32 newKeyCommitment
    );
    event DIDStatusChanged(bytes32 indexed didHash, bool active, address indexed changedBy);

    error InvalidDIDHash();
    error InvalidKeyCommitment();
    error ZeroAddress();
    error DIDAlreadyRegistered(bytes32 didHash);
    error DIDNotFound(bytes32 didHash);
    error DIDNotActive(bytes32 didHash);
    error ControllerAlreadyHasDID(address controller);
    error NotController(address caller, address controller);
    error InvalidNonce(uint256 expected, uint256 provided);
    error SignatureExpired(uint256 deadline, uint256 nowTimestamp);
    error InvalidSignature();
    error ControllerUnchanged();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // The implementation contract must never be initialisable in its own right;
        // only proxies delegating into it may be.
        _disableInitializers();
    }

    function initialize(address initialAdmin) external initializer {
        if (initialAdmin == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("TrustChainDIDRegistry", "1");
        // UUPSUpgradeable holds no storage of its own in OpenZeppelin v5, so it
        // has no initializer to call.

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(ADMIN_ROLE, initialAdmin);
    }

    modifier onlyController(bytes32 didHash) {
        address controller = _records[didHash].controller;
        if (controller == address(0)) revert DIDNotFound(didHash);
        if (msg.sender != controller) revert NotController(msg.sender, controller);
        _;
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    /// @notice Register a DID controlled by the caller.
    function registerDID(bytes32 didHash, bytes32 keyCommitment) external whenNotPaused {
        _register(didHash, msg.sender, keyCommitment);
    }

    /**
     * @notice Register a DID on behalf of `controller`.
     * @dev The problem statement has identities assigned by the organisation, so an
     *      administrator can enrol a member who has no gas. Control still rests with
     *      `controller`: the admin cannot rotate or act for the identity afterwards.
     */
    function registerDIDFor(
        bytes32 didHash,
        address controller,
        bytes32 keyCommitment
    ) external whenNotPaused onlyRole(ADMIN_ROLE) {
        _register(didHash, controller, keyCommitment);
    }

    function _register(bytes32 didHash, address controller, bytes32 keyCommitment) private {
        if (didHash == bytes32(0)) revert InvalidDIDHash();
        if (keyCommitment == bytes32(0)) revert InvalidKeyCommitment();
        if (controller == address(0)) revert ZeroAddress();
        if (_records[didHash].controller != address(0)) revert DIDAlreadyRegistered(didHash);
        if (_didByController[controller] != bytes32(0)) {
            revert ControllerAlreadyHasDID(controller);
        }

        uint64 timestamp = uint64(block.timestamp);

        _records[didHash] = DIDRecord({
            controller: controller,
            keyCommitment: keyCommitment,
            createdAt: timestamp,
            updatedAt: timestamp,
            rotationNonce: 0,
            active: true
        });
        _didByController[controller] = didHash;

        emit DIDRegistered(didHash, controller, keyCommitment, msg.sender, timestamp);
    }

    // ---------------------------------------------------------------------
    // Rotation
    // ---------------------------------------------------------------------

    /**
     * @notice Rotate the controller using an EIP-712 authorisation from the current one.
     * @dev Anyone may submit the transaction; authority comes from the signature, not
     *      from `msg.sender`. `nonce` must equal the DID's current `rotationNonce`, and
     *      the nonce advances on success — so replaying a captured signature reverts.
     *      ERC-1271 signatures are accepted, so a smart-contract wallet can control a DID.
     */
    function rotateController(
        bytes32 didHash,
        address newController,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused {
        DIDRecord storage record = _requireActive(didHash);

        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        if (nonce != record.rotationNonce) revert InvalidNonce(record.rotationNonce, nonce);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ROTATION_TYPEHASH, didHash, newController, nonce, deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(record.controller, digest, signature)) {
            revert InvalidSignature();
        }

        _rotateController(didHash, record, newController, true);
    }

    /**
     * @notice Rotate the controller directly, called by the current controller.
     * @dev Also advances the nonce, which invalidates any rotation signature already
     *      issued for this DID. A controller who suspects a signature has leaked can
     *      neutralise it by rotating here.
     */
    function rotateControllerDirect(
        bytes32 didHash,
        address newController
    ) external whenNotPaused onlyController(didHash) {
        DIDRecord storage record = _requireActive(didHash);
        _rotateController(didHash, record, newController, false);
    }

    function _rotateController(
        bytes32 didHash,
        DIDRecord storage record,
        address newController,
        bool viaSignature
    ) private {
        if (newController == address(0)) revert ZeroAddress();

        address previousController = record.controller;
        if (newController == previousController) revert ControllerUnchanged();
        if (_didByController[newController] != bytes32(0)) {
            revert ControllerAlreadyHasDID(newController);
        }

        uint256 consumedNonce = record.rotationNonce;

        delete _didByController[previousController];
        _didByController[newController] = didHash;

        record.controller = newController;
        record.rotationNonce = consumedNonce + 1;
        record.updatedAt = uint64(block.timestamp);

        emit ControllerRotated(didHash, previousController, newController, consumedNonce, viaSignature);
    }

    /// @notice Replace the commitment to the DID's key material.
    function rotateKeyCommitment(
        bytes32 didHash,
        bytes32 newKeyCommitment
    ) external whenNotPaused onlyController(didHash) {
        if (newKeyCommitment == bytes32(0)) revert InvalidKeyCommitment();

        DIDRecord storage record = _requireActive(didHash);
        bytes32 previous = record.keyCommitment;

        record.keyCommitment = newKeyCommitment;
        record.updatedAt = uint64(block.timestamp);

        emit KeyCommitmentRotated(didHash, previous, newKeyCommitment);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Suspend or restore a DID. Suspension blocks rotation but preserves history.
    function setDIDStatus(bytes32 didHash, bool active) external onlyRole(ADMIN_ROLE) {
        DIDRecord storage record = _records[didHash];
        if (record.controller == address(0)) revert DIDNotFound(didHash);

        record.active = active;
        record.updatedAt = uint64(block.timestamp);

        emit DIDStatusChanged(didHash, active, msg.sender);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function exists(bytes32 didHash) public view returns (bool) {
        return _records[didHash].controller != address(0);
    }

    function isActive(bytes32 didHash) external view returns (bool) {
        return _records[didHash].active;
    }

    function controllerOf(bytes32 didHash) external view returns (address) {
        return _records[didHash].controller;
    }

    function didOf(address controller) external view returns (bytes32) {
        return _didByController[controller];
    }

    function keyCommitmentOf(bytes32 didHash) external view returns (bytes32) {
        return _records[didHash].keyCommitment;
    }

    function rotationNonceOf(bytes32 didHash) external view returns (uint256) {
        return _records[didHash].rotationNonce;
    }

    function recordOf(bytes32 didHash) external view returns (DIDRecord memory) {
        if (!exists(didHash)) revert DIDNotFound(didHash);
        return _records[didHash];
    }

    /// @notice Digest a controller must sign to authorise a rotation. Exposed for clients.
    function rotationDigest(
        bytes32 didHash,
        address newController,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(ROTATION_TYPEHASH, didHash, newController, nonce, deadline))
            );
    }

    function _requireActive(bytes32 didHash) private view returns (DIDRecord storage record) {
        record = _records[didHash];
        if (record.controller == address(0)) revert DIDNotFound(didHash);
        if (!record.active) revert DIDNotActive(didHash);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert ZeroAddress();
    }
}
