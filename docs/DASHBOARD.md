# Dashboard (P3.2) — what it shows, and what it refuses to

The dashboard is the screen most likely to be judged, and therefore the screen most tempting
to fake. A seeded asset grid with three attractive NFTs and a busy activity feed would demo
beautifully. It would also be the single most damaging thing this product could ship: the
entire claim is that these records are independently verifiable, and a convincing fabricated
record on the main screen refutes that claim more effectively than any missing feature.

So the rule here is absolute. **Every value on this page was read from the API, or it is
absent and says why.** No seeded account, no illustrative row, no stock artwork.

## What is real

| Panel                              | Source                                      | Real?                                                                        |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Identity card (DID, wallet, roles) | `GET /auth/session`                         | Yes — claims from the verified session token, roles read on-chain at sign-in |
| QR code                            | The DID from that session                   | Yes — encodes the actual DID, and is absent when there is none               |
| Activity feed                      | `GET /audit?actor=<me>`                     | Yes — on-chain audit entries                                                 |
| Stat counters                      | Counted from that audit page                | Yes — counts of what was returned, never estimated                           |
| My Assets                          | `ASSET_MINTED` entries from the audit trail | Partly — see below                                                           |
| My Credentials                     | `CREDENTIAL_ISSUED` / `_REVOKED` entries    | Partly — see below                                                           |
| Network badge                      | `GET /network`                              | Yes                                                                          |

## The new endpoint

`GET /auth/session` was added for this phase. `POST /auth/verify` already returns identity,
but only once, and the session lives in an httpOnly cookie that script deliberately cannot
read — so after a reload the app is authenticated while having no way to say _who_. Without
this, showing your own DID would have required signing a fresh SIWE message.

It grants no new authority: it verifies the same access token every gated route verifies and
returns exactly the claims that token already carries, so anything learned from it was
already sufficient to make the request. Mutations still re-read the chain through
`requirePermission`, because a token minted before a revocation keeps the revoked role until
it expires. Six tests pin that boundary, including one asserting the response shape so a
later edit cannot quietly widen it.

## Why assets and credentials are derived

There is no `GET /assets?owner=` and no "list credentials for a subject". The asset
repository and the event indexer are not implemented, and `GET /assets/:id` answers 404 by
design rather than inventing a record.

What does exist is the audit trail: every mint, issuance and revocation is an on-chain event
attributed to the actor who requested it. Filtering it by the signed-in address is a
truthful — if minimal — account of what someone did, and it is enough to say "you minted
this token, in this block, in this transaction".

It is _not_ enough for a picture. Token metadata lives on IPFS behind a CID the audit entry
does not carry, so asset cards show a framed "metadata pending the asset indexer" panel. The
skeleton shimmer and the image error state are both built and wired; they are waiting on a
CID, not on styling. A test asserts no `<img>` is rendered when there is no CID, because
"just use a placeholder image" is exactly the shortcut that would undo the page.

Credential badges take one further precaution: a hash that appears in both an issuance and a
revocation is shown as **revoked**. The later fact wins. Showing it as valid because the
issuance event came first would be the worst bug this screen could have, and it has its own
test.

## Three kinds of nothing

An empty grid is ambiguous, and the three things it might mean are very different. Each gets
its own state and its own test:

1. **You have none.** The trail was read and returned nothing → empty state with an
   explanation and a way forward.
2. **You may not look.** `403` — reading the audit trail needs `VIEW_AUDIT`, which a plain
   USER does not hold. This is the RBAC working, and the page says so. Showing an empty grid
   instead would be making a claim about the chain that this account is not entitled to make.
3. **Nothing is available.** `503` — no usable network. Not empty; _unknown_.

The stat counters follow the same rule: when their source could not be read they show an em
dash rather than a confident `0`. A "0 assets" that nobody verified is a false statement.
"Roles held" keeps its number in that case, because it comes from the session rather than
the trail — each figure is blanked exactly when its own source failed.

## Deviations from the build plan

Two, both deliberate, both flagged rather than quietly decided:

- **"hover = lift + glow"** → lift and a brightening border. Glow was ruled out by the
  standing design instruction and by `docs/DESIGN.md`: a coloured halo here would spend a
  hue that means nothing, on a page where green and amber mean "verifiable" and "local only".
- **"Lottie illustration"** → inline animated SVG. A Lottie player is a dependency that
  needs a real animation file to justify it, and stock Lottie art is full-colour and rounded
  in a way that would be the loudest thing in a monochrome interface. These are line drawings
  in the palette, drawn in with the same motion primitive as everything else. If a designed
  Lottie file arrives, swapping it is a change to one component.

## Motion

Everything obeys `src/motion/`, unchanged from P3.1. Specific to this page:

- **Count-up** runs on scroll into view, and falls back to showing the final value
  immediately when `IntersectionObserver` is unavailable. A stat stuck at `0` is not a
  missing animation, it is wrong information.
- **The identity card tilts** only where a real hovering pointer exists
  (`(hover: hover) and (pointer: fine)`). On a phone every "hover" is a tap, and the card
  would lurch while being read.
- **The credential pulse marks a live credential only.** An animation on a revoked badge
  would read as "active" to anyone skimming.
- **Feed rows animate on entry, keyed by `entryId`**, so a poll returning the same page
  moves nothing — which is what stops a 30-second refresh looking like a nervous tic.

## Known limits

- The activity feed polls every 30s. There is no subgraph subscription to listen to, and on
  the local chain the `getLogs` fallback scans blocks on every call, so polling faster would
  cost more than it is worth.
- With no chain running, every panel correctly reports unavailable rather than empty. That
  is the designed behaviour, not a failure to work around.
