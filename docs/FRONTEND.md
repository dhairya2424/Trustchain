# Frontend — app shell, motion policy and wallet connect (P3.1)

The design brief for Phase 3 is that a centralized IAM dashboard feels like paperwork and
this should feel like a command deck. That is a real constraint, not decoration: the product
has to argue for itself on a landing page before anyone has signed in. What follows is how
that is built without the usual costs — an unusable page for anyone with motion sensitivity,
a hot phone for anyone on mid-range hardware, and a wallet modal that traps a keyboard user.

Stack: React 18, wagmi 3, viem, TanStack Query, react-router 7, Framer Motion, GSAP
ScrollTrigger, three.js. TypeScript 6.0.3 across the monorepo.

## Routes

| Route        | State                                                                |
| ------------ | -------------------------------------------------------------------- |
| `/`          | Complete — hero, scroll-revealed sections, wallet connect            |
| `/dashboard` | Scaffold, wallet-gated. Real contents land in P3.2                   |
| `/admin`     | Scaffold, wallet-gated. Roles and audit trail land in P3.3           |
| `/verify`    | Scaffold, deliberately public — no wallet, no account. Lands in P3.4 |

The three scaffolds state what they will contain and render no invented data. That is a
deliberate rule rather than laziness: on a platform whose entire claim is that its records
are independently verifiable, a mocked-up audit row that demos well is the one placeholder
that would undermine the product. A test asserts the disclaimer is present.

An unknown path renders a "page not found" rather than redirecting home, because silently
sending someone to the landing page hides the fact that their link was wrong.

## The motion policy

`prefers-reduced-motion` is respected through a single primitive rather than per component,
because "we respect the setting" is a promise that decays — the next animation someone adds
either forgets to check, or checks slightly differently, and it breaks silently for exactly
the people who need it.

- `src/motion/useReducedMotion.ts` observes the media query, live. The setting can be
  changed while the page is open on both macOS and Windows, so a value read once at import
  time would leave the app animating at someone who just asked it to stop.
- `src/motion/motion.ts` turns the answer into a `MotionScheme` — resolved durations,
  transitions, stagger delays and flattened variants.
- `src/motion/MotionProvider.tsx` supplies it. `useMotion()` **throws** outside the
  provider. Returning an un-reduced scheme instead would mean a component animates for
  people who opted out, silently; failing at first render surfaces it immediately.

Components receive an already-resolved scheme, never a boolean. There is no un-resolved
duration for a component to reach for, so it cannot animate without having consulted the
preference.

Reduced motion means **instant, not absent**. Transitions collapse to zero and elements
still arrive in their final state, so the interface still communicates what changed. The one
exception is the confetti burst, which is removed entirely — it carries no meaning to
preserve. The checkmark stays, undrawn, because the shape itself says "connected".

`src/styles/global.css` carries a `@media (prefers-reduced-motion: reduce)` block as defence
in depth for what CSS owns — hover transitions, keyframes, smooth scrolling — including
anything added later by someone who has not read `src/motion/`.

**Verified by regression:** forcing `createMotionScheme` to ignore its argument fails 13
tests across five files — the hook, the scheme, the typewriter, the hero tier and the
connect modal.

## The hero, and three tiers of device

`src/hero/` renders an animated chain-link particle network. It is the most expensive thing
in the app, and it is on the first screen anyone sees, so which renderer runs is decided from
declared capability rather than assumed:

| Tier       | When                                                   | What runs                     |
| ---------- | ------------------------------------------------------ | ----------------------------- |
| `static`   | Reduced motion                                         | A painted gradient. No loop.  |
| `canvas2d` | No WebGL, data saver, slow connection, <4 cores, <4 GB | 70 nodes, 2D, no depth        |
| `webgl`    | Otherwise                                              | 190 nodes, three.js, additive |

`selectRenderer` is a pure function over a capability snapshot, so the interesting cases —
two cores, data saver on, WebGL refused — are testable, which is impossible to arrange in a
real browser during a test run.

Design notes worth keeping:

- **The simulation is shared.** `field.ts` contains the physics with no rendering in it, so
  the 2D fallback is recognisably the same artwork rather than a different effect that shows
  up on weaker devices.
- **Absent capability hints are not treated as failure.** Safari and Firefox report neither
  `deviceMemory` nor `hardwareConcurrency`; penalising them would downgrade a large share of
  perfectly capable machines for a privacy decision.
- **three.js is dynamically imported**, and only from `renderWebgl.ts`. It is 735 kB — the
  single heaviest dependency — and the majority of visits never render it. A static import
  would put it in the entry chunk and make everyone download it in order not to use it.
- **The delta is clamped.** A backgrounded tab resumes with an enormous frame delta, and
  unclamped every node teleports across the field in one step.
- **GPU resources are disposed on unmount.** They are not garbage collected with the JS
  objects that reference them, and browsers cap live WebGL contexts, so a few navigations
  back to the landing page would otherwise kill the renderer outright.

The canvas is `aria-hidden` throughout — it is decoration with no information in it.

## Scroll reveals

`useScrollReveal` drives GSAP ScrollTrigger, and is written around one failure mode: a
reveal normally starts its target at `opacity: 0`. If the animation never runs — reduced
motion, a failed dynamic import, a trigger that never fires — the content stays invisible,
and the page has no content for exactly the visitors least able to work out why.

So the hidden state is only ever applied by the code that has already committed to animating
it back. Markup ships visible; GSAP hides and reveals. Under reduced motion the hook does
nothing at all.

## Wallet connect

`src/wallet/`. wagmi 3 with an injected connector always present, and WalletConnect added
only when `VITE_PUBLIC_WALLETCONNECT_PROJECT_ID` is set — its connector throws during
construction on an empty id, and because connectors are built at import time that would be a
white screen rather than a missing option.

Chains are Polygon Amoy then local Hardhat, matching the backend's own order of preference.
The frontend never decides which chain a write lands on: the backend's network selector does,
and reports it through `/network`. No mainnet appears in the list, and both a type-level
narrowing and a runtime test enforce that.

The flow is `choosing → pending → connected`, animated as the brief asks — staggered options,
pulse rings while pending, a stroke-drawn checkmark and a confetti micro-burst on success.
The parts that are not in the brief but decide whether it is usable:

- `role="dialog"` with `aria-modal` and a label
- focus moved into the dialog on open and returned to the opener on close
- Tab and Shift+Tab contained, so focus cannot walk into the still-focusable page behind
- Escape and scrim-click to dismiss, with the dialog stopping propagation so a click on a
  wallet option does not also dismiss it
- one `aria-live` region announcing each phase as text, since the animations are all
  `aria-hidden`
- body scroll locked while open

A wallet's error string is rendered as text by React and never as markup. It is
attacker-influencable in principle — a malicious injected provider controls it.

**A bug this caught:** the auto-close timer was originally set in the same effect that
advanced the phase to `connected`. The state change re-ran the effect, whose cleanup cleared
the timer it had just set, and the new run no longer matched the condition — so the modal
reached the success state and sat there forever. The timer now lives in its own effect keyed
on the phase.

## The typewriter tagline

Two things make it accessible rather than merely decorative. The full sentence is always in
the DOM in a visually-hidden span and the animated copy is `aria-hidden`, so a screen reader
reads the finished sentence once instead of re-announcing a live region on every keystroke —
which is what a naive typewriter does, and it is genuinely unusable. Under reduced motion the
text is simply present, not typed faster.

## Bundle

| Chunk           | Size   | Loaded                          |
| --------------- | ------ | ------------------------------- |
| `index`         | 214 kB | Always                          |
| `react`         | 180 kB | Always                          |
| `web3`          | 98 kB  | Always                          |
| `ScrollTrigger` | 44 kB  | Only when motion is not reduced |
| `three.module`  | 735 kB | Only on the `webgl` tier        |

React and the web3 stack are split into their own chunks because they change on a completely
different schedule from application code — without that, every deploy invalidates ~450 kB
that did not change. three.js and GSAP are deliberately _not_ named in `manualChunks`:
they are already separate because they are imported dynamically, and naming them would pull
them back into the static graph.

## Running it

```
npm run dev --workspace @trustchain/frontend    # http://localhost:5173
npm run dev --workspace @trustchain/backend     # http://localhost:4000
```

The frontend's origin must appear in the backend's `CORS_ORIGIN` — see `docs/CORS.md`. With
no chain running the network badge reports that no network is available rather than naming
one, which is the intended behaviour and not an error state to work around.

## Tests

104 frontend tests. The ones that matter most are the reduced-motion suite (proven by
regression to fail 13 ways if the preference is ignored), the renderer tiering, and the
modal's focus containment.
