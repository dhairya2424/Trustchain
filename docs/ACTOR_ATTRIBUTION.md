# Actor attribution: who asked, not just who signed

The problem statement requires a tamper-proof trail of identity operations, NFT creation
and allocation, ownership transfers and permission updates. An audit trail satisfies that
only if it can name **the identity that requested** each action. This document records how
that is made true, and why the obvious approaches are not enough.

---

## 1. The problem

Transactions reach the chain through a relayer, which signs them with its own key. So
inside every system contract `msg.sender` is the relayer, and `AuditTrail` recorded only
which contract wrote the row. The ledger could say _an asset was minted_ but never _which
administrator minted it_ — every action in the system attributed to one machine.

**Adding an `actor` parameter does not fix this.** The relayer builds its own calldata, so
an unverified `actor` argument is the relayer's claim, written on-chain and dressed as a
fact. A compromised relayer could mint an asset and have the permanent record attribute it
to an innocent identity — worse than no attribution, because it looks authoritative.

## 2. The mechanism

The requester signs. `TrustChainForwarder` (OpenZeppelin's audited `ERC2771Forwarder`,
unmodified) verifies an EIP-712 `ForwardRequest` — the actor's own signature over target,
calldata, nonce and deadline — then calls the target with the actor's address appended.
Targets read it back through `ERC2771Context._msgSender()`.

```
actor ──signs EIP-712 request──► backend ──► relayer ──► TrustChainForwarder
                                                              │ verifies signature
                                                              ▼
                                                      system contract
                                                      _msgSender() == actor
                                                              │
                                                              ▼
                                                      AuditTrail.logAction(..., actor)
```

The recorded actor is therefore **proven, not asserted**. The relayer pays the gas and may
decline to forward, but cannot forge a request, alter one, or replay one — nonce and
deadline are inside the signed payload.

## 3. Three parties, kept apart

| Field      | Meaning                          | Where it comes from                                       |
| ---------- | -------------------------------- | --------------------------------------------------------- |
| `actor`    | who **requested** the action     | the actor's EIP-712 signature, recovered by the forwarder |
| `via`      | which **contract** wrote the row | `msg.sender` at the AuditTrail                            |
| `executor` | who **submitted and paid**       | the transaction's own sender, recorded by the chain       |

`executor` is deliberately **not** a contract parameter. It is already the transaction
sender, which the chain records itself; accepting it as calldata would let a caller state
an executor different from the one that actually signed. The indexer reads it from the
transaction and the API reports all three separately.

`AuditTrail` refuses a zero actor: an entry that cannot say who asked is not an audit
record.

## 4. Authorization improved, not just attribution

Because the contracts check permissions against `_msgSender()`, they now check **the
actor's** permission rather than the relayer's.

That closes a confused deputy at the contract level. Previously the relayer necessarily
held `MINT_ASSET` — it could not relay a mint otherwise — so the contract's check said
nothing about whoever requested it. Now:

- a USER signing a mint is refused **by the contract**, not only by the API
- **the relayer needs no platform role at all**, so a compromised relayer cannot mint; it
  can only forward requests someone authorised has already signed

`test/ActorAttribution.test.ts` proves each property, including that a forged `from`, an
altered calldata, a replay and an expired request are all rejected.

## 5. What the backend enforces

`chain/forwardRequest.ts` checks a returned signature before relaying:

1. **`from` equals the authenticated session's address.** The client may propose a request,
   but the identity it is attributed to comes from the server's session — this is the rule
   that the actor is never taken on the frontend's word.
2. **The signature verifies** for that address, over exactly this action.
3. **The target is one of ours.** Without this an authenticated user could have the
   platform's funded relayer submit arbitrary calldata to any contract on the network — an
   open relay, paid for by us, with our relayer's address on every transaction.
4. **No native value, and not expired.**

RBAC is enforced at the API before a request is even offered for signing, and again by the
contract when it lands.

## 6. Deployment consequences

- **The forwarder deploys first.** Every implementation stores its address immutably at
  construction. That immutability is the point: a swappable trusted forwarder would be a
  complete takeover of attribution, since whoever controlled it could assert any identity.
  Changing it requires an upgrade, which the Safe governs.
- **`AuditTrail` is a new deployment.** It is deliberately not upgradeable, so the added
  `actor` field means a fresh contract. Older entries keep their own history in the previous
  trail; `docs/DEPLOY.md` already states that an audit schema change is a new trail, never a
  migration.
- Direct (non-forwarded) calls still work unchanged — `_msgSender()` falls back to
  `msg.sender` — so a direct administrative action is recorded with that account as actor.

## 7. The API shape this forces

An attributed write is two calls, and the shape follows from the security property rather
than from preference: a signature only the requester can produce cannot be produced by a
server on their behalf.

```
POST /assets/mint            multipart; scans, strips metadata, pins, returns EIP-712 payload
   (the requester signs it in their wallet)
POST /network/forward        { request, signature, verifyingContract, chainId }
```

`/assets/mint`, `/credentials/issue` and `/credentials/revoke` return **200, not 202** —
nothing has been submitted. Reporting "accepted" for an action that still needs a signature
would be the same kind of overclaim as naming the wrong chain. `/network/forward` returns
202 and names the actor it attributed the call to, which is the session's address by
construction because the verifier refuses anything else.

**There is deliberately no path that submits without a signature.** Keeping one "for
convenience" would mean the convenient path is the one that gets used, and every action
through it would again be attributed to the relayer.

### The product consequence

**The user signs in their wallet for every mint, issuance and revocation.** That is inherent
to attribution a relayer cannot forge. It fits the problem statement's "authenticated using
cryptographic proofs" and the self-sovereign framing, and it is the same interaction the
SIWE sign-in already uses — but it is a real change to how the app feels, and worth knowing
before Phase 3 designs around it.

## 8. What is done

Contracts, forwarder, audit trail, event, indexer, API reporting of actor and executor, CSV
export, backend signature verification with its target allowlist, and the two-phase write
flow on every write route.

Proven by 137 contract tests (10 written specifically for attribution and spoofing), 517
backend tests (13 for request verification), and the live exit check, which mints through a
real wallet signature and then asserts against real chain data that the trail names the
**manager** who signed and not the **relayer** who paid.

Still open: the frontend signing call, which belongs with Phase 3's wallet integration —
the API contract it needs is fixed and documented above.
