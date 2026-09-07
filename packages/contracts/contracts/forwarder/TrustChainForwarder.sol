// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/**
 * @title TrustChainForwarder
 * @notice Proves who requested an action, so the relayer cannot claim to be someone else.
 *
 * @dev The problem this solves.
 *
 *      Transactions reach the chain through a relayer, whose key signs them. Without a
 *      forwarder, `msg.sender` inside every system contract is that relayer, so the audit
 *      trail can only ever record which machine submitted an action — never which person
 *      asked for it. Attribution would then rest on the relayer's own word, and a relayer
 *      that was compromised, or merely wrong, could mint an asset and have the ledger
 *      permanently attribute it to an innocent identity.
 *
 *      Passing an `actor` argument would not fix it: the relayer controls its own calldata,
 *      so an `actor` parameter is exactly the relayer's unverified claim, written on-chain
 *      and looking authoritative.
 *
 *      So the requester signs. This contract verifies an EIP-712 `ForwardRequest` — the
 *      actor's own signature over the target, calldata, nonce and deadline — and only then
 *      calls the target with the actor's address appended to the calldata. The target reads
 *      it back through `ERC2771Context._msgSender()`.
 *
 *      The result is that the actor recorded on-chain is cryptographically proven. The
 *      relayer pays the gas and can choose whether to submit a request, but cannot forge
 *      one, cannot alter one, and cannot replay one — the nonce and deadline are inside the
 *      signed payload.
 *
 *      This is OpenZeppelin's audited ERC-2771 forwarder, deliberately unmodified. A
 *      bespoke signature-verification contract on the platform's authorization boundary is
 *      the kind of code whose bugs are found by other people, later.
 *
 *      Note the consequence for authorization, which is an improvement rather than a
 *      compromise: because the system contracts check permissions against `_msgSender()`,
 *      they now check the ACTOR's permission. The relayer needs no platform role at all,
 *      and a compromised relayer cannot mint — it can only forward requests that someone
 *      authorised has already signed.
 */
contract TrustChainForwarder is ERC2771Forwarder {
    /// @param name EIP-712 domain name; must match what signers use.
    constructor(string memory name) ERC2771Forwarder(name) {}
}
