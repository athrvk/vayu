---
description: >-
  The fonts the app bundles, their measured x-heights and the type scale conventions.
---

# Typography

## Fonts

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

`app/src/fonts.css` holds the `@fontsource` `@import` lines for all six families - the weights bundled, the subsets, and why.

```css
body { font-family: var(--font-sans); } /* default: "Space Grotesk", system-ui, sans-serif */
/* mono via the font-mono Tailwind class */
```

The faces are bundled rather than fetched because a stylesheet in `index.html`'s head is render-blocking and the window is only shown on first paint, so the fetch delayed the window appearing at all - measured at ~12.8s on a network that black-holes the request.
Nothing about how the app renders changed with the move: the weights bundled are exactly the ones the old css2 URL asked for, so `font-mono font-bold` stays browser-synthesised for JetBrains Mono, Fira Code and IBM Plex Mono, same as before.
Every subset each family ships is bundled too, which is what Google served on demand; behind their `unicode-range` a file is still only read when a character needs it, so the subsets beyond latin cost installer bytes and no startup work.

**User-selectable UI font + scale.**
Settings → Appearance → Interface lets the user pick the sans/body face (Space Grotesk / Inter / System / JetBrains Mono) and an interface scale - a slider over **80% to 200% in 10% steps**, which covers the 125-150% accessibility band the three fixed presets it replaced (Compact / Default / Comfortable) topped out below.
Font swaps the `--font-sans` custom property (so `body` + every `font-sans` utility follow); scale sets the page zoom factor (Electron `webFrame`, CSS `zoom` fallback in the browser).
Both live in `appearance-store` (source of truth `constants/appearance.ts`), persisted to localStorage, and applied pre-paint in `index.html`.

**User-selectable Code font** (#3692).
Settings → Editor → Code font swaps the `--font-mono` custom property on `documentElement` (`client-settings-store`), and every mono surface follows it: the Monaco editors, and every `font-mono` utility.
That holds only because `--font-sans` and `--font-mono` are declared in the plain `@theme` block of `index.css`, not `@theme inline`: `inline` would compile `font-mono` to the literal stack, and the override would reach nothing but the rules that write `var(--font-mono)` by hand.
`app/src/constants/appearance.font-tokens.test.ts` holds the declaration there.
`VariableInput` turns ligatures off on its `<input>` and its overlay (#3783): Blink mis-paints a native input after typing `//` in a ligating code face.

**Reflow guarantee** (#3494).
The window's minimum is 1024px and the scale slider reaches 200%, so the smallest layout the app promises is **512 CSS px wide** (a pane beside the context bar is narrower again).
At that width nothing may overlap, clip a word, or break a label into a column of characters: a control that cannot fit **wraps or truncates**, and the thing that gives way is the one the user can read least of (a timestamp, a button label, a hint), never the one they came for (a run's name, the URL, the status code).
The class-level rules that hold it are under [Overflowing Text](overflow-and-shrink.md#overflowing-text) below.

**Interface density** (issue #1670) is a fourth Interface control, next to Roundedness: `Default` and `Comfortable`, toggled by a `data-density` attribute on `documentElement` rather than a computed value, because the two densities are whole `--spacing` values declared in `index.css` (see Spacing Scale below) with nothing for a resolver function to pick between.
The name `Comfortable` also named a discontinued interface-scale preset (a 1.1x zoom factor); the two are unrelated settings under different storage keys, and the scale preset has not been offered since the slider above replaced it.

The View menu's `Ctrl`/`Cmd` `+` `-` `0` drive that same setting rather than Chromium's own zoom, so a keyboard zoom persists across a restart and "Actual Size" means 100% *because that is the default setting*, not because it bypasses it.
The code font size (Settings → Editor) stays an independent control and composes with page zoom.

## Type Scale Conventions

| Use | Size | Weight | Class |
|-----|------|--------|-------|
| Section label / eyebrow | 11px | semibold, uppercase, +tracking | `text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground` |
| Hero metric value | 34px | bold, tabular | `text-hero font-bold leading-none font-mono tabular-nums` |
| Secondary metric value | 22px | bold | `text-metric font-bold font-mono` |
| View title | 20px | semibold | `text-xl font-semibold` |
| Tile metric value | 18px | bold | `text-lg font-bold` |
| Title / small heading | 15px | semibold | `text-md font-semibold` |
| Body / default | 13px | regular | `text-sm` |
| Small label | 12px | medium | `text-xs font-medium` |
| Micro / badge (mono) | 10–11px | mono semibold | `text-micro font-mono font-semibold` |
| Micro / badge (UI face) | 10–11px | semibold | `text-micro font-semibold` |
| URL / path | 12–13px | mono | `text-xs font-mono` |

**No font size is written as an arbitrary value.**
Every step in the table above has a name, and `type-scale.test.ts` fails on any `text-[Npx]` in `app/src`.
The last two exceptions closed in #1692: 11px and 10px - the app's two most-used sizes, at 188 and 60 call sites - are `--text-label` and `--text-micro` now, joining `--text-hero` (34px) and `--text-metric` (22px) before them, which closed the same way for the same reason: a named step arrives with its line-height, an arbitrary one does not.

**A step whose name is not a size word has to be registered in `cn()`.**
`text-<x>` is either a font size or a text colour, and tailwind-merge tells the two apart from a list of size labels it ships - so it read `text-hero` as a colour and dropped it from `cn("text-hero …", "text-foreground")`, leaving the dashboard's largest number at body size with nothing in the source to look wrong.
`lib/utils.ts` extends the merge's `font-size` group with the app's own steps; `text-md` never showed the defect only because "md" is already one of the labels it knows.
Add a step, add it there, and `cn-font-size.test.ts` is where that is held.

**The micro/badge step is semibold because 600 is the heaviest face the code font ships.**
`fonts.css` loads JetBrains Mono - the default `--font-mono` - at 400/500/600, and Fira Code and IBM Plex Mono at 400/500; only Space Mono, one of four selectable code faces, has a real 700.
So `font-mono font-bold` on a chip renders a synthesised weight for every user who has not picked that one face - which is what this row used to specify while `MethodBadge`, the primitive that owns the step, shipped `font-semibold` (#1199).

**The same step in the UI face is semibold too, and the reason is the row itself.**
The mono row settled one half of 10px and left the other half with no row to read, so the chips that are not `font-mono` picked a weight each - four different values, one pair of them inside a single primitive: `VariableScopeBadge` rendered `font-medium` compact and `font-semibold` full, because compact overrode `Badge`'s base and full did not (#1222).
Semibold is that base, so a chip that names no weight is already correct; a chip that names one should name this.
Above 600 is refused here for a second reason on top of the synthesised face: at 10px in the UI face the extra stroke closes the counters rather than reading as emphasis.

`type-scale.test.ts` reads both rows and every 10-11px class string written in `src` - either face, quoted or a template literal - and fails on a weight above 600 in any of them, so the rows and the app cannot part again.
A weight that is not *written* beside the size is out of its reach, whether it arrives through a `cn()` argument or from a `cva` base, so the two primitives at this step are pinned by rendering them instead (`MethodBadge.test.tsx`, `variable-scope-badge.test.tsx`).

It is a ceiling and never a floor: a chip that names a *lighter* weight, or none at all, passes.
That is deliberate, and tightening it is not the fix - the two exceptions below live in exactly the shape a floor would have to match, so a floor would fail on a `<code>` printing a column name.
Below the ceiling the row above is the rule and review is what applies it.

Two things at this size deliberately carry no badge weight.
A chip that prints a *value* rather than a label - a column name, a cookie attribute - is the URL / path step and stays unweighted.
And a numeric readout may take `font-medium` to lift one figure above its unweighted siblings, as the timing waterfall and the phase percentiles do; that is emphasis inside a row, not a badge.

The app had drifted to **182 arbitrary sizes across 11 distinct values**.
Half duplicated a step that already existed - `text-[12px]` *is* `text-xs`, `text-[13px]` *is* `text-sm` - and in doing so skipped the paired line-height: 34 of 36 and 13 of 16 set no `leading-*`, so they inherited the parent's while their `text-sm` siblings got 18px.
Same size, two rhythms, chosen by nobody.
Seven were half-pixel (`text-[10.5px]`, `text-[11.5px]`), which no scale contains and which render soft on a non-retina display.

`--text-md` (15px/20px) was added rather than removed: six surfaces reached for `text-[15px]` independently - the empty and error state titles, a collection name, the response heading, the font picker and the brand mark - which is a missing step, not six mistakes. 13px is body and 16px is heavy for a small heading in a dense tool.

**Use `text-sm` for body, not `text-[13px]`.**
Tailwind ships `text-sm` at 14px, which left the app running two scales a pixel apart - `text-sm` in ~160 places against `text-[13px]` in ~18.
Rather than migrate every call site, `--text-sm` is redefined in `@theme` (`index.css`) to **13px/18px**, so the utility *is* the documented body size.
`text-xs` already matches the 12px label, so that was the only size that diverged.
`text-[13px]` still works but skips the paired line-height - prefer `text-sm`.

**The heading register stops at 15px, and a heading never names its own size.**
`CardTitle` and `DialogTitle` carry `text-md`; a card or dialog heading that writes a size is overriding the primitive rather than using it.
That is how the app got here (#1202): `CardTitle` named no size at all, so every card heading in the app named one, 45 at `text-base` and 6 at `text-lg` - a settings panel and a report tab heading at 16-18px against 13px body, which is the register Postman and VS Code cap around 14px.
`Input` is `text-sm` for the same reason: stock shadcn ships `text-base md:text-sm`, the web workaround for iOS zooming a focused field under 16px, and a narrow desktop window is not a phone.

So **`text-base` (16px) is written nowhere in `src`**, and every step above the 15px title is held by file rather than by rule, because "a number in a tile" is not something a scan can recognise:

- **`text-lg` (18px)** is the tile metric value - bold numbers in muted tiles, five files, no headings.
- **`text-xl` (20px)** is the view title, one per view, and only the two settings views write it.
  A settings view stacks its title, the description under it, and cards whose `CardTitle` is 15px; flattening the title into that last step would lose the level, and reusing `text-lg` would give one step two meanings (#1409).
- **`text-metric` (22px) and `text-hero` (34px)** are the dashboard's metric values.
  Nothing in `src` writes `text-2xl` or above: 24px was five strays reaching past the step their siblings were designed at.

`type-scale.test.ts` holds all of it, and holds `input.tsx` to carrying no responsive size variant.
Each allowlisted file is asserted to still use its step, so a file that stops rendering one drops off the list instead of quietly licensing a heading there later.

`heading-step.test.tsx` also reads the dialog half, by scanning every non-test `.tsx` for a `<DialogTitle>` whose `className` carries a `text-` or `font-` class other than `sr-only`.
Rendering the primitive cannot find an override, because the caller's classes win through `cn()` (Import's title was `text-sm font-bold` until #2316).

**The type register is a measurement, not a preference.**
Perceived size follows x-height, not nominal size, and the six bundled faces differ by 13% at the same `font-size`.
Ratios are `OS/2.sxHeight / head.unitsPerEm`, read from the bundled `@fontsource` files by `appearance.font-metrics.test.ts`:

| Face | Role | x-height ratio | at 13px | at 12px |
|------|------|----------------|---------|---------|
| Space Grotesk | UI default | 0.486 | 6.32px | 5.83px |
| Inter | UI alternate | 0.546 | 7.10px | 6.55px |
| JetBrains Mono | code default | 0.550 | 7.15px | 6.60px |
| Fira Code | code option | 0.526 | 6.84px | 6.32px |
| IBM Plex Mono | code option | 0.516 | 6.71px | 6.19px |
| Space Mono | code option | 0.496 | 6.45px | 5.95px |
| Segoe UI | not bundled, the reference | 0.50 | 6.50px | 6.00px |

Two decisions come out of that table.
**The 13px body step stays**: the default UI face renders a 6.32px x-height there, *below* the 6.50px a system face gives at the same size, so body text was never what read large - the 16px chrome above was.
And **the code font default is 12px, not 13px**: JetBrains Mono has the largest x-height ratio of the six, which put 13px at 7.15px where an editor shipping Menlo or Consolas at its own default sits between 6.3 and 6.6px; 12px measures 6.60px.
Settings → Editor still offers 11 through 16, and the interface-scale slider still multiplies everything: these are the defaults the register is judged on, not a ceiling on the user.

**Icon sizing goes on `className`, not lucide's `size` prop.**
Mixing the two hides icons from a scale audit and lets off-grid values (15px) creep in.

**The two most common icon sizes are fixed steps, not `--spacing` multiples** (issue #1679, superseding the #1670 decision below).
Use `size-icon` (16px, was `w-4 h-4` / `size-4`) and `size-icon-sm` (12px, was `w-3 h-3`) - the app's own legibility floor at both densities, per the Chrome, Target and Icon Floors table under Spacing Scale Conventions.
`w-5 h-5` still rides `--spacing` (15/20px at Default/Comfortable): it was not part of the #1679 fix pathway and remains density-scaled until a reason to fix it turns up.

**`h-3.5 w-3.5`, `w-3.5 h-3.5` and `size-3.5` are banned outright** (`components/ui/icon-size-token.test.ts`, issue #1693).
They were a third icon size with no token behind them, spelled three ways across 152 call sites and doing the same job as `size-icon-sm` in the same rows; all of them are now `size-icon-sm`, a deliberate step onto the scale from 14px to 12px rather than a translation.
`size-icon` was wrong for them - each sits beside `text-sm` or smaller text, which is why it was written under the default in the first place.

**A glyph is `size-icon` or `size-icon-sm`; 12px is the floor** (same test, issue #2304).
The 3.5 ban read one shape, so glyphs that `--spacing` draws under the floor (`size-3` is 9px at Default, `h-2.5 w-2.5` 7.5px) or that spell a length by hand (`w-[15px] h-[15px]`) went unflagged.
A lucide icon or `RunStatusGlyph` whose own `className` carries `size-N`, `h-N` or `w-N` for N <= 3 (half steps included), or an arbitrary `w-[Npx]` / `h-[Npx]`, now fails.
Only the glyph's own className is read: a `<span>` dot, a skeleton bar and a solid `fill-current` Circle are shapes the control sizes, not icons.
Two glyphs stay at 7.5px by design and are listed with their reason in `SMALL_GLYPH_ALLOWED`: `InfoChip`'s "i" (inside the chip's own 12px dot) and the `ResizableHandle` grip (inside a handle box that carries its own border).
The entry is a path and an exact tag count, and the test fails when the file stops carrying that many, so an entry cannot outlive its glyph.
A new exception means a new entry with its reason, not a looser regex.

*Superseded decision (issue #1670, kept for history): the shrink applied to icons too, with nothing pinned outside the unit - `w-4 h-4` read 12px at Default and `w-3 h-3` read 9px, both checked by eye against a live render.
The owner's report on 0.32.0 reversed it: 12px and 9px glyphs read as small, not as dense, which is what sent `size-icon`/`size-icon-sm` back to a fixed floor.*

**Text beside an icon is `cap-centred`** (`index.css`, #1830).
An `items-center` row centres an icon's box and a label's *line box*, and the glyphs do not sit in the middle of their line box: the browser rounds the face's ascent and descent to whole pixels and gives an odd leading pixel to the bottom, so the cap band lands off centre by an amount that changes with the face, the size and the platform.
Space Grotesk at `text-sm` puts its caps 0.57px above the centre of every drawer row, which is the chevron reading low beside the name.
`cap-centred` trims the label's box to the cap band (`text-box: trim-both cap alphabetic`) and pads it back out to one line (`padding-block: calc((1lh - 1cap) / 2)`, floored at `1lh`), so the box keeps its height and its centre is the cap band's, for any face the user picks.

What remains is the renderer snapping the baseline to a pixel.
Measured at 2x in the collections tree, settings categories and element headers: the worst icon-to-caps offset went from 0.57px to 0.43px (a row on a whole pixel can only put its caps 0.57px above centre or 0.43px below it, and the trim picks the nearer), and rows on a half pixel stay at 0.07px.

Lucide draws three glyphs on these rows from y=3 to y=20 of its 24-unit grid, half a unit above every other glyph: `folder`, `folder-open` and `gauge`.
In a row whose text is `cap-centred` they come down by that half unit (1/48 of the box, a `transform` because the icon motions own `translate`), so the folder and the chevron sit on one line with the name.
The rule is scoped to those rows: beside a label still on its line box the high glyph happens to match the text, and centring it there would leave it the lower of the two.

Put it on every bare text item in the row, not only the one next to the icon: an item left on its line box sits half a pixel off the others.
Two sizes in one row then share a cap centre rather than a baseline (13px and 12px differ by 0.35px).
Not on an element that sets its own `py-*` (the two fight over the padding), and it cannot reach a `Button` or `SelectTrigger` label: the first is an anonymous box, the second a line-clamped one the trim does not apply to.
**Never on an `Input`, as a class or a `text-box`:** a field with no vertical padding (`size="xs"`) clips every descender and underscore at its own edge ("Create charae", "base url"); `input.test.tsx` fails on one.
The field needs nothing: its text already lands on a `cap-centred` label's line, so a rename moves no text at either density.
