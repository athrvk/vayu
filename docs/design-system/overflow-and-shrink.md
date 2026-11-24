---
description: >-
  How text overflows inside a row, and why a flex item or a grid track must be told it may shrink.
---

# Overflowing text and flex shrink

## Overflowing Text

User-supplied names - collections, requests, environments, URLs - are unbounded, so every surface that shows one needs a defined overflow behaviour.
There are exactly **two**, and they are not interchangeable:

| Treatment          | Component          | Where                                 |
| ------------------ | ------------------ | ------------------------------------- |
| Ellipsis + tooltip | `TruncatedText`    | Rows, headers, pickers - the default. |
| Marquee on hover   | `ScrollOnOverflow` | Tab strip only.                       |

**`TruncatedText` is the default.**
It ellipses, and reveals the full value in a native `title` tooltip **only while the text is actually clipped**.
An unconditional `title={name}` - the obvious version - pops a tooltip on every hover, including names that are already fully readable, telling the user something they can see.
The tooltip appears when the name is cut off and disappears when the drawer is widened enough to read it; `useOverflowTitle` re-measures on resize via `ResizeObserver`.
It renders a block box whatever tag it is given: `overflow` and `text-overflow` do nothing on an inline one, so a `span` under a non-flex parent never ellipsed at all.

Do not hand-write `title={name}` alongside `truncate`.
That is the pattern this component replaced, and it drifts - some rows get it, some do not, and the ones that do show it unconditionally.

**`ScrollOnOverflow` marquees instead**, and is limited to the tab strip, where the label is the primary target and there is no way to widen it.
Rows must not animate under the cursor.

**A tab's label stops where its close button starts** (#3495).
The close button is absolute, so a name clamped at the tab width cap ran under it: `truncate` inside `ScrollOnOverflow`'s `w-fit` track never engages, and the viewport was only as narrow as the row's `px-3`.
The label viewport carries a right margin of `size-target` less the padding past the button's `right-0.5` offset, in the density-scaled units of all three, so it ends exactly where the button begins and `tab-fit.ts`'s natural width still fits a name that is not clamped.
At rest the clipped edge fades (`.scroll-on-overflow`, a `mask-image`, not an ellipsis); while the marquee runs the fade is off, so the end of the name is readable at the edge.
`TabItem.label-strip.test.tsx` derives the margin from the button's and the row's own classes.

Text that **wraps** (`break-words`) is neither - it never clips, so it needs no tooltip.

### A row that holds a name, a chip and some controls (#3494, #3495)

The "reflow guarantee" (Interface scale, above) is met with class rules, not a media query per surface. jsdom has no layout, so each is held as a class guard (`reflow-floors.test.ts` and the component's own test), and none can prove a pixel.

- **A chip never shrinks or breaks.**
  A status chip, a pill or a metric group is `shrink-0 whitespace-nowrap`.
  A flex item that may shrink breaks "503 Service Unavailable" or "120 ms" into a column of characters *before* its row wraps.
  `StatusCodeBadge` and `RunStatusPill` carry it themselves; a metric group in `ResponseStatusBar` carries it on its own wrapper.
- **The row wraps, between groups.**
  A header or status row is `flex-wrap` with `gap-x-*` and `gap-y-*`, so what does not fit drops to a second line whole.
  `ResponseStatusBar`, the run header in `HistoryDetail` and `UrlBar` do.
- **The thing the user came for keeps a floor, and the rest yield first.**
  The run's name group is `min-w-[12rem]`, the URL field `min-w-[12rem]`: below that the controls wrap under it instead of squeezing it.
  A floor in `rem`, not a `--spacing` step, so density does not move it.
- **A table scrolls before it squeezes.**
  `VariableTableEditor`'s Variable and Value headers carry `min-w-[8rem]` / `min-w-[10rem]`; the fixed-width Type, Secret and action columns would otherwise leave all of the slack to the two inputs.
  The scroller already computes `overflow-x: auto`.

- **In a two-span row, the descriptor gives way and the name does not** (#3495).
  A palette row is a title and a subtitle (a collection path, often the longer of the two).
  The title keeps a floor (`min-w-[12ch]`), the subtitle is `min-w-0 max-w-[50%]` and truncates, and neither carries `shrink-0`: a `shrink-0 truncate` subtitle never truncates (it keeps its intrinsic width, so its ellipsis has nothing to cut) and left the title 0px.
  Both are `TruncatedText`, so a clipped path still has its full text on hover.
  A row's *action cluster* (the chip, a button, a chord) is the opposite and stays `shrink-0`.
- **A flat list of nested things shows the ancestor path in front of the name** (#3495).
  The Variables drawer lists every collection, roots and sub-folders, in one flat group, so two "v1" folders under different parents read alike.
  A sub-collection carries its ancestors as a muted `text-xs` prefix ("Payments API /", built with `collectionPath`, as the palette does) and a root carries none.
  The prefix is `min-w-0 max-w-[50%]` and truncates, the name keeps `min-w-[12ch]`, so the distinguishing part is the last to go.
  Both are `TruncatedText` with `title` set to the full path, and the row's `aria-labelledby` lists the prefix then the name, so its accessible name is "Payments API / v1" while typeahead (`data-tree-label`) stays the bare name.
- **A name in a table is one token and never wraps.**
  `HeadersViewer`'s name cell is `whitespace-nowrap` and its text a `TruncatedText` capped at `40ch` (the longest registered header names are about 35), so "Content-Type" never reads as "Content-" over "Type" and a pathological name cannot take the value's column.
  The value keeps `break-all`: it is the part that is allowed to wrap.
  `CompactHeadersViewer`'s name is the same cap on a `shrink-0` label.
- **A breadcrumb's every crumb can be cut, none to nothing.**
  `TabBreadcrumb`'s ancestors truncate down to `min-w-[3ch]` (and never past `16ch`), so a chevron cannot land on a label's first letter; the current crumb is `min-w-0` and a `TruncatedText`, so a long name ellipses with its full text on hover instead of running under the nav's clip (it was `shrink-0` with no `title`).
  The ancestor labels and their chevrons are direct children of one row: a wrapper per pair with `min-w-0` would shrink below the label's floor.

- **A list of rows that must line up is a grid of fixed tracks.**
  Every row of a list is a grid of its own, so only fixed-size tracks align across rows, and a flexible one is a single `minmax(0,1fr)` lead.
  `SampledExchange`'s summary row has a `3.5rem` label, a `12rem` status (wide enough for "503 Service Unavailable"), a `4.5rem` latency and an `auto` time, with the cells placed by `@3xl:col-start-*`; below that width the status, latency and time wrap as one group under the name.
  The thresholds are container variants against the row's own `@container` root (see "A run pane's grids answer to the pane"), and the error's first clause is a `TruncatedText`, not a fixed `max-w-[200px]`.

The title bar is the one surface where these are viewport-sized (see the note under "A run pane's grids answer to the pane").
Its side columns are `minmax(0,1fr)`, the search bar is `clamp(2.5rem, 100vw - 36rem, 28rem)`, so each side keeps 18rem for the environment switcher and Linux's window buttons down to the 1024px minimum and the bar alone gives way below it; the switcher is `min-w-0` (truncating) and the chord caps hide by CSS (`max-[46rem]:hidden`), never by removing the nodes.

**A URL is the exception, and it gives way at the head.**
Both treatments above keep the beginning of a string, which is right for a name and wrong for a URL: the scheme and host are what every row on one host shares, so a page of local runs read `http://127.0.0.1:9...` five times over for five different requests.
`lib/truncate-url.ts` (`truncateUrl(url, max = 48)`) shortens the head and keeps the path tail, and `RunItem` passes its URL-titled rows through it before the `truncate` class ever applies - the class stays, because a character budget is not a promise about a narrow drawer.
The full value stays in the element's `title` and in the row's accessible name.

It is a display helper and never parses: a row can hold a value still being typed, a `{{variable}}` in the authority or a relative path, and `new URL()` throws on all three.

---

## Flex Items Must Be Told They May Shrink

**A flex item defaults to `min-width: auto` / `min-height: auto`, which refuses to shrink below its content.**
`flex-1` sets how an item _grows_; it does not grant permission to shrink.
This has caused two separate bugs in this codebase and is worth checking whenever a flex child holds unbounded content.

| Axis       | Add                        | Symptom when missing                                                                                              |
| ---------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Horizontal | `min-w-0` on the wrapper   | `truncate` never engages - a long name widens the row and the panel scrolls sideways.                              |
| Vertical   | `min-h-0` on the wrapper   | The child keeps its old height when the container shrinks - the parent overflows and grows a second scrollbar.     |

The vertical case is the more confusing one, because the visible symptom is a _scrollbar_, not a sizing error: a Monaco editor in a resizable pane kept its previous height when the pane was dragged smaller, so the pane overflowed and drew a native scrollbar next to the editor's own.
Two scrollbars for one editor.
The fix is never to hide the extra scrollbar - it is to let the child shrink, after which there is no overflow to scroll.

An element that is itself the scroller is exempt on that axis: `overflow: hidden` (which `truncate` sets) already gives a flex item an automatic minimum size of 0.

**The exemption reaches exactly one box, though - the item itself.**
A scroller nested a few blocks below a flex or grid item does not lend it that minimum, and `overflow-auto` bounds the box it is on without stopping the min-content width that box contributes upward.
So "I made it scroll" is not the same claim as "it cannot widen its host", and the second is the one a fixed-width surface needs.

### A grid track has the same default, and a panel cannot follow it

`grid` gives an implicit track a sizing function of `auto`, whose minimum is its items' min-content - the same refusal to shrink, one box further out.
On a surface whose width is capped this is worse than on the canvas, because the **track can outgrow the box that paints the background**: the panel stays at its `max-w` and every row inside it lays out at the track's width, so controls that have nothing to do with the wide content are the ones the user sees hanging over the backdrop.
Issue #701 found this in the Run Collection dialog, where a seven-column data-file preview put the footer buttons 428px outside the painted panel.

`grid-cols-1` - `repeat(1, minmax(0, 1fr))` - is the fix for any width-capped grid surface: the `0` lets the track be narrower than its content's min-content, which is what gives the scrollers inside it room to scroll.
Prefer it on the surface over `min-w-0` sprinkled on the items - the items are written by every caller, and the cap is the surface's own promise.

`DialogContent` itself is a **column flex container** rather than that grid since issue #773, which needed a height cap a grid will not honour (see below), and it refuses the same widening for a different reason:
`min-width: auto` is a main-axis rule, so on the cross axis an item stretches to the line - the panel's own content width - and a wide descendant overflows inside it instead of widening it.
Measured in Chromium on the seven-column shape from #701, the footer landed 580px past the painted edge under a bare `auto` track and 25px *inside* it under either spelling of the clamp.
The grid version is still the right one for a surface that is genuinely a grid.

Write it as the stock utility, not as the arbitrary value that says it more directly.
**Tailwind emits no rule for `grid-cols-[minmax(0,1fr)]`** (verified against the built CSS), so that spelling is a class that reads correctly, passes a `className` assertion, and styles nothing.
