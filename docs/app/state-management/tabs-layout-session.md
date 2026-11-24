---
description: >-
  The cross-cutting Zustand stores for open tabs and navigation, the drawer and panel layout, and the active environment.
---

# Tabs, layout and session stores

## `tabs-store.ts` - Open Tabs & Navigation

Manages all open tabs (welcome, request, collection, dashboard, run, variables, settings) and active tab focus.
Enforces a maximum of 12 open tabs with LRU eviction for non-exempt types.

**State:**
```typescript
{
  openTabs: Tab[]                        // Each tab has unique id, type, and optional entityId
  activeTabId: string | null
  tabFocusedAt: Record<string, number>   // Tab id -> when it was last focused (epoch ms)
  navIntent: NavIntent | null            // What the navigation in flight asked of the screen it opened (session-only)
  navHistory: TabLocation[]              // Visited locations this session, oldest first
  navIndex: number                       // Cursor into navHistory; -1 before anything is visited
}
```

**Key Features:**
- Deduplication: Singleton types (welcome, variables, settings, inbox) only allow one tab at a time.
  Opening one that is already open with a *different* `entityId` **retargets** it - same tab id, new address - rather than focusing whatever it was showing.
  The inbox tab is the case that needs it: every Services drawer row opens that one tab pointed at its own inbox (issue #554).
  The other three are always opened with a null `entityId`, for which this is a no-op
- LRU eviction: when over the limit, the least recently focused non-active, non-exempt, clean tab is closed - "oldest" is by `tabFocusedAt`, not strip order, with an unstamped tab ranking first and ties kept in strip order.
  The tab being opened is never a candidate, so a strip whose other tabs are all dirty runs past the cap.
  Every path that makes a tab active stamps it, a close that activates a survivor included
- Integration with save-store: dirty tabs are never selected for eviction.
  The guard resolves each tab's save-context key by tab *type* (`isTabDirty`), because the registry is keyed by editor and the two do not line up: `settings` and `variables` are singletons with no `entityId`, so a `request-${entityId}` lookup read them as clean and the 13th tab could close a dirty Settings tab.
  A `variables` tab counts any dirty variable-editor context as its own, since a `Tab` does not record which editor the sidebar has selected - over-matching keeps a tab that could have closed, under-matching loses work.
  Nothing is flushed *during* eviction; the predicate already refused the tab
- Bulk close (issue #1360): `closeOtherTabs`, `closeTabsToRight` and `closeSavedTabs` - the tab strip's right-click menu - go through the same `closeTabs` core as `closeTab` and `closeTabsForEntities`, so "which tab takes the place of the one that was showing" stays one rule.
  A bulk close is one `set` and at most one recorded navigation visit, never a loop of single closes: closing tabs one at a time would focus and record a visit for every intermediate tab on the way to the last, leaving Back to walk the user through places they never went.
  `closeOtherTabs` and `closeTabsToRight` carry `closeTab`'s #1489 guard (issue #3324): while `engineStatus` is not `connected`, a dirty tab (`isTabDirty`) is left out of the set to close, the clean ones still close, and one "Not saved - Vayu's engine is unreachable; kept N unsaved tabs open" toast says how many stayed (none when nothing was kept).
  `closeSavedTabs` never selects a dirty tab, so it needs no guard
- Reorder (issue #2038): `moveTab(tabId, toIndex)` puts a tab at the index it occupies afterwards, clamped to the list, and returns without a `set` when the tab is unknown or already there.
  It writes `openTabs` and nothing else: the active tab, `tabFocusedAt` and the navigation history name tabs by id and location, never by position, so a move is not a navigation and records no visit.
  The `Tab` objects are reused, not copied, because `TabItem`'s memo compares `prev.tab === next.tab`.
  The order persists with no extra work: `partialize` writes `openTabs` and `migrateTabs` reads it back in order.
- Response eviction: `closeTabsForEntities` clears each id's entry in `response-store`.
  Both callers reach it after a delete - the map's own LRU bound would get there eventually, but a response nothing can reach again should go at the delete, not twenty-four sends later.
  `MAX_OPEN_TABS` is exported for that bound: the cache retains twice it
- Focus recency: `tabFocusedAt` stamps `openTab` and `focusTab`, and is read by the command palette, which lists open tabs most-recently-used first.
  It cannot come from `openTabs`, which is insertion order - the tab you were just in sits wherever it was opened.
  Session-scoped on purpose (absent from `partialize`): tabs *are* restored across launches, so a persisted copy would rank a restored list by yesterday's attention, and an empty map falls back to strip order.
  Entries for closed tabs are dropped on the next focus rather than in every close path - nothing reads a stamp for a tab that is not open
- Pointing *into* a screen: `navIntent` is the one hand-off from a navigation to the screen it opened, because `openTab` can only name a tab.
  It is a `NavIntent` - `{ kind: "spec" | "dataRow" | "compare" | "focusUrl", target, ... }`, with `target` the id of the collection, request or run it is for - and at most one is pending.
  `openCollectionSpecTab(collectionId)` issues `spec`: the import dialog's Sync for an already-bound document (issue #680), which `CollectionDetail` answers by opening on Spec.
  `openRequestWithDataRow` issues `dataRow`, carrying the `rowIndex` a failed step of a collection run bound (issue #730): "reproduce this step" means its request *and* the row, and the UrlBar selects the row and opens the picker on it.
  A non-integer or negative index throws rather than being stored.
  `openRunComparison(runId)` issues `compare`, the History row's "Compare with…" (issue #2164), which `LoadTestDetail` answers by opening the run's report on its compare view.
  `openRequestFocusingUrl(requestId)` issues `focusUrl` for a request just created blank (issue #3400): ⌘N, the palette command, the Launcher tile and the sidebar's "+" all leave the caret in the new request's URL field, which `UrlInput` answers once it mounts - the builder mounts after the tab opens, so a focus call made with it would find no field.
  A request created from a preset (the demo, an import, a saved agent run) issues none
- A screen takes its intent with `takeNavIntent(kind, target)`, which returns it and clears it only when both match - another kind or another target gets `null` and leaves it pending - so it fires once, on the screen it was for.
  The UrlBar takes its own whether or not the request can bind rows.
  The intent belongs to the navigation that issued it (issue #3355), not to the entity it names: the tab and the intent are set in one `set`, so the screen sees both on the same render, and any later `openTab`, `focusTab`, `focusAdjacentTab`, `goBack` or `goForward` replaces or clears it, as does closing the tab it names (a single close, a bulk close or `closeTabsForEntities`).
  An intent whose screen never rendered therefore cannot fire on a later visit.
  Session-scoped like `tabFocusedAt` (absent from `partialize`): a persisted copy would jump the user to Spec, a data row or a comparison for a choice made in a previous launch, and a data row points into a file whose rows are deliberately never persisted
- Navigation history (issue #1245): `navHistory` is a `TabLocation` per visit (a `Tab` without its instance id, so a closed tab's place survives it), with `navIndex` as the cursor - `-1` before anything is visited.
  `openTab` and `focusTab` record each visit themselves, coalescing a repeat of the current location and truncating the forward half on a new one; capped at 50 entries (`MAX_NAV_HISTORY`), oldest dropped first.
  `goBack()` / `goForward()` move the cursor and show what it lands on - focusing the open tab if there is one, reopening it through `openTab` otherwise - without recording a step of their own.
  Closing the *active* tab now activates the most recent history entry whose tab is still open, falling back to the old left-neighbour rule, and leaves the closed location ahead of the cursor so Forward can reopen it; `closeTabsForEntities` prunes history entries for deleted entities, so Back never lands on one.
  Session-scoped like `tabFocusedAt` and `navIntent` (absent from `partialize`), and NOT persisted: tabs *are* restored across launches, and a persisted history would offer a Back that walks yesterday's route through today's window
- Persistence: `vayu.tabs` (v1), with a pass-through `migrate`. zustand discards a payload whose *stamped* version differs from the store's when no `migrate` is supplied, so the stub is where the next bump goes; it also refuses a payload of the wrong shape rather than handing a non-array to every reader

**Key Methods:**
```typescript
const { openTab, closeTab, focusTab, closeTabsForEntities } = useTabsStore();
openTab({ type: "request", entityId: "req-123" });
closeTabsForEntities(["req-123"]); // after a delete: closes tabs, drops responses

const { closeOtherTabs, closeTabsToRight, closeSavedTabs } = useTabsStore();
closeOtherTabs("tab-1"); // keeps tab-1, one set-and-visit for the rest
closeTabsToRight("tab-1");
closeSavedTabs(); // keeps every dirty tab
openCollectionSpecTab("col-123"); // opens the collection, on its Spec tab
openRequestWithDataRow("req-123", 500); // opens the request, on row 501 of its data file

const { goBack, goForward } = useTabsStore();
goBack(); // step back through navHistory; reopens the tab if it was closed
goForward(); // never records a visit - only openTab/focusTab do that

// canGoBack / canGoForward are exported selectors, not store methods - read
// by the title-bar buttons and the palette's go-back / go-forward commands
canGoBack(useTabsStore.getState());
canGoForward(useTabsStore.getState());
```

## `layout-store.ts` - Drawer, Context Bar, Bottom Panel, & Response Position

Manages the left drawer (collections/history/variables/settings), the right context bar, the bottom panel, and where the response pane sits - beside the request or below it - with one split ratio per arrangement.

**State:**
```typescript
{
  drawerOpen: boolean                    // Is the left drawer visible?
  drawerView: DrawerView                 // "collections" | "history" | "variables" | "services" | "settings"
  drawerWidth: number                    // One width for every view
  contextBarOpen: boolean                // Is the right context bar visible?
  contextBarWidth: number
  contextBarCollapsedSections: string[]  // Section ids the user collapsed (`code` by default)
  responsePosition: ResponsePosition     // "beside" | "below" | "auto" (default beside, #1711)
  autoResponseArrangement: "beside" | "below"  // What auto resolves to right now - written by the builder's measurement, not persisted
  requestSplitRatioBeside: number        // 0-1; the request pane's share while the response is beside it
  requestSplitRatioBelow: number         // 0-1; the request pane's share while the response is below it
  scriptSnippetsCollapsed: boolean       // Default a fresh script row's snippets list starts from (collapsed); each row keeps its own state after that
  scriptEditorHeights: Record<string, number>  // Height (px) of a script.pre/script.post element's editor box, keyed by the element's own id - capped at 200 entries, oldest set evicted first
  scriptEditorHeightDefault: number      // Height a script row with no entry above starts at - the last height set on any row
  recentElementKinds: string[]           // Last 5 kinds added through the Add-element picker, most recent first
  bottomPanelOpen: boolean               // Is the bottom panel showing? Closed by default (#3635)
  bottomPanelHeight: number              // px; clamped to [BOTTOM_PANEL_MIN_HEIGHT, BOTTOM_PANEL_MAX_HEIGHT] here, and to half the window as it is drawn
  bottomPanelTab: BottomPanelTab         // "console" (the default) or "logs"; the id of one of BOTTOM_PANEL_TABS (constants/layout.ts)
  paletteOpen: boolean                   // Is the ⌘K command palette showing?
}
```

**Key Methods:**
```typescript
const {
  drawerOpen, setDrawerOpen, toggleDrawer,
  drawerView, setDrawerView, activateDrawerView, revealDrawerView,
  drawerWidth, setDrawerWidth,
  contextBarOpen, setContextBarOpen, toggleContextBar,
  contextBarWidth, setContextBarWidth,
  contextBarCollapsedSections, toggleContextBarSection,
  bottomPanelOpen, setBottomPanelOpen, toggleBottomPanel,
  bottomPanelHeight, setBottomPanelHeight,
  bottomPanelTab, setBottomPanelTab,
  responsePosition, setResponsePosition, toggleResponsePosition,
  setRequestSplitRatio
} = useLayoutStore();
activateDrawerView("variables"); // Open drawer to variables, or toggle closed if already there
revealDrawerView("variables"); // Open drawer to variables, never closes it - for anything that points at a view
setDrawerWidth(300); // Clamped to [PANEL_MIN_WIDTH, PANEL_MAX_WIDTH] (constants/layout.ts)
toggleResponsePosition(); // beside <-> below; from auto, the opposite of what auto currently shows
setRequestSplitRatio("below", 0.6); // Into the ratio for the arrangement that was dragged, clamped 0.2..0.8
resolveResponseArrangement(useLayoutStore.getState()); // The arrangement on screen: the setting, or auto's pick
```

**One drawer width, not one per view.** v2 stored a width per view, so switching from Collections to History resized the main content under the user; the **v3** migration collapses them onto a single `drawerWidth`, keeping whatever Collections (the default view) had.
Re-introducing a per-view width re-introduces that bug.
`setRequestSplitRatio` clamps to [0.2, 0.8]; both panel widths clamp to `PANEL_MIN_WIDTH` / `PANEL_MAX_WIDTH`.

**The bottom panel's three fields persist and the panel starts closed** (#3635, the **v7** migration).
`toggleBottomPanel` is the one write the Dock button, the `Chord` in `constants/shortcuts.ts` (⌘J / Ctrl+J) and the palette row make, so no route has an opinion of its own.
`setBottomPanelHeight` clamps to the absolute bounds only; the half-the-window cap needs a window the store does not know, so `BottomPanel` applies `clampBottomPanelHeight` when it draws and a window that is briefly small does not overwrite the user's choice.
A persisted `bottomPanelTab` that names a tab a later release removed resolves to the first one (`resolveBottomPanelTab`).
The panel renders nothing while closed, so a tab's content is mounted only while it is on screen.

**`setDrawerWidth` / `setContextBarWidth` / `setBottomPanelHeight` are not called per `pointermove`.**
`PanelResizeHandle` (`app/src/components/layout/PanelResizeHandle.tsx`) holds a drag's live size outside the store, painting it onto the panel's own inline `style.width` (`style.height` for the bottom panel's top-edge handle) once per animation frame, and calls the setter - the one write `partialize` persists - exactly once, on `pointerup`.
A store write on every `pointermove` was a synchronous `JSON.stringify` + `localStorage.setItem` of the whole persisted slice 120-240 times a second (#1715).

**`paletteOpen` is here, and is not persisted.**
The palette lives in `Shell` while the things that open it - the welcome Launcher's Search tile, the title bar's search bar - are in other subtrees, so the flag has to be shared state rather than the dialog's own.
It is deliberately absent from `partialize`: a dialog that reopened itself on every launch is not a layout preference.

**Context-bar sections are collapsed by exception.**
The store holds the ids the user closed (`contextBarCollapsedSections`); anything not listed is expanded.
Two consequences worth keeping: a section added in a later release ships *expanded* for existing users, because a blob written before it existed cannot name it; and it is an array rather than a `Set` because `persist` serializes with JSON, which writes a `Set` as `{}` - a collapse would survive exactly until the next launch.

`code` is the one section allowed to break the ships-expanded rule (`CONTEXT_BAR_DEFAULT_COLLAPSED`, `constants/layout.ts`, currently `["code"]`): an expanded Code section issues a `POST /compose` on mount, so with the bar open the app composed a snippet on every request tab opened, whether or not anyone looked at it.
That default needs both the initial state *and* the v3 -> v4 migration to actually reach an existing user, and neither alone is enough:
`persist` merges a missing *key* onto the initial state, never a missing *element* into an array that is already there, so seeding `contextBarCollapsedSections: ["code"]` in the initial state only reaches a fresh install - a user who has ever collapsed anything already has the key, with an array `persist` treats as complete.
The migration writes `code` into that array directly, and at the same time prunes any id in `RETIRED_CONTEXT_BAR_SECTIONS` (`environment`, retired the same release), so a persisted collapse list never keeps naming a section that no longer exists.
It is a default, not a policy: once migrated, a user's own toggle on `code` overrides it exactly like any other section.

**Persistence:** `vayu.layout` (v6, with a real migration for every bump - the one store in the app doing persistence versioning end to end; v6 carries the old single `requestSplitRatio` forward as the Beside ratio, seeds Below even and keeps the position at Beside, so an upgrade re-arranges nothing)

## `session-store.ts` - Active Environment

Tracks the active environment (for variable resolution) and the collection the user last worked in (a new-request target only), persisted across sessions.

**State:**
```typescript
{
  activeEnvironmentId: string | null
  lastCollectionId: string | null
}
```

**Key Methods:**
```typescript
const { activeEnvironmentId, setActiveEnvironmentId } = useSessionStore();
setLastCollectionId(collectionId);
```

**Persistence:** `vayu.session` (v2)

**A persisted id must not outlive what it names.**
`activeEnvironmentId` rides on every composed payload, so a dangling one is not cosmetic - the switcher renders "No Environment" through a defensive `find()` while the wire still carries a deleted id.
It is cleared at both ends: `useDeleteEnvironmentMutation` clears it when the active environment is the one deleted (in the mutation, so both delete flows are covered), and `useActiveEnvironmentGuard()` - mounted once in `App.tsx` - clears an id the engine's environment list does not contain.
That guard keys on the query's `isSuccess`, never on the list being empty: an unreachable engine produces an empty list too, and clearing on that would discard a good selection whenever the app started before the engine did.

A delete is soft since #2970 - the environment goes to the Trash - and the id stays cleared through a restore.
The engine clears `is_active` in the same write that stamps the row and a restore clears only the stamp, so a restored environment comes back inactive; neither `useRestoreTrashMutation` nor the delete's Undo toast writes `activeEnvironmentId`.
Making it active again is the user's choice, through the switcher or **Set active**.

`activeCollectionId` was **removed** in v2.
It had a reader (the resolver's fallback scope) and no writer, so it was permanently null on a fresh install and, on an older one, rehydrated a collection the user had long left and silently scoped `{{var}}` previews to it.
The persist `migrate` drops the stored key.
`lastCollectionId` is the field that looks similar and is not: it has a real writer and feeds only the welcome screen's new-request target - it must never feed the resolver.

The migration rebuilds the payload from the fields v2 knows rather than deleting that one key, which is also the shape check: a hand-edited or half-written entry degrades to defaults instead of handing a non-string id to the switcher.
That whitelist is where the next bump goes - zustand discards a payload whose *stamped* version does not match when no `migrate` is supplied, which is the same reason `tabs-store` carries one.

**`activeEnvironmentId` is a cache of engine state, not the source of truth.**
The engine owns which environment is active (`environments.is_active`, at most one row, enforced in its DB layer).
The store holds the same id so the switcher, the resolver and every composed payload can read it synchronously, and two pieces of wiring keep the two in step:

- `useSetActiveEnvironmentMutation` (`queries/environments.ts`) is the only writer.
  It PUTs `isActive` and updates the store optimistically, rolling the store back if the engine refuses - a selection the engine did not accept must not survive in the UI, or the next launch silently disagrees with this one.
  It invalidates the environments list rather than patching the response into it, because the *deactivated* row changed server-side without appearing in any response body.
  Switches made before an earlier one settles are numbered and their PUTs run one at a time (a mutation `scope`), so the engine ends holding the last switch that landed.
  The hook also keeps the environment the engine is known to hold (`settledActiveId`: the store's value when no switch is in flight, then each PUT that succeeded).
  A refusal rolls the store back to that, and only while it is still the latest switch: a newer one has already replaced the optimistic value, and the store's value at the time the refused switch started may be an earlier switch the engine also refused.
  A clear deactivates the same environment, not the one the store was showing when the clear was issued (#3355).
- `useActiveEnvironmentRestore` (`hooks/`, mounted in `App.tsx`) reconciles on launch: adopt the engine's active environment if it has one, otherwise push a persisted id that names an environment that still exists - once per session, so a write the engine keeps rejecting is a failed write and not a request loop.
  Both directions wait on `isSuccess`; an unreachable engine returns an empty list that is indistinguishable from "no environments exist", and adopting from that would clear a good selection on every cold start.
  A third direction was added with the MCP state tools (#758): once this session has *seen* the engine hold a selection, an engine that reports none is adopted as a clear rather than pushed back at.
  Otherwise an `activate_environment` with `"none"` - or any other client's deactivate - would be undone on the very next refetch by this window's memory of the id it used to hold.
  The upgrade push stays for the case it was written for: an engine that has never held a selection at all.

It composes with `useActiveEnvironmentGuard` above rather than replacing it, and is mounted after it: the guard answers "does this id still exist", this hook answers "which id does the engine hold".
Order matters only in the one case where both would act - a dangling id should be dropped, not pushed back at the engine as a selection.

Editing an environment's variables deliberately sends no `isActive` (absent means "keep" on a PUT): echoing a cached value back would let a variable edit re-activate an environment from a stale read, deactivating whichever one the engine actually holds.
