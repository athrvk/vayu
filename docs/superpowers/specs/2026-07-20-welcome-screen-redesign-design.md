# Welcome Screen Redesign

**Date:** 2026-07-20
**Status:** Approved, ready for implementation

## Problem

The welcome screen looks generic and roughly half its content is useless.

**Useless.** The screen is built as a product landing page, but it is the app's
new-tab surface. `"welcome"` is a singleton tab type and TabStrip's `+` button
opens it, so a user sees it every time they start something new. It currently
serves them a hero logo, a four-card "Key Features" pitch for software they have
already installed, and two hardcoded marketing numbers (`50k+` RPS, `< 1ms`)
that are not their data and read as telemetry.

Two further redundancies: **Recent Collections duplicates the Collections
sidebar**, which is visible at the same moment, and **Recent Runs partly
duplicates the History drawer**.

Critically, the screen is *not* the returning user's landing pad. `openTabs` and
`activeTabId` are persisted and restored (`tabs-store` `partialize`), so a
returning user lands on the exact tabs they left. Resumption is already solved,
and solved better than a "recent items" list could. The screen's real job is
narrow: **start something new**, plus first-run orientation.

**Generic.** The screen does not follow Vayu's own design system. `design-system.md`
specifies 13px body, 11px uppercase eyebrow labels, mono tabular numerals,
`rounded-md`, and a 3-level elevation model. WelcomeScreen uses `text-5xl` /
`text-xl` / `text-2xl`, `py-12`, `text-center`, a `bg-gradient-to-br` that exists
nowhere else in the app, and stock shadcn `Card*` primitives. It speaks a
different visual language from every other surface.

## Market context

| Tool | Product shape | Home screen |
|------|---------------|-------------|
| Postman | cloud, teams, workspaces | rich hub — coordination, discovery, monetization |
| Bruno | local-first, single user | near-none — one action, import-forward |
| JMeter | local desktop | none |
| **Vayu** | **local-first, single user, sidecar** | currently a landing page |

Postman's home carries "Pick up where you left off" and "Needs your attention"
(team join requests, access requests, pull requests awaiting review) — machinery
for problems a local single-user tool does not have. Its resume feature
compensates for not having reliable tab restore; Vayu already has that.

Vayu belongs to Bruno's class but wears Postman's clothes. The one idea worth
taking is Bruno's: **lead with import**. Nobody adopts an API client from zero;
they arrive carrying Postman collections. Vayu ships Postman/Insomnia/OpenAPI
importers but buries "Import Collection" as the fifth of five equal cards.

## Approach

A split launcher: one screen, two states, sharing a shell.

Considered and rejected: **deleting the welcome screen** so `+` opens a request
directly (Bruno/JMeter behavior). This is arguably more correct, but Vayu has no
draft-request concept — requests always persist, and `handleNewRequest`
auto-creates a collection when none exists. `+` would either litter the
workspace on every press or require building ephemeral draft semantics across
tabs-store and the request layer. Out of scope; revisit separately.

Also rejected: restyling in place, which fixes "useless" but not "generic",
since the centered-hero-above-a-card-grid shape *is* the generic thing.

## Content model

State trigger: empty when `collections.length === 0 && runs.length === 0`.

### Empty (first run)

| Element | Detail |
|---------|--------|
| Brand | 24px icon + `text-[15px]` wordmark + one descriptive line |
| **Primary: Import** | Opens the existing import modal. Names formats explicitly — Postman, Insomnia, OpenAPI — since that recognition is the pitch |
| Secondary: New request | Existing `handleNewRequest` |
| Footer links | Settings, Scripting docs, Documentation |

Action tiles carry one-line descriptions in this state only.

### Populated

| Element | Detail |
|---------|--------|
| Action row | New Request, Import, Load Test, Variables — four, equal weight, no descriptions |
| Recent Runs | Up to 5; section hidden entirely when there are none |
| Workspace line | `N collections · N runs` |
| Footer links | Settings, Scripting docs, Documentation |

**No branding in this state.** The app is already open and the logo is in the
title bar.

### Action handlers

| Action | Handler |
|--------|---------|
| New Request | existing `handleNewRequest` (creates a collection if none exists, then a request, then opens its tab) |
| Import | `useImportModalStore.open()` |
| Load Test | `openTab({ type: "dashboard", entityId: null })` |
| Variables | `openTab({ type: "variables", entityId: null })` |
| Settings (footer) | `openTab({ type: "settings", entityId: null })` |
| Scripting docs / Documentation (footer) | `shell:openAppLink` with `"scripting"` / `"docs"` |

### Recent-run row

Left: run-type badge (`Load Test` / `Design`) and status text — `success-text`
when completed, `warning-text` when stopped, omitted otherwise. Below: relative
start time via the existing `formatDistanceToNow`, mono tabular. Right: chevron
affordance. Whole row is the click target.

Dropped from the action row: *Settings* (configuration, not starting work —
demoted to a footer link) and *View History* (superseded by Recent Runs).

Removed entirely: Key Features, Performance stats, Recent Collections, the
four-card Overview grid, the hero, both taglines.

## Visual spec

Left-aligned column, `max-w-2xl`, `px-8 py-10` — replacing `max-w-6xl` +
`py-12` + `text-center`.

**Surfaces**

- Page `bg-background`; the gradient is removed.
- Action tiles: `bg-card border border-border rounded-md`, hover `bg-accent`.
- Recent-run rows: flat rows, `hover:bg-accent rounded-md` — not cards.
  Escaping the card grid is most of what stops it reading as generic.
- Do not use shadcn `Card`/`CardHeader`/`CardTitle`/`CardDescription` here; they
  impose spacing and type that fight the token scale.

**Type** (all from `design-system.md`)

| Element | Class |
|---------|-------|
| Section eyebrow | `text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground` |
| Action label | `text-[13px] font-medium` |
| Body / description | `text-[13px] text-muted-foreground` |
| Workspace line, timestamps | `text-[12px] font-mono tabular-nums` |
| Footer links | `text-[12px] text-muted-foreground hover:text-foreground` |

No `text-5xl`, `text-xl`, or `text-2xl`.

**Icons.** Drop the `p-2 bg-primary/10` tinted chips — they also currently lack a
radius class, so they render square regardless of the user's roundedness
setting. Use plain 16px lucide icons, `text-muted-foreground` going
`text-primary` on hover.

**Personality** comes from Recent Runs carrying the app's existing visual
vocabulary — run-type badge, `success-text` / `warning-text` status tokens, mono
tabular timestamps — the same language as the dashboard and history views,
rather than a novel aesthetic invented for one screen.

**Density.** Both states fit without scrolling at the default window size.

Keyboard-shortcut hints beside actions were considered and rejected: Vayu has no
shortcut system for these actions, so the hints would advertise bindings that do
not exist.

## Structure

```
app/src/modules/welcome/
  WelcomeScreen.tsx           container: hooks, picks state
  EmptyState.tsx              first run
  Launcher.tsx                populated
  components/ActionTile.tsx
  components/RecentRuns.tsx
  components/FooterLinks.tsx  shared by both states
```

## Data

Two defects in the current implementation, fixed here:

1. **N-query fan-out.** `useMultipleCollectionRequests` fires one query per
   collection to total request counts. After this redesign its only consumer
   would be the word "requests" in the workspace line. Drop the request count;
   keep `N collections · N runs` from the two queries already loaded, and remove
   the hook from this screen.

2. **Empty-state flash.** `useCollectionsQuery` / `useRunsQuery` return `[]`
   while loading, so `hasData` is false and a returning user briefly sees the
   first-run import screen before it flips to the launcher. Hold on `isLoading`
   from both queries and render nothing until they settle — no skeleton, since
   the resolved render is fast and a skeleton would flash too.

Plus two behavioral fixes to code being replaced:

3. **Run rows open the wrong thing.** They call `activateDrawerView("history")`,
   opening the drawer rather than the run clicked. Use
   `openTab({ type: "run", entityId: run.id })`, which Shell already supports.

4. **Query-cache mutation.** `runs.sort(...)` sorts in place, mutating the
   TanStack Query cache array. Use `[...runs].sort(...)`.

## External links

The renderer has no general way to open external URLs: the only exposed channel
is `oauth:openExternal`, and `mainWindow` has no `setWindowOpenHandler`, so a
plain `<a target="_blank">` would spawn an unmanaged Electron window.

Add `shell:openAppLink` — an IPC handler keyed `"docs" | "scripting" | "issues"`,
resolved against the existing `DOCS_URL` / `SCRIPTING_DOCS_URL` / `ISSUES_URL`
constants in the main process; a preload binding; and the `electronAPI` type.

**The renderer never passes a URL.** A named-key channel avoids handing the web
layer a general "open any URL" capability, which an `openExternal(url)` binding
would. This widens the preload surface, a security boundary, so it is done
deliberately and narrowly.

## Error handling

`handleNewRequest` swallows failures into `console.error`, so a failed create
looks like a dead click. Route failures to the existing `Toaster`.

## Testing

Behavior tests, not snapshots (the repo's characterization snapshots suit stable
legacy surfaces; this one is being rewritten):

- empty workspace → import is the primary action
- populated → action row and recent runs render; no brand block
- clicking a run opens a `run` tab with that run's id *(regression: defect 3)*
- the runs array from the query is not mutated *(regression: defect 4)*
- loading → neither state renders *(regression: defect 2)*

## Out of scope

- Draft-request semantics and changing what `+` does (see Approach).
- The dead `/vite.svg` favicon reference in `index.html`.
- Any change to the Collections sidebar or History drawer.
