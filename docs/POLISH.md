# Polish, accessibility and end-to-end (P3.5)

The pass that turns a working frontend into one that is pleasant, usable without a mouse,
and kept that way by tests rather than by care.

## Accessibility: zero axe violations, enforced

`src/a11y.test.tsx` runs axe against the rendered tree on **every route** — `/`,
`/dashboard`, `/admin`, `/admin/mint`, `/admin/roles`, `/verify` and the not-found page —
and on the interactive states a keyboard user actually lands in: the wallet dialog open, the
mint wizard past its first step, and a verdict on screen.

It found two real defects that review had missed:

- **Duplicate `main` landmark** (moderate). `AdminLayout` rendered its own `<main>` inside
  the shell's, so a screen-reader user navigating by landmark found two "main" regions with
  no way to tell which held the content.
- **Unlabelled file input** (**critical**). The mint wizard's file input is visually hidden
  but still focusable, and had no accessible name — a screen-reader user tabbing to it heard
  nothing at all.

Both are fixed. Three further tests assert what axe cannot: the skip link is the first
focusable element, every interactive element has an accessible name, and the current route
is marked with `aria-current` rather than colour alone.

**Two limits, stated rather than implied.** Colour contrast is not asserted in jsdom — it
computes no layout and resolves no CSS custom properties, so the rule cannot run and would
report a false pass. And axe takes static snapshots, so it cannot tell whether focus _moves_
correctly; that is covered by the component tests that drive it.

## Layout shift: measured, not assumed

The plan asks for "zero layout shift". That can only be checked in a browser, so it is a
Playwright assertion with a budget of 0.1 — Google's "good" threshold.

The first run measured **0.64**, six times over. Two causes, both real:

1. **The dashboard's loading state was one line of text.** "Reading your session…" occupies
   almost no height, so when the real page arrived it pushed the whole viewport down at
   once. Replaced with a skeleton shaped like the loaded page, reserving roughly the height
   each block will occupy.
2. **The network badge grew and rewrapped the header.** It starts as "Checking network…" and
   resolved to the network name plus its verifiability plus a 60-character fallback
   sentence, which wrapped the navigation onto a second line and pushed everything down.

The second fix is worth reading carefully, because it looks like it trades honesty for
layout and does not. The long "Fallback — Polygon Amoy unavailable; records are not publicly
verifiable" sentence is now confined to the `full` variant used on the dashboard and
verifier. The compact header badge still states `verifiabilityLabel` — "Locally Verifiable"
— in every variant, and still carries the amber tone. What moved is the _reason_, to the
pages with room to explain it. The header also reserves the badge's width so its resolution
cannot rewrap anything.

The assertion reports **which nodes shifted** on failure. A bare CLS number tells whoever
hits it only that something moved, which is the less useful half.

## Errors are sentences

`src/api/errors.ts` is the single place a failure becomes text. Three kinds would otherwise
leak into the interface, each bad for its own reason: API codes (`actor_mismatch`) are
precise and meaningless; RPC and wallet errors are long, name internals and often contain
"execution reverted" followed by a hex blob; and library exception messages were written for
developers.

So there is a table by code and a table by pattern — the wallet libraries offer no stable
codes for "user rejected" or "insufficient funds", so text matching is the only option — and
**an unrecognised error returns a plain sentence rather than the original text**. That
deliberately loses information at the boundary: an error we have not classified is one we
cannot promise is fit to display.

Where there is a request id it is surfaced separately, because that is what actually
connects a user's report to a log line.

## Caching, transitions and prefetch

- **Every read goes through TanStack Query.** The network badge was the last holdout, doing
  its own `fetch` and `setInterval`; since it renders in the header _and_ on the verifier,
  that meant two independent pollers asking the same question twice. One query key now means
  one request whatever the page renders.
- **Page transitions** use `AnimatePresence mode="wait"` so the outgoing page finishes
  leaving before the next arrives — both mounted at once means two pages' queries running
  and a doubled scrollbar. Keyed on `pathname`, so the verifier writing its result into the
  query string does not remount the page and discard what is on screen.
- **Route prefetch on hover _and focus_.** The 100–300ms between hover and click is usually
  enough for a local round trip, so the destination arrives with data. Bound to focus too —
  an optimisation that only helps pointer users is half an optimisation. It warms only what
  a route certainly needs, and never a mutation or a permission-gated read: a hover is not
  consent, and a 403 fired on mouse-over is a wasted request that also counts against a rate
  limiter.

## Playwright

`npm run e2e` — nine specs covering landing → dashboard → admin → verifier, plus keyboard
reachability and the layout-shift budget.

The API is stubbed at the network boundary with `page.route`. That is deliberate: it makes
the suite runnable in CI with no chain, database or relayer, and it lets a spec assert what
the UI does with a 403 or a 503 without manufacturing one on-chain. **A failure in this job
is unambiguously a frontend failure**, never an environment one.

The complementary claim — that the backend behaves correctly — is made by
`tools/e2e-flow.mjs` (91), `tools/e2e-roles.mjs` (18) and `tools/e2e-verify-page.mjs` (18),
which stub nothing and run against real infrastructure.

CI runs the browser job on Chromium only. The suite asserts layout, focus order and layout
shift, none of which differ enough between engines to justify tripling every push; the HTML
report uploads as an artifact on failure.
