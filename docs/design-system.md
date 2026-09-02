---
description: >-
  Vayu's UI design system: colour tokens, the elevation model that inverts between themes, typography, spacing and component patterns.
---

# Vayu Design System

> Reference for all UI tokens, component patterns, and visual conventions.
> Future sessions must read this before touching any UI file.

---

## Philosophy

**3-level elevation** - every surface sits on one of three layers. Nothing floats outside this hierarchy.

| Level | Token | Dark | Light |
|-------|-------|------|-------|
| Canvas (outermost) | `bg-background` | `#09090b` | `#f4f4f5` |
| Panel (sidebar/header/toolbar) | `bg-panel` | `#111113` | `#fafafa` |
| Card (content surface) | `bg-card` | `#1a1a1f` | `#ffffff` |

**`--tab-active`** is a fourth, single-purpose surface for the active tab. It
exists because the elevation model inverts between themes: in dark, `background`
is *below* `panel`, so an active tab matching the content pane reads darker than
the bar - correct. In light, `background` (96%) is *lighter-adjacent* to `panel`
(98%), so the same rule gave only ΔL\* 2.06 of separation and put the active tab
on the wrong side of the convention (active tabs are normally the lightest thing
in light UIs). `--tab-active` deepens it to ΔL\* 4.82 in light and stays equal to
`--background` in dark, where nothing needed fixing.

The active tab also carries a `border-t-2 border-t-primary` stripe. That is the
*primary* signal, because it reads identically in both themes, where a surface
shift does not. Inactive tabs carry `border-t-2 border-t-transparent` so the
stripe does not displace their contents by 2px.

**Paper White light mode** - light surfaces use a cool near-neutral (zinc) family; higher surfaces are lighter (canvas → panel → white card).  
**Dark canvas** - dark mode uses near-black with subtle violet undertones (zinc-950 family).

---

## CSS Custom Properties

All tokens live in `app/src/index.css` as HSL channel values (no `hsl()` wrapper - `@theme inline` and Tailwind config add that). Separate light and dark values are listed where they differ.

### Elevation

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

### Foreground Scale

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

`subtle-foreground` is the least-prominent text tier, and it is **deliberately
below AA** - 2.69:1 light, 2.89:1 dark against the surfaces it sits on.

**That is structural, not a tuning miss.** For it to clear 4.5 it would have to
darken to ~42% lightness in light mode, which is exactly `muted-foreground`. The
tier cannot be both fainter than muted and AA-compliant; there is no room
between them.

So it is reserved for text where a miss is acceptable and the meaning survives
without it: **units** (the `ms` after a number), **dashes and dash
placeholders**, and decorative icons. Never for a label, a count, a legend, or
anything the user has to read - a dashboard sweep once found 20 such misuses
("dispatched", "4xx 0", "target 10"), all measuring 3.34:1. Those belong on
`muted-foreground`.

**Light `muted-foreground` is 42%, not zinc-500's 46%.** It is solved against
the *darkest* light surface it lands on - `--muted`/`--accent` at 93%, not the
card. At 46% it cleared the card (4.86) and the panel (4.64) but measured
**4.13 on `--muted`**, so muted text on any tinted chip or hovered row missed
4.5. At 42% every one of those surfaces clears: card 5.62, panel 5.37,
background 5.12, `--muted` 4.77. The darkening is not perceptible on its own but
moves a whole class of text over the line.

One surface still does not clear it: `--accent-active` (88%), the selected-row
background, where 42% measures **4.22**. Muted text on a selected row is
therefore slightly under AA. Darkening further to fix it would collapse the gap
to `--foreground`, so this is a known limit rather than an oversight - prefer
`--foreground` for text that must stay readable on a selected row.

### Interactive States

```css
/* Dark */
--accent:        240  7% 16%;   /* #26262c - hover background */
--accent-active: 240  6% 21%;   /* #323238 - selected / active background */

/* Light */
--accent:        240 5% 93%;   /* #ededef - hover background */
--accent-active: 240 5% 88%;   /* #e0e0e4 - selected / active background */
```

### Borders

```css
/* Dark */
--border:        0  0% 10%;   /* ≈ rgba(255,255,255,0.07) - default dividers */
--border-strong: 0  0% 18%;   /* ≈ rgba(255,255,255,0.15) - prominent borders */

/* Light */
--border:       240  6% 89%;   /* #e2e2e5 - default dividers */
--border-strong: 240 5% 82%;   /* #cfcfd5 - prominent borders */
```

### Primary (Accent Color)

Set by the `[data-color-scheme]` attribute; the default is **Ocean**
(`DEFAULT_COLOR_SCHEME` in `constants/color-schemes.ts` is the source of truth).
The accent is **split into two tokens** to resolve a contrast bind:

- **`--primary`** - the accent used for text, borders, rings, tints, indicators
  (`text-primary`, `border-primary`, `bg-primary/10`). Mode-adaptive: deep on
  the light card, brightened on the near-black dark canvas so it reads in both.
- **`--primary-fill`** - solid button/badge backgrounds that carry a white
  label (`bg-primary-fill`). Kept deep in **both** modes so white text clears
  AA-large (a brightened dark accent would fail white-on-fill).

Rule: white-labelled solid fills use `bg-primary-fill`; everything else accent
uses `--primary`. `--primary-foreground` (white) sits on the fill.

```css
/* Sunset (the values below; the default scheme is Ocean) */
--primary:       24 90% 46%;   /* light - deep accent */    /* dark: 24 95% 58% (brighter) */
--primary-fill:  24 90% 46%;   /* both modes - white-safe button fill */
--primary-text:  var(--primary);   /* accent as a label - see below */
--primary-foreground: 0 0% 100%;
--ring / --variable: track --primary
```

**`--primary-text` - the accent when the accent *is* the label.** Used by the
section tabs for the active trigger (`text-primary-text`), where the accent has
to separate not from the surface but from the `--muted-foreground` label beside
it.

It is not sufficient on its own, and the tabs pair it with a 2px underline on
`--primary`. Colour plus weight leaves the active tab hard to find in graphite,
where the accent is a neutral: the label then differs from an inactive one in
lightness alone, and 12px at 600 against 500 is a difference you have to hunt
for. A rule is a *shape*, which no accent can wash out. Note the split - the
label takes `--primary-text` and the indicator takes `--primary`, because one is
text and the other is an indicator.

That separation is carried almost entirely by **saturation**, not lightness.
Measured on `--card`, accent text and muted text sit within a **1.01-1.56**
contrast ratio of each other in every scheme - effectively the same brightness -
so what the eye reads is "coloured vs grey". At 55-95% saturation against an
inactive 4-5% that is plenty, which is why `--primary-text` defaults to
`--primary` and seven of the eight schemes never override it.

`graphite` overrides it, because it is the only desaturated scheme (S=12% light,
15% dark) and so has no hue to spend: `220 12% 26%` light and `220 15% 86%`
dark, which take its active-vs-inactive separation from 1.14 to 1.86 and 1.23 to
1.81. Retuning graphite's `--primary` instead is not an option - that also
paints its buttons, ring and `--chart-1`, and would give it near-black buttons.
This is the same bind `--primary-fill` exists to solve, answered the same way.

**Adding a scheme:** override `--primary-text` only if the accent's saturation
is under about 25%. `color-schemes.test.ts` derives that rule from the
stylesheet rather than naming graphite, so a new desaturated scheme fails until
it declares one. It is deliberately *not* in that test's `REQUIRED` list -
inheriting it is correct for a saturated scheme, not a forgotten block.

Note the ratios above are between two *foreground* colours; neither WCAG nor
APCA is defined for that, so treat them as a discriminability proxy rather than
a conformance figure.

### Semantic Status Colors

These differ between light and dark mode.

```css
/* Light */
--success:            142 76% 36%;   /* green */
--warning:             38 92% 50%;   /* amber */
--info:               199 89% 38%;   /* cyan */
--destructive:          0 84% 48%;   /* red */

/* Dark */
--success:            142 70% 45%;   /* lighter green */
--warning:             38 92% 50%;   /* same */
--info:               199 89% 55%;   /* brighter on a dark plot */
--destructive:          0 62.8% 30.6%;  /* darker red */
```

`--info` used to be one value in both modes, like `--warning` still is. It was
never measured, and at `199 89% 48%` it scored **2.85** on a light card against
the 3.0 bar - while painting three chart series (wire, send rate, connections).
Mode-consistency is deliberate for the `--status-*` indicators, where one value
must read as the same signal on either surface; `--info` had no such reason, so
it is split like everything else here.

### Chart series tier

A chart series is a stroke or fill on a plot that sits on `--card`, so its job
is an icon's: be distinguishable from the surface behind it. That is not the job
`--warning` and `--destructive` are tuned for, and asking them to do both failed
in opposite directions - `--warning` measured **2.14** on a light plot (amber is
intrinsically light) and `--destructive` **1.73** on a dark one, because in dark
it is a deep red chosen to carry a white button label, which all but vanishes on
near-black.

```css
/* Light */
--series-success:  142 76% 36%;   /* 3.35 on card */
--series-warning:   38 92% 36%;   /* 3.98 */
--series-danger:     0 84% 48%;   /* 4.87 */

/* Dark */
--series-success:  142 70% 45%;   /* 7.45 */
--series-warning:   38 92% 50%;   /* 8.09 */
--series-danger:     0 84% 60%;   /* 4.57 */
```

Split per theme rather than mode-consistent, because charts re-read their tokens
on a light/dark flip (`currentThemeKey`), so neither end has to compromise.
`--warning` and `--destructive` keep their banner and button values and are no
longer painted onto a plot.

`status-token-contrast.test.ts` derives what it checks from `ROLE_TOKEN` itself,
so repointing a chart role at a token that fails is caught. A first version
listed the token names by hand and was decorative: pointing the roles back at the
button tokens left it green, since it went on checking the `--series-*` values
that still existed.

**`-text` variants for legible text.** The base `--success` / `--warning` /
`--destructive` tokens are tuned as *fills and indicators*; as small text on a
light surface they fall below AA. Use the darkened (light) / lightened (dark)
`-text` variant when the color is the text itself - `text-success-text`,
`text-warning-text`, `text-destructive-text` - keeping `bg-*` / `border-*`
fills on the base token.

```css
/* Light - accessible text on light surfaces */
--success-text:  142 72% 27%;   --warning-text:  38 90% 30%;   --destructive-text: 0 60% 48%;
/* Dark - accessible text on dark surfaces */
--success-text:  142 60% 55%;   --warning-text:  40 92% 60%;   --destructive-text: 0 65% 65%;
```

**Every `-text` token is solved against the darkest surface it can land on -
`--muted`/`--accent` (93%) in light, `--card` (11%) in dark - not against the
card.** That distinction is not academic: tuned against the card, the light
green and amber measured 4.04 and 3.57 on `--muted`, so a status message on a
tinted chip failed while the same colour on a card passed. The dashboard's
"⚠ ramp off target" is what surfaced it.

The current floor across all four surfaces, both themes, is **4.63** (light
amber). If you add or retune a text token, measure it against all four
surfaces, not the one you happen to be looking at.

**The bare token is the fill; the `-text` token is the foreground.** This is the
whole of the rule, and it is worth stating separately because the failure mode is
easy to miss: a bare token used as a foreground still *looks* like the right
colour, it is just too close in luminance to the surface behind it. Measured on
`bg-card` in the running app (contrast ratio; **bold fails** the 4.5 floor for
normal text, and the two worst also fail the 3.0 floor for icons):

| family           | light bare | light `-text` | dark bare | dark `-text` |
|------------------|-----------:|--------------:|----------:|-------------:|
| `destructive`    |       4.87 |          5.48 |  **1.73** |         5.40 |
| `success`        |   **3.33** |          5.71 |      7.46 |         8.81 |
| `warning`        |   **2.13** |          5.46 |      8.13 |         9.81 |
| `status-success` |   **2.30** |          5.71 |      7.53 |         8.81 |
| `status-error`   |   **3.78** |          5.88 |      4.59 |         5.85 |
| `status-stopped` |   **2.79** |          5.73 |      6.23 |         7.40 |
| `status-running` |   **3.64** |          5.99 |      4.77 |         6.75 |
| `status-warning` |      17.72 |         17.72 |     15.78 |        15.78 |

Note the inversion: `destructive` is the only family that fails in **dark**,
every other family fails in **light**. That rules out "a dark-mode bug" as the
diagnosis - the single cause is the fill token standing in for the foreground
one, and which mode it breaks in just depends on where that fill sits relative to
the surface. `destructive` on `bg-destructive/10` and on `bg-background` measures
worse still (4.14 / 4.43 light, 1.69 / 1.99 dark), so a tinted error chip is the
worst case, not the safe one.

`status-warning` is the exception: it has no `-text` variant, because the bare
token already measures 17.72 / 15.78. Leave it as-is.

Icons count. 1.73 fails the non-text threshold as surely as the text one, so a
red `AlertCircle` is in scope, not just the sentence next to it. So are opacity
variants - `text-destructive-text/50` on an error icon is a fainter version of
the problem, and on an error affordance the fading is working against the point
anyway. Drop the opacity rather than carrying it over.

One measured surface is worth calling out because it does *not* reach 4.5 even
after the fix. The row-action delete button (`rowActionDestructive`) hovers on
`--accent-active`, where the fill token gives 3.66 light / 1.27 dark and
`destructive-text` gives 4.12 / 3.96. Those clear the 3.0 icon floor but not the
4.5 text floor, and the variant is icon-only by design - every call site renders
a `Trash2` at `size="icon"`. Putting a text label in it would stop it passing.

`app/src/components/ui/status-color-tokens.test.ts` enforces this: it fails on
any `text-<family>` in `app/src` (including `hover:`/`focus:` prefixes and `/NN`
opacity forms) while allowing `bg-*`, `border-*` and `*-foreground`, which are
correct uses of the fill token.

**Non-text contrast (WCAG 1.4.11) is a separate 3.0 bar**, and it applies to
things text contrast never touches: focus rings, control boundaries, and the
*states* of a control. Measured in the running app:

| what | light | dark | verdict |
|------|------:|-----:|---------|
| `--ring` vs every surface | 4.57–5.39 | 5.11–6.75 | passes comfortably |
| `--border` / `--input` vs card | 1.30 | 1.00 | decorative only - see below |

**A divider *inside* a card needs `border-border-strong`.** `--border` is
tuned for the canvas - its dark value is commented "= rgba(255,255,255,0.07)
on dark canvas", where it measures 1.14. Measured against the surfaces it is
actually used on:

| | canvas | panel | card | muted |
|---|---:|---:|---:|---:|
| `--border` | 1.14 | 1.08 | **1.00** | 1.16 |
| `--border-strong` | 1.47 | 1.39 | 1.28 | **1.11** |

At 1.00 the divider is the same colour as the card and simply is not there
in dark mode. `--border-strong` gives 1.28, which is what `--border` itself
achieves on a card in light mode - so the strong token on dark reads the way
the default token reads on light. This is not enforced by a test: whether a
border sits on a card is an ancestry question a source scan cannot answer.

**Ask what the box sits *on*, not what it is.** A card's own outline is fine on
`border-border`, because that edge faces the canvas, where the token measures
1.14 as designed. The 1.00 case is a rule *inside* a card. Both look like
`border border-border bg-card` in the source, and only the ancestry tells them
apart - so measure the parent's computed background before calling one a defect.

### `border-rule`: let the surface pick the token

Because that ancestry question has to be answered correctly every single time,
and was not - the same defect was found and fixed one component at a time about
ten times - the answer now lives in the stylesheet instead of in this document.

A **surface class** sets its background *and* the `--rule` that reads on it.
A divider says `border-rule` and inherits the right value, including through
nesting: a `surface-sunken` slab inside a `surface-card` re-declares `--rule`, so
rows in the slab get the slab's colour while the card's own dividers keep the
card's.

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

The card rule is **per theme on purpose**. No single token serves both:
`--border` is right in light (1.304) and invisible in dark (1.003), while
`--border-strong` fixes dark (1.278) but overshoots light to 1.553. `--rule` is a
variable, so each theme gets the token that lands on ~1.29 - the parity this
section already asks for. Being able to do that is the point of centralising.

This does not make the mistake impossible; it makes it **enumerable**. A
`border-rule` whose ancestors declare no surface falls back to the `:root`
default and is invisible on a card again - so the guard pins the *declarations*
(`surface-rule.test.tsx`), not the `border-rule` classes, which prove nothing on
their own. Resolved colour is a computed-style question and is checked in the
browser.

Definitions live in `app/src/index.css` under "Surfaces, and the rule colour that
reads on each". Adopted by the response-viewer family, the import dialog
(`ImportModal.surface-rule.test.tsx` guards the latter's declarations) and the
command list, whose `Command` root declares `bg-card surface-card` so the
input's divider, the section separators and the footer can all say `border-rule`
(`command.chrome.test.tsx`); the rest of the app still uses explicit tokens and
can migrate as it is touched.

A surface a component only *looks* like it has is the case the command list
answers: it painted `bg-popover`, which no surface class declares. `--popover`
and `--card` hold the same three numbers in both themes, and their foregrounds
do too, so it declares the card rather than gaining a `surface-popover` that
would be a second definition with nothing behind it. Check the values before
copying that move - two tokens that merely look alike are two surfaces.

One trap the import dialog documents: `surface-card` **cannot simply replace**
a background utility that a primitive already sets. The surface classes live in
`@layer components`, and a utility (`bg-background` on `DialogContent`) outranks
any component-layer class - while tailwind-merge does not recognise
`surface-card` as a background class, so it will not strip the primitive's
utility either. On such an element write the pair `bg-card surface-card`: the
utility wins the cascade, the surface class contributes the `--rule`
declaration, and both set the same colour.

**On `--muted` there is no border to pick.** It is the one surface where
`--border-strong` is *weaker* than `--border`: `--muted` (L 16%) sits between
them (L 10% and L 18%) in dark, so the usual escape hatch makes the edge
fainter still, 1.11 against 1.16, and neither is visible. In light the pair
inverts, 1.11 and 1.32, so whichever token is chosen one theme gets no edge at
all. A `bg-muted` block has to be defined by its fill instead, which separates
from a card at 1.18 light / 1.15 dark - the treatment the console log slabs and
the script panels' Quick Reference blocks use. `--accent` carries the same value
as `--muted` in both themes and behaves identically.

That fill-not-border guidance is about a *block* separating from its parent. An
edge that is itself the point is different: the import drop zone's dashed border
is a drag-target affordance, and it uses `surface-sunken` + `border-rule` - the
alpha-of-`--foreground` rule is the one edge that does work on this fill, and
the strongest available in both themes (1.356 light / 1.343 dark). The
`border-border-strong` it previously kept "for prominence" is in fact the
*faintest* option there in dark (1.11, per the table above). Decided in issue
#69; the detected-collections preview list in the same dialog got the same
treatment.
| switch **off** track vs card | 1.55 | 1.28 | failed |
| switch off **thumb** vs its track | 1.41 | 12.35 | failed in light |
| switch **on** track vs card | 5.39 | 5.89 | passes |

The focus ring needed no work, which is the one that matters most for keyboard
users - worth knowing so nobody "fixes" it.

`--border` at 1.00–1.30 is deliberate and stays: it is a seam between surfaces,
not the thing identifying a control.

**`--input` is not in that category, and the note above used to lump it in.**
For a field with `bg-transparent` - `Input`, `Textarea` and `SelectTrigger` all
are - the border *is* the thing identifying the control, so 1.4.11 applies to it.
In dark mode it was `240 6% 11%`, byte-identical to `--card`: a boundary of 1.00,
absent rather than faint. Light mode masked the same weakness because `shadow-sm`
gives a light field an edge and a shadow contributes nothing on a dark ground.

It is `240 6% 26%` now - 1.64 on the card, 1.79 on the panel, 1.89 on the
background. A real boundary, still quiet, and **still short of 3.0**: reaching
that needs ~42% lightness, which turns every input into a hard outline. Recorded
as a known gap rather than claimed as a pass. Where a boundary *is* the only identifying
information, it needs its own colour rather than the border token - which is
exactly what the switch needed. Its off state now colours the 2px border it had
already reserved, with `subtle-foreground` (3.17 / 3.34), the faintest tier that
clears the bar. The fill stays quiet on purpose; `muted-foreground` would pass
at 5.61 / 6.77 and make an off switch read almost as loudly as an on one.

Measure with transitions frozen. An unchecked switch first measured 13.58 in
light, which was a `transition-colors` mid-flight reading, not a colour.

### Variable Scope Colors (Categorical)

Variable scopes use a **categorical** palette (not semantic status): a distinct
hue per scope, mode-adaptive so it reads on both light and dark surfaces. Used
as text/icon/border at full strength and as tinted backgrounds via opacity.

Like the method colours, a scope is painted as text on its own 10% tint (the
count badges), so the light values are solved against that wash - at green-700
/ orange-700 the badge text measured 4.04 and 3.61.

```css
/* Light */
--scope-global:      142 72% 26%;
--scope-collection:   21 90% 35%;
--scope-environment: 217 91% 45%;   /* blue-600 - already clears it */

/* Dark */
--scope-global:      142 69% 58%;   /* green-400 */
--scope-collection:   27 96% 61%;   /* orange-400 */
--scope-environment: 213 94% 68%;   /* blue-400 */
```

**Utility classes** (`text-`, `bg-`, `border-`, `ring-`, `accent-`):
`text-scope-global`, `bg-scope-collection/10`, `border-scope-environment/20`, …

| Scope | Token | Convention |
|-------|-------|-----------|
| Global | `scope-global` | icon/text solid; `bg-scope-global/10` tint |
| Collection | `scope-collection` | icon/text solid; `bg-scope-collection/10` tint |
| Environment | `scope-environment` | icon/text solid; `bg-scope-environment/10` tint |

Never hardcode `bg-green-50 dark:bg-green-950` pairs for scopes - use the token
at an opacity (`/10` background, `/20`–`/30` border, full for text/icon).

### Run / Status Indicator Colors

Run, connection, and test status (dots, left-bars, pills, status icons) use a
cohesive `--status-*` set. Unlike everything else, these are **mode-consistent** - the same value in light and dark - because a status dot should read as the
same "good / bad / busy" signal on either surface. Distinct from `--success` /
`--destructive`, which are tuned for banner text and button fills respectively.

```css
--status-success: 142 71% 45%;   /* green-500  - completed / connected / pass */
--status-error:   0 84% 60%;     /* red-500    - failed / test fail */
--status-running: 217 91% 60%;   /* blue-500   - running */
--status-stopped: 25 95% 53%;    /* orange-500 - stopped */
/* pending → text-muted-foreground / bg-muted-foreground */
```

**A status colour has three jobs, and three tokens.** The base value above is
tuned as an *indicator* - a dot, a bar, an icon - where only 3:1 is required.
Reuse it as text or as a solid chip and it fails: `status-success` measured
**2.21:1** as 12px text on the light panel and **2.30:1** as white-on-fill.

| Job                                       | Token                    | Example                        |
| ----------------------------------------- | ------------------------ | ------------------------------ |
| Dot, bar, icon, tint, border              | `--status-*`             | `bg-status-success` dot        |
| The colour **is the text**                | `--status-*-text`        | `text-status-error-text`       |
| Solid chip under a **white** label        | `--status-*-fill`        | `bg-status-success-fill`       |

Only `-text` is mode-adaptive (light needs a darker value, dark a lighter one).
The base indicators and the `-fill` chips stay mode-consistent, so a green dot
and a "200 OK" chip read identically on either theme. This is the same split
`--primary` / `--primary-fill` already uses.

**Utility classes** (`text-`, `bg-`, `border-`): `text-status-success-text`,
`bg-status-error-fill`, `border-status-running/25`, etc. Use `--warning` for
"expiring / caution" indicators (amber) and `--success` for success *banners*.

The same set also colors **HTTP response severity** and **latency thresholds**,
since those map onto the same hues.

**HTTP status classes have their own vocabulary**, in
`constants/http-status.ts`. Never re-derive it: `httpStatusClass(code)` gives
the class, `STATUS_CLASS_STYLE[class]` gives the utility for the surface role
you need (`fill` / `text` / `tint` / `indicator`). Guarded by
`http-status.test.ts`, which fails if a component classifies a code and picks a
colour inline.

| Class | Codes | Family |
|-------|-------|--------|
| `success` | 2xx | `status-success` |
| `redirect` | 3xx, and 1xx | `status-redirect` (violet) |
| `client-error` | 4xx | `status-warning` (amber) |
| `server-error` | 5xx | `status-error` |
| `no-response` | `0`, and anything not a valid code | `status-no-response` (neutral) |

**This table has now been corrected twice, in opposite directions, so the
reasoning is recorded rather than the conclusion alone.** It previously
described the response badge's mapping: 3xx on `status-warning-fill`, 4xx on
`status-stopped-fill`. That ramp reads as principled - green to amber to orange
to red - but it packs four classes into 38deg-0deg of hue, and measured as OKLab
distance three of its ten pairs collide: 3xx/4xx at 0.073, 4xx/5xx at 0.095, and
5xx against a connection failure at **0.000**, because both used
`status-error-fill`. The set above has no pair under 0.144.

3xx is violet because that is where the wheel has room. Excluding the hues the
other classes own and requiring 3.0 on both card surfaces, the best-separated
free band is 262-294; violet scores 0.202 against its siblings where blue
manages 0.134, and blue is already `--status-running`, which appears in the same
History row. Hue 258 rather than 262 so it matches `--chart-3`, which is what
the dashboard chart paints 3xx with.

A violet accent scheme (Aurora) sits 0.068 from it, which sounds disqualifying
and is not: *every* existing status indicator already collides with some accent
(`--status-stopped` is 0.023 from Sunset), and none of those is a defect,
because a status dot and an accent button are different UI roles. The 0.10 bar
is a chart-series rule, where colour is the sole encoding within one plot.

`--status-warning` completes a family that only ever had a `-fill`, which is why
the history tiles used raw `yellow-700`. Amber cannot follow the `-500`
convention: amber-500 (`38 92% 50%`) measures **2.14** on a light card. The
indicator sits at `38 92% 36%`, only 3 points from its own fill - amber is
squeezed from both ends, which is a property of the hue, not a mistake.

**The status-code chart uses this family too**, through dedicated
`status-*` roles in `uplotTheme`. The other charts keep the generic
`success` / `warning` / `destructive` roles, and must: those are a *series*
palette wearing semantic names, and the same three also paint p50 / p95 / p99
and the error-rate area. Repointing them would recolour the latency charts,
which have nothing to do with HTTP status.

That distinction was got wrong first time round. The status chart borrowed
`categorical` for 3xx and `muted` for a failed connection, and this document
claimed the chart therefore "taught the same violet" as the response badge. It
did not: `categorical` is `--chart-3`, which also paints the p99 scatter, the
HDR distribution, the latency breakdown and the **throughput area**. So violet
meant "the categorical series in this plot", not "redirect", and a user could
not learn the association from a dashboard where violet is throughput one chart
higher. `muted` had the same problem in reverse - it made "nothing came back"
read as de-emphasised rather than as an outcome of its own.

Latency uses `status-running` → `status-stopped` → `status-error` for normal →
slow → danger (`LatencyMetric.tsx`).

### Decorative categorical palettes (the one token exception)

A surface may use a **fixed decorative palette** to give items a stable identity
by color rather than to signal state - the same idea as `--chart-*`. Such a
palette may keep Tailwind hue utilities (with `dark:` variants) instead of
tokens, because it never responds to theme and carries no semantics.

**The list is currently empty.** Everything - state, status, scope, semantics,
and categorical identity alike - uses tokens.

**Three entries were removed because they no longer describe the code.** The
per-section Settings accent palette is gone; there are zero `pink/purple/cyan`
utilities left under `modules/settings/`. The console's Pre-request and Test
script groups now use `status-running-*` and `status-success-*` tokens rather
than raw `blue-500` / `green-500`, because the raw values were theme-blind and
measured 3.76 and 2.22 in light mode; the console body is `bg-muted`, not a
fixed `zinc-900` terminal. And the timing phases - DNS / connect / TLS / TTFB /
download - are covered below.

The history overview tiles were on this list too, and should not have been: they
encode HTTP severity, which is state. They use `STATUS_CLASS_STYLE`.

#### Timing phases

The five network phases are a categorical set, and they were the last entry
here: the history breakdown tinted each tile with an explicit
`bg-blue-50 dark:bg-blue-950/30` pair. They are `--chart-*` now, declared once
in `components/shared/response-viewer/timing-phases.ts`:

| Phase | Token |
|-------|-------|
| DNS | `--chart-2` (teal) |
| Connect | `--chart-4` (amber) |
| TLS | `--chart-5` (rose) |
| TTFB | `--chart-3` (violet) |
| Download | `--chart-6` (moss) |

Two rules come with that table. **Never `--primary` or `--chart-1`** - both
follow the user's accent, so either can land on a neighbouring phase's hue;
under the green scheme `--primary` and `--success` sat three lightness points
apart and two of the five phases rendered as one swatch. And **colour is only
carried where it is the encoding** - the timeline segments in the builder's
timing tab and the bars in the dashboard's waterfall, where hue is how you tell
the phases apart. The tile grid (`TimingPhaseTiles`) is deliberately neutral:
each tile already has the label written in it, so a hue there was decoration
paying for an exception.

The lesson worth keeping: an entry on this list is a claim about the code, and
it decays. A raw palette class here is only defensible if it comes with a
`dark:` counterpart - a single value cannot serve a white card and a near-black
one, which is why every theme-blind foreground found in this tree failed in
light mode and passed in dark.

### HTTP Method Color Tokens

**Always render methods with `MethodBadge`** (`components/shared`) - never a
hand-rolled span or `Badge` with inline colours. It previously rendered seven
different ways (three sizes, two weights, some tinted, two with no colour at
all), and the history sidebar kept a private copy of the colour logic that
omitted `getMethodColor`'s fallback, so an unrecognised method silently lost its
colour.

```tsx
<MethodBadge method={request.method} />                        // tinted chip, 10px
<MethodBadge method={request.method} size="md" />              // 11px, beside body text
<MethodBadge method={request.method} variant="text" />         // colour only, dense rows
<MethodBadge method={m} variant="text" muted={!isActive} />    // secondary context
```

**The `badge` variant is a fixed-width column, not a chip that grows with its
letters.** Every list that shows one puts the badge first and the name after it,
so an intrinsic-width chip started `GET` names at one x, `POST` names at another
and `DELETE`/`OPTIONS` further still - a ragged left edge down the collections
tree, the history sidebar and the welcome recents at once. The chip is `7ch`
wide plus its own padding and border (`ch`, so one class serves both sizes and
tracks the mono font it already uses), seven being the longest standard method -
`OPTIONS` and `CONNECT`. The label is centred, and a longer method (the engine
and a pasted `curl -X` both pass arbitrary strings) truncates inside the chip
with the full method on the element's `title`, rather than widening it and
re-breaking every row around it.

The width is not an opt-in prop - the primitive enforces it, which is the whole
reason this component exists. The `text` variant keeps its intrinsic width: it
sits inline in running text, where a fixed column would punch holes, and a
caller that wants a column there (the import preview) still sets its own.

Method colors are design tokens, not hardcoded hex values. **They are
mode-adaptive** - hue and saturation are identical in both themes, so a method
always reads as "its" colour; only lightness shifts.

They have to be. `MethodBadge` paints one value three ways at once - as text, as
a 10% tinted background, and as a 30% border - so the badge text sits on a wash
of itself and contrast comes down entirely to lightness. As a single
mode-consistent set, 10px badge text failed AA in **both** themes at once: PUT
measured 1.97:1 in light, PATCH 2.86:1 in dark. Each value below is solved
against its own tint over the worst surface of its theme, and clears 4.6:1.

```css
/* light */                      /* dark */
--method-get:     142 76% 25%;   /* 142 76% 45% - green  */
--method-post:    217 91% 45%;   /* 217 91% 63% - blue   */
--method-put:      38 92% 28%;   /*  38 92% 45% - amber  */
--method-patch:   262 83% 45%;   /* 262 83% 71% - purple */
--method-delete:    0 84% 42%;   /*   0 84% 65% - red    */
--method-head:    199 89% 31%;   /* 199 89% 45% - cyan   */
--method-options: 240  5% 41%;   /* 240  5% 58% - gray   */
```

**Utility classes** (defined in `index.css`, available as Tailwind class names):
- Text color: `.method-get`, `.method-post`, `.method-put`, `.method-patch`, `.method-delete`, `.method-head`, `.method-options`
- Background: `.bg-method-get`, `.bg-method-post`, etc.

These exist but **nothing in `src/` currently uses them** - prefer
`getMethodColor` below, which is the one path `MethodBadge`, the tab strip and
the method selector all take. A second way to spell the same colour is a second
place for it to drift.

**`getMethodColor(method)`** in `app/src/utils/helpers.ts` returns `var(--method-xxx)` - the raw CSS variable reference. Callers construct full color values:

```tsx
const c = getMethodColor(method); // e.g. "var(--method-get)"

// Solid color (text, stroke):
color: `hsl(${c})`

// Tinted background (~10% opacity):
background: `hsl(${c} / 0.1)`

// Tinted border (~30% opacity):
borderColor: `hsl(${c} / 0.3)`
```

**Do not hand-roll that span for a method.** This section used to carry the
badge's markup as a pattern to copy, naming `RunItem` and `DashboardHeader` as
its users; both have rendered `MethodBadge` for some time, and the copy here had
already drifted (`font-bold` against the primitive's `font-semibold`, `rounded`
against `rounded-md`, and no fixed width at all - so a copy of it would have
reintroduced the ragged left edge the primitive now prevents). A hand-rolled
copy of a primitive does not receive the primitive's fixes. Render
`MethodBadge`; the three `hsl()` forms above are how it, the tab strip and the
method selector each build a colour from `getMethodColor`.

**MethodSelector** used to carry its own `METHOD_COLORS` map of those utility
classes - a second source of truth for the same seven colours, and the kind that
quietly stops matching. It now takes the `getMethodColor` path above, like
`MethodBadge` and the tab strip:

```tsx
style={{ color: `hsl(${getMethodColor(request.method)})` }}
```

### Charts

A cohesive categorical set - `chart-1` tracks the active accent, then five
evenly-spaced hues (teal / violet / amber / rose / moss) shared across modes and
tuned only in lightness for each ground.

```css
/* Light */
--chart-1: <accent>;         /* tracks --primary */
--chart-2: 172 66% 38%;   /* teal */
--chart-3: 258 55% 55%;   /* violet */
--chart-4:  38 88% 48%;   /* amber */
--chart-5: 340 72% 50%;   /* rose */
--chart-6: 105 58% 34%;   /* moss */

/* Dark - same hues, lifted for the dark ground */
--chart-1: <accent>;
--chart-2: 172 60% 52%;
--chart-3: 258 78% 72%;
--chart-4:  38 90% 60%;
--chart-5: 340 74% 62%;
--chart-6: 105 52% 50%;
```

`--chart-6` was added for the response timing waterfall, which needs five series
at once. With four fixed hues available, two phases had been reaching outside the
set - TTFB to `--primary` and Download to `--success` - and under the green
accent those two land on the same hue (142) three points of lightness apart, so
two of five phases rendered as the same swatch. Moss sits in the widest gap in
the ring (38 -> 172), 67 degrees from its nearest neighbour.

**A series never takes `--primary` or `--chart-1`.** Both move with the user's
accent, so either can drift onto a neighbouring series in one scheme and not
another - which is invisible when you are looking at the scheme it works in.

---

## Color Schemes (Accent Themes)

Applied via `data-color-scheme` attribute on `<html>`. Each scheme sets
`--primary`, `--primary-fill`, `--primary-foreground`, `--ring`, `--variable`,
and `--chart-1`. The authoritative per-scheme values (deep fill + mode-adaptive
accent) live in `app/src/index.css`; the table below is an approximate guide.

**`--primary` and `--primary-fill` are not the same thing, and the split is what
keeps labels legible.** `--primary-fill` is the solid button background - the
`Button` default variant, badges, tooltips and the Send button all use it - and
it holds **one value in both themes**, so the white label on it never changes
contrast. `--primary` is the accent as *text*, focus ring, `--variable` and
`--chart-1`; it brightens in dark mode because those all sit on a near-black
card and have to read there. Every bare `bg-primary` in the app is a translucent
wash (`/10`, `/15`, `/30`), never a solid fill under white text.

Pinning `--primary` to its light value would look like a contrast fix and is in
fact a regression: accent *text* on the dark card would fall from APCA Lc 44–69
to Lc 22–37.

**Secondary text on the fill is a tint of `--primary-foreground`, never
`--muted-foreground`.** The muted token is tuned against the canvas, so on the
accent fills it measures 1.04–2.27:1 - on `ocean`, the default, it is 1.04,
which is not a de-emphasis but a disappearance. A tooltip's second line (a
shortcut, a URL, the source of a value) therefore uses the `TooltipHint`
primitive, which holds the one tint; the same argument `surface-sunken` makes
for its `--rule`, on a filled surface instead of a raised one. The hint cannot
out-read the label it is secondary to - white on `sunset` is the ceiling at
3.6:1 - so the bar is 2.5:1 on every scheme, checked in
`tooltip-hint-contrast.test.ts`.

**A value and the hint that sources it stack; they never share a flex row.**
`TooltipContent` is capped at `max-w-xs`, a value that wraps on `break-all` has
a min-content width of about one character, and a hint has to keep its
intrinsic width to stay readable - so a row of the two hands its whole width to
the hint and leaves the value a vertical strip of letter fragments. It takes
only a long environment name beside an unbroken value (issue #1195), or a note
carrying the user's own data, such as a declared column list. `TooltipValue`
holds the stacked shape and takes the hint as a prop, so a call site using it
cannot express the row; the one-line alternative - `min-w-0 flex-1` on the
value plus a truncated hint - was rejected, because a clipped source name loses
the answer to "which environment". A short label beside a short one
(`TooltipIconButton`'s shortcut hint) has neither ingredient and stays a row.
→ `tooltip-value-layout.test.ts` reads every tooltip block for the shape.

| Scheme | Light (`--primary` = `--primary-fill`) | Dark `--primary` | Dark `--primary-fill` |
|--------|-----------|----------|----------|
| `sunset` | `24 90% 46%` | `24 95% 58%` | `24 90% 46%` |
| `sky` | `192 95% 36%` | `188 90% 52%` | `192 95% 36%` |
| `ocean` (default) | `217 80% 48%` | `217 90% 66%` | `217 80% 48%` |
| `forest` | `142 72% 33%` | `142 65% 52%` | `142 72% 33%` |
| `aurora` | `262 55% 54%` | `258 88% 76%` | `262 55% 54%` |
| `coral` | `0 68% 54%` | `0 80% 68%` | `0 68% 54%` |
| `magenta` | `305 72% 45%` | `305 85% 70%` | `305 72% 45%` |
| `graphite` | `220 12% 46%` | `220 15% 72%` | `220 12% 46%` |

Every scheme also resolves `--primary-text` (the accent as a label). It tracks
`--primary` for all of these except `graphite`, which sets `220 12% 26%` light
and `220 15% 86%` dark - see **Primary (Accent Color)** above for why.

**Adding a scheme.** Edit `constants/color-schemes.ts` and `index.css` - nothing
else. `color-schemes.test.ts` asserts the two agree, in both themes, because a
missing block fails silently: the picker offers a swatch that inherits `:root`
and quietly does nothing.

The value has to clear two bars. As a fill it carries a white label, so aim for
the band the existing schemes occupy - **APCA Lc 68–84** - and keep the fill at
**3.0+ against `--card`** so the button still reads as a control. The dark
`--primary` is text, so it wants **Lc 44–69** against the dark card. Check the
new hue is more than about **0.10 OKLab ΔE** from every existing scheme *and*
from the semantic status colours, or it will read as a duplicate in the picker.
`magenta` sits at ΔE 0.153 from `aurora`; `graphite` is distinct by being the
only desaturated option.

---

## Typography

### Fonts

| Role | Family | Weights bundled | Source |
|------|--------|-----------------|--------|
| UI / body default | Space Grotesk | 400, 500, 600, 700 | `@fontsource`, in the app |
| UI / body alternate | Inter | 400, 500, 600, 700 | `@fontsource`, in the app |
| Code / mono default | JetBrains Mono | 400, 500, 600, 400 italic | `@fontsource`, in the app |
| Code / mono option | Fira Code | 400, 500 | `@fontsource`, in the app |
| Code / mono option | IBM Plex Mono | 400, 500 | `@fontsource`, in the app |
| Code / mono option | Space Mono | 400, 700 | `@fontsource`, in the app |

```css
/* app/src/index.css */
@import "./fonts.css";
```

`app/src/fonts.css` holds the `@fontsource` `@import` lines for all six
families - the weights bundled, the subsets, and why.

```css
body { font-family: var(--font-sans); } /* default: "Space Grotesk", system-ui, sans-serif */
/* mono via font-mono Tailwind class, or .font-code utility */
```

The faces are bundled rather than fetched because a stylesheet in
`index.html`'s head is render-blocking and the window is only shown on first
paint, so the fetch delayed the window appearing at all - measured at ~12.8s
on a network that black-holes the request. Nothing about how the app renders
changed with the move: the weights bundled are exactly the ones the old css2
URL asked for, so `font-mono font-bold` stays browser-synthesised for JetBrains
Mono, Fira Code and IBM Plex Mono, same as before. Every subset each family
ships is bundled too, which is what Google served on demand; behind their
`unicode-range` a file is still only read when a character needs it, so the
subsets beyond latin cost installer bytes and no startup work.

**User-selectable UI font + scale.** Settings → Appearance → Interface lets the
user pick the sans/body face (Space Grotesk / Inter / System / JetBrains Mono)
and an interface scale - a slider over **80% to 200% in 10% steps**, which
covers the 125-150% accessibility band the three fixed presets it replaced
(Compact / Default / Comfortable) topped out below. Font swaps the `--font-sans`
custom property (so `body` + every `font-sans` utility follow); scale sets the
page zoom factor (Electron `webFrame`, CSS `zoom` fallback in the browser).
Both live in `appearance-store` (source of truth `constants/appearance.ts`),
persisted to localStorage, and applied pre-paint in `index.html`. Code/mono
text stays JetBrains Mono regardless.

The View menu's `Ctrl`/`Cmd` `+` `-` `0` drive that same setting rather than
Chromium's own zoom, so a keyboard zoom persists across a restart and "Actual
Size" means 100% *because that is the default setting*, not because it bypasses
it. The code font size (Settings → Editor) stays an independent control and
composes with page zoom.

### Type Scale Conventions

| Use | Size | Weight | Class |
|-----|------|--------|-------|
| Section label / eyebrow | 11px | semibold, uppercase, +tracking | `text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground` |
| Hero metric value | 34px | bold, tabular | `text-[34px] font-bold leading-none font-mono tabular-nums` |
| Secondary metric value | 22px | bold | `text-[22px] font-bold font-mono` |
| Title / small heading | 15px | semibold | `text-md font-semibold` |
| Body / default | 13px | regular | `text-sm` |
| Small label | 12px | medium | `text-xs font-medium` |
| Micro / badge | 10–11px | mono semibold | `text-[10px] font-mono font-semibold` |
| URL / path | 12–13px | mono | `text-xs font-mono` |

**Only `text-[10px]`, `text-[11px]`, `text-[22px]` and `text-[34px]` may be
written as arbitrary values.** Everything else has a named step, and
`type-scale.test.ts` fails on anything outside that set.

**The micro/badge step is semibold because 600 is the heaviest face the code
font ships.** `fonts.css` loads JetBrains Mono - the default `--font-mono` - at
400/500/600, and Fira Code and IBM Plex Mono at 400/500; only Space Mono, one of
four selectable code faces, has a real 700. So `font-mono font-bold` on a chip
renders a synthesised weight for every user who has not picked that one face -
which is what this row used to specify while `MethodBadge`, the primitive that
owns the step, shipped `font-semibold` (#1199). `type-scale.test.ts` now reads
this row and every 10-11px mono class string in `src`, and fails on a weight
above 600 in either, so the two cannot part again.

Two things at this size deliberately carry no badge weight. A chip that prints a
*value* rather than a label - a column name, a cookie attribute - is the URL /
path step and stays unweighted. And a numeric readout may take `font-medium` to
lift one figure above its unweighted siblings, as the timing waterfall and the
phase percentiles do; that is emphasis inside a row, not a badge.

The app had drifted to **182 arbitrary sizes across 11 distinct values**. Half
duplicated a step that already existed - `text-[12px]` *is* `text-xs`,
`text-[13px]` *is* `text-sm` - and in doing so skipped the paired line-height:
34 of 36 and 13 of 16 set no `leading-*`, so they inherited the parent's while
their `text-sm` siblings got 18px. Same size, two rhythms, chosen by nobody.
Seven were half-pixel (`text-[10.5px]`, `text-[11.5px]`), which no scale
contains and which render soft on a non-retina display.

`--text-md` (15px/20px) was added rather than removed: six surfaces reached for
`text-[15px]` independently - the empty and error state titles, a collection
name, the response heading, the font picker and the brand mark - which is a
missing step, not six mistakes. 13px is body and 16px is heavy for a small
heading in a dense tool.

**Use `text-sm` for body, not `text-[13px]`.** Tailwind ships `text-sm` at 14px,
which left the app running two scales a pixel apart - `text-sm` in ~160 places
against `text-[13px]` in ~18. Rather than migrate every call site, `--text-sm` is
redefined in `@theme` (`index.css`) to **13px/18px**, so the utility *is* the
documented body size. `text-xs` already matches the 12px label, so that was the
only size that diverged. `text-[13px]` still works but skips the paired
line-height - prefer `text-sm`.

**Icon sizing goes on `className`, not lucide's `size` prop.** Mixing the two
hides icons from a scale audit and lets off-grid values (15px) creep in. Use
`w-3 h-3` (12), `w-3.5 h-3.5` (14), `w-4 h-4` (16), `w-5 h-5` (20).

---

## Geometry

```css
--radius: 0.375rem;      /* 6px - base border radius (default) */
--dock-height: 2rem;     /* 32px - footer status strip */
```

**`--dock-height` exists because a `fixed` element has to know it.** The Dock is
the last row of the shell column, so the layout keeps everything else clear of
it automatically. The toast viewport is `position: fixed` and anchors to the
window instead, so it has to subtract the strip's height by hand - and with a
plain `bottom-4` it did not, landing 16px off the window floor, inside the
Dock's 32px band and covering its lower half, "Connected" and the version string
included. Measured in the app: viewport bottom 704px against a Dock top of 688px.

Both sides now go through the token - `h-[var(--dock-height)]` on the Dock,
`bottom-[calc(var(--dock-height)+1rem)]` on the viewport - so the height cannot
change in one place only. jsdom does no layout and cannot measure the overlap, so
`toast-position.test.tsx` guards the *reference* on each side instead.

| Class | Value | Follows the setting? |
|-------|-------|----------------------|
| `rounded-sm` | `calc(var(--radius) - 4px)` | yes |
| `rounded-md` | `calc(var(--radius) - 2px)` | yes |
| `rounded-lg` | `var(--radius)` | yes |
| `rounded-full` | pill / circle | no - deliberately fixed |
| `rounded-none` | `0` | no - deliberately fixed |
| `rounded` | Tailwind default | **no - never use it** |

**Never use bare `rounded`.** It resolves from Tailwind's own default rather
than `--radius`, so it sits at 4px whatever the user picks - measured 4px at
`0rem`, `0.375rem` and `0.75rem` alike, while `rounded-md` moved 0 → 4 → 10.
Three had drifted into the MCP settings panel, staying rounded for anyone who
had chosen Square. A test (`radius-token.test.tsx`) now fails on any bare
`rounded` in a class string.

**Inline `borderRadius` escapes the setting too**, and no class scan sees it.
The uPlot chart tooltip carried `borderRadius: "6px"`, so it stayed rounded on
Square and stopped short of the app's own tooltip on Rounded; it is now
`var(--radius-md)`, measured 0 / 4 / 10 across the three settings. Inline radii
are allowed only as a `var(--radius…)` reference or a percentage (a circle) -
plus the Appearance panel's own roundedness swatches, which must show every
option regardless of which one is active. The same test enforces this, across
`.ts` as well as `.tsx`.

**User-adjustable.** Settings → Appearance → Interface → Roundedness sets
`--radius` (Square `0rem` / Default `0.375rem` / Rounded `0.75rem`), owned by
`appearance-store`, persisted, applied pre-paint. So `rounded-sm/md/lg` reshape
live. **Always use `rounded-md`/`rounded-lg`/`rounded-sm`, never Tailwind's
unsuffixed `rounded`** (fixed 4px - it ignores `--radius` and won't follow the
control). `rounded-full` stays a pill regardless.

Cards and panels use `rounded-md`. Badges/chips use `rounded-sm`.

**`rounded-full` is for circles, not for chips.** Status dots, spinners,
circular icon wells, colour swatches, switch tracks - things whose shape *is* a
circle or a capsule. It is not for anything rectangular that merely looked
nicer with round ends: the dashboard header's LIVE / COMPLETED / STOPPED chips
were `rounded-full` while the `Badge` primitive they otherwise match is
`rounded-md`, so on Square they were the only round things left on the screen.
They are `rounded-md` now.

No test can tell a chip from a dot, so this one is a judgement call at review
time. The question to ask: if the user picks Square, should this element go
square? If yes it is a chip, and `rounded-full` is wrong.

The same reasoning rules out `rounded-full` on controls - a button or dropdown
trigger that keeps its pill shape becomes the one thing on screen ignoring the
Roundedness setting. Interactive elements take `rounded-md`/`rounded-sm`.

---

## Animations

Defined in both `index.css` and `tailwind.config.js`. All three `vayu-*` animations have Tailwind shorthand aliases (`animate-vayu-spin`, `animate-vayu-pulse`, `animate-vayu-fadepulse`) in addition to the verbose arbitrary form.

| Name | Duration | Curve | Tailwind class | Use |
|------|----------|-------|----------------|-----|
| `vayu-spin` | 0.7s | linear | `animate-vayu-spin` | Loading spinners |
| `vayu-pulse` | 1.6s | ease-in-out | `animate-vayu-pulse` | Live indicators (100→35% opacity) |
| `vayu-fadepulse` | 2s | ease-in-out | `animate-vayu-fadepulse` | Subtle breathe (90→50% opacity) |
| `accordion-down/up` | 0.2s | ease-out | `animate-accordion-down/up` | Radix accordion |
| `fade-in` | 0.2s | ease-out | `animate-fade-in` | General reveal |
| `slide-in` | 0.2s | ease-out | `animate-slide-in` | Dropdown/panel entry |
| interaction state | 0.15s | ease | *(baseline in `index.css`)* | Hover/active colour changes on interactive elements |

**Spinner pattern:**
```tsx
<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-vayu-spin inline-block" />
```

**Live dot pattern:**
```tsx
<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
```

---

## Focus & Interaction States

Interactive elements get a keyboard focus ring and hover transition from a
baseline in `app/src/index.css` (`@layer base`) - **do not add per-component
focus classes for the default case.**

```css
:where(button, [role="button"], a[href], input, select, textarea, summary,
       [tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 1px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

- `:where()` keeps specificity at **0**, so any component utility overrides it
  without `!important`. The `components/ui/*` primitives already carry their own
  `focus-visible:ring` and keep their appearance.
- `:focus-visible` fires only on keyboard/AT focus - mouse users never see a ring.
- **1px, not 2px.** On dense lists and toolbars a hairline reads as considered;
  a 2px saturated rectangle reads as a browser default.
- `outline` follows the **element's own** `border-radius`. That means the
  roundedness setting governs the ring **only on elements that already carry a
  `rounded-*` class**. An element with no radius gets a square ring at every
  setting - so if a ring should reshape with the control, put the indicator on an
  element that has the radius (see below).
- Transitions list paint properties explicitly (`background-color`, `color`,
  `border-color`, `opacity`) at **150ms**. Never `transition: all` - it can
  animate layout properties. Reduced motion already collapses these app-wide.

**Clipping panels.** An element whose `overflow-*` would cut off an outset ring
must carry `.panel-clip`; every focusable descendant then gets
`outline-offset: -1px`. Currently on the `TabStrip` row, the `Drawer` content
wrapper and the load-test dialog's "Recording & limits" card. Put it on the
element carrying the overflow - not on the rows. For a one-off outside such a
container, use the `.focus-ring-inset` utility.

Two limits worth knowing before reaching for it. **`overflow-y-auto` clips
horizontally too** - it computes `overflow-x` to `auto`, so a box that only
meant to scroll vertically still cuts a ring off its left and right edges. And
**`.panel-clip`'s element list is narrower than the baseline's**: it covers
`button`, `[role="button"]` and `[tabindex]` only, so for `a[href]`, `input`,
`select`, `textarea` and `summary` it is inert - the baseline still draws the
ring 2px out and the panel still cuts it off. The `components/ui` primitives are
unaffected either way, since they set `focus-visible:outline-none` and paint
their own ring.

**Which is why a primitive fixes its own clipping, with `ring-inset`.** Neither
`.panel-clip` nor `.focus-ring-inset` reaches a Tailwind `ring` - both move
`outline-offset`, and a primitive has already turned its outline off. `TabsTrigger`
is the worked example: a trigger fills its list's height exactly (measured in the
running app, both boxes were 74->98) and the three scrolling strips - the response
viewer, the request builder and Collection Detail - are `overflow-x-auto
overflow-y-hidden`, so an outward `ring-2` had no room at the top or bottom and
rendered as two cut-off vertical strokes. `focus-visible:ring-inset` on the
trigger fixes every strip at once, present and future; padding the three lists
would have fixed it three times. Same reasoning as *prefer clearance* above,
reached the other way round: the clipping is on the list and the ring is on the
trigger, and only one of those is a single place. Guarded by `tabs.test.tsx`.

**Prefer clearance to tucking-in for a control that also appears outside a
clipping panel.** Both fix the clipping; only clearance keeps one control
looking like one control. The row-enable checkbox is the worked example: a plain
`<input type="checkbox">` in both the variables table and the request builder's
key-value rows. `KeyValueRow` wraps its row in `p-1`, so the ring reads as an
outset hairline with a 4px gap. The variables table's cell had no horizontal
padding and sat against a `p-0` scroll container, so the ring lost its left side
on Collection Detail but not on the Variables screen, where the container
carries `p-4`. The fix is `px-1` on that cell - the same 4px - **not**
`.panel-clip` on the container, which would have tucked this instance's ring
inward and made the two checkboxes disagree. `key-value-parity.test.tsx`
guards both halves: the two checkboxes must declare equal clearance, and neither
may sit under a `.panel-clip`. The clearance assertion alone would pass a change
that re-broke the match. That file grew into the wider parity contract between
the two tables (#587) - control height, checkbox sizing and accent, the
destructive row-action variant, and the shared secret-reveal control.

**Composite rows - `.focus-row`.** The baseline attaches the ring to whatever is
*focusable*, which is only right when the focusable element is also what the user
reads as the target. In a tree row it often isn't: a collection row is 220px with
a rounded hover fill, but its label button is 150px with square corners, so an
outline on the button indicates the wrong shape in the wrong place.

Put `.focus-row` on the element that paints the hover background. It then draws
the indicator itself - at its own radius, so the roundedness control governs it -
and adds the same accent fill hover uses, which is how native list selection
reads. The inner control draws nothing.

```css
:where(.focus-row):has(:focus-visible:not(.focus-self)) {
  outline: 2px solid hsl(var(--primary) / 0.3);
  outline-offset: -2px;
}
.focus-row :focus-visible:not(.focus-self) { outline: none; }
```

The indicator mirrors the disclosure chevron's own ring (`ring-2
ring-primary/30`) and the selected-row ring (`ring-1 ring-inset
ring-primary/20`) so focus, selection and hover speak one language. It uses
`outline` rather than `box-shadow` because Tailwind's ring utilities own
`box-shadow` - a selected row already sets one, which would override it.

**Auxiliary controls opt out with `.focus-self`.** A control inside the row that
is its own target - the chevron toggles expansion rather than opening the
collection - keeps its own ring and does not light the row, so exactly one
indicator ever shows.

`.focus-row` covers two cases: the row is itself focusable (the collection tree's
roving tabindex focuses the row), or focus sits on a control inside it. `:has()`
is descendant-only and does not cover the first, hence the `:focus-visible`
selector alongside it.

**Focus must be able to leave, and a Monaco editor is where it could not.** A
ring that says where focus is means nothing if Tab cannot move it on. Monaco
indents with Tab - right for a code editor, and a keyboard trap for anyone who
reached one by tabbing (WCAG 2.1.2). Two rules, both held in `ui/code-editor.tsx`
rather than at the dozen mount sites:

- **A read-only editor runs with `tabFocusMode` on.** There is no indentation to
  insert in text nobody can type into, so Tab simply moves focus and no trap
  exists to escape.
- **An editable editor advertises the way out while it holds focus.** ⇧⌘M
  (`LEAVE_EDITOR_CHORD`) moves focus to the first focusable element after the
  editor, and a `Kbd` hint names it in the editor's bottom-right corner - on
  focus, not always, so a dozen panes do not each carry a standing badge over
  their content. The caps come from `chordKeys`, like every other chord this app
  puts on screen; a hand-rolled badge would be a second place a modifier is
  spelled.

The general rule behind both: **any component that takes over a key the browser
uses for navigation owes the user a documented way back**, and that way back is a
`Chord` in `constants/shortcuts.ts` so the Keyboard Shortcuts panel lists it
without being told. Guarded by `code-editor.chords.test.tsx` (the chord is
registered, the hint appears on focus and never on a read-only editor) and
`shortcuts.listed.test.ts` (it reaches the panel).

---

## Row Actions

Controls that appear on a row you are already hovering - `⋯`, delete, remove.

**Never use `ghost` for these.** `ghost` hovers to `bg-accent`, which is exactly
what the row underneath already paints, so the button looks like it has no hover
state at all. Use the dedicated variants, which step up to `accent-active`:

| Variant | Use | Hover |
|---------|-----|-------|
| `rowAction` | neutral (`⋯`, edit, copy) | `bg-accent-active` + `text-foreground` |
| `rowActionDestructive` | delete / remove | `bg-accent-active` + `text-destructive` |

Destructive rows share the neutral shape and differ **only** in glyph colour on
hover. No red background tint: the row already carries one fill, a second
competing tint is noise, and `DeleteConfirmDialog` is what actually protects the
user - the red glyph only needs to signal at the point of intent.

Reveal them with `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`.
The `focus-within` half is not optional: without it a keyboard user lands on an
invisible control.

**A state toggle is not a row action, and must not be hover-revealed.** The test
is whether the control has an *off* state that means something. Delete has none -
it either fires or it does not - so hiding it costs nothing. The variables
table's "mark as secret" key does: hidden at rest, "this value is not secret"
looked exactly like "there is no control here", so the only way to discover you
could mask a value was to hover the row. It is now always visible on
`muted-foreground`, stepping to `warning-text` when on.

Same rule for anything that reports state - a pin, a mute, an enable. Quiet is
fine; absent is not.

**A row with no action of its own keeps its controls visible too.** Hover-reveal
exists so the row's own job - open the request, select the run - is not crowded
by buttons the user did not come for. A Trash row (`modules/trash`) has no such
job: it opens nothing, and Restore and Delete forever are the entire reason it
is on screen. Revealed on hover they would hide the surface's whole purpose and
leave a list of names that reads as inert. The test is the same one the state
toggle above passes - would the row still say what it is for with the control
absent - and here the answer is no.

**Prefer `RowActionsMenu`** (`components/shared`) over adding another inline icon
button. It renders the `⋯` trigger plus a `DropdownMenu`, so rows expose actions
consistently and get focus management, Escape-to-close and arrow-key navigation
for free. Used by request rows and environment rows. It opens on a pointer and
on a click reporting `detail === 0` - the keyboard's kind - and takes a
`tabIndex` prop, `0` unless the row sits in a roving-tabindex tree. See Tree
Navigation for why.

---

## Drawer Panel Frame

**Every drawer view renders inside `DrawerPanel`** (`components/shared`). It owns
the header (title + trailing actions) and the scroll region; views supply only
their content.

The four views had drifted into two different panel designs - Collections and
History used a 16px padded container with a heading, Variables and Settings were
flush with no heading at all. Switching views moved the content's vertical start
*and* made the title appear or vanish. All four now match exactly: one 32px
header band, body below it.

- **The header is the drawer's half of the second chrome row.** It takes its
  height from `--tabstrip-height` and carries the same bottom rule as the tab
  strip on the other side of the resize handle, so the two read as one band
  across the window rather than as two adjacent headers. That is the only reason
  the height is a token and not an `h-8`: `TabStrip.tsx` and `DrawerPanel.tsx`
  cannot see each other, and `titlebar-height.test.ts` holds them together.

- **The frame owns header padding; the body is flush.** Rows run edge to edge -
  the sidebar convention, and it recovers the ~32px of row width the old inset
  cost. Rows bring their own internal padding.
- **Full-bleed rows are square.** A rounded corner meeting the panel edge reads
  as a clipped rectangle, not a rounded row.
- **The panel owns scrolling** - vertically only. Views used to differ: some were
  wrapped in a `ScrollArea` by the Drawer, others managed their own.
- **Indent with padding inside the row, never margin around it.** Margin pushes
  the row's _background_ in too, so a nested row's hover and selection fill stops
  short of the panel edge while a top-level row's reaches it. Depth is shown by
  where the content sits, not where the row starts:
  `paddingLeft: 8 + depth * INDENT_STEP` (`constants/layout`).
- **A control with an outward focus ring needs clearance from the body's top
  edge.** The body scrolls, so it clips at its own bounds, and a ring drawn
  outside the border box gets its top cut off when the control sits flush. Rows
  are exempt - their focus outline is inset (`outline-offset: -2px`). Padded
  content blocks (the History search field) carry `pt-2`.
- **A row must never widen the panel.** Long names ellipse; the drawer has no
  horizontal scrollbar - `overflow-x-hidden` is set explicitly, because
  `overflow-y: auto` alone computes overflow-x to `auto` too. `truncate` alone is not enough when the text sits inside
  a `flex-1` _wrapper_ - a flex item will not shrink below its content width, so
  the wrapper needs `min-w-0` as well. (A `truncate` element that is itself the
  flex item is fine: `overflow: hidden` already gives it an automatic minimum
  size of 0.) Short trailing metadata - counts, badges, spinners - takes
  `shrink-0`, so the name is what yields.

---

## Drawer Row Metric

**Single-line drawer rows are `h-8` (32px).** State the height; do not let it
fall out of the content. It previously did - a 28px chevron set the collection
row, padding set the others - so the four drawer views ran **34 / 36 / 38 / 40px**
and the rhythm shifted every time the user switched view, one click apart in the
same panel. Collection and request rows differed by 4px inside a *single* tree.

Applies to `CollectionItem`, `RequestItem`, `SettingsCategoryTree` and
`VariablesCategoryTree` rows. Put `h-8 items-center` on the row and let content
centre; do not re-add vertical padding, which is what caused the drift.

Section *headers* (e.g. "Environments") stay shorter on purpose - they are group
labels, not list items, and the difference carries hierarchy.

The disclosure chevron is `w-6 h-6` (24px) so it fits a 32px row. That is still
an adequate pointer target, and the row around it opens the collection.

**`h-8 items-center` on the row means the activator needs `self-stretch`.** The
two rules above interact, and the interaction is a bug the eye cannot see. A
composite row (see `.focus-row`) paints the height, the hover fill, the selection
tint and `cursor-pointer`, while the click handler sits on a narrower activator
button inside it - the row carries a `⋯` menu, so it cannot itself be one button,
and a plain `<div onClick>` is not keyboard operable. `items-center` then makes
that button *content*-height: ~22px in a request row, where the `MethodBadge`
props it open, and ~18px in a collection or environment row. The remaining 5-7px
above and below took the fill and the pointer and did nothing on click. Measured
in the running app at the 260px default drawer width, the share of the row that
actually responded was **41%** for a collection, **51%** for a request and
**36%** for an environment - and hit-testing 3px inside the top or bottom edge
landed on the container, which has no handler.

`self-stretch` on the activator overrides the row's centring; the activator's own
`items-center` still centres its contents, and `.focus-row` is unaffected because
the row paints the ring either way.

**`self-stretch` fixes the height; the row's own box needs delegation.** The
indent is `paddingLeft` *on the row* - deliberately, so the fill reaches the panel
edge - and the flex gaps and right padding belong to no child either. No amount of
stretching reaches any of it, and on a collection row the indent cannot move onto
the activator even in principle, because the chevron sits between them. So the row
takes the click itself and forwards it:

```tsx
const isRowSurface = (e: React.MouseEvent) => e.target === e.currentTarget;
// on the row:
onClick={(e) => isRowSurface(e) && handleClick(e)}
```

`target === currentTarget` is exactly "the pointer landed on the row's own box".
It excludes the chevron and the `⋯` menu without naming them - they are children,
and they own their own actions - and it stops a click on the activator from firing
twice as it bubbles through. Drop the check and every label click activates twice.

This is *not* the `<div onClick>` the environment row's comment warns against: the
activator button stays and remains the keyboard path (`useRovingTreeFocus` clicks
`[data-tree-activate]` on Enter). The row is a second, pointer-only entrance to
the same handler.

Together the two changes take all three rows to **100% of their own pixels** -
measured by sweeping `elementFromPoint` across the row box in the running app. The
only pixels a row does not own are the chevron, the `⋯` menu and the drawer's 8px
`cursor-col-resize` handle at the panel edge. Both halves are guarded by
`drawer-row-hit-area.test.tsx`: the height as a `className` assertion (jsdom has
no layout, so an `offsetHeight` assertion would pass while measuring nothing), the
delegation behaviourally, because `fireEvent.click(row)` targets the row itself -
exactly the pointer that used to land on dead padding.

---

## Overflowing Text

User-supplied names - collections, requests, environments, URLs - are unbounded,
so every surface that shows one needs a defined overflow behaviour. There are
exactly **two**, and they are not interchangeable:

| Treatment          | Component          | Where                                 |
| ------------------ | ------------------ | ------------------------------------- |
| Ellipsis + tooltip | `TruncatedText`    | Rows, headers, pickers - the default. |
| Marquee on hover   | `ScrollOnOverflow` | Tab strip only.                       |

**`TruncatedText` is the default.** It ellipses, and reveals the full value in a
native `title` tooltip **only while the text is actually clipped**. An
unconditional `title={name}` - the obvious version - pops a tooltip on every
hover, including names that are already fully readable, telling the user
something they can see. The tooltip appears when the name is cut off and
disappears when the drawer is widened enough to read it; `useOverflowTitle`
re-measures on resize via `ResizeObserver`.

Do not hand-write `title={name}` alongside `truncate`. That is the pattern this
component replaced, and it drifts - some rows get it, some do not, and the ones
that do show it unconditionally.

**`ScrollOnOverflow` marquees instead**, and is limited to the tab strip, where
the label is the primary target and there is no way to widen it. Rows must not
animate under the cursor.

Text that **wraps** (`break-words`, e.g. the run URL in `RunItem`) is neither -
it never clips, so it needs no tooltip.

---

## Tree Navigation (roving tabindex)

The collection tree follows the WAI-ARIA treeview pattern: **the whole tree is
one tab stop**. Previously every row and every control in it was a stop - a
workspace with 2 collections and 4 requests cost 17 presses to tab past.

- Container: `role="tree"`. Rows: `role="treeitem"`, `aria-expanded` on
  collections, `aria-selected` for the open entity.
- Rows render `tabIndex={-1}`; `useRovingTreeFocus` promotes exactly one to `0`.
- Keys: Up/Down move, Home/End jump, Right expands then steps in, Left collapses
  then moves to the parent, Enter/Space opens, **F2** renames, **Delete /
  Backspace** deletes, **Shift+F10 / Menu / Shift+Enter** opens row actions,
  **typeahead** jumps to the next row whose name starts with what you type,
  **`*`** expands every folder at the focused row's level.
- **The second binding on those two is what a Mac keyboard can reach.** The key
  labelled "delete" on a Mac reports `"Backspace"` (`"Delete"` is forward-delete,
  Fn+Delete), and Mac keyboards have no Menu key and default F10 to a media key -
  so the `Delete`-only and `Shift+F10`-only versions were dead on macOS while
  passing every test, since jsdom reports one platform. Both bindings are live on
  every platform rather than behind an `isMac` fork; the tests fire both keys and
  assert neither the host nor a stubbed platform.
- **Alt+Arrow moves the row itself**, the keyboard half of drag-and-reorder:
  Up/Down among its siblings, Right into the folder rendered above it, Left out
  to after its parent. Alt because the tree owns the bare arrows and the app owns
  Ctrl/Cmd; every move is announced in the live region below, and the row menu's
  **"Move to..."** is the same move with no chord at all.
- Every control inside a row is `tabIndex={-1}`, so those keys are the *only*
  keyboard path to row actions - do not remove one without providing another.
  Both row types must render every hidden control: a folder row without
  `data-tree-delete` swallowed Delete silently for months, because the hook
  `preventDefault`s the key whether or not it finds something to click.

**Those keys reach a control by clicking it, so the control has to answer a
click.** The hook calls `.click()` on the row's `[data-tree-menu]`, and Radix's
dropdown trigger opens on `pointerdown` and on its own `keydown` - neither of
which a programmatic click dispatches. Every menu-only action (Duplicate, Move
to, Run, Add, Export) was therefore mouse-only, on a path the tree advertised
(#1212). `RowActionsMenu` now holds its own open state and opens on a click
reporting `detail === 0`, which is what a click with no pointer behind it
reports - the mouse path stays Radix's, since its own `pointerdown` has already
opened the menu by the time a real click arrives. The hidden `<button>` controls
answer a click by being plain buttons; anything richer added to a row has to
declare how it answers one.

**`RowActionsMenu` takes its `tabIndex` from the row.** It is `0` by default -
outside a tree the `⋯` menu is an ordinary tab stop - and these rows pass `-1`,
because the tree is one tab stop and the keys above are the way in. Closing the
menu hands focus back to the *row*, not to the trigger Radix would return it to:
a `tabIndex={-1}` control holding the tree's focus is a stop the user cannot Tab
back to.

Rows declare behaviour through data attributes rather than props
(`data-tree-activate`, `data-tree-toggle`, `data-tree-menu`, `data-tree-rename`,
`data-tree-delete`, `data-tree-move-up` / `-down` / `-in` / `-out`,
`data-tree-label`), so the hook needs nothing threaded
through `CollectionItem`'s prop list. `data-tree-label` is the row's name for
typeahead and is not optional decoration: a request row's `textContent` starts
with its method badge and a folder's ends with its child count, so matching the
text would search a string the user never sees.

**Focus is not selection.** Arrows move focus without opening anything; Enter
opens. Keep roving focus, `aria-selected`, and the open tab in tabs-store
distinct - conflating them is the classic treeview bug.

**The whole row is the drag handle, and that is only safe because the
discriminator is movement.** There is no grip icon: the row already fought dead
zones to become clickable everywhere (see the hit-area rule above), and a grip
would hand most of that area back. A press becomes a drag at ~4px and not
before, so every click affordance survives - and the completed drag swallows the
one click the browser fires after it, or the row it was just dropped on would
open. Never a timer: `RequestItem.test.tsx` pins that opening is synchronous.

**A row's pointer handlers must ignore what its own menu sends them.** The ⋯
menu is a React child of the row and a *portal* in the DOM, and React bubbles
synthetic events through the component tree - so a press on "Delete" arrives at
the row's `onPointerDown`. Taking it captures the pointer on the row, the
capture retargets the `pointerup` the menu item was waiting for, and every
action in every row menu stops working while looking perfectly normal.
`closest("[data-tree-menu]")` does not catch it (portalled content is not inside
its trigger); a DOM containment check - `currentTarget.contains(target)` - does,
and is the guard on every pointer handler a row spreads.

**Drop indicators are classes on rows that already exist.** A line between two
rows is a 2px `bg-primary` span positioned inside the target row and indented to
that row's own depth - the depth is the only thing separating "after this
collapsed folder", "into it" and "after its parent". Dropping *into* a folder
reuses the selected-row ring. Nothing new gets `role="treeitem"`: the
roving-focus walk and the group nesting are read off the DOM, so an indicator
node between rows would change the tree's shape mid-drag. A row that cannot take
the drop is dimmed and carries `data-drop-blocked` - the dragged folder's own
subtree, and the block the dragged row does not belong to.

**A rename must hand focus back.** The rename field replaces the row's label and
then unmounts, so closing it from the keyboard (Enter or Escape) with nothing to
catch focus drops the user to `<body>` and the next Tab restarts from the top of
the document. Both row types refocus their own row. A *blur* deliberately does
not - focus has already gone where the user sent it.

Visible order comes from the DOM (`[role="treeitem"]` in document order), since
collapsed subtrees are not rendered. Note a row's children are a **sibling** of
that row inside a shared wrapper, not nested within it, so finding a parent row
means walking up to the enclosing wrapper - not `closest()`.

**That same shape is why the hierarchy has to be stated, not inferred.** A
sibling group is not a child group, so the accessibility tree read as a flat
list of rows. Every row carries `aria-level` (1-based), `aria-posinset` and
`aria-setsize`; the children wrapper is `role="group"` and the folder row claims
it with `aria-owns`, which buys the ownership without moving the DOM the
roving-focus walk and the hit-area rules depend on. Folders and requests inside
one group are **one** set - the requests continue the folders' numbering, or two
adjacent rows both announce "1 of 1".

`CollectionTree` also renders one polite live region (`data-tree-live`). It
shipped empty, ahead of anything that wrote to it, on purpose: a live region
added at the same moment as its first message is not reliably announced (the
same constraint `ResponseAnnouncer` carries). What writes to it now is a move -
"Moved Get Users to position 2 of 5 in Billing", or the reason a move did not
happen ("Get Users is already first in Billing"), which is the only feedback a
keyboard user gets for a row that visibly went nowhere.

Currently on `CollectionItem` and `RequestItem` rows. **Only needed where the
control and the row genuinely differ** - the history, variables and settings
trees use full-width buttons that are their own target, so they use the baseline.
Before adding it, check whether the focusable element already spans the row.

---

## Flex Items Must Be Told They May Shrink

**A flex item defaults to `min-width: auto` / `min-height: auto`, which refuses
to shrink below its content.** `flex-1` sets how an item _grows_; it does not
grant permission to shrink. This has caused two separate bugs in this codebase
and is worth checking whenever a flex child holds unbounded content.

| Axis       | Add                        | Symptom when missing                                                                                              |
| ---------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Horizontal | `min-w-0` on the wrapper   | `truncate` never engages - a long name widens the row and the panel scrolls sideways.                              |
| Vertical   | `min-h-0` on the wrapper   | The child keeps its old height when the container shrinks - the parent overflows and grows a second scrollbar.     |

The vertical case is the more confusing one, because the visible symptom is a
_scrollbar_, not a sizing error: a Monaco editor in a resizable pane kept its
previous height when the pane was dragged smaller, so the pane overflowed and
drew a native scrollbar next to the editor's own. Two scrollbars for one
editor. The fix is never to hide the extra scrollbar - it is to let the child
shrink, after which there is no overflow to scroll.

An element that is itself the scroller is exempt on that axis: `overflow: hidden`
(which `truncate` sets) already gives a flex item an automatic minimum size of 0.

**The exemption reaches exactly one box, though - the item itself.** A scroller
nested a few blocks below a flex or grid item does not lend it that minimum, and
`overflow-auto` bounds the box it is on without stopping the min-content width
that box contributes upward. So "I made it scroll" is not the same claim as "it
cannot widen its host", and the second is the one a fixed-width surface needs.

### A grid track has the same default, and a panel cannot follow it

`grid` gives an implicit track a sizing function of `auto`, whose minimum is its
items' min-content - the same refusal to shrink, one box further out. On a
surface whose width is capped this is worse than on the canvas, because the
**track can outgrow the box that paints the background**: the panel stays at its
`max-w` and every row inside it lays out at the track's width, so controls that
have nothing to do with the wide content are the ones the user sees hanging over
the backdrop. Issue #701 found this in the Run Collection dialog, where a
seven-column data-file preview put the footer buttons 428px outside the painted
panel.

`grid-cols-1` - `repeat(1, minmax(0, 1fr))` - is the fix for any width-capped
grid surface: the `0` lets the track be narrower than its content's min-content,
which is what gives the scrollers inside it room to scroll. Prefer it on the
surface over `min-w-0` sprinkled on the items - the items are written by every
caller, and the cap is the surface's own promise.

`DialogContent` itself is a **column flex container** rather than that grid
since issue #773, which needed a height cap a grid will not honour (see below),
and it refuses the same widening for a different reason: `min-width: auto` is a
main-axis rule, so on the cross axis an item stretches to the line - the panel's
own content width - and a wide descendant overflows inside it instead of
widening it. Measured in Chromium on the seven-column shape from #701, the
footer landed 580px past the painted edge under a bare `auto` track and 25px
*inside* it under either spelling of the clamp. The grid version is still the
right one for a surface that is genuinely a grid.

Write it as the stock utility, not as the arbitrary value that says it more
directly. **Tailwind emits no rule for `grid-cols-[minmax(0,1fr)]`** (verified
against the built CSS), so that spelling is a class that reads correctly, passes
a `className` assertion, and styles nothing.

### Dialog widths: three sizes

| Size | Class | For |
| ---- | ----- | --- |
| Standard | `sm:max-w-lg` (512px) | A form or a decision - a confirm, a rename, a picker, a short field set. |
| Wide | `max-w-xl` (576px), the primitive's default | A dialog holding something with a shape of its own: a table, a diff, a preview, a dense config. |
| Browser | `sm:max-w-2xl` (672px) | A dialog whose job is *reading* that shape and picking out of it, not confirming something about it. One call site: the data-row picker beside Send. |

These had drifted to five values across eleven call sites, including two one-off
pixel widths, so the same kind of dialog came out a different size depending on
who wrote it. `dialog-width-scale.test.tsx` holds the set closed; a dialog that
genuinely needs another size widens the scale here and in `dialog.tsx`, with the
reason, rather than opening a one-off.

`2xl` was opened for the row picker (issue #892): seven columns of ordinary CSV
at 576px leaves about 60px a column, which is one truncated cell per column and
nothing scannable. It is deliberately the last size on the scale - a dialog is a
focus device before it is a container, so content that wants more room than this
wants a pane, not a wider modal.

Prefer a **cap** (`max-w-*`) over a fixed `w-[…]`: a fixed width is one the panel
keeps on a viewport narrower than it, where `w-full` under a cap gives the same
stable band and still fits. And widening is never the fix for content escaping
the panel - a wider panel with an `auto` track spills exactly the same way, just
further along. Clamp the track; widen only for the reading.

### Dialog height: one cap, and the band that scrolls

A dialog panel is `fixed` and centred by a translate, so a panel taller than the
viewport is centred on a box it does not fit: clipped at the **top and the
bottom** at once, with nothing to scroll, because a fixed box does not scroll the
page. The footer is the half that goes, which makes the dialog's primary action
unreachable by pointer - and only *by pointer*, since Tab still reaches it, which
is how this survived fourteen call sites (issue #773). Measured in Chromium at a
613px viewport, an eighteen-row dialog put its Run button 227px below the screen.

The panel therefore declares `max-h-[85vh]`, and the band between the header and
the footer is a **`DialogBody`**:

```tsx
<DialogContent className="sm:max-w-xl">
  <DialogHeader>…</DialogHeader>
  <DialogBody className="space-y-4 py-2">…</DialogBody>   {/* the only scroller */}
  <DialogFooter>…</DialogFooter>
</DialogContent>
```

Three rules hold it together:

- **The body scrolls, never the panel.** `overflow-y-auto` on the panel is the
  tempting one-liner and it is the wrong one: the corner close button is
  `absolute` *inside* the panel, so it scrolls away exactly when the dialog is
  long enough to need a visible way out. The panel keeps one anyway as a
  fallback for a dialog with no band; with a band present the panel never
  scrolls and the button stays pinned.
- **`min-h-0` on the band is load-bearing**, for the same reason `min-w-0` is
  one section up: a flex item's automatic minimum on the main axis is its
  content, so without it the band refuses to shrink and the overflow moves
  straight back out to the panel.
- **`flex-auto`, not `flex-1`.** Basis `0%` asks a short dialog to stretch its
  one band over the whole cap; basis `auto` grows only into height that is free.

Header and footer are `shrink-0` so they stay bands rather than being the first
thing squashed. A dialog with no middle to scroll - a confirm, a rename - needs
no body. A dialog that manages bands of its own (`ImportModal`) or whose content
is already a self-scrolling list (`CommandDialog`) opts out at the call site with
the reason written there; `dialog-height-band.test.tsx` holds that list closed,
so a new dialog cannot skip the band silently.

Opting out of the band does not opt out of the shape. The command palette's
keyboard hints are a `CommandFooter` - `shrink-0`, a sibling of `CommandList`
and never a row inside it - because the rule is about what scrolls, not about
which primitive names it: hints that scroll away with the results they describe
are hints nobody reads. Nor does opting out excuse the cap: the list that
scrolls in place of a band owns one of its own, and the palette's is
`min(400px, 60vh)` (#1177) rather than a bare pixel value, so the input, the
list and the hints together stay inside the panel's `85vh` on a short window
instead of being clipped by the `overflow-hidden` that keeps the list's scroll
the only one.

---

## Layout Structure

```
Shell
├── Resizable sidebar container  (280–600px, default 320px - useResizable hook)
│   └── Sidebar
│       ├── ActivityBar     w-11 (44px)  bg-panel border-r border-border
│       └── SidebarPanel    w-60 (240px) bg-panel border-r border-border  (collapsible)
├── Resize handle            w-1  bg-border hover:bg-primary cursor-col-resize
└── main (flex-1)            routes render here
```

### Resizable Sidebar

Shell uses `useResizable` from `app/src/hooks/useResizable.ts`:

```tsx
const { size: sidebarWidth, isResizing, startResizing } = useResizable({
  defaultSize: 320,
  min: 280,
  max: 600,
});

// Sidebar container:
<div style={{ width: `${sidebarWidth}px`, minWidth: "280px", maxWidth: "600px" }} className="flex-shrink-0 ...">
  <Sidebar />
</div>

// Drag handle:
<div
  onMouseDown={startResizing}
  className={cn("w-1 bg-border hover:bg-primary cursor-col-resize transition-colors shrink-0", isResizing && "bg-primary")}
/>
```

**`useResizable` API:**

```ts
useResizable({ defaultSize, min, max, direction?: "horizontal" | "vertical" })
// → { size: number, isResizing: boolean, startResizing: (e: React.MouseEvent) => void }
```

`startResizing` takes a `React.MouseEvent` (wire directly to `onMouseDown`). Uses delta-based calculation - captures drag origin on mousedown, computes `newSize = startSize + delta` - so it works for panels that don't start at the viewport origin.

### ActivityBar

- **Width:** `w-11` (44px), full height, `bg-panel border-r border-border`
- **Tab buttons:** `w-10 h-10 flex items-center justify-center rounded-md`
- **Active state:** `bg-primary/10 text-primary` + 2px left accent bar
  ```tsx
  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-sm" />
  ```
- **Inactive hover:** `hover:bg-accent hover:text-foreground`
- **Icon size:** `w-4 h-4`
- **Tabs (top):** Collections (Folder), History (Clock), Variables (Code2)
- **Tab (bottom, pinned):** Settings (Settings2) - pushed down with `flex-1` spacer
- **Collapse:** clicking active tab while panel open → `setPanelOpen(false)`
- **Tooltips:** `side="right"` via `TooltipContent`

### SidebarPanel

- **Width:** `w-60` (240px) internal - the outer resizable container starts at 320px
- `bg-panel border-r border-border overflow-hidden`
- **Content:** `ScrollArea` fills available space
- **Footer:** `ConnectionStatus` pinned to bottom with `border-t border-border`

---

## Component Patterns

### Empty, error and loading - the three states of a data pane

Every pane backed by a query needs all three, and they were each hand-written
before: casing split two ways ("No Run Selected" vs "No collections yet") and
structure ranged from icon + heading + description + action down to one bare
line of muted text. Three shared primitives in `components/shared/` now cover it.

| State | Component | Notes |
|-------|-----------|-------|
| Nothing here yet | `EmptyState` | `variant="inline"` for a single muted line inside a list; default is the centred icon + title + description + optional action |
| It broke | `ErrorState` | Takes the raw `detail` and an `onRetry` |
| Still loading | `DetailSkeleton` | `rows` prop, default 4 |

**`ErrorState` is deliberately not a variant of `EmptyState`.** "Nothing here
yet" and "this failed" are different messages with different affordances, and
folding them into one component with a flag makes it easy to show the wrong one.
`ErrorState`'s icon is not a prop, either - one symbol for all failures.

**The bug underneath the inconsistency is worth knowing.** `useQuery` destructured
as `{ data = [] }` with no `throwOnError` resolves to `[]` when the request
*fails*, and never reaches an ErrorBoundary - so six screens told the user their
workspace was empty when the query had simply errored. When adding an error
pane, gate it on `length === 0`: TanStack keeps last-good data through a failed
background refetch, and covering still-valid content with a full-pane error is
its own regression.

Sentence case for titles, everywhere.

### Cards

```tsx
<div className="bg-card border border-border rounded-md p-4">
  ...
</div>
```

Never use hardcoded background colors like `bg-gray-50`, `bg-blue-50`, `bg-zinc-900` for card surfaces. Always `bg-card`.

### Section Eyebrow Label

```tsx
<p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-4">
  Section Title
</p>
```

That string has one home: the `Eyebrow` primitive
(`app/src/components/ui/eyebrow.tsx`), which is what a section label should
render - it was extracted because the class was hand-typed in about a dozen
components and two of them had already drifted, and `eyebrow.test.ts` fails on a
second copy of the literal. The command palette's group headings are an
`Eyebrow` inside the element cmdk labels the group by.

### Status Badges / Pills

**Live (running):**
```tsx
<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-green-500/15 text-green-500 border border-green-500/25">
  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
  LIVE
</span>
```

**Completed / Stopped:**
```tsx
<span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-muted text-muted-foreground border border-border">
  COMPLETED
</span>
```

**Run status left-bar (RunItem):**
```tsx
<div className={cn(
  "absolute left-0 top-0 bottom-0 w-1",
  status === "completed" && "bg-green-500",
  status === "failed"    && "bg-red-500",
  status === "running"   && "bg-blue-500",
  status === "stopped"   && "bg-orange-500",
  status === "pending"   && "bg-muted-foreground"
)} />
```

### Toasts

Transient report of an action the user just took. The queue is
`stores/toast-store.ts`; the surface is the shadcn/Radix primitive in
`components/ui/toast.tsx`, rendered once by `components/shared/Toaster.tsx`.

**Four things about toasts are user-configurable** (Settings -> Notifications,
persisted in `client-settings-store` as `notifications`, options and defaults in
`constants/toast.ts`):

| Setting | Values | Default | Applied |
|---------|--------|---------|---------|
| `position` | 6: each corner plus top/bottom centre | `bottom-right` | `Toaster` (viewport class + swipe side) |
| `durationScale` | `short` 0.5x, `default` 1x, `long` 2x, `never` | `default` | at enqueue |
| `maxVisible` | 1-8 | 4 | at enqueue |
| `minSeverity` | `all`, `warning`, `error`, `none` | `all` | at enqueue |

Three of the four are resolved **when a toast is enqueued**, not when it is
drawn, so changing them does not restyle what is already on screen. That is why
the panel has a Preview button.

The duration setting is a **multiplier over the per-variant durations in the
table below**, never a replacement for them: those are tuned so a failure
outlasts a confirmation, and a flat "5 seconds for everything" would throw that
away. `never` resolves to a 24h sentinel rather than `Infinity`, because the
primitive arms a real `setTimeout` and a non-finite delay there is coerced to 1.

**Every position clears the chrome on its own edge**, via `--dock-height` at the
bottom and `--titlebar-height` **plus** `--tabstrip-height` at the top - never a
round number. The top edge is two bands since the shell split the title row from
the tab strip, and clearing only the first put the stack back on the chrome
32px lower. The stack is
`position: fixed`, so it anchors to the window rather than the layout, and a
plain `bottom-4` once put it on top of the Dock. `toast-position.test.tsx`
checks all six.

**The icon carries the variant; the rail reinforces it.** Never colour alone.
The version this replaced signalled variant with a 40%-alpha border and nothing
else: `border-destructive/40` measured **1.16:1** against the toast surface in
dark and 2.01:1 in light, while success's equivalent measured 2.21 / 1.42 - so
the two were not reliably tellable apart in either theme, and error was
effectively invisible in dark. All four variants now come from one token family:

| Variant | Icon | Rail (a rule) | Glyph (a foreground) | Duration |
|---------|------|---------------|----------------------|----------|
| `info` | `Info` | `border-l-border` | `text-muted-foreground` | 4s |
| `success` | `CheckCircle2` | `border-l-status-success` | `text-status-success-text` | 4s |
| `warning` | `AlertTriangle` | `border-l-status-warning` | `text-status-warning-text` | 6s |
| `error` | `XCircle` | `border-l-status-error` | `text-status-error-text` | 10s |

Measured against the popover surface, light / dark:

| Variant | Rail | Icon |
|---------|------|------|
| `info` | 1.30 / 1.00 | 5.61 / 6.77 |
| `success` | 2.30 / 7.53 | 5.71 / 8.81 |
| `warning` | 4.00 / 4.34 | 5.46 / 9.81 |
| `error` | 3.78 / 4.59 | 5.88 / 5.85 |

Two of those rows look wrong and are not. **`info` is the neutral variant and
takes no accent rail on purpose** - `border-l-border` is invisible against the
toast's own fill, and absence of a rail is itself the signal. And **success's
rail on white is 2.30**, under the 3:1 a graphic needs when it is the *sole*
carrier of meaning. It is not the sole carrier: every icon clears 5.4:1 in both
themes. That is the whole reason the icon exists.

The rail and the glyph take **different tiers of the same family on purpose**: a
rail is a rule and takes the bare `--status-*`, a glyph is painted with a `text-`
utility and takes `--status-*-text`, the tier tuned to be read against a
background. `status-color-tokens.test.ts` enforces the second half repo-wide.
Neither ever takes `--status-*-fill`, which is only correct under a white label.

The shell keeps `bg-popover` with a `border-border` edge. That edge faces the
canvas, which is the case `border-border` is for. It is deliberately **not**
`border-rule`: no `surface-popover` class is declared, and `border-rule` under no
declared surface falls back to the invisible default.

**The stack sits above the Dock, not on it** -
`bottom-[calc(var(--dock-height)+1rem)]`, keeping the same 1rem of air it has on
its right edge. See **Geometry** for why that is a token and not a literal. It
also clears dialogs at `z-50` on `z-[100]`, which is hit-tested rather than
assumed, since a dialog portals to `body` while the viewport lives in `#root`.

Durations are floors, not limits - the primitive pauses them on hover, focus and
window blur. A failure gets longer than a confirmation because it often carries a
cause from the engine ("database is locked") that takes longer to take in.

**Queue policy** lives in the store, because the primitive has no opinion on it:
an identical message and variant already on screen is collapsed rather than
stacked (the OAuth2 guard retries; an SSE stream can fail on every reconnect),
and past four the oldest is dropped so a burst cannot run off-screen where it is
unreachable and undismissable.

**Everything is polite, including errors** (`type="background"`). A toast
dismisses itself on a timer and always reports something the user just asked
for, so interrupting what they are reading is the wrong trade.

### Destructive Actions

```tsx
/* Error/warning banner */
<div className="bg-destructive/10 text-destructive rounded-md p-3">...</div>

/* Stop button */
<Button
  variant="ghost"
  className="text-destructive hover:bg-destructive/10 hover:text-destructive border border-destructive/30"
>
  Stop
</Button>

/* Delete icon button */
<Button
  variant="ghost"
  size="icon"
  className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100"
>
  <Trash2 className="w-3 h-3" />
</Button>
```

### URL Bar (Flat Style)

```tsx
<div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-panel shrink-0">
  <MethodSelector />   {/* w-[76px] h-[34px] bg-accent font-mono font-semibold text-[11px] */}
  <UrlInput className="flex-1 h-[34px] bg-card border border-border rounded-md px-3 text-[13px] font-mono focus:border-primary focus:outline-none transition-colors" />

  {/* Primary action */}
  <button className="h-[34px] px-4 rounded-md bg-primary text-white text-[13px] font-semibold ...">
    {isExecuting
      ? <><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-vayu-spin inline-block" /> Sending</>
      : <>▶ Send</>
    }
  </button>

  {/* Secondary action - always token-based (text-primary/border-primary/bg-primary/10), never hardcoded purple */}
  <button className="h-[34px] px-3.5 rounded-md text-[12px] font-semibold text-primary border border-primary bg-primary/10 ...">
    <Zap className="w-3.5 h-3.5" /> Load Test
  </button>
</div>
```

### Dashboard Header (Compact 52px)

```tsx
<div className="h-[52px] flex items-center gap-3 px-5 bg-panel border-b border-border shrink-0">
  {/* Status pill - LIVE (green animated dot) or COMPLETED/STOPPED (muted) */}
  {/* Method badge - inline <span> with hsl(var(--method-xxx)) inline style */}
  {/* URL - font-mono text-[12px] flex-1 truncate */}
  {/* Config summary - text-[12px] text-muted-foreground hidden sm:block */}
  {/* Stop button - ghost variant, destructive color, Loader2 spinner while stopping */}
</div>
```

The header has a live elapsed timer (`liveTick` state) that resets to 0 at the start of each run.

### SVG Sparkline

```tsx
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
  const w = 108, h = 26;
  const pts = data.map((v, i) =>
    `${(1 + (i / (data.length - 1)) * w).toFixed(1)},${(1 + h * (1 - (v - min) / rng)).toFixed(1)}`
  );
  const area = `M1,${h + 1} L${pts.join(" L")} L${w + 1},${h + 1}Z`;
  return (
    <svg width={110} height={28} className="block overflow-visible">
      <path d={area} fill={color} fillOpacity="0.15" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
```

### SVG Area Chart

`viewBox="0 0 600 150"`, padding `PL=42 PR=8 PT=6 PB=20`. Area fill uses `fillOpacity="0.12"` (slightly less than the sparkline's `0.15`). Grid lines use `hsl(var(--border))` with `strokeDasharray="2 2"`. Axis labels use `hsl(var(--muted-foreground))` in JetBrains Mono at `fontSize="9"`. Requires `data.length >= 2` (returns null otherwise).

### Hero Metric Card

```
┌─────────────────────────────────────────┐
│ LABEL (11px, uppercase, muted)          │
│ 34px bold mono value   unit (xs, muted) │
│ sub-label (11px, muted)                 │
│ [sparkline 110w] (optional, below)      │
└─────────────────────────────────────────┘
```

```tsx
<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1">
  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
  <div className="flex items-baseline gap-1.5 mt-0.5">
    <span
      className="text-[34px] font-bold leading-none font-mono tabular-nums"
      style={{ color: valueColor || "hsl(var(--foreground))" }}
    >
      {value}
    </span>
    {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
  </div>
  {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
  {sparkData && sparkData.length > 1 && (
    <div className="mt-2">
      <Sparkline data={sparkData} color={sparkColor || "hsl(var(--primary))"} />
    </div>
  )}
</div>
```

Note: sparkline renders **below** the value row, not beside it.

### Secondary Stat Card

```tsx
<div className="bg-card border border-border rounded-md p-3">
  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-1.5">{label}</p>
  <div className="flex items-baseline gap-1">
    <span className="text-[22px] font-bold font-mono text-foreground">{value}</span>
    {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
  </div>
</div>
```

### Latency Distribution Bar

Gradient track (green→amber→red at 18% opacity), with absolute-positioned needle markers at p50/p95/p99. Each marker consists of:
- A 1px-wide, 16px-tall vertical pin: `w-px h-4 mx-auto opacity-85`
- A dot below it: `w-2 h-2 rounded-full mx-auto -mt-1` with `boxShadow: "0 0 0 2px hsl(var(--card))"` (creates the ring effect without Tailwind ring classes)
- Value label + percentile label below

### Progress Bar

`components/ui/progress.tsx`, over `@radix-ui/react-progress`. Track
`h-1.5 w-full overflow-hidden rounded-full surface-sunken`; fill
`h-full rounded-full bg-primary`.

Three choices worth stating, because each has a plausible wrong answer:

- **`bg-primary`, not `bg-primary-fill`.** `--primary-fill` exists for solids
  that carry a white label; a progress fill carries none, so it follows the
  accent rule and brightens in dark like every other accent surface.
- **`surface-sunken` for the track.** It is the one recessed fill that reads on a
  card in both themes (1.356 / 1.343), and on `--muted` / `--accent` no border
  token works at all - see the borders section.
- **`rounded-full`, not a radius token.** A track is a pill at every roundedness
  setting, which is that setting's documented fixed-radius exemption. A bare
  `rounded` would pin it to 4px and fail `radius-token.test.tsx`.

Determinate sets the fill's `width` and transitions it
(`transition-[width] duration-200 ease-out`). Indeterminate is a `w-1/3` stripe
crossing the track via `.progress-indeterminate` - growth from the start would
read as a fraction, and there is no fraction to report.

---

## Tailwind Utility Reference

| Token | Tailwind class |
|-------|---------------|
| Canvas background | `bg-background` |
| Panel background | `bg-panel` |
| Card background | `bg-card` |
| Primary text | `text-foreground` |
| Secondary text | `text-muted-foreground` |
| De-emphasized text | `text-subtle-foreground` |
| Primary accent | `text-primary`, `bg-primary`, `border-primary` |
| Default border | `border-border` |
| Strong border | `border-border-strong` |
| Hover state | `hover:bg-accent` |
| Selected state | `bg-accent-active` |
| Success | `text-success`, `bg-success/10` |
| Warning | `text-warning`, `bg-warning/10` |
| Info | `text-info`, `bg-info/10` |
| Error | `text-destructive`, `bg-destructive/10` |
| Method text (GET) | `method-get` (and `method-post`, `method-put`, etc.) |
| Method bg (GET) | `bg-method-get` (and `bg-method-post`, etc.) |
| Mono font | `font-mono` |
| Code font (utility) | `font-code` |
| Thin scrollbar | nothing - 6px is the global baseline (see [Scrollbar](#scrollbar)) |
| Tab-strip scrollbar | `scrollbar-strip` (4px, thumb on hover) |
| Variable color | `text-variable` or `.variable-highlight` |

### Never use

- `bg-gray-*`, `bg-zinc-*`, `bg-slate-*` - use `bg-card`, `bg-panel`, `bg-background`
- `bg-blue-50`, `bg-red-950`, etc. - use `bg-destructive/10`, `bg-info/10`, etc.
- `dark:bg-*` hardcoded overrides - tokens handle both modes automatically
- `text-gray-500`, `text-gray-400` - use `text-muted-foreground`
- Hardcoded hex method colors like `text-[#22c55e]` - use `method-get` or `hsl(var(--method-get))`
- `${hexColor}18` hex-alpha concatenation - use `hsl(var(--method-xxx) / 0.1)`
- Hardcoded purple for Load Test / secondary actions - use `text-primary/border-primary/bg-primary/10`

These rules are enforced for the request/response tree by
`modules/request-builder/components/ResponseViewer/palette-tokens.test.ts`. They
were documented long before they were enforced, and the tree had drifted: seven
usages of `text-green-500` / `text-blue-500` and friends, every one of which
failed its contrast bar in **light** mode (1.63–3.76 against thresholds of 3.0
and 4.5) while passing in dark. That asymmetry is inherent to a raw palette
class rather than bad luck - one value cannot suit a white card and a near-black
one, so the light failure is unfixable without breaking dark. The per-theme
`-text` tokens clear both.

The guard is scoped to the trees that were measured. Elsewhere the raw palette
classes appear as explicit `bg-blue-50 dark:bg-blue-950` pairs, which are
theme-aware and so are not this defect; converting those needs new tokens
(there is no purple or info `-text` token today) and is a design decision.

---

## Response Body Syntax Highlighting

Planned / pending implementation. Intended colors for the JSON pretty-printer:

| Token | Color |
|-------|-------|
| Object keys | `#7dd3fc` (sky-300) |
| String values | `#86efac` (green-300) |
| Number values | `#fbbf24` (amber-400) |
| Boolean values | `#a78bfa` (violet-400) |
| Null | `#94a3b8` (slate-400) |

---

## Scrollbar

**Thin scrollbars are a global baseline, not a utility.** Every scroll
container gets them; there is nothing to remember and nothing to apply.

```css
/* index.css, @layer base */
@supports not selector(::-webkit-scrollbar) {
	:where(*) {
		scrollbar-width: thin;
		scrollbar-color: hsl(var(--muted-foreground) / 0.3) transparent;
	}
}
::-webkit-scrollbar {
	@apply w-1.5 h-1.5;
}
```

**The `@supports` guard is load-bearing, not defensive.** Since Chromium 121 a
scroller that declares `scrollbar-width` or `scrollbar-color` renders the
_standard_ scrollbar and ignores every `::-webkit-scrollbar` rule that applies
to it - the two systems do not compose. The properties were declared globally
on `:where(*)`, so the whole webkit block below them was inert: the stylesheet
said 8px and the app drew Chromium's `thin`, which measures 10px. That gap is
the "scrollbars read too thick" report. Measured on Chromium 141: a scroller
with `scrollbar-width: thin` and a 6px `::-webkit-scrollbar` renders **10px**;
the same scroller with the standard properties behind the guard renders
**6px**.

So `scrollbar-width` and `scrollbar-color` belong nowhere outside that guard.
Setting either on an element turns that element's webkit rules off, silently -
the bar stays, at the wrong width, in the wrong colour.

**6px, and 6px in all three systems.** The app draws scrollbars three ways, and
only the first is reached by a stylesheet at all:

| System | Where the width lives | Was |
| ------ | --------------------- | --- |
| Native `overflow` panes | `index.css`, the block above | 8px declared, 10px drawn |
| Radix `ScrollArea` | `scroll-area.tsx` class list | 10px, `bg-border` thumb |
| Monaco editors | `code-editor.tsx`, `SCROLLBAR_SIZE` in px | 14px vertical, 12px horizontal |

They are read side by side - a body panel puts an editor, a `ScrollArea` and a
plain scroll pane in one view - so all three carry one number. `ScrollArea`
also repeats the baseline's `muted-foreground/30` thumb: `--border`, shadcn's
default, is the same colour as `--card` in dark, which is an invisible thumb on
the surface that component is usually laid over. Monaco renders its bars as its
own DOM inside the editor and takes a **number**, not a class, which is why no
sweep of the stylesheet can see it drift.

`scrollbar-systems.test.ts` derives the two repeats from the CSS, so the three
move together or the suite reddens.

Do not take a content pane below 6px: the thumb stops being a mouse target.

### Tab strips: `scrollbar-strip`

A `TabsList` that scrolls natively (request builder, response viewer,
collection detail) draws the baseline bar directly under a 24px band of tabs.
The scoped utility takes those strips to 4px and hides the thumb until the
strip is hovered:

```css
/* index.css, @layer utilities */
.scrollbar-strip::-webkit-scrollbar {
	@apply w-1 h-1;
}
.scrollbar-strip::-webkit-scrollbar-thumb {
	@apply bg-transparent;
}
.scrollbar-strip:hover::-webkit-scrollbar-thumb {
	@apply bg-muted-foreground/30;
}
```

Chromium repaints scrollbar pseudo-elements on the scroller's own `:hover`, so
the reveal costs no JS. This is the one blessed exception to the 6px floor: a
strip is scrolled by wheel or by tab focus rather than dragged.

This was a `.scrollbar-thin` class applied per element, and it drifted badly:
**38 of the app's 44 scroll containers never got it**, so chunky
arrow-button scrollbars appeared mid-UI. Two traps made the class approach
unfixable by discipline alone:

- **`scrollbar-width` is not inherited.** A styled ancestor does nothing for a
  nested scroll container. This is exactly how the History run list ended up
  with a platform scrollbar inside an already-styled panel.
- **Styling `::-webkit-scrollbar` at all is what removes the stepper arrows.**
  So an unstyled container did not merely look slightly different - it grew
  arrow buttons, which is a different control, not a different colour.

`:where()` keeps specificity at zero, so an element that genuinely needs a
different scrollbar can still override with a plain class.

Electron is Chromium, so the webkit rules are the ones that render here;
`scrollbar-width` is the standards-track fallback for an engine that has no
such pseudo-element, which is why it sits behind the `@supports` guard above
rather than beside the rules it would otherwise disable.

---

## Motion

Motion collapses for two independent reasons, and both must keep working.

```css
/* index.css - outside @layer, so the !important declarations win */

/* 1. The in-app toggle: Settings → Appearance → Reduced motion */
html[data-reduced-motion="true"], html[data-reduced-motion="true"] * { … }

/* 2. The system preference, which a user states once for every app */
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }
```

Both collapse the same four properties - `animation-duration`,
`animation-iteration-count`, `transition-duration`, `scroll-behavior`. A
declaration added to one and forgotten in the other leaves the system-preference
path animating something the toggle stops, which `reduced-motion.test.ts`
guards.

**The system preference was ignored until it wasn't.** The toggle shipped
first, and `prefers-reduced-motion` appeared nowhere in the stylesheet - so
someone who had turned Reduce Motion on in Windows, macOS or GNOME got every
animation until they found a checkbox in Vayu and said it a second time.

**The two are additive, and deliberately only in one direction.** The toggle
forces the collapse for a system that asks for nothing. There is no way to opt
*back into* animation against a system that asked for less; that is the one
direction where guessing wrong has a cost.

**Which means the switch can read "off" while nothing animates**, so the
Appearance panel says so when `usePrefersReducedMotion()` is true. Without that
line the only explanation for the app's behaviour lives in another
application's settings.

**Nothing animates from JavaScript.** No `element.animate()`, no
requestAnimationFrame loops, and the single `scrollIntoView` passes no
`behavior`, so it follows the `scroll-behavior` the rules above set. Keep it
that way: JS-driven motion is invisible to both rules and would need its own
opt-out.

---

## Source Files

| File | Purpose |
|------|---------|
| `app/src/index.css` | All CSS custom properties, keyframes, utility classes |
| `app/tailwind.config.js` | Color mapping, font families, keyframes, animation aliases |
| `app/index.html` | Pre-paint appearance script; no font `<link>` (see `fonts.css`) |
| `app/src/fonts.css` | Bundled `@fontsource` imports for all six font families |
| `app/src/components/layout/Shell.tsx` | Root layout - resizable sidebar + drag handle + main |
| `app/src/components/layout/Sidebar.tsx` | ActivityBar + SidebarPanel |
| `app/src/hooks/useResizable.ts` | Drag-to-resize hook (delta-based, horizontal/vertical) |
| `app/src/utils/helpers.ts` | `getMethodColor(method)` → `var(--method-xxx)` |
| `app/src/modules/dashboard/components/MetricsView.tsx` | Sparkline, SvgAreaChart, LatencyBar, HeroCard, StatCard |
