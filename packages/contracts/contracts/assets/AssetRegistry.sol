// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721PausableUpgradeable.sol";
import {ERC721URIStorageUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAuditTrail} from "../interfaces/IAuditTrail.sol";
import {IDIDResolver} from "../interfaces/IDIDResolver.sol";
import {IRoleAccessControl} from "../interfaces/IRoleAccessControl.sol";
import {ActionCodes} from "../libraries/ActionCodes.sol";
import {Permissions} from "../libraries/Permissions.sol";
import {TrustChainRoles} from "../libraries/TrustChainRoles.sol";
import {ERC2771ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";

/**
 * @title AssetRegistry
 * @notice ERC-721 registry of digital assets, where ownership is bound to a decentralized
 *         identity rather than to a bare wallet address.
 *
 * @dev Authorization deliberately does NOT live here. Every check delegates to
 *      RoleAccessControl, so there is exactly one on-chain source of truth for who may
 *      act. Embedding a second local role table would let the two disagree, and an
 *      ADMIN re-scoping MANAGER would silently fail to take effect here.
 *
 *      Minting requires PERM_MINT_ASSET, held by ADMIN and MANAGER in the default
 *      matrix — "only authorized administrators may mint and assign assets".
 *
 *      Every token carries an `ownerDID`. On transfer the recipient must itself control
 *      an active DID, so an asset can never be stranded on an address with no identity.
 *      That is what makes the ownership chain verifiable end to end.
 *
 *      Soulbound tokens cannot move BETWEEN identities. They can still move between the
 *      keys of one identity, which is what {reclaim} does after a controller rotation —
 *      otherwise a soulbound credential would be permanently lost with a lost key.
 */
contract AssetRegistry is
    Initializable,
    ERC721Upgradeable,
    ERC721URIStorageUpgradeable,
    ERC721PausableUpgradeable,
    ReentrancyGuardTransient,
    ERC2771ContextUpgradeable,
    UUPSUpgradeable
{
    IRoleAccessControl public accessControl;
    IDIDResolver public didRegistry;
    IAuditTrail public auditTrail;

    uint256 private _nextTokenId;

    mapping(uint256 tokenId => bytes32 didHash) private _ownerDID;
    mapping(uint256 tokenId => bool soulbound) private _soulbound;

    /// @dev Reserved so future versions can add storage without shifting existing slots.
    uint256[44] private __gap;

    event AssetMinted(
        uint256 indexed tokenId,
        bytes32 indexed ownerDID,
        address indexed owner,
        string tokenURI,
        bool soulbound,
        address mintedBy
    );
    event AssetTransferred(
        uint256 indexed tokenId,
        bytes32 indexed fromDID,
        bytes32 indexed toDID,
        address from,
        address to
    );
    /// @dev Same identity, new key — emitted instead of {AssetTransferred} on a reclaim.
    event AssetReclaimed(
        uint256 indexed tokenId,
        bytes32 indexed didHash,
        address previousController,
        address newController
    );
    event AuditTrailUpdated(address indexed previousTrail, address indexed newTrail);

    error ZeroAddress();
    error NotPermitted(address caller, bytes32 permission);
    error NotAdmin(address caller);
    error UnknownDID(bytes32 didHash);
    error DIDNotActive(bytes32 didHash);
    error RecipientHasNoDID(address recipient);
    error SoulboundToken(uint256 tokenId);
    error StaleHolder(address holder, bytes32 ownerDID);
    error NotDIDController(address caller, bytes32 didHash);
    error AlreadyHeldByController(uint256 tokenId);
    error EmptyTokenURI();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address trustedForwarder) ERC2771ContextUpgradeable(trustedForwarder) {
        _disableInitializers();
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        address accessControl_,
        address didRegistry_
    ) external initializer {
        if (accessControl_ == address(0) || didRegistry_ == address(0)) revert ZeroAddress();

        __ERC721_init(name_, symbol_);
        __ERC721URIStorage_init();
        __ERC721Pausable_init();
        // ReentrancyGuardTransient keeps its flag in EIP-1153 transient storage, so it
        // occupies no storage slot and needs no initializer. That is exactly why
        // OpenZeppelin 5.6 dropped the upgradeable variant.

        accessControl = IRoleAccessControl(accessControl_);
        didRegistry = IDIDResolver(didRegistry_);
    }

    modifier onlyPermission(bytes32 permission) {
        if (!accessControl.hasPermission(_msgSender(), permission)) {
            revert NotPermitted(_msgSender(), permission);
        }
        _;
    }

    modifier onlyAdmin() {
        if (!accessControl.hasRole(TrustChainRoles.ADMIN_ROLE, _msgSender())) {
            revert NotAdmin(_msgSender());
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    /**
     * @notice Mint an asset and allocate it to an identity.
     * @param toDID identity that will own the asset
     * @param uri metadata location (IPFS) — never PII
     * @param soulbound true for a non-transferable credential
     */
    function mint(
        bytes32 toDID,
        string calldata uri,
        bool soulbound
    ) external nonReentrant onlyPermission(Permissions.MINT_ASSET) returns (uint256 tokenId) {
        if (bytes(uri).length == 0) revert EmptyTokenURI();

        address owner = didRegistry.controllerOf(toDID);
        if (owner == address(0)) revert UnknownDID(toDID);
        if (!didRegistry.isActive(toDID)) revert DIDNotActive(toDID);

        tokenId = ++_nextTokenId;

        // Bind the identity before minting: _safeMint hands control to the recipient,
        // so every observable state must already be consistent.
        _ownerDID[tokenId] = toDID;
        if (soulbound) _soulbound[tokenId] = true;
        _setTokenURI(tokenId, uri);

        // Every observable field is written BEFORE _safeMint, because _safeMint hands
        // control to the recipient's onERC721Received. A receiver that inspected the
        // token mid-mint would otherwise see it with an empty tokenURI.
        _safeMint(owner, tokenId);

        emit AssetMinted(tokenId, toDID, owner, uri, soulbound, _msgSender());
        _audit(toDID, ActionCodes.ASSET_MINTED, bytes32(tokenId));
    }

    // ---------------------------------------------------------------------
    // Identity-preserving recovery
    // ---------------------------------------------------------------------

    /**
     * @notice Pull an asset to the DID's current controller after a key rotation.
     * @dev Without this, rotating a compromised key would leave the asset held by the
     *      old key: the DID binding would still be correct, but the lost key would keep
     *      the power to transfer. Assets follow the identity, not the key.
     */
    function reclaim(uint256 tokenId) external nonReentrant {
        bytes32 didHash = _ownerDID[tokenId];
        _requireOwned(tokenId);

        address controller = didRegistry.controllerOf(didHash);
        if (_msgSender() != controller) revert NotDIDController(_msgSender(), didHash);
        if (!didRegistry.isActive(didHash)) revert DIDNotActive(didHash);

        address currentHolder = _ownerOf(tokenId);
        if (currentHolder == controller) revert AlreadyHeldByController(tokenId);

        _transfer(currentHolder, controller, tokenId);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Wire the append-only audit ledger. This registry must also be allowlisted there.
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
    // Views
    // ---------------------------------------------------------------------

    function ownerDIDOf(uint256 tokenId) external view returns (bytes32) {
        _requireOwned(tokenId);
        return _ownerDID[tokenId];
    }

    function isSoulbound(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return _soulbound[tokenId];
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * @dev Single choke point for every ownership change: mint, transfer, reclaim.
     *      `super._update` runs the pause check and the ERC-721 bookkeeping first.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721Upgradeable, ERC721PausableUpgradeable) returns (address from) {
        from = super._update(to, tokenId, auth);

        // Minting is not an identity transfer — the binding is written by {mint}.
        // There is deliberately no burn path in this contract, so `to` is never zero
        // here; if burning is ever introduced, this branch must be revisited.
        if (from == address(0)) return from;

        bytes32 fromDID = _ownerDID[tokenId];
        bytes32 toDID = didRegistry.didOf(to);

        if (toDID == bytes32(0)) revert RecipientHasNoDID(to);
        if (!didRegistry.isActive(toDID)) revert DIDNotActive(toDID);

        if (toDID == fromDID) {
            // Same identity, different key: a reclaim. Permitted even when soulbound,
            // otherwise a lost key would strand the credential forever.
            emit AssetReclaimed(tokenId, fromDID, from, to);
            _audit(fromDID, ActionCodes.ASSET_RECLAIMED, bytes32(tokenId));
            return from;
        }

        // A stale holder is a key that no longer controls the owning DID — the exact
        // position a rotated-out or compromised key is in. It may not move the asset to
        // a third party; the only move available is a reclaim by the real controller,
        // handled above. Without this, rotating a leaked key would not actually revoke
        // that key's power over already-held assets.
        if (didRegistry.didOf(from) != fromDID) revert StaleHolder(from, fromDID);

        if (_soulbound[tokenId]) revert SoulboundToken(tokenId);

        _ownerDID[tokenId] = toDID;
        emit AssetTransferred(tokenId, fromDID, toDID, from, to);
        _audit(toDID, ActionCodes.ASSET_TRANSFERRED, bytes32(tokenId));
    }

    /**
     * @dev Records to the audit trail when one is wired.
     *
     * Skipping while unset keeps deployment ordering workable. Once wired, a rejected
     * log reverts the whole action — an ownership change that escaped the audit trail
     * is worse than one that never happened.
     */
    function _audit(bytes32 didHash, uint8 actionCode, bytes32 refHash) private {
        if (address(auditTrail) == address(0)) return;
        // The entry id is informational. What matters is that a refused write reverts,
        // which propagates from this call.
        // slither-disable-next-line unused-return
        auditTrail.logAction(didHash, actionCode, refHash, _msgSender());
    }

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721Upgradeable, ERC721URIStorageUpgradeable) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721Upgradeable, ERC721URIStorageUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ---------------------------------------------------------------------
    // ERC-2771 context
    // ---------------------------------------------------------------------

    /**
     * @dev Resolves the request's originator.
     *
     * When the call arrives through the trusted forwarder this is the address that SIGNED
     * the request; otherwise it is `msg.sender` unchanged, so direct calls behave exactly
     * as before. Every authorization check and every audit entry in this contract reads
     * from here, which is what makes them attribute to the requester rather than to the
     * relayer that paid for gas.
     */
    function _msgSender()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (address)
    {
        return ERC2771ContextUpgradeable._msgSender();
    }

    function _msgData()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (bytes calldata)
    {
        return ERC2771ContextUpgradeable._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (uint256)
    {
        return ERC2771ContextUpgradeable._contextSuffixLength();
    }
}
