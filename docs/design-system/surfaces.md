---
description: >-
  The elevation, foreground, interactive-state and border tokens, and the rule for letting a surface pick its border token.
---

# Surface, foreground and border tokens

## Elevation

```css
/* Dark */
--background: 240 10%  4%;   /* #09090b - outermost canvas */
--panel:      240  6%  7%;   /* #111113 - sidebar / panel bg */
--card:       240  6% 11%;   /* #1a1a1f - elevated surface */

/* Light */
--background: 240  6% 96%;  /* #f4f4f5 - paper-white canvas */
--panel:      240  5% 98%;  /* #fafafa - panel */
--card:         0  0% 100%; /* #ffffff - white card */
```

## Foreground Scale

```css
/* Dark */
--foreground:         240  5% 96%;   /* #f4f4f5 - primary text */
--muted-foreground:   240  5% 65%;   /* #a1a1aa - secondary / labels */
--subtle-foreground:  240  4% 44%;   /* de-emphasized text - faintest readable tier */

/* Light */
--foreground:         240  6% 10%;   /* #18181b - primary text */
--muted-foreground:   240  4% 42%;   /* secondary / labels (see note) */
--subtle-foreground:  240  4% 58%;   /* de-emphasized text - faintest readable tier */
```

`subtle-foreground` is the least-prominent text tier, and it is **deliberately below AA** - 2.69:1 light, 2.89:1 dark against the surfaces it sits on.

**That is structural, not a tuning miss.**
For it to clear 4.5 it would have to darken to ~42% lightness in light mode, which is exactly `muted-foreground`.
The tier cannot be both fainter than muted and AA-compliant; there is no room between them.

So it is reserved for text where a miss is acceptable and the meaning survives without it: **units** (the `ms` after a number), **dashes and dash placeholders**, and decorative icons.
Never for a label, a count, a legend, or anything the user has to read - a dashboard sweep once found 20 such misuses ("dispatched", "4xx 0", "target 10"), all measuring 3.34:1.
Those belong on `muted-foreground`.
A chart's axis tick labels and a list's day-group headings are labels in this sense: the uPlot theme's `text` and the `Eyebrow` headings sit on `muted-foreground`.
`subtle-foreground-text.test.ts` keeps it that way - every file allowed to write `text-subtle-foreground` is named in its ledger with a permitted count, so a new use fails until someone argues it is a unit, a dash or a decorative icon.

**Light `muted-foreground` is 42%, not zinc-500's 46%.**
It is solved against the *darkest* light surface it lands on - `--muted`/`--accent` at 93%, not the card.
At 46% it cleared the card (4.86) and the panel (4.64) but measured **4.13 on `--muted`**, so muted text on any tinted chip or hovered row missed 4.5.
At 42% every one of those surfaces clears: card 5.62, panel 5.37, background 5.12, `--muted` 4.77.
The darkening is not perceptible on its own but moves a whole class of text over the line.

One surface still does not clear it: `--accent-active` (88%), the selected-row background, where 42% measures **4.22**.
Muted text on a selected row is therefore slightly under AA.
Darkening further to fix it would collapse the gap to `--foreground`, so this is a known limit rather than an oversight - prefer `--foreground` for text that must stay readable on a selected row.

## Interactive States

```css
/* Dark */
--accent:        240  7% 16%;   /* #26262c - hover background */
--accent-active: 240  6% 21%;   /* #323238 - selected / active background */

/* Light */
--accent:        240 5% 93%;   /* #ededef - hover background */
--accent-active: 240 5% 88%;   /* #e0e0e4 - selected / active background */
```

## Borders

```css
/* Dark */
--border:        0  0% 10%;   /* ≈ rgba(255,255,255,0.07) - default dividers */
--border-strong: 0  0% 18%;   /* ≈ rgba(255,255,255,0.15) - prominent borders */

/* Light */
--border:       240  6% 89%;   /* #e2e2e5 - default dividers */
--border-strong: 240 5% 82%;   /* #cfcfd5 - prominent borders */
```

## `border-rule`: let the surface pick the token

Because that ancestry question has to be answered correctly every single time, and was not - the same defect was found and fixed one component at a time about ten times - the answer now lives in the stylesheet instead of in this document.

A **surface class** sets its background *and* the `--rule` that reads on it.
A divider says `border-rule` and inherits the right value, including through nesting: a `surface-sunken` slab inside a `surface-card` re-declares `--rule`, so rows in the slab get the slab's colour while the card's own dividers keep the card's.

```tsx
<div className="surface-card">            {/* declares --rule */}
  <div className="border-b border-rule">  {/* resolves to the card's */}
    <div className="surface-sunken">      {/* re-declares --rule */}
      <div className="border-b border-rule" />  {/* resolves to the slab's */}
```

Measured in the running app, both themes:

| surface | light | dark |
|---|---:|---:|
| canvas / panel (`:root` default) | 1.186 | 1.143 |
| `surface-card` | 1.304 | 1.278 |
| `surface-sunken` | 1.356 | 1.343 |

The card rule is **per theme on purpose**.
No single token serves both: `--border` is right in light (1.304) and invisible in dark (1.003), while `--border-strong` fixes dark (1.278) but overshoots light to 1.553.
`--rule` is a variable, so each theme gets the token that lands on ~1.29 - the parity this section already asks for.
Being able to do that is the point of centralising.

This does not make the mistake impossible; it makes it **enumerable**.
A `border-rule` whose ancestors declare no surface falls back to the `:root` default and is invisible on a card again - so the guard pins the *declarations* (`surface-rule.test.tsx`), not the `border-rule` classes, which prove nothing on their own.
Resolved colour is a computed-style question and is checked in the browser.

Definitions live in `app/src/index.css` under "Surfaces, and the rule colour that reads on each".
`Card` itself carries the `bg-card surface-card` pair, so a card and everything inside it resolve `border-rule` without the call site declaring anything; add `surface-card` to a `Card` and you are repeating the primitive.
Adopted by the response-viewer family, the import dialog (`ImportModal.surface-rule.test.tsx` guards the latter's declarations) and the command list, whose `Command` root declares `bg-card surface-card` so the input's divider,
the section separators and the footer can all say `border-rule` (`command.chrome.test.tsx`), the collection `InheritanceChain` card and the dashboard's `MetricsView` with its hero, stat and chart cards (`MetricsView.surface-rule.test.tsx`);
the rest of the app still uses explicit tokens and can migrate as it is touched.
A progress or stacked-bar track filled with `--accent` carries no border at all, since no border token reads there.

A surface a component only *looks* like it has is the case the command list answers: it painted `bg-popover`, which no surface class declares.
`--popover` and `--card` hold the same three numbers in both themes, and their foregrounds do too, so it declares the card rather than gaining a `surface-popover` that would be a second definition with nothing behind it.
Check the values before copying that move - two tokens that merely look alike are two surfaces.

One trap the import dialog documents: `surface-card` **cannot simply replace** a background utility that a primitive already sets.
The surface classes live in `@layer components`, and a utility (`bg-background` on `DialogContent`) outranks any component-layer class - while tailwind-merge does not recognise `surface-card` as a background class, so it will not strip the primitive's utility either.
On such an element write the pair `bg-card surface-card`: the utility wins the cascade, the surface class contributes the `--rule` declaration, and both set the same colour.

**On `--muted` there is no border to pick.**
It is the one surface where `--border-strong` is *weaker* than `--border`: `--muted` (L 16%) sits between them (L 10% and L 18%) in dark, so the usual escape hatch makes the edge fainter still, 1.11 against 1.16, and neither is visible.
In light the pair inverts, 1.11 and 1.32, so whichever token is chosen one theme gets no edge at all.
A `bg-muted` block has to be defined by its fill instead, which separates from a card at 1.18 light / 1.15 dark - the treatment the console log slabs and the response viewer's boxed metadata use.
`--accent` carries the same value as `--muted` in both themes and behaves identically.

That fill-not-border guidance is about a *block* separating from its parent.
An edge that is itself the point is different: the import drop zone's dashed border is a drag-target affordance, and it uses `surface-sunken` + `border-rule` - the alpha-of-`--foreground` rule is the one edge that does work on this fill, and the strongest available in both themes (1.356 light / 1.343 dark).
The `border-border-strong` it previously kept "for prominence" is in fact the *faintest* option there in dark (1.11, per the table above).
Decided in issue #69; the detected-collections preview list in the same dialog got the same treatment.

The switch on rows in the first table above are the default scheme (Ocean) with the track on `bg-primary-fill`.
They used to read `--primary`, which brightens in dark: the track was 5.89 against the card but only 2.94 under the white thumb.
`checked-control-contrast.test.ts` holds the thumb and the checkbox's check at 3.0 on the fill in every dark scheme, and holds the on switch's edge against the card at 3.0 in every dark scheme.
The track fill alone stays under the bar on `aurora` (2.98), so the checked state also paints the reserved 2px border with `--primary` (`data-[state=checked]:border-primary`): that edge measures 5.79 on the card at its weakest (`coral`) and 6.47 on `aurora`, and it carries the 3:1.
In light `--primary` equals `--primary-fill` in `ocean` and `aurora`, where the edge is invisible; in the other six it is three to six points darker than the fill (#3499), a slightly deeper rim of the same hue.

The focus ring needed no work, which is the one that matters most for keyboard users - worth knowing so nobody "fixes" it.

`--border` at 1.00–1.30 is deliberate and stays: it is a seam between surfaces, not the thing identifying a control.

**`--input` is not in that category, and the note above used to lump it in.**
For a field with `bg-transparent` - `Input`, `Textarea` and `SelectTrigger` all are - the border *is* the thing identifying the control, so 1.4.11 applies to it.
In dark mode it was `240 6% 11%`, byte-identical to `--card`: a boundary of 1.00, absent rather than faint.
Light mode masked the same weakness because `shadow-sm` gives a light field an edge and a shadow contributes nothing on a dark ground.

It is `240 6% 26%` now - 1.64 on the card, 1.79 on the panel, 1.89 on the background.
A real boundary, still quiet, and **still short of 3.0**: reaching that needs ~42% lightness, which turns every input into a hard outline.
Recorded as a known gap rather than claimed as a pass.
Where a boundary *is* the only identifying information, it needs its own colour rather than the border token - which is exactly what the switch needed.
Its off state now colours the 2px border it had already reserved, with `subtle-foreground` (3.17 / 3.34), the faintest tier that clears the bar.
The fill stays quiet on purpose; `muted-foreground` would pass at 5.61 / 6.77 and make an off switch read almost as loudly as an on one.
Its on state uses the same border for the accent edge described above, which is why the border stays 2px in both states: a 1px edge would change `border-2` and the thumb's 24px travel for the unchecked switch too.

Measure with transitions frozen.
An unchecked switch first measured 13.58 in light, which was a `transition-colors` mid-flight reading, not a colour.
