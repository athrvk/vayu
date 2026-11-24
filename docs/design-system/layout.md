---
description: >-
  The window layout: the shell structure, the rails, the dock, the bottom panel, the drawer and how the side panels behave at a narrow window.
---

# Layout Structure

```
Shell                            flex flex-col h-full bg-background
├── row (flex-1)
│   ├── ActivityRail (nav)   w-[var(--rail-width)], bg-panel - the six view
│   │                        buttons, on the window's left edge (#1615)
│   └── drawer box           relative - what an overlaying Drawer positions from
│       ├── Drawer (aside)   220–480px, default 260px, bg-panel - one of the six
│       │                    views, plus its PanelResizeHandle on the right edge
│       └── content column   TabStrip, then a row of [main + ContextBar]
│                            beside ContextRail (w-[var(--rail-width)])
├── BottomPanel (section)    bg-panel, 120px to half the window, default 240px,
│                            closed by default - a tab strip (Console, Logs) over
│                            the active tab, its PanelResizeHandle on the top
│                            edge (#3635, #3634)
└── Dock                     h-[var(--dock-height)] border-t border-border -
                             ambient status, then the bottom panel's button and
                             the per-tab view controls on the right
```

## Push or overlay: the side panels at a narrow window

Each side panel either **pushes** (a flex sibling that takes its width out of the content) or **overlays** (`absolute`, `shadow-lg`, `z-10`, over the content's edge, taking nothing).
Both read one window width, `useWindowWidth()` (`app/src/hooks/useWindowWidth.ts`), through `sidePanelMode` and a named threshold in `app/src/constants/layout.ts`, push at or above it:

| Panel | Threshold | Overlay edge |
|-------|-----------|--------------|
| Drawer | `DRAWER_PUSH_MIN_WIDTH`, 1000px | content's left (`left-0`) |
| ContextBar | `CONTEXT_BAR_PUSH_MIN_WIDTH`, 1200px | content's right (`right-0`) |

The widths are CSS px, so a 200% scale halves them: a 1024px window at 200% is 512 and overlays both.
The drawer's 1000 is both rails (40 each), the drawer at `PANEL_MAX_WIDTH` (480) and one 440px builder pane of content; the maximum width rather than the current one, so a drag on the handle never flips the mode under the pointer.
Each overlay positions from a `relative` box that leaves out its rail (the drawer box above leaves out `ActivityRail`, the main+ContextBar row leaves out `ContextRail`), so an open panel never covers the button that closes it.
Both boxes exist in either mode, so crossing a threshold changes a class list and never remounts the tab.
An overlay keeps its width, its `rail-collapse` animation and its F6 stop.

**An overlay dismisses like one** (#3507).
The rules live in one hook, `useOverlayPanel` (`app/src/components/layout/useOverlayPanel.ts`), called by both panels, and none of them applies to a panel that pushes:

- **One overlay at a time.**
  When both panels are showing as overlays, the one that most recently started showing wins and the other is closed.
  "Started showing" is an open, or a tab switch that gives the context bar sections; the rule watches the layout and tabs stores (`subscribe`) and not the actions behind them, so the rail buttons, the chords, the palette and `revealDrawerView` are all covered without each knowing it.
  It is a subscription and not a render effect because `Shell`'s reveal can reopen the drawer in the same flush that closed it, a round trip no render observes.
  Where nothing opened - the first render with both persisted open, or a resize that turned two pushing panels into overlays - the drawer stays.
  A pushing panel is never closed by the rule, and neither is a bar that is not on screen (no sections on this tab), so a flag is rewritten only for a panel that was overlaying and lost.
  **That does write the persisted flag**: ⌘I on a narrow window, or a resize from wide to 512 with both open, leaves the loser's open flag false, and it stays closed when the window widens again.
  `Shell` hands each panel both modes (`siblingMode`).
- **The drawer closes on a selection**: a drawer item that opens or switches a tab (a request, a collection, a run, a variables scope, a settings category) calls `onItemOpened` from `useDrawerItemOpened()` (`drawer-item-opened.ts`), and an overlay drawer closes and moves focus to the opened tab.
  It is an explicit call, not a watch on the active tab, which also changes for a closed tab, Back and every chord.
  Duplicate and the undo of a delete open a tab too and are not selections; expand, rename, filter and the row menu keep it open.
  **One rule for creation: any drawer action whose result is a newly opened tab closes the overlay** - the toolbar's New request (`useNewRequest`, which reports the tab it opened), a row menu's Add request, New environment, and the Services rows' Open.
  Duplicate and undo reopen something that existed, so they stay open.
  The context bar never closes on selection.
- **Escape closes it** when focus is inside it and nothing of its own is open above it - no menu, listbox or popover (by role, not closed) and no dialog - and no one has already answered the key (`defaultPrevented`, which Radix sets for the layer it dismisses).
  A text field keeps its own Escape.
  Focus returns to the rail button that toggles the panel (`data-rail-side` on `RailButton`), the active tab if the rail is not drawn.
  A tooltip on the focused control may take the first Escape (Radix cancels it), so a second press closes the panel.
- **A pointer press outside closes it**, heard on `document` in the capture phase and never cancelled, so the click still reaches what it was aimed at.
  Presses on the panel, on its own rail's buttons (the click toggles it; closing on the press would reopen it), on a menu or dialog it opened (portalled out of it) and anything while a dialog is up or a menu, listbox or popover is open are not outside: the press that dismisses a modal menu can land on `<html>`, and it is the menu's, not the panel's.

## The panels that resize, and the one handle that resizes them

The drawer, the context bar and the bottom panel are the panels a user drags, and all use `PanelResizeHandle` (`app/src/components/layout/PanelResizeHandle.tsx`): one focusable `role="separator"` where each panel used to carry its own mouse-only copy.
`side` sets the direction, so the drawer's right-edge handle widens on ArrowRight and the context bar's left-edge one widens on ArrowLeft; Page keys jump, Home and End take the bounds, and Enter or Space resets to the default - the keyboard equivalent of the double-click that was already there.
The bottom panel's handle is `side="top"`: a horizontal separator on the panel's top edge, dragged on the vertical axis, where pointer up, ArrowUp and PageUp grow the panel.
It takes its own `min` and `max`: the panel's floor and half the window, which is why the props are `size`, `setSize` and `defaultSize` rather than a width.

The width itself is a preference, not component state: `drawerWidth` and `contextBarWidth` live in `layout-store`, clamped to `PANEL_MIN_WIDTH` (220) and `PANEL_MAX_WIDTH` (480) from `app/src/constants/layout.ts`, and survive a restart; so does `bottomPanelHeight`, held to `BOTTOM_PANEL_MIN_HEIGHT` (120) there and to half the window as it is drawn.
The request/response split is `react-resizable-panels` through `components/ui/resizable.tsx`, with one ratio per arrangement in the same store (`requestSplitRatioBeside` / `requestSplitRatioBelow`, #1711): the share of the width a request wants beside its response is not the share of the height it wants above it.
The builder's divider resets its arrangement to an even split on double-click (`ResizableHandle`'s `onReset`), the drawer handle's own gesture; stacked panes take a `160px` floor rather than the 20% side-by-side ones do, because 20% of a short window is a response pane that cannot show a status line and a row of body.

**An editor inside a pane is not one of them.**
The Body and script editors fill the pane they sit in - a `flex-1` box with a `min-h-40` floor and no ceiling - because a drag there resized a box inside a pane the user had already sized, and held that size in component state that Radix threw away on the next tab switch (#1323).
The pane's own splitter is the one control for how tall an editor is.

## A run pane's grids answer to the pane, not the window

The context bar is a fixed-width aside, so a pane at a 1280px window is far narrower than a viewport variant believes: `lg:grid-cols-6` fires at 1024px of *window* whatever the pane holds, and clipped the P99 tile with the bar open (#2272).
A grid inside a run pane (`LoadTestDetail`'s content wrapper, `MetricsView`'s root) therefore uses **container variants**, not viewport ones.
The pane root carries `@container`, and its grids read `@md:` / `@3xl:` (Tailwind 4's built-in container scale, `@md` = 28rem, `@3xl` = 48rem) against the pane's own content width.
A container query measures the content box of the nearest `@container` ancestor and never the element that declares it, so `@container` goes on a wrapper above the grids; a container variant with no `@container` ancestor never matches, and the grid silently stays at its base column count.
A grid item that holds a chart takes `min-w-0`, since uPlot sets a fixed canvas width and a grid track's automatic minimum would otherwise stop the item shrinking.
Chrome that really is window-sized (the dialogs, the launcher, the title bar) keeps viewport variants.
Layout does not exist in jsdom, so `run-pane-container-queries.test.ts` is a source guard.

## ActivityRail and ContextRail

The primary navigation runs down the window's left edge, not along its bottom (#1615): the OS Dock auto-hides over the app's lowest 60-80px on macOS, so a switcher living there is the one target on screen the system can cover mid-use.
`ActivityRail` (`app/src/components/layout/ActivityRail.tsx`) is a `<nav aria-label="Sidebar views">`, `w-[var(--rail-width)]`, holding the six `RailButton`s the Dock used to render, top-aligned rather than pinned to the rail's own bottom (a bottom cluster is the same Dock problem in miniature).
`ContextRail` (`ContextRail.tsx`) is the same shape on the right edge: one button per `CONTEXT_BAR_SECTIONS` entry the active tab has something for.
Both rails share one keyboard model: a single Tab stop (`useRovingStop`, so the stop is state and cannot be left stray by an arrow) with `ArrowUp`/`ArrowDown` moving focus, wrapping, without activating.
`ActivityRail`'s stop is the selected view; `ContextRail`'s is the first expanded section, or the first section when all are collapsed.

- **`RailButton` (`RailButton.tsx`) is `w-full h-band` with a `size-icon` icon**, icon-only so `aria-label` is the accessible name and the chord (where there is one) stays out of it - a tooltip supplies `aria-describedby` while open, never a name.
  Two variants: `"edge-left"`/`"edge-right"` paint a 2px `border-*-primary` bar on the rail's outer edge when active and nothing else - not a filled tile, which would read as a toolbar of independent actions rather than one mutually-exclusive choice of what the Drawer shows.
  `"tile"` is the ordinary `bg-accent text-accent-foreground` icon-toggle look, for `ContextRail`'s buttons, which are a multi-select set of expanded sections rather than a single current view.
- **ActivityRail's names, marks and order** read from `constants/drawer-views.ts` and its chords from `constants/shortcuts.ts`, so the palette offering the same six cannot name them differently.
  Deliberately not `role="toolbar"`, the same choice the Dock nav it replaces made: arrow keys move focus (`ArrowUp`/`ArrowDown`, roving `tabindex`, mirroring `TabStrip`'s handler), but claiming full toolbar semantics for six toggle buttons would overstate what six toggle buttons are.
- **Clicking the open view's button closes the drawer.**
  The buttons call `activateDrawerView`, which switches the view and toggles `drawerOpen` only when that view is already showing.
  A small `status-success-text` dot on the Services button is the one badge the footer carried that moved here - the running-services count itself stays in the Dock too (see below).
- **ContextRail renders nothing when the context bar has nothing for the active tab** (`contextBarHasContent`, the same predicate the Dock's toggle used to read).
  Clicking a section's icon opens the bar if closed, expands that section if collapsed, and scrolls it into view with `scrollWithin` (`@/lib/scroll-within`, #1612) rather than `Element.scrollIntoView`; clicking the icon of the section that is the only one expanded collapses the whole bar.
  Present in both of `ContextBar`'s layout modes - see below.

## Dock

**Status in the centre, controls on the right, and every item has a non-footer path.** #1615 moved the footer's two switchers onto the rails above and left it status-only; #1711 amends that rule to admit a right-aligned cluster of controls that act on the *active tab's* view, and #3635 amends it again for the bottom panel's button, the one control that is not per-tab.
`Dock` (`app/src/components/layout/Dock.tsx`) is one flex row, `h-[var(--dock-height)] px-2 gap-2 border-t border-border bg-panel shrink-0`, with two equal `flex-1` gutters around the centre group so the connection light does not shift when the right cluster comes and goes.
The height is that token rather than a bare `h-8` because the toast viewport is `fixed` and offsets itself above this strip by the same value - the token is what keeps the two from drifting apart.

The centre holds the engine connection light (a `bg-current` dot plus Starting… / Engine connected / Engine disconnected, on `status-success-text` when connected and `--muted-foreground` otherwise), a running-services button and a pending-restart button that render only when there is something to report, the save status, and the version string.
**This strip is where the connection state lives** - no sidebar footer carries a second copy.
When the engine is not running, the light's tooltip says why, and a button beside it recovers: Retry for a start that cannot succeed (a held port), Restart for an engine that left on its own, whose tooltip names the signal, exit code or error and quotes the last lines it printed (#3336).
Both are the same `EngineRestartButton`, in the strip's existing height, and drawn while `selectEngineRestartOffered` holds, which is also what the response pane's "Vayu's engine didn't respond" tip reads before it points at the status bar's button.
A crash the main process reported turns the light at once: it reads `selectKnownEngineStatus`, so "Engine connected" from a poll older than the crash never stands beside Restart (#3493), and the poll's next answer is what turns it back.
The running-services button reads the same derivation and drops out with it.

The right cluster leads with the bottom panel's button (`BottomPanelButton.tsx`, see Pane Toggles below), on every tab and with none open.
The controls that act on the active tab's view follow it and render **only while that tab is a request tab**; every other tab's cluster is the one button.
The first of them is `ResponsePositionButton` (`app/src/components/layout/ResponsePositionButton.tsx`), a `TooltipIconButton` that moves the response pane from beside the request to below it and back, its chord in the tooltip.
The icon names the destination (see Pane Toggles below): `PanelBottom` while the response is beside ("Response below"), `PanelRight` while it is below ("Response beside"), swapped with `IconSwap`.
While the setting is Auto the button shows Auto's current pick and a click writes an explicit choice.
**Right-click picks instead of flipping**: a `ContextMenuRadioGroup` over Beside / Below / Auto, the same set as the Settings row, which is what puts Auto within reach from the strip and marks which setting is in force - the destination glyph by design does not say. → `Dock.response-position.test.tsx` (mutation-checked: without the request-tab gate, the settings and dashboard cases fail).

The rule that lets a control sit here at all is the one every amendment kept:
every item has a path that is not the footer (pending restart is the banner in Settings, save status opens the tab it names, the response position has its chord ⇧⌘B, its palette row and its Settings > Appearance row, the bottom panel its chord ⌘J and its palette row),
so the system Dock covering this strip on macOS costs a glance, never a click. → `Dock.bottom-panel.test.tsx` (the button on every tab type and with no tab).

## Bottom panel

`BottomPanel` (`app/src/components/layout/BottomPanel.tsx`, #3635) is a full-width band between the main row and the Dock, under the sidebar and the content alike: a `<section>` on `bg-panel` labelled by `BOTTOM_PANEL_LABEL`, `shrink-0`, with an inline height from `layout-store`'s `bottomPanelHeight` held to half the window as it is drawn.
It renders nothing while closed, so a tab's body mounts only while it is on screen.
Its top edge is a `PanelResizeHandle side="top"` (above), which also draws the rule against the main row; the strip under it is the ordinary `TabsList variant="pane"`, whose `border-rule` is right on `bg-panel` because that is the root surface.
A surface a tab paints inside it declares its own (`surface-card`, `surface-sunken`), and `BottomPanel.surface-rule.test.tsx` fails on a `bg-card` or `bg-muted` at rest that does not (a `hover:` fill and a translucent tint such as `SampledExchange`'s `bg-muted/30` expansion are not surfaces, and no `surface-*` class could declare them).
It is a stop in the F6 cycle, between the context rail and the Dock.
Its tabs are Console, first and the one a fresh install opens on, then Logs; in UI text the panel is named for the first, "Console" (`BOTTOM_PANEL_LABEL`), and never "drawer" (`docs/ux-writing.md`).
The Console tab's rows are `SampledExchange` rows, the same row History's samples and steps draw, in a flat `divide-y divide-rule` list on the panel's surface; a console line between them is a dense mono row with the `LogGutter` the response pane's Console and the Logs tab draw.

## Drawer

The sidebar is `Drawer` (`app/src/components/layout/Drawer.tsx`): an `<aside className="relative flex shrink-0 bg-panel">` whose width is `drawerWidth` from `layout-store` and whose right edge carries its own `PanelResizeHandle`.
It renders nothing while `drawerOpen` is false, and it is labelled by the view showing ("Collections sidebar") because one landmark hosts six panels - collections, history, variables, services, trash and settings - and "Complementary" alone would not say which.

**A drag does not persist per frame.**
`useResizeGesture` (`lib/resize-gesture.ts`, issue #1738) paints the live value straight into the DOM -
`PanelResizeHandle` onto the `<aside>`'s inline `style.width` (it is the handle's own `parentElement`), the script editor's own resize handle (`ScriptElementForm`, `components/shared/ElementList/`) onto its box's `style.height` - once per animation frame, and commits to the store it persists to exactly once, on `pointerup`.
A `pointercancel` (a touch interruption, an OS overlay) reverts the live value to where the drag started and commits nothing.
A discrete keyboard press or the double-click reset still commit immediately; only a held key's own repeats are throttled to one commit per 200 ms (flushed on keyup and blur; OS key repeat is slower than a frame, so per-frame coalescing would not help), so holding a key does not flood `localStorage` with one write per repeat.
Both handles share this one hook rather than each carrying its own copy, after the two independently-written copies this started from had already drifted (only one handled keyboard Page/Home/End and a reset; neither handled `pointercancel`).

**The Drawer wraps no view in a scroll region.**
Each view supplies its own `DrawerPanel` (`app/src/components/shared/DrawerPanel.tsx`), which owns the header - `h-[var(--tabstrip-height)]`, so it lines up with the TabStrip across the resize handle - and the single `overflow-y-auto overflow-x-hidden` body below it.
That frame, not the shell, is what a new view needs: switching views changes the content and nothing else.
The body is flush, so rows run edge to edge and bring their own padding.

## Pane Toggles

**A toggle for a docked pane sits at the edge the pane opens from, and its icon names that side.**
A user reaches for the side the pane will appear on; a toggle on the far edge is not where anyone looks for it, and `PanelRightOpen` on a control that opens a pane to the left states the wrong thing outright.
The GraphQL schema explorer had both faults at once: it is the first panel of a horizontal `ResizablePanelGroup`, so it opens on the **left**, while the chip that opened it sat at the right of the Query header drawing the `PanelRight*` pair (#1224).

- **Icons:** `PanelLeftOpen` / `PanelLeftClose` for a pane on the left, `PanelRightOpen` / `PanelRightClose` for one on the right.
  Only the icon and the label change with state.
- **State:** `aria-expanded` bound to the store the pane reads, never a literal.
- **One home:** the toggle stays put when the pane opens, and the pane does not grow a close button of its own.
  A control that changes address with the state it controls teaches a position and then abandons it, and the two copies drift into saying the same thing differently.
- **The bottom panel's button is an icon with its own name.**
  The Dock's button for the bottom panel (`BottomPanelButton.tsx`, #3635) is a `TooltipIconButton` drawing `SquareTerminal`, a console's prompt, in every state (#3634): it is what a user arriving from Postman looks for in the footer, and it serves the Logs tab beside the Console.
  A panel glyph would sit a few pixels from the response-position button's `PanelBottom` and read as the same control.
  It is named by the panel's label (`BOTTOM_PANEL_LABEL`, "Console") as its `aria-label` and tooltip, and the tooltip carries the chord.
  The name never changes with the state; the state is `aria-pressed` bound to `bottomPanelOpen`, as the rails' buttons do, rather than `aria-expanded`, so a pressed button reads as "Console, on".
  It stays put when the panel opens, and the panel grows no close button of its own.
- **A switch between two arrangements names the destination too.**
  The Dock's response-position button draws `PanelBottom` while the response is *beside* the request and `PanelRight` while it is *below*: the glyph is where a click takes you, not where you are, because a glyph showing the current state reads as one more status in a strip full of them.
  The vocabulary for that arrangement is **Beside / Below / Auto** everywhere - UI strings, docs, code comments - never "vertical" or "horizontal", which name opposite things in Postman and in `react-resizable-panels`.
