# Interaction Fidelity — Phase 1 of the UI polish pass

**Date:** 2026-07-20
**Status:** Approved, ready for implementation
**Note:** Working artifact. Delete once implemented and verified; the durable
rules move into `docs/design-system.md`.

## Problem

An audit of the app against its own design system found the *static* system in
good shape and the *interaction* layer inconsistent.

| Check | Result |
|-------|--------|
| Hardcoded palette (violates tokens) | 2 files |
| Bare `rounded` (breaks the radius setting) | 0 |
| Reduced-motion support | already wired (`data-reduced-motion`) |
| **Keyboard focus rings** | **~20 files** with `hover:` and no `focus-visible` |
| **Hover transitions** | **11 of 42** files animate nothing |
| `disabled:` / `aria-label` | 18 / 20 across ~53 hand-rolled buttons |

The `Button` primitive has a proper focus ring, but most interactive surfaces
are hand-rolled `<button>` elements that skipped it — including the core
navigation: TabStrip, Dock, CollectionTree, TitleBar. Tabbing through the app
gives no visible indication of position. Separately, motion is inconsistent
rather than absent: some elements ease into hover, others snap.

## Approach

Chosen: **a systemic baseline in `index.css`, plus targeted supplements.**

Rejected: per-file utility classes (~20 diffs, and the next hand-rolled button
omits it — the drift returns) and routing every button through the `Button`
primitive (rewrites TabStrip, Dock and CollectionTree; several elements are not
button-shaped; high regression risk on core navigation for a polish pass).

Two existing facts make the systemic route clean rather than blunt:

- The reduced-motion rule already sets `transition-duration: 0.01ms !important`
  app-wide, so any transition baseline is neutralised automatically.
- `--ring` is already defined per accent theme, so a ring built on it follows
  the user's colour scheme for free.

## Baseline

Placement: `@layer base` in `app/src/index.css`. Base layer plus `:where()`
gives zero specificity, so any component utility (utilities layer) overrides it
without `!important`.

```css
@layer base {
  /* Keyboard focus baseline. :focus-visible fires only on keyboard/AT focus,
     never a mouse click — pointer users see no change. */
  :where(button, [role="button"], a[href], input, select, textarea, summary,
         [tabindex]:not([tabindex="-1"])):focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }

  /* Paint-only transitions — never layout properties, so no reflow jank. */
  :where(button, [role="button"], a[href], summary) {
    transition: background-color 150ms ease, color 150ms ease,
                border-color 150ms ease, opacity 150ms ease;
  }
}
```

**`outline`, not `box-shadow`/`ring`** — outline does not participate in layout,
and modern browsers make it follow `border-radius`, so it tracks the
user-adjustable roundedness setting with no extra code.

**Paint properties enumerated, not `transition: all`** — cannot animate a layout
property and cause jank.

**150ms is a new documented value.** `design-system.md` defines 0.2s for
`fade-in`/`slide-in`, but those are *entrances*. Hover state-changes at 200ms
read as sluggish. 150ms is recorded as the "interaction state" duration,
distinct from entrance timing.

Existing primitives (`button`, `input`, `switch`, `tabs`, `textarea`,
`resizable`) already carry `focus-visible:ring` utilities and therefore override
the baseline, keeping their current appearance. This change is additive.

## Targeted supplements

Two containers clip an outset ring:

- **TabStrip tabs** — `<div role="tab" tabIndex={0}>` with `h-full` inside an
  `overflow-x-auto` row; an outset ring clips top and bottom.
- **Drawer rows** — `w-full` buttons inside the Drawer's `overflow-hidden`; an
  outset ring clips left and right.

Scope the inset by **container** rather than adding a class to every row
component (6+ files, and new rows would forget it):

```css
@layer base {
  /* Inside clipping panels an outset ring is cut off, so tuck it inward. */
  :where(.panel-clip) :where(button, [role="button"],
         [tabindex]:not([tabindex="-1"])):focus-visible {
    outline-offset: -2px;
  }
}
```

`.panel-clip` goes on the **clipping container itself** — the element carrying
the `overflow-*` — so every focusable descendant inherits the inset. Exactly two
elements:

| File | Element |
|------|---------|
| `components/layout/Drawer.tsx` | the view-content wrapper, `flex-1 overflow-hidden flex flex-col min-w-0` |
| `components/layout/TabStrip.tsx` | the `role="tablist"` row, `flex h-full min-w-0 items-stretch overflow-x-auto` |

Every row inside them, current and future, inherits the correct ring.

A `.focus-ring-inset` utility is added as an escape hatch for one-off cases
outside those containers.

**Deliberately unchanged:** the tab close button is `tabIndex={-1}` and stays
out of tab order. A tab stop per close button makes tabbing noisy, and ⌘W
already closes the active tab. Recorded as a decision, not an oversight.

## Verification

**Automated — keyboard reachability.** jsdom does not apply `index.css`, so a
test asserting `outline` styles would pass regardless of whether the CSS is
correct; such a test is worse than none. What is genuinely testable is that the
core navigation surfaces (TabStrip tabs, Drawer rows, Dock buttons) are
focusable and in sensible tab order. That is the real bug class and it gets
tests.

**Manual — appearance.** Requires a running app:

- ring visible and not clipped on TabStrip tabs, Drawer rows, Dock buttons
- light *and* dark mode
- at least two accent themes (`--ring` is theme-aware; it must read well in more
  than the default)
- reduced-motion still collapses the new transitions
- mouse users see no focus ring on click (confirms `:focus-visible`, not `:focus`)

**Standard gates:** `pnpm type-check`, `pnpm test`, `pnpm build`.

## Deliverables

1. `app/src/index.css` — focus baseline, transition baseline, `.panel-clip`
   inset rule, `.focus-ring-inset` utility
2. `.panel-clip` applied in two files — Drawer content wrapper, TabStrip row
3. `docs/design-system.md` — the 150ms interaction-state duration, the focus
   baseline, and the `.panel-clip` convention
4. Keyboard-reachability tests for the core navigation surfaces

## Out of scope

- Typography, spacing, density and colour — Phase 2 (visual refinement)
- Consolidating hand-rolled buttons into the `Button` primitive
- Empty, loading and error states
- The two remaining hardcoded-palette files (separate cleanup)
