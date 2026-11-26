---
description: >-
  The spacing scale, the floors for chrome bands, targets and icons, and the tree indent guides.
---

# Spacing, chrome floors and tree indent guides

## Spacing Scale Conventions

Every `p-*`, `m-*`, `gap-*`, `space-*` and `h-*`/`w-*` utility resolves to `calc(var(--spacing) * n)` (Tailwind v4), so the one `--spacing` declaration in `index.css` moves every padding, margin, gap and row height in the app at once (issue #1670).
Two densities, both in `index.css`: `Default` (`--spacing: 0.1875rem`, 3px/unit) and `Comfortable` (`[data-density="comfortable"] { --spacing: 0.25rem }`, 4px/unit - the value Tailwind defaulted to before this variable existed, so Comfortable is 0.30.0's layout exactly, not an approximation of it).
Set by Settings → Appearance → Interface → Density, owned by `appearance-store` (`applyDensity`), applied pre-paint.

| Use | Class | Default | Comfortable |
|-----|-------|---------|-------------|
| Control gap | `gap-2` | 6px | 8px |
| Group gap | `gap-3` | 9px | 12px |
| Section gap | `gap-4` / `space-y-4` | 12px | 16px |
| Card padding | `p-4` (`CardHeader`/`CardContent`/`CardFooter`) | 12px | 16px |
| Dialog padding | `p-5` (`DialogContent`) | 15px | 20px |
| Drawer row height | `h-8` | 24px | 32px |
| Icon (panel heading) | `w-5 h-5` | 15px | 20px |

The space between an icon and its label inside a `Button` is that same row: the primitive sets `gap-2` itself (`button-variants.ts`), so the icon carries no `mr-*` and the label no `ml-*`; a margin stacks on the gap and the pair sits further apart than in every other button.
A button that needs a different gap says `gap-*` on the `Button`.
`button-icon-gap.test.ts` fails on a margin on a leading icon (conditional ones included) or on the label that follows it.

Menu and toolbar icons are not a density row: they sit on a fixed floor, `size-icon-sm` (12px) or `size-icon` (16px), in the [Chrome, Target and Icon Floors](#chrome-target-and-icon-floors) table below.

`density.test.ts` reads both `--spacing` declarations directly off `index.css` and reds if either value changes.
`spacing-scale.test.ts` guards `Card` and `DialogContent` specifically - the two primitives this issue tightened - rather than scanning the whole tree for `p-6`/`p-8`/`gap-6`/`gap-8`:
several other `p-6`/`p-8` call sites exist outside those two primitives (page-level containers, and the `EmptyState`/`ErrorState` shared components) and were deliberately left alone as outside this issue's fix pathway.
`--titlebar-height` stays a literal `32px`: it sizes the macOS traffic lights, a fixed platform constant no density setting should move.

## Chrome, Target and Icon Floors

**Density scales rhythm - row heights, paddings, gaps - not chrome, interactive targets or icons** (issue #1679).
Three classes of thing have a floor `--spacing` must not carry below it: a chrome band is an anchor, not a list row; an interactive target has the WCAG 2.2 SC 2.5.8 24x24px minimum; an icon has a legibility floor.
Ten named steps, outside the `--spacing` multiplier, generate real Tailwind utilities (`h-band`, `size-target`, and so on) for these.
They live in a plain `@theme` block in `index.css`, deliberately not `@theme inline`: `inline` bakes a literal into each generated utility instead of a `var()` reference, which would silently disable the Comfortable override below.
The two font stacks sit in that block for the same reason (see Typography).

| Step | Class prefix | Default | Comfortable | Used by |
|------|-------|---------|-------------|---------|
| `--spacing-band` | `h-band` | 32px | 32px | Tab strip, drawer header, response toolbar, `RailButton`, the Dock (via `--dock-height`) |
| `--spacing-band-md` | `h-band-md` | 40px | 40px | The URL bar row (as `min-h-band-md`) |
| `--spacing-band-lg` | `h-band-lg` | 52px | 52px | Pane headers: the dashboard header, the Collection Detail header |
| `--spacing-banner` | `h-banner` | 36px | 36px | Update banner, recovery banner |
| `--spacing-control` | `h-control` | 28px | 36px | `Input` default, `Select`, `Button` default, the URL bar's controls |
| `--spacing-control-sm` | `h-control-sm` | 24px | 32px | `Button` sm, toast action, `ToggleGroup` xs, `Input` / `VariableInput` `size="sm"` |
| `--spacing-control-xs` | `h-control-xs` | 20px | 24px | `Input` `size="xs"`: the inline rename field inside a `target` row |
| `--spacing-target` | `size-target` | 24px | 28px | Icon buttons, close buttons, `Switch`, checkboxes, `CommandSearchBar`, the in-row tree controls (chevron, row menu), `InfoChip` (as an `after:` hit box behind its 12px dot) |
| `--spacing-icon` | `size-icon` | 16px | 16px | The app's default icon size (was `w-4 h-4` / `size-4`) |
| `--spacing-icon-sm` | `size-icon-sm` | 12px | 12px | The app's small icon size (was `w-3 h-3`, and `h-3.5 w-3.5` / `size-3.5` since #1693; `size-3` and anything smaller on a glyph since #2304) |

`band`, `band-md`, `band-lg`, `banner`, `icon` and `icon-sm` are theme-independent, the same way `--titlebar-height` and `--dock-height` are - a chrome anchor or a glyph's legibility does not become less real at a looser density.
The wider two arrived with issue #1688, which moved the last three bands off arbitrary bracketed literals; a band written that way was the one piece of chrome in the app that could follow no token at all, and the rows still breathe with the density setting because their own padding and gaps ride `--spacing`.
`header-band.test.ts` fails on any element that paints a band (a bottom rule over a panel fill) and sets its height with a pixel literal, and on any file that declares such a band and also writes `style={{ height`.
A JS prop that has to match a band (the GraphQL Variables pane's `collapsedSize`, `GRAPHQL_PANE_HEADER_HEIGHT`) is held to `--spacing-band` by `titlebar-height.test.ts` instead.
`control`, `control-sm`, `control-xs` and `target` scale on their own schedule under `[data-density="comfortable"]`, the same mechanism `--spacing` itself uses - just a different curve, so a control never drops below its own floor at either density.
`density.test.ts` and `chrome-floors.test.ts` guard both halves of this: the former that the ten steps are declared with these values and none of them is expressed as a `calc(var(--spacing) * n)`, the latter that the chrome bands, interactive targets and icon classes across `app/src` actually use them.
The latter also scans every non-test file for a `Button` / `TooltipIconButton` / `TimeMarker` / `SelectTrigger` / plain `<button>` tag carrying `h-N`, `w-N` or `size-N` with N <= 7.5 (under 24px at the 3px unit, fractions included), or an arbitrary `h-[18px]` / `size-[1rem]` under 24px: such an override outranks the size variant in emission order.
It also flags a bare `size-icon` / `size-icon-sm` as the tag's own box (#1867): a glyph step is 12-16px, and on a `Button` it replaces `size-target`.
A glyph passed in an `icon={...}` prop or a `[&_svg]:size-icon-sm` descendant is not the box; a small visible dot keeps its size and states the floor as an `after:size-target` hit area, as `InfoChip` and `TabItem`'s close button do.
It also flags a bare `h-8` or `h-9` on those tags (#1912, #2304): `h-8` is 24px and clears the floor, but it is the pre-density literal a control no longer states; `h-9` is the 27px `Button` default `h-control` replaced, and a `SelectTrigger` carrying it sits proud of the `Input` beside it (`w-8` and `size-8` are fine).
A third rule is about shape, not a number (#2304): **a plain `<button>` whose only content is a lucide glyph states a 24px box on its own `className`**, since otherwise it is as wide as the 12px or 16px glyph.
The accepted statements are `size-target` or `size-full`, an `after:size-target` hit area, or one height token (`h-target`, `min-h-target`, `h-control*`, `h-band*`, `h-full`) beside one width token (`w-target`, `min-w-target`, `w-full`); an `sr-only` label or a ternary between two glyphs still counts as glyph-only.
Use `Button size="icon"` or `TooltipIconButton` where the control is a real button.
The two in-row controls of the GraphQL schema tree (the expand chevron and "Show in the tree") are the exception: the row is a dense 18px line (`min-h-6`), so a 24px box would grow every expandable row and shift its label against the leaf rows, and each is a mouse affordance beside the tree's keyboard path (`tabIndex={-1}`).
The test counts them per file in `BOXLESS_GLYPH_BUTTONS` (two tags in `SchemaExplorer.tsx`), spent first-come exactly like `DRAWER_ROW_BUTTONS`: a third glyph-only button in that file is an offence, and an entry that stops matching exactly that many tags fails the test.
A box that arrives in a variable is invisible to the scan, so state it inline.
The one place `h-8` stays is a single-line drawer row (see "Drawer Row Metric" below): those are `<div>`s outside the tag set, plus the Settings drawer's category rows, which are hand-rolled `<button>`s.
The test counts them per file in `DRAWER_ROW_BUTTONS` (one tag in `SettingsCategoryTree.tsx`; the exemption covers `h-8` only, never `h-9`): a further `h-8` in that file is an offence, and an entry that stops matching exactly that many tags fails the test.
A compact text button or select trigger states `h-control-sm`, an icon button `size-target`, or `size-control-sm` when it sits beside a `control-sm` field and has to span it (the variables table's row buttons, the popover's reveal eye; `lib/utils.ts` teaches `cn()` that it replaces `size-target`).
The text fields are scanned too, by a rule of their own (#1830): **a text field states its size, never its height.**
`Input`, `VariableInput` and `SecretInput` take `size` from three of these tokens (the map is `input-size.ts`, shared so the two kinds of field cannot drift), and their `className` carries no height class of any kind (`h-N`, `h-[...]`, a fraction, `h-full`, `h-control*`, `size-N`; `min-h` and `max-h` are fine).
UrlInput is the one text field that is a band component, not a control: it fills the min-h-band-md URL bar, so its h-full is correct.

| `size` | Token | Default | Comfortable | Use |
|--------|-------|---------|-------------|-----|
| (none) | `control` | 28px | 36px | A standalone input |
| `"sm"` | `control-sm` | 24px | 32px | A dense standalone input: dialog rows, filters, the console filter, the schema explorer search, a table-cell editor, the key-value rows, a label beside its field |
| `"xs"` | `control-xs` | 20px | 24px | A field inside a `target` row: the inline renames |

A numeric step is a height the row never agreed to, and `h-full` makes the input's height whatever its row happens to be; a size names a token, so every input is one of three heights and Comfortable follows.
`size="xs"` on an input that stands alone is a review matter, since the scan cannot know the row.
The `xs` field is drawn for a label a `gap-2` from the icon or badge before it: it is pulled back by its padding plus its 1px border (`px-1`, and a margin of `calc(var(--spacing) * 1 + 1px)`, the width giving it back on the right), so its text lands on the label's x and its border clears the icon by a step (2px at Default, 3px at Comfortable).
Every rename site writes `size="xs"` and nothing else: the same scan fails a `px-`, `-ml-` or `w-` beside it.
The field takes the focus colour on its border in place of the ring.
The tree-row controls are 24px at Default inside 24px rows, so they carry `size-target` rather than an exemption.

## Tree indent guides

The collections tree draws depth twice: by the row's `paddingLeft` (`rowInsetPx(depth)`, a 16px `INDENT_STEP`) and by a 1px vertical guide for each ancestor level `k` of a row, `0 <= k < depth`, at `x = rowInsetPx(k) + var(--spacing-target) / 2 - 0.5px`:
the 1px line centred on the centre of level `k`'s chevron (a layer is placed by its left edge), so it follows the density setting with the chevron.
The guide is the divider token `--rule` (it reads on whichever surface the panel sits on, in both themes), painted as one background layer per level on the row itself (`treeGuideStyle`, `modules/collections/tree-guide-style.ts`), so a level adds no DOM node.
Each row paints its own segment over its full height and the segments join into one line from below an open folder to its last visible descendant.
The gap between rows (half a `--spacing` unit, a whole one into a folder) is top padding on the row's wrapper in `CollectionTreeRows`, so the wrapper paints the same lines across that strip alone (the third argument of `treeGuideStyle`) and the line has no breaks; the row keeps its own full-height segment, so the accent is not painted twice.
The "Empty collection" line and the new-folder form draw guides like any other row at their depth; a root row draws none.

The selected request's folder gets the accent: the guide at that folder's level is drawn again in `--primary` at 50% alpha, on every row inside the folder's visible subtree (`activeGuideLevel` on the row, set by `flattenVisibleRows`).
No request tab active, or the request hidden in a collapsed folder, highlights nothing.
Guides are the collections tree's alone; Move to and the schema explorer take the step and draw none.
Row height, the selected fill and ring, hover, focus and the drop indicator are unchanged: a background image paints over the row's fill and under its content.
