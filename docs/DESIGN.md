# Design language

One rule holds the whole system together:

> **Colour means something.**

The interface is monochrome graphite. Every hue on screen is a status — verified, fallback,
revoked — so a coloured pixel is always information. That is not restraint for its own sake.
This product's entire claim is the difference between "publicly verifiable" and "local
only", and a UI that spends green and amber on ornament has thrown away the vocabulary it
needs to say the one thing that matters.

Structure is carried by 1px rules, alignment and spacing — closer to a spec sheet or an
instrument panel than to a marketing page.

## What that rules out

| Not used                      | Why                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gradients                     | Decorative by nature. A gradient headline is harder to read than a solid one, and a gradient button is a hue spent on nothing.                                             |
| Glow / coloured shadows       | Colour with no meaning, and it makes every surface look the same distance away. Depth comes from a hairline and honest elevation.                                          |
| Glassmorphism                 | Blur only earns its place when there is something live behind it. On `/admin` and `/verify` there is nothing to blur, so it was paying full paint cost for no effect.      |
| A brand accent                | There isn't one. Focus and "current" are high-contrast neutral, because those are _states_, not statuses, and a brand hue would compete with the three that carry meaning. |
| Additive blending in the hero | It sums overlapping particles toward white and blooms. That reads as a screensaver; the field is meant to read as a lattice.                                               |

The one surviving blur is the modal scrim, where two live layers genuinely need separating,
and the one surviving "gradient" is the legibility scrim on the grid-pattern card — a single
colour at varying alpha, fading a pattern out beneath text. Both do a job.

## Tokens

Defined in `src/styles/theme.css` under Tailwind v4's `@theme`, so they are available as
utilities (`bg-surface`, `text-fg-muted`, `border-line`) and as CSS variables.

**Surfaces** — neutral, no blue cast: `base` `#0b0b0c` → `surface` → `raised` → `hover`.

**Hairlines** — `line` for structure, `line-strong` for emphasis and for the edge of
anything interactive.

**Text** — three steps only: `fg`, `fg-muted`, `fg-faint`. A fourth always gets misused.

**Status** — the only chroma in the product:

| Token      | Colour | Means                                               |
| ---------- | ------ | --------------------------------------------------- |
| `verified` | green  | On a public chain. A stranger can check it.         |
| `fallback` | amber  | Running locally. Real, but only locally verifiable. |
| `revoked`  | red    | Revoked, expired, or refused.                       |

Never use a status colour for anything that is not that status. If you want emphasis, reach
for weight, size or a rule.

## Colour is never the only carrier

Roughly one in twelve men cannot reliably separate the green from the amber, and "is this
record publicly verifiable" is not a question to answer with hue alone. So:

- `Status` always pairs its colour with a dot **and** a text label.
- The active nav item changes **weight and background**, not just colour.
- The network badge always states its verifiability in words next to the chip.

## Components

`src/components/ui/` follows the shadcn convention — `cva` variants, `cn()` for conflict
resolution, `asChild` via Radix Slot — so anything pulled from shadcn or 21st.dev composes
rather than fights.

- **`button.tsx`** — `primary` is a solid near-white fill, which on a monochrome interface
  is the loudest thing available and needs no hue. `asChild` lets a router `<Link>` wear
  button styling while staying a real anchor.
- **`status.tsx`** — the only component permitted to be coloured.
- **`dialog.tsx`** — Radix. It owns focus containment, focus restoration, Escape, scroll
  lock and `aria-hidden` on the rest of the document. `aria-modal="true"` is set explicitly
  because Radix deliberately omits it, relying on `aria-hidden` instead; the two are
  complementary and assistive technology has read the attribute for a decade.
- **`grid-pattern-card.tsx`** — adapted from _Card with Grid Pattern_ by
  [@Ali-Hussein-dev on 21st.dev](https://21st.dev/Ali-Hussein-dev/card-with-grid-pattern).
  Two changes were required, both instructive:
  - Its entrance animation ran unconditionally, which would animate at people who asked the
    system not to. Routing it through `useMotion()` would fix that, but its `whileInView`
    form carries a worse hazard — it starts at `opacity: 0` and depends on an
    IntersectionObserver firing to come back, so wherever that observer is missing the
    content is simply invisible. Reveal is left to `useScrollReveal`, the one mechanism here
    that handles it safely, and the card is purely presentational.
  - Its zinc light/dark palette became our surface tokens.

## On importing components

The catalog is worth searching and mostly worth rejecting. Most of what is on 21st.dev is
gradient-and-glow SaaS styling, which is precisely what this system is defined against.
Two things to check before pasting anything:

1. **Does it animate unconditionally?** Almost all of them do. It must consult `useMotion()`
   or it breaks the accessibility guarantee documented in `docs/FRONTEND.md`.
2. **Does it introduce a hue?** If the colour is not carrying a status, strip it.

## Motion

Unchanged by this pass and documented in `docs/FRONTEND.md`: `prefers-reduced-motion` is
resolved once in `src/motion/` and every animated component takes an already-resolved
`MotionScheme` rather than a boolean. Reduced means instant, not absent.
