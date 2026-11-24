---
description: >-
  Row actions, full-width list rows, the drawer panel frame and the drawer row metric.
---

# Row actions, list rows and drawer panels

## Row Actions

Controls that appear on a row you are already hovering - `⋯`, delete, remove.

**Never use `ghost` for these.**
`ghost` hovers to `bg-accent`, which is exactly what the row underneath already paints, so the button looks like it has no hover state at all.
Use the dedicated variants, which step up to `accent-active`:

| Variant | Use | Hover |
|---------|-----|-------|
| `rowAction` | neutral (`⋯`, edit, copy) | `bg-accent-active` + `text-foreground` |
| `rowActionDestructive` | delete / remove | `bg-accent-active` + `text-destructive-text` |

Destructive rows share the neutral shape and differ **only** in glyph colour on hover.
No red background tint: the row already carries one fill, a second competing tint is noise, and `DeleteConfirmDialog` is what actually protects the user - the red glyph only needs to signal at the point of intent.

Reveal them with `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`.
The `focus-within` half is not optional: without it a keyboard user lands on an invisible control.

**Where the row's width is scarce, the control also gives its width back until it is revealed** (#3495): `opacity-0` keeps the space, and the pin and delete of a History row kept 52px of a 260px drawer from the name.
`ROW_ACTIONS_REVEAL` (`components/shared/row-actions.ts`) takes the control out of the flex flow while collapsed (`absolute`, pinned to the row's trailing corner, no gap and no scrollable overflow) and returns it on `group-hover`, `group-focus-within`, and on a `hover: none` device, which never matches the first.
It is `absolute`, never `hidden` or `invisible`, because those take the control out of the tab order and there would be nothing for focus to reveal.
The row is the `group` and must be positioned.
History rows and Trash rows use it; the `⋯` of a tree row is a fixed-size slot and keeps the plain opacity form.

**A state toggle is not a row action, and must not be hover-revealed.**
The test is whether the control has an *off* state that means something.
Delete has none - it either fires or it does not - so hiding it costs nothing.
The variables table's "mark as secret" key does: hidden at rest, "this value is not secret" looked exactly like "there is no control here", so the only way to discover you could mask a value was to hover the row.
It is now always visible on `muted-foreground`, stepping to `warning-text` when on.

Same rule for anything that reports state - a pin, a mute, an enable.
Quiet is fine; absent is not.

**A row with no action of its own still reveals them** (#3495).
Hover-reveal exists so the row's own job - open the request, select the run - is not crowded by buttons the user did not come for.
A Trash row (`modules/trash`) has no such job: it opens nothing, and Restore and Delete forever are the entire reason it is on screen, which is why they were always visible.
At the 260px drawer that cost the name about 105px and wrapped the secondary line to four lines, so they are `ROW_ACTIONS_REVEAL` now: out of the flow until the row is hovered or focused, in the DOM and the tab order throughout, and shown at all times on a device with no hover, where "a list of names that reads as inert" would otherwise be the whole touch experience.
The secondary line is one truncated line with its full sentence as a `title` while it is cut.

**Every row that has actions draws them this way, Services included** (issue #1690).
The Services drawer's rows were the last holdout - two or three always-visible `TooltipIconButton`s on a 32px row whose payload is a URL, so the URL truncated to make room for controls the user had not come for.
They are one hover-revealed `⋯` menu now, and the values those tooltips carried (the inbox URL, the mock's base URL) ride the items' `hint`, which reads without hovering.
There is no exemption: the one control that stays visible at rest is a state toggle, which keeps its place (a pinned run's pin among the History row's actions).

**Prefer `RowActionsMenu`** (`components/shared`) over adding another inline icon button.
It renders the `⋯` trigger plus a `DropdownMenu`, so rows expose actions consistently and get focus management, Escape-to-close and arrow-key navigation for free.
Used by request rows and environment rows.
It opens on a pointer and on a click reporting `detail === 0` - the keyboard's kind - and takes a `tabIndex` prop, `0` unless the row sits in a roving-tabindex tree.
See Tree Navigation for why.

**A disabled item says why on the item.**
`RowAction`'s `disabledReason` draws the reason at the row's trailing edge - "Move up / Already first" - rather than in a tooltip: `DisabledHint`'s wrapper works by taking a tab stop of its own, and inside a menu that second stop competes with Radix's own focus management, which deliberately skips a disabled item.
`RowActionBody` draws it, so the `⋯` dropdown and the right-click menu explain a gate the same way.
See "A disabled control says why" under Component Patterns for the button case.

**Right-click reaches the same actions through `RowContextMenu`** (issue #1360): one list, two menus.
`row-actions.ts` holds the one rule about the list's shape - the first destructive action gets a separator above it - and `RowActionBody` holds what an item draws, so the `⋯` dropdown and the context menu cannot describe a row's actions differently.
Environment rows and history rows take it.
The collection tree takes one menu for all its rows instead (`CollectionTreeContextMenu`, #2543): the tree is the trigger, the row comes from the click, and the items are drawn by the same `RowContextMenuContent`.

**A row that names an entity offers "Copy for agent" (issue #2047).**
It is the standard copy item: `Copy` glyph, the label "Copy for agent", and the reference line it will put on the clipboard as the item's `hint`, so the user reads what will be pasted before choosing it.
Request, collection, environment, history, inbox, mock-issuer and mock-server rows, and a pipeline element's row in `ElementList` (after Duplicate), carry it, placed after the row's primary actions and above the destructive one.
The line comes from a formatter in `lib/agent-reference.ts` and goes out through `useCopy()` with the name "Reference".
**Duplicate takes `CopyPlus`**, not `Copy`, so the plain glyph means "puts something on the clipboard".
The clipboard items themselves (Copy path, Copy URL, Copy for agent) share it and are told apart by label and `hint`.

---

## Full-Width List Rows

**`Button`'s `listRow` variant** is for a summary row that spans its container and opens something on click - a stream event, a sampled exchange, a collection's last run, a recent send, a GraphQL operation, a recent-runs entry.
Not `row` - that name already belongs to Row Actions above, a smaller control at a different scale.

It carries only the axis-level shape: `w-full`, `justify-start` in place of the default's `justify-center`, `text-left`,
and `h-auto` overriding the default size's fixed `h-control` (in `compoundVariants`, not the variant string itself - `cva` concatenates `size`'s classes after `variant`'s, so a height set beside `w-full`/`justify-start` would lose to the default size once both pass through the same `cn()` merge; `button-variants.test.ts` mutation-checks this).
Padding, gap, text size and icon size stay with the caller's own `className`: the rows this variant serves span three different scales (a context-bar row is not a welcome-screen row), and a fixed opinion here would renormalize all of them.
A caller whose icons are not the base's default 16px overrides with `[&_svg]:size-N`; a caller whose content wraps to a second line (rather than truncating) needs `whitespace-normal`, since the base string's `whitespace-nowrap` is otherwise inherited by every child.

---

## Drawer Panel Frame

**Every drawer view renders inside `DrawerPanel`** (`components/shared`).
It owns the header (title + trailing actions) and the scroll region; views supply only their content.

The four views had drifted into two different panel designs - Collections and History used a 16px padded container with a heading, Variables and Settings were flush with no heading at all.
Switching views moved the content's vertical start *and* made the title appear or vanish.
All four now match exactly: one 32px header band, body below it.

- **The header is the drawer's half of the second chrome row.**
  It takes its height from `--tabstrip-height` and carries the same bottom rule as the tab strip on the other side of the resize handle, so the two read as one band across the window rather than as two adjacent headers.
  That is the only reason the height is a token and not an `h-8`: `TabStrip.tsx` and `DrawerPanel.tsx` cannot see each other, and `titlebar-height.test.ts` holds them together.

- **A group inside a view is a `DrawerSection`, and a count is the muted inline count.**
  The frame gave the four views one shape; the groups inside a view had none.
  Services drew muted labels with a trailing plus, Variables drew a chevron, an icon, a filled `Badge` count and a plus, and the collection rows wrote the same fact as inline `(2)` text one click away from that badge - two count idioms in one drawer.
  `DrawerSection` owns the shape (the padding, the muted small type, the chevron, where the count sits, where the actions sit) and the **badge idiom loses**: a count beside a group name is not a status and not a control, it is the least important thing in the row, and a `Badge` gives it a fill, a border, a 20px floor and the weight of a chip.
  `DrawerSectionCount` is exported for a *row* to use the same idiom, which is how the collection tree stays in step without gaining a section header - its panel band already says "Collections", and a section of the same name inside it would be a double heading.
  A root collection's count is the requests in its whole subtree; a nested collection's is its direct children.
- **The section's ARIA stays at the call site.**
  Variables' headers are `role="treeitem"` rows in a roving-tabindex tree and their "+" sits outside that row on purpose (the tree has no create key, so the button is the drawer's own tab stop).
  `rowProps` and `activatorProps` are spread through rather than owned, so the primitive never has to know about the tree.
  Guard: `DrawerSection.test.tsx`.
- **The frame owns header padding; the body is flush.**
  Rows run edge to edge - the sidebar convention, and it recovers the ~32px of row width the old inset cost.
  Rows bring their own internal padding.
- **Full-bleed rows are square.**
  A rounded corner meeting the panel edge reads as a clipped rectangle, not a rounded row.
- **The panel owns scrolling** - vertically only.
  A view is not wrapped in a `ScrollArea` by the Drawer, and does not manage a scroll region of its own.
- **Indent with padding inside the row, never margin around it.**
  Margin pushes the row's _background_ in too, so a nested row's hover and selection fill stops short of the panel edge while a top-level row's reaches it.
  Depth is shown by where the content sits, not where the row starts: `paddingLeft: rowInsetPx(depth)` (`constants/layout`, `8 + depth * INDENT_STEP`, a 16px step; the collections tree, Move to, and the GraphQL schema explorer all read it, so the app has one indent).
- **Non-row content inside a level takes a child row's left edge.**
  A placeholder, an inline form, a loading skeleton and an inline error all stand in for the rows that are not there, so they start where those rows would: in the collections tree they are rows of their own at the children's depth (`flattenVisibleRows`), so `rowInsetPx(depth)` places them;
  the named `GROUP_CHILD_INSET` in the two-level variables tree; and `rowInsetPx(0)` - a root row's own inset, there being no parent row to be a child of - in the GraphQL schema explorer, whose search results are one flat level.
  Each carrying its own `px-*` is how one expanded folder came to show up to five different left edges, with "Empty collection" left of its own parent's label (#1372).
  An empty level also has to _say_ so: nothing under the folder is a `treeitem`, so the folder row carries `aria-describedby` pointing at the placeholder rather than the placeholder taking a role in a tree whose children are rows.
- **A group heading is a label, not a placeholder - and it follows the rule anyway.**
  The schema explorer's `Query` / `Mutation` / `Types` eyebrows were the one case #1372 left open, because an uppercase label over a flat group reads as a heading rather than as a row that escaped its level.
  Looked at in the running app (#1378) that held - what did not was the pane drawing three left edges at once: rows on a private base offset, the headings and both stand-in lines on their own `px-2`, and the rows' column matching neither the headings nor the search field above them.
  The headings stayed where they were and the rows came to meet them, because the pane reuses `rowInsetPx` now instead of a second copy of `INDENT_STEP`.
- **A control with an outward focus ring needs clearance from the body's top edge.**
  The body scrolls, so it clips at its own bounds, and a ring drawn outside the border box gets its top cut off when the control sits flush.
  Rows are exempt - their focus outline is inset (`outline-offset: -2px`).
  Padded content blocks (the History search field) carry `pt-2`.
- **A row must never widen the panel.**
  Long names ellipse; the drawer has no horizontal scrollbar - `overflow-x-hidden` is set explicitly, because `overflow-y: auto` alone computes overflow-x to `auto` too.
  `truncate` alone is not enough when the text sits inside a `flex-1` _wrapper_ - a flex item will not shrink below its content width, so the wrapper needs `min-w-0` as well.
  (A `truncate` element that is itself the flex item is fine: `overflow: hidden` already gives it an automatic minimum size of 0.)
  Short trailing metadata - counts, badges, spinners - takes `shrink-0`, so the name is what yields.

---

## Drawer Row Metric

**Single-line drawer rows are `h-8` (24px at the default density, 32px at Comfortable - see Spacing Scale above).**
State the height; do not let it fall out of the content.
Left to the content - a 28px chevron setting the collection row, padding setting the others - the four drawer views run **34 / 36 / 38 / 40px** and the rhythm shifts every time the user switches view, one click apart in the same panel.
Collection and request rows differed by 4px inside a *single* tree.

Applies to `CollectionItem`, `RequestItem`, `SettingsCategoryTree` and `VariablesCategoryTree` rows.
Put `h-8 items-center` on the row and let content centre; do not re-add vertical padding, which is what caused the drift.
The row's text carries `cap-centred` (see Type Scale Conventions), or its caps sit above the chevron beside them.

Section *headers* (e.g. "Environments") stay shorter on purpose - they are group labels, not list items, and the difference carries hierarchy.

The disclosure chevron is `size-target` - 24px at the default density, 28px at Comfortable - so it clears the interactive floor at either.
The row around it opens the collection.

**`h-8 items-center` on the row means the activator needs `self-stretch`.**
The two rules above interact, and the interaction is a bug the eye cannot see.
A composite row (see `.focus-row`) paints the height, the hover fill, the selection tint and `cursor-pointer`, while the click handler sits on a narrower activator button inside it - the row carries a `⋯` menu, so it cannot itself be one button, and a plain `<div onClick>` is not keyboard operable.
`items-center` then makes that button *content*-height: ~22px in a request row, where the `MethodBadge` props it open, and ~18px in a collection or environment row.
The remaining 5-7px above and below took the fill and the pointer and did nothing on click.
Measured in the running app at the 260px default drawer width, the share of the row that actually responded was **41%** for a collection, **51%** for a request and **36%** for an environment - and hit-testing 3px inside the top or bottom edge landed on the container, which has no handler.

`self-stretch` on the activator overrides the row's centring; the activator's own `items-center` still centres its contents, and `.focus-row` is unaffected because the row paints the ring either way.

**`self-stretch` fixes the height; the row's own box needs delegation.**
The indent is `paddingLeft` *on the row* - deliberately, so the fill reaches the panel edge - and the flex gaps and right padding belong to no child either.
No amount of stretching reaches any of it, and on a collection row the indent cannot move onto the activator even in principle, because the chevron sits between them.
So the row takes the click itself and forwards it:

```tsx
const isRowSurface = (e: React.MouseEvent) => e.target === e.currentTarget;
// on the row:
onClick={(e) => isRowSurface(e) && handleClick(e)}
```

`target === currentTarget` is exactly "the pointer landed on the row's own box".
It excludes the chevron and the `⋯` menu without naming them - they are children, and they own their own actions - and it stops a click on the activator from firing twice as it bubbles through.
Drop the check and every label click activates twice.

This is *not* the `<div onClick>` the environment row's comment warns against: the activator button stays and remains the keyboard path (`useRovingTreeFocus` clicks `[data-tree-activate]` on Enter).
The row is a second, pointer-only entrance to the same handler.

Together the two changes take all three rows to **100% of their own pixels** - measured by sweeping `elementFromPoint` across the row box in the running app.
The only pixels a row does not own are the chevron, the `⋯` menu and the drawer's 8px `cursor-col-resize` handle at the panel edge.
Both halves are guarded by `drawer-row-hit-area.test.tsx`: the height as a `className` assertion (jsdom has no layout, so an `offsetHeight` assertion would pass while measuring nothing), the delegation behaviourally, because `fireEvent.click(row)` targets the row itself - exactly the pointer that would land on dead padding.

The shared `ElementList`'s element card header (`components/shared/ElementList/`, issue #1608) is the same `h-8` row with two embedded controls beyond its own toggle - an enable switch and a `⋯` menu - each a real interactive child rather than a row-level click delegated by target equality:
with the header's own click handled by two real buttons (the chevron and the label), there is no ambiguous "click landed on the row itself" case left for `isRowSurface` to resolve.
