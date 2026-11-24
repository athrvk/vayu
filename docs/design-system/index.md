---
description: >-
  Vayu's UI design system: colour tokens, the elevation model that inverts between themes, typography, spacing and component patterns.
---

# Vayu Design System

> Reference for all UI tokens, component patterns, and visual conventions.
> Future sessions must read this before touching any UI file.

---

## Philosophy

**3-level elevation** - every surface sits on one of three layers.
Nothing floats outside this hierarchy.

| Level | Token | Dark | Light |
|-------|-------|------|-------|
| Canvas (outermost) | `bg-background` | `#09090b` | `#f4f4f5` |
| Panel (sidebar/header/toolbar) | `bg-panel` | `#111113` | `#fafafa` |
| Card (content surface) | `bg-card` | `#1a1a1f` | `#ffffff` |

**`--tab-active`** is a fourth, single-purpose surface for the active tab.
It exists because the elevation model inverts between themes: in dark, `background` is *below* `panel`, so an active tab matching the content pane reads darker than the bar - correct.
In light, `background` (96%) is *lighter-adjacent* to `panel` (98%), so the same rule gave only ΔL\* 2.06 of separation and put the active tab on the wrong side of the convention (active tabs are normally the lightest thing in light UIs).
`--tab-active` deepens it to ΔL\* 4.82 in light and stays equal to `--background` in dark, where nothing needed fixing.

The active tab also carries a 2px bar on its bottom edge, on the side the content is on.
That is the *primary* signal, because it reads identically in both themes, where a surface shift does not.
The bar is an `after:` pseudo-element (`after:absolute after:inset-x-0 after:bottom-0 after:h-0.5`) that every tab carries, `after:bg-transparent` at rest and `data-[active=true]:after:bg-primary` when active; the 1px `border-b` rule under the strip is `border-b-border` at rest and `data-[active=true]:border-b-transparent` when active.
The base is stable and the modifier changes only a colour, which is why switching tabs transitions: a class string that swapped wholesale would add and remove the bar, and nothing can transition between present and absent.
`after:transition-colors` is on its own line because a pseudo-element paints separately from its box.
The bar is absolutely positioned, so it never displaces the tab's contents.
The reference is `app/src/components/layout/TabItem.tsx`.

**Paper White light mode** - light surfaces use a cool near-neutral (zinc) family; higher surfaces are lighter (canvas → panel → white card).  
**Dark canvas** - dark mode uses near-black with subtle violet undertones (zinc-950 family).

---

## CSS Custom Properties

All tokens live in `app/src/index.css` as HSL channel values (no `hsl()` wrapper - `@theme inline` and Tailwind config add that).
Separate light and dark values are listed where they differ.

## Pages

Each page holds the tokens or the patterns of one family.

| Page | Covers |
|---|---|
| [Surface, foreground and border tokens](surfaces.md) | Elevation, foreground scale, interactive states, borders, `border-rule` |
| [Accent and status color tokens](accent-and-status.md) | Primary, semantic status colors, run and status indicators |
| [Chart series and text color tokens](chart-colors.md) | Chart series tier, `-text` variants, contrast bars, charts |
| [Scope, decorative and HTTP method colors](categorical-colors.md) | Variable scope colors, decorative palettes, HTTP method tokens |
| [Color Schemes (Accent Themes)](color-schemes.md) | The accent themes and their values |
| [Typography](typography.md) | Fonts, type scale |
| [Spacing, chrome floors and tree indent guides](spacing-and-floors.md) | Spacing scale, chrome, target and icon floors, tree indent guides |
| [Geometry](geometry.md) | Radius, dock height, rail width |
| [Animations and motion](motion.md) | Animations, motion vocabulary, motion, icon motion |
| [Focus & Interaction States](focus-states.md) | Focus rings and interaction states |
| [Accessibility](accessibility.md) | Accessibility rules, the `jsx-a11y` suppressions |
| [Row actions, list rows and drawer panels](rows-and-drawers.md) | Row actions, full-width list rows, drawer panel frame, drawer row metric |
| [Overflowing text and flex shrink](overflow-and-shrink.md) | Overflowing text, flex items, grid tracks |
| [Tree Navigation (roving tabindex)](tree-navigation.md) | Roving tabindex trees |
| [Dialog widths and height](dialogs.md) | Dialog widths, dialog height |
| [Layout Structure](layout.md) | Push or overlay, resizable panels, rails, dock, bottom panel, drawer, pane toggles |
| [Component Patterns](component-patterns.md) | Empty, error and loading, tab strips, cards, eyebrows, status badges |
| [Toasts, feedback, destructive actions and dashboard components](feedback-and-dashboard.md) | Toasts, inline rename, copy feedback, `DisabledHint`, destructive actions, dashboard parts |
| [Utility classes, editor widgets and scrollbars](utilities-editor-scrollbar.md) | Tailwind utility reference, Monaco widgets, scrollbars |

## Source Files

| File | Purpose |
|------|---------|
| `app/src/index.css` | All CSS custom properties, keyframes, utility classes |
| `app/tailwind.config.js` | Color mapping, font families, border radii (no keyframes or animations: those live in `index.css`) |
| `app/index.html` | Pre-paint appearance script; no font `<link>` (see `fonts.css`) |
| `app/src/fonts.css` | Bundled `@fontsource` imports for all six font families |
| `app/src/components/layout/Shell.tsx` | Root layout - the ActivityRail, the drawer row, the content column (TabStrip, main, ContextBar, ContextRail), the Dock, and the window chords |
| `app/src/components/layout/ActivityRail.tsx` | Left-edge nav - the six view buttons the Dock used to hold, with roving tabindex |
| `app/src/components/layout/ContextRail.tsx` | Right-edge nav - one icon per applicable context-bar section |
| `app/src/components/layout/RailButton.tsx` | The icon button shared by both rails - edge-indicator and tile variants |
| `app/src/components/layout/Dock.tsx` | The bottom strip - status in the centre (engine light, version, services, save state, pending restart), per-tab view controls on the right |
| `app/src/components/layout/ResponsePositionButton.tsx` | The Dock's response-position switch - click flips Beside / Below, right-click picks Beside / Below / Auto, icon names the destination, request tabs only |
| `app/src/components/layout/Drawer.tsx` | The sidebar `<aside>` - one of six views, plus its resize handle |
| `app/src/components/shared/DrawerPanel.tsx` | The frame every drawer view sits in - header plus the one scroll region |
| `app/src/components/shared/run-status.ts` | `RUN_STATUS`: the one status-to-label/glyph/token map behind the dashboard pill and the history row |
| `app/src/components/shared/RunStatusPill.tsx` | `RunStatusPill` and `RunStatusGlyph`, both drawn through `runStatusDisplay`, the status above refined by a verdict |
| `app/src/components/shared/RunOutcomeBanner.tsx` | The Passed / Failed / Not judged line a finished load run opens on, over `run-outcome.ts`'s verdict |
| `app/src/components/layout/PanelResizeHandle.tsx` | The drawer's and the context bar's one drag handle (a focusable window splitter) |
| `app/src/components/ui/disabled-hint.tsx` | The wrapper that lets a disabled control say why it is off |
| `app/src/components/ui/heading.tsx` | `Heading` and `HeadingSection`: a title's element from the main pane's outline (`heading-level.ts`) |
| `app/src/hooks/useInlineRename.ts` | The one inline-rename editor: commit keys, the Escape that never commits, trim, focus return |
| `app/src/lib/method-display.ts` | `getMethodColor(method)` → `var(--method-xxx)` |
| `app/src/lib/time-value.ts` | The one place text becomes a time: `parseTimeValue`, `describeInstant`, `formatInstant`, `formatRelative`, `formatDayHeading` |
| `app/src/components/shared/TimeValue/TimeValue.tsx` | The one renderer of a time: visible text plus the hover card, and `TimeTooltip` for a trigger the surface draws |
| `app/src/components/shared/TimeValue/TimeMarker.tsx` | The time card's marker beside an editable field that holds a time |
| `app/src/modules/dashboard/components/MetricsView.tsx` | `MetricsView`, the live dashboard's router: derives the run's metrics and composes the rows from `hero/`, `stats/` and `charts/` beside it |
