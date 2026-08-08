# State Management

The Vayu app uses a dual-state management approach: **Zustand** for UI state and **TanStack Query** for server state. **Cross-cutting stores** (tabs, layout, session, engine, save, response, dashboard, client settings, toasts, import modal) live in `app/src/stores/` and are exported via the barrel `app/src/stores/index.ts`. **Module-local UI stores** co-locate in `app/src/modules/<feature>/<feature>-store.ts` (collections, history, variables, settings) to keep feature-specific UI state decoupled from global app state.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│           State Management Layers                │
├─────────────────────────────────────────────────┤
│  UI State (Zustand)                             │
│  - Cross-cutting: tabs, layout, session         │
│  - Domain: engine, save, response, dashboard    │
│  - Module-local: collections, history, vars     │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Server State (TanStack Query)                  │
│  - Collections, Requests, Environments           │
│  - Runs, Metrics, Global Variables              │
│  - Automatic caching & synchronization          │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Services Layer                                 │
│  - HTTP Client (api.ts)                        │
│  - SSE Client (sse-client.ts)                  │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Vayu Engine (C++ Daemon)                      │
│  - SQLite Database                              │
│  - HTTP API (localhost:9876)                    │
└─────────────────────────────────────────────────┘
```

## Zustand Stores

### Cross-Cutting Stores (`app/src/stores/`)

#### `tabs-store.ts` - Open Tabs & Navigation

Manages all open tabs (welcome, request, collection, dashboard, run, variables, settings) and active tab focus. Enforces a maximum of 12 open tabs with LRU eviction for non-exempt types.

**State:**
```typescript
{
  openTabs: Tab[]          // Each tab has unique id, type, and optional entityId
  activeTabId: string | null
}
```

**Key Features:**
- Deduplication: Singleton types (welcome, variables, settings) only allow one tab at a time
- LRU eviction: Oldest non-active, non-exempt, clean tabs are closed when over limit
- Integration with save-store: dirty tabs are never selected for eviction. The
  guard resolves each tab's save-context key by tab *type* (`isTabDirty`),
  because the registry is keyed by editor and the two do not line up: `settings`
  and `variables` are singletons with no `entityId`, so a `request-${entityId}`
  lookup read them as clean and the 13th tab could close a dirty Settings tab.
  A `variables` tab counts any dirty variable-editor context as its own, since
  a `Tab` does not record which editor the sidebar has selected - over-matching
  keeps a tab that could have closed, under-matching loses work. Nothing is
  flushed *during* eviction; the predicate already refused the tab
- Response eviction: `closeTabsForEntities` clears each id's entry in
  `response-store`. Both callers reach it after a delete, and nothing else
  evicts from that map
- Persistence: `vayu.tabs` (v1), with a pass-through `migrate`. zustand discards
  a payload whose *stamped* version differs from the store's when no `migrate`
  is supplied, so the stub is where the next bump goes; it also refuses a
  payload of the wrong shape rather than handing a non-array to every reader

**Key Methods:**
```typescript
const { openTab, closeTab, focusTab, closeTabsForEntities } = useTabsStore();
openTab({ type: "request", entityId: "req-123" });
closeTabsForEntities(["req-123"]); // after a delete: closes tabs, drops responses
```

#### `layout-store.ts` - Drawer, Context Bar, & Split Ratio

Manages the left drawer (collections/history/variables/settings), the right context bar, and request/response split ratio.

**State:**
```typescript
{
  drawerOpen: boolean                    // Is the left drawer visible?
  drawerView: DrawerView                 // "collections" | "history" | "variables" | "settings"
  drawerWidth: number                    // One width for every view
  contextBarOpen: boolean                // Is the right context bar visible?
  contextBarWidth: number
  contextBarCollapsedSections: string[]  // Section ids the user collapsed
  requestSplitRatio: number              // 0–1; left/request pane fraction
}
```

**Key Methods:**
```typescript
const {
  drawerOpen, setDrawerOpen, toggleDrawer,
  drawerView, setDrawerView, activateDrawerView,
  drawerWidth, setDrawerWidth,
  contextBarOpen, setContextBarOpen, toggleContextBar,
  contextBarWidth, setContextBarWidth,
  contextBarCollapsedSections, toggleContextBarSection,
  requestSplitRatio, setRequestSplitRatio
} = useLayoutStore();
activateDrawerView("variables"); // Open drawer to variables, or toggle closed if already there
setDrawerWidth(300); // Clamped to [PANEL_MIN_WIDTH, PANEL_MAX_WIDTH] (constants/layout.ts)
```

**One drawer width, not one per view.** v2 stored a width per view, so switching
from Collections to History resized the main content under the user; the **v3**
migration collapses them onto a single `drawerWidth`, keeping whatever
Collections (the default view) had. Re-introducing a per-view width re-introduces
that bug. `setRequestSplitRatio` clamps to [0.2, 0.8]; both panel widths clamp to
`PANEL_MIN_WIDTH` / `PANEL_MAX_WIDTH`.

**Context-bar sections are collapsed by exception.** The store holds the ids the
user closed (`contextBarCollapsedSections`); anything not listed is expanded. Two
consequences worth keeping: a section added in a later release ships *expanded*
for existing users, because a blob written before it existed cannot name it; and
it is an array rather than a `Set` because `persist` serializes with JSON, which
writes a `Set` as `{}` - a collapse would survive exactly until the next launch.
No migration was needed for the field: `persist` merges a missing key onto the
initial state, which is `[]`.

**Persistence:** `vayu.layout` (v3, with real migrations for both bumps - the one
store in the app doing persistence versioning end to end)

#### `session-store.ts` - Active Environment

Tracks the active environment (for variable resolution) and the collection the
user last worked in (a new-request target only), persisted across sessions.

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

**A persisted id must not outlive what it names.** `activeEnvironmentId` rides
on every composed payload, so a dangling one is not cosmetic - the switcher
renders "No Environment" through a defensive `find()` while the wire still
carries a deleted id. It is cleared at both ends:
`useDeleteEnvironmentMutation` clears it when the active environment is the one
deleted (in the mutation, so both delete flows are covered), and
`useActiveEnvironmentGuard()` - mounted once in `App.tsx` - clears an id the
engine's environment list does not contain. That guard keys on the query's
`isSuccess`, never on the list being empty: an unreachable engine produces an
empty list too, and clearing on that would discard a good selection whenever
the app started before the engine did.

`activeCollectionId` was **removed** in v2. It had a reader (the resolver's
fallback scope) and no writer, so it was permanently null on a fresh install
and, on an older one, rehydrated a collection the user had long left and
silently scoped `{{var}}` previews to it. The persist `migrate` drops the
stored key. `lastCollectionId` is the field that looks similar and is not: it
has a real writer and feeds only the welcome screen's new-request target - it
must never feed the resolver.

The migration rebuilds the payload from the fields v2 knows rather than deleting
that one key, which is also the shape check: a hand-edited or half-written entry
degrades to defaults instead of handing a non-string id to the switcher. That
whitelist is where the next bump goes - zustand discards a payload whose
*stamped* version does not match when no `migrate` is supplied, which is the
same reason `tabs-store` carries one.

**`activeEnvironmentId` is a cache of engine state, not the source of truth.**
The engine owns which environment is active (`environments.is_active`, at most
one row, enforced in its DB layer). The store holds the same id so the
switcher, the resolver and every composed payload can read it synchronously,
and two pieces of wiring keep the two in step:

- `useSetActiveEnvironmentMutation` (`queries/environments.ts`) is the only
  writer. It PUTs `isActive` and updates the store optimistically, rolling the
  store back if the engine refuses - a selection the engine did not accept must
  not survive in the UI, or the next launch silently disagrees with this one. It
  invalidates the environments list rather than patching the response into it,
  because the *deactivated* row changed server-side without appearing in any
  response body.
- `useActiveEnvironmentRestore` (`hooks/`, mounted in `App.tsx`) reconciles on
  launch: adopt the engine's active environment if it has one, otherwise push a
  persisted id that names an environment that still exists - once per session,
  so a write the engine keeps rejecting is a failed write and not a request
  loop. Both directions wait on `isSuccess`; an unreachable engine returns an
  empty list that is indistinguishable from "no environments exist", and
  adopting from that would clear a good selection on every cold start.

It composes with `useActiveEnvironmentGuard` above rather than replacing it, and
is mounted after it: the guard answers "does this id still exist", this hook
answers "which id does the engine hold". Order matters only in the one case
where both would act - a dangling id should be dropped, not pushed back at the
engine as a selection.

Editing an environment's variables deliberately sends no `isActive`
(absent means "keep" on a PUT): echoing a cached value back would let a
variable edit re-activate an environment from a stale read, deactivating
whichever one the engine actually holds.

#### `engine-store.ts` - Engine Connection & Restart State

Merged store managing engine connection status and restart-required notifications (for config changes that need an engine restart).

**State:**
```typescript
{
  isEngineConnected: boolean
  engineError: string | null
  pendingRestart: boolean
  restartRequiredKeys: string[]  // Config keys requiring restart
}
```

**Key Methods:**
```typescript
const {
  isEngineConnected, setEngineConnected,
  engineError, setEngineError,
  pendingRestart, addRestartRequiredKey, clearRestartRequired,
} = useEngineStore();
```

`engineError` is what the failed health poll recorded (`queries/health.ts`), and
the Dock's connection indicator renders it in a tooltip when the engine is down -
"Disconnected" alone read the same for a refused connection, a timeout and a TLS
failure.

**Non-persisted** (cleared on app restart).

#### `save-store.ts` - Centralized Auto-Save

Orchestrates auto-save across the app with a registry of saveable contexts (e.g., request tabs, environment editors). Provides Ctrl/Cmd+S integration and unified save status.

**State:**
```typescript
{
  status: "idle" | "pending" | "saving" | "saved" | "error"
  activeContextId: string | null
  contexts: Map<string, SaveContext>  // Saveable entities
}
```

**`failSave` is the app's single failure seam.** It sets `status: "error"` *and*
raises an error toast carrying the reason. Its call sites are the collection
tree's create / delete / duplicate / rename, `useSaveManager`, `SettingsMain`,
`VariableTableEditor`, `useDraftSaveContext` and the context bar's
`VariablesSection` - and doing the reporting here rather than at each of them
means a new caller cannot forget to report. The last two were added because both
could fail in complete silence: the variables section fired three mutations with
no `onError` at all, and the
manual-draft editors rendered an inline callout that a quit flush has no screen
to show.

`VariablesSection` also **registers a context** (`context-bar-variables`),
because `failSave` alone only covers the failure. A variable commit is a plain
mutation rather than a draft, so it registers one entry for the whole section
whose
`hasPendingChanges` tracks whether any commit is outstanding and whose `save()`
resolves when the last one settles - without it `flushAll` had nothing to wait
for, and the renderer could be torn down mid-PUT with the input already showing
the value as committed.

**Only the context that set a status clears it.** `SettingsMain` used to run an
unconditional `setStatus("idle")` whenever it had nothing pending - which
included mount - so merely opening Settings wiped an `error` another context had
just published to the Dock. It now tracks whether the `pending` on screen is its
own and leaves anything else alone.

The same rule is why **`completeSaveThenIdle` is the only way to report a
success**: it sets `saved` and arms the return to `idle` behind two checks - that
the status is still the `saved` it set, and that no later save has re-armed the
reset since. A bare `completeSave()` followed by
`setTimeout(() => setStatus("idle"), …)` fires regardless of what happened in the
meantime, so a rename that succeeded two seconds ago cleared the failure a delete
had just published; and two saves a second apart had the first one's timer end
the second one's indicator early. `triggerSave` has always guarded the first way,
`useSaveManager` hand-rolled the second as a `clearTimeout` of its own timer.
Both live in the store now, and the six call sites (`useSaveManager`,
`SettingsMain`, `VariableTableEditor`, `VariablesSection`, both collection-tree
renames) share that one implementation rather than five copies of the timer.

`completeSave` is gone with them. It set `saved` and armed nothing, so every
caller either paired it with a hand-rolled timer or - `VariablesSection`, the one
non-draft commit path - left "Saved" in the Dock until something else happened to
change it. The indicator's lifetime is `TIMING.SAVED_STATUS_DURATION_MS`, in one
place, for every surface that saves.

There is no `errorMessage` field. The reason travels in the toast; the store
holds only the status the Dock renders. The field used to exist and its sole
reader was the Dock's error line, which the toast replaced.

There is no `lastSavedAt` or `pendingSaveId` either, for the same reason - every
match on either name was a write inside `save-store.ts`. `status` is the store's
whole public surface, and all five of its values now have a reader: the Dock
renders `pending` as **"Unsaved changes"**, which is the only place in the app
that says so. That matters because auto-save is a setting the user can turn off,
and with it off nothing was written back and nothing said as much (the tab strip
carries no unsaved-dot on purpose).

**`triggerSave` will not report a success the context did not have.** Registered
contexts report their own failures through `failSave` and then *resolve* rather
than rejecting - `useSaveManager`, `SettingsMain` and `VariableTableEditor` all
do - so `runSave` checks for `status === "error"` after awaiting instead of
setting `"saved"` unconditionally. Without that check a failed Cmd/Ctrl+S showed
"Saved" beside its own failure toast.

**SaveContext:**
```typescript
{
  id: string
  name: string
  save: () => Promise<void>
  hasPendingChanges: boolean
}
```

**Key Methods:**
```typescript
const {
  registerContext, unregisterContext, updateContext,
  setActiveContext, getActiveContext,
  triggerSave,       // Ctrl/Cmd+S - saves active or first dirty context
  flushAll           // Save all dirty contexts (used before app quit)
} = useSaveStore();
```

**Non-persisted**. See `useSaveManager` (autosave editors) and
`useDraftSaveContext` (manual save-button editors) for registration details.
Between them every dirty editor in the app is in this registry, which is what
`flushAll` walks on quit - a surface that is not registered is not merely
unsaved on quit, it is invisible.

#### `response-store.ts` - Response Cache

In-memory storage of responses per request ID, persisted across view/tab switches but not to disk.

**State:**
```typescript
{
  responses: Map<string, StoredResponse>
}
```

**StoredResponse:** Includes status, headers, body, execution time, script results, and console logs.

**Key Methods:**
```typescript
const { setResponse, getResponse, clearResponse, clearAll } = useResponseStore();
```

**Eviction:** `clearResponse` runs from `useDeleteRequestMutation` (the delete is
what makes the response unreachable) and from `tabs-store`'s
`closeTabsForEntities` (the collection cascade, which knows every descendant id).
Nothing else drops an entry, so a map with no eviction at all grew for the whole
session - each entry holds a body plus its raw copy.

**Non-persisted** (responses are reloadable from backend).

#### `client-settings-store.ts` - Renderer Preferences

Central home for renderer-only preferences that aren't part of the pre-paint appearance set (theme/color/UI-font/scale/radius live in their own localStorage keys so `index.html` can apply them before React mounts). Holds editor behavior, the monospace/code font, chart granularity, the capacity SLO threshold, the live refresh rate, auto-save preferences, reduced motion, the notification preferences and the load-test dialog's ceilings. Backs the Settings **panels** (`modules/settings/main/panels/`). Non-React consumers (services, the dashboard store) read via `getState()`.

**State:**
```typescript
{
  editor: EditorPrefs            // fontSize, wordWrap, minimap, lineNumbers, tabSize
  monoFont: MonoFontChoice       // a preset or "custom"
  monoFontCustom: string         // used when monoFont === "custom"
  chartBucketSeconds: number     // time-bucket width for the dashboard charts
  sloThresholdMs: number         // p99 latency the capacity breakpoint triggers at
  liveRefreshMs: number          // how often live metrics commit into the store
  autoSave: AutoSavePrefs        // { enabled, delayMs }
  reducedMotion: boolean         // mirrored onto <html data-reduced-motion>
  notifications: NotificationPrefs  // position, durationScale, maxVisible, minSeverity
  loadTestCeilings: LoadTestCeilings
}
```

```typescript
import { SETTINGS_STORAGE_KEYS } from "@/stores";  // localStorage keys reset by "Reset app settings"
```

`monoFont` and `reducedMotion` also touch the DOM (`--font-mono`,
`data-reduced-motion`), so their setters and `onRehydrateStorage` both apply
them - a preference that only lands on the next reload reads as a broken
setting.

`loadTestCeilings` is the one slice with a bound outside the app: each value is clamped to `LOAD_TEST_CEILING_BOUNDS` (`constants/load-test.ts`) on write **and** on rehydrate, because the bounds are the engine's crash guards and a build that tightens one must not keep offering a stored ceiling above it. The load dialog turns them into its field ranges via `resolveLoadTestLimits`; nothing else reads them.

**Persisted** to localStorage (via `zustand/persist`), `version: 1` with a
pass-through `migrate`; workspace/session state (open tabs, layout, active
environment) is deliberately excluded from the reset, as is the live chart
window - that one is engine config, so it resets with the engine's settings.

**Nested preferences are completed against their defaults on rehydrate**
(`mergeWithNestedDefaults`). zustand's merge is a shallow top-level spread, so a
stored `editor` / `autoSave` / `notifications` / `loadTestCeilings` object
replaces its defaults whole and a key added after that payload was written
arrives `undefined` - `notifications.maxVisible` feeds `slice(-maxVisible)` in
`toast-store`, and `slice(-undefined)` caps nothing. Adding an object-valued
preference means adding a line to that merge; the store's test enumerates them
rather than trusting the list.

#### `dashboard-store.ts` - Load Test Metrics & State

Manages live load test run state: streaming metrics, final reports, and running aggregates (peak concurrency, SLO breakpoint). Retention is **time-based, not a fixed point count**: `addMetricsBatch` trims ticks older than the user-configurable live window (`liveWindowSeconds`, default 5m, `null` = full run), backstopped by a `maxRetainedTicks` ceiling (default 50,000). Both are kept in sync by the `useLiveChartSettings` hook and drive what the live charts plot. (`app/src/config/metrics.ts` now only holds the SSE commit throttle, `METRICS_UI_THROTTLE_MS`.)

**The window is engine config, not a renderer preference.** It is stored as the engine's `liveReplayWindowMs` entry (milliseconds; `0` = full run), so `useLiveChartSettings` reads it from `useConfigQuery` and writes it with `useUpdateConfigMutation` - there is no localStorage key. The engine needs the same number: it sizes the in-memory SSE tick ring that `GET /runs/:runId/live` replays **from offset 0**, and that replay is what rebuilds these charts when the dashboard attaches or re-attaches mid-run. Two settings would let the retained span and the displayed span disagree, with the engine replaying less than the chart is configured to show. `constants/live-window.ts` owns the option list and the `liveWindowToMs` / `liveWindowFromMs` mapping.

The **tick ceiling** is shared the same way, as `liveMaxRetainedTicks` (default 50,000). It is a memory bound, not a rendering one - `bucketColumns` collapses ticks into `chartBucketSeconds` buckets (0.5s by default) before uPlot sees them, and uPlot draws to canvas, so a full window reaches the screen as a few thousand points however many ticks back it. It also costs nothing at stock settings, since the *window* is what sizes the retained history; it only binds when window / tick-interval exceeds it. `DEFAULT_MAX_RETAINED_TICKS` here and `DEFAULT_MAX_LIVE_TICKS` in the engine are the pre-config defaults and must move together.

Because the value arrives asynchronously, the store seeds `liveWindowSeconds` with the module default rather than reading it synchronously at creation; the hook corrects it once the config query resolves.

**State:**
```typescript
{
  currentRunId: string | null
  mode: "running" | "completed" | "stopped"
  isStreaming: boolean
  currentMetrics: LoadTestMetrics | null
  historicalMetrics: LoadTestMetrics[]  // Trimmed to liveWindowSeconds (cap: maxRetainedTicks)
  liveWindowSeconds: number | null             // Live retention window; null = full run
  finalReport: RunReport | null
  error: string | null
  activeView: "metrics" | "request-response"
  isStopping: boolean
  loadTestConfig: LoadTestRunConfig | null     // Config snapshot during run
  requestInfo: LoadTestRequestInfo | null      // Request snapshot during run
  peakConcurrency: number                      // Running max (monotonic)
  breakpoint: Breakpoint                       // SLO crossing (latched on first breach)
}
```

**Key Methods:**
```typescript
const {
  startRun, stopRun, setStreaming,
  addMetricsBatch,  // Efficiently fold batch into history and update aggregates
  setFinalReport, setError, setActiveView, setStopping,
  setLiveWindowSeconds,  // Update the live retention window (from useLiveChartSettings)
  setMaxRetainedTicks
} = useDashboardStore();
```

There is deliberately no store-wide `reset`: `startRun` already wipes the series,
the report and the aggregates, and a reset on top of it nulls `currentRunId` -
the dashboard then shows no active test while one streams.

**Non-persisted** (fresh per session).

#### `import-modal-store.ts` - Import Modal UI

Simple modal state for the collection import dialog.

**State:**
```typescript
{
  isOpen: boolean
}
```

**Key Methods:**
```typescript
const { isOpen, open, close } = useImportModalStore();
```

#### `toast-store.ts` - Transient Notifications

The queue behind the toasts. It holds *what* to show; the Radix primitive in
`components/ui/toast.tsx` owns *when* - the dismiss timer, pausing on hover,
focus and window blur, swipe, and the open/closed state the exit animation keys
off. There is no `setTimeout` in the store.

**State:**
```typescript
{
  toasts: Toast[]   // { id, title?, message, variant, action?, duration }
}
```

**Key Methods:**
```typescript
const { showToast, dismissToast } = useToastStore();

showToast("Run history cleared", "success");   // string form, still supported
showToast({                                     // returns the toast id
  message: "Couldn't stop the run",
  variant: "error",
  action: { label: "Try again", onClick: retry },
});
```

Variants are `info` | `success` | `warning` | `error`, with base durations of 4s
/ 4s / 6s / 10s from `TIMING.TOAST_DURATION_MS`. `warning` is for a refusal ("A
load test is already running") as distinct from a failure.

**Three of the policies are user preferences** (`notifications` on
`client-settings-store`, shapes in `constants/toast.ts`), applied here on the way
in:

- `minSeverity` - a floor, compared by `passesSeverityFloor`. Below it
  `showToast` returns an id and shows nothing.
- `durationScale` - a **multiplier** over the per-variant duration
  (`scaledDuration`), not a replacement for it, so halving keeps the ratio
  between a confirmation and a failure. `never` becomes `NEVER_DISMISS_MS`
  rather than `Infinity`, which the primitive's `setTimeout` would coerce to 1.
- `maxVisible` - the stack cap, defaulting to `MAX_TOASTS` (4); past it the
  oldest is dropped.

Two more policies live here because the primitive has no opinion on them: an
identical message and variant already on screen is **collapsed rather than
stacked**, and an explicit `duration` from the caller wins over the scale.
Removal is driven by
the primitive's `onOpenChange(false)`, which covers timeout, close button and
swipe alike, so there is one removal path rather than three - but it *closes*
the toast rather than dropping it, and the entry leaves the queue
`TIMING.TOAST_EXIT_MS` later so the exit animation has frames to run in.

**The values are not in the store.** Delays live in `config/timing.ts`
(`TOAST_DURATION_MS`, `TOAST_EXIT_MS`) with every other UI-facing delay in the
app, and the stack cap in `constants/toast.ts` (`MAX_TOASTS`). The store holds
behaviour, not configuration.

See `docs/design-system.md` -> Toasts for the visual tokens.

### Module-Local Stores

Module-local UI stores co-locate in `app/src/modules/<feature>/<feature>-store.ts` and manage feature-specific UI state that should not leak into the global store tree.

#### `modules/collections/collections-store.ts` - Collections Tree Expansion

UI-only: Which collections are expanded/collapsed in the tree.

**State:**
```typescript
{
  expandedCollectionIds: Set<string>
}
```

**Key Methods:**
```typescript
const {
  expandedCollectionIds,
  toggleCollectionExpanded, expandCollection, expandCollections
} = useCollectionsStore();
```

**Every action here has a caller, and expanding is idempotent.** `expandCollection`
(one id) and `expandCollections` (an ancestor chain) both return the *same* Set
when nothing changes, because it is passed down the whole tree and listed in
effect dependencies - a fresh Set for a no-op re-renders every row and re-runs
the reveal effect. That is why the tree calls them instead of hand-rolling
`if (!expanded.has(id)) toggle(id)`, which reads the set it writes and so drags
`expandedCollectionIds` into the dependencies of everything that expands.
`collapseCollection` and `reset` used to live here with no callers at all;
collapsing goes through `toggleCollectionExpanded`.

#### `modules/history/history-store.ts` - History Filter & Sort

UI-only: Search, filter (type/status), and sort (newest/oldest) for the history tab.

**State:**
```typescript
{
  searchQuery: string
  filterType: "all" | "load" | "design"
  filterStatus: "all" | "pending" | "running" | "completed" | "stopped" | "failed"
  sortBy: "newest" | "oldest"
}
```

**Helper:** `filterRuns(runs, filters)` applies **type/status filtering and
sorting** to the loaded pages. Search is **not** handled here: `searchQuery` is
debounced into the server-side `q` param (see `useRunsQuery`) so it covers all
runs, not just the pages loaded into the sidebar.

**Key Methods:**
```typescript
const {
  searchQuery, setSearchQuery,
  filterType, setFilterType,
  filterStatus, setFilterStatus,
  sortBy, setSortBy,
  resetFilters
} = useHistoryStore();
```

#### `modules/variables/variables-store.ts` - Variables Category Selection

UI-only: Which category (globals/collection/environment) is selected in the variables tree.

**State:**
```typescript
{
  selectedCategory: VariableCategory | null
  // VariableCategory = { type: "globals" } | { type: "collection"; collectionId }
  //                  | { type: "environment"; environmentId }
}
```

**Key Methods:**
```typescript
const { selectedCategory, setSelectedCategory, reset } = useVariablesStore();
```

#### `modules/settings/settings-store.ts` - Settings Category Selection

UI-only: Which settings category (e.g., "ui") is selected in the sidebar.

**State:**
```typescript
{
  selectedCategory: SettingsCategory | null
}
```

**Key Methods:**
```typescript
const { selectedCategory, setSelectedCategory } = useSettingsStore();
```

## TanStack Query (Server State)

TanStack Query manages server state with automatic caching, refetching, and synchronization. It is the source of truth for collections, requests, environments, globals, and runs.

### Query Hooks

Located in `app/src/queries/`, one file per resource family, all re-exported
from `app/src/queries/index.ts`, which is what callers import from. The key
factory lives beside them in `app/src/queries/keys.ts`. A couple of hooks with a
single consumer are imported from their file directly (`useRunTimeSeriesQuery`
from `@/queries/runs`); everything with more than one is in the barrel.

#### Collections & Requests

- **`useCollectionsQuery()`** - Fetch all collections (there is no
  single-collection query: a collection is read out of this list)
- **`useRequestsQuery(collectionId)`** - Fetch requests in a collection
- **`useMultipleCollectionRequests(collectionIds)`** - The same list for several
  collections at once, as parallel queries. Its `requestsByCollection` map is
  **referentially stable** while the underlying results are unchanged (built in
  `useQueries`' `combine`, which TanStack memoises only for a `combine` of
  stable identity - hence the `useCallback`). Callers list it in effect
  dependencies; when it was rebuilt on every call, the collection tree's reveal
  effect (`useRevealActiveSelection`) re-ran on every render and re-expanded a
  collection the user had just collapsed
- **`useRequestQuery(requestId)`** / **`requestDetailOptions(requestId)`** - One
  request by id (`GET /requests/:id`), used by a restored request tab and by a
  design-run copy on cold start. Only an `ApiError` with `statusCode === 404`
  becomes **`RequestNotFoundError`** (test it with `isRequestNotFound`); a 5xx or
  an unreachable engine is rethrown untouched, because a transport failure must
  not read as "this request was deleted"
- **`useCollectionAncestors(collectionId)`** - The collection's ancestor chain
  including itself, root first, derived from the collections list rather than
  fetched
- **`usePrefetchCollectionsAndRequests()`** - Warm-cache pass over every
  collection's requests at startup

**Sorting:** every tree list - roots, a collection's children, a collection's
requests - sorts with the single exported `compareTreeOrder` (`types/domain.ts`):
`order`, then `createdAt`, then `id` byte-wise. There were two comparators with
two different tie rules and neither matched the engine's, so "run this folder"
could execute in an order the sidebar had never shown. The rule is pinned to the
engine's SQL by `engine/tests/fixtures/tree-order-conformance.json`, read by
`types/tree-order.conformance.test.ts` and by the engine's `tree_order_test.cpp`
- change one side and the other suite fails.

**Mutations:**
- **`useCreateCollectionMutation()`** - Create collection
- **`useUpdateCollectionMutation()`** - Update collection (with cache update)
- **`useDeleteCollectionMutation()`** - Delete collection (invalidates coarsely,
  see below)
- **`useCreateRequestMutation()`** - Create request
- **`useUpdateRequestMutation()`** - Update request (invalidates only the lists
  that can have changed, see below)
- **`useDeleteRequestMutation()`** - Delete request (also clears the response)
- **`useReorderMutation()`** - Reposition collections and requests through
  `POST /reorder` in one transaction, optimistically (see below)
- **`useImportMutation()`** (`queries/import.ts`) - Apply a parsed import through
  `POST /import/apply` in one transaction

**Reordering (`useReorderMutation`)** is the one mutation that writes its caches
three times, because a drag is only believable if the row is where the pointer
left it before the write returns:

- `onMutate` snapshots every key the plan can touch and *draws the plan* into the
  caches - the same two steps the engine performs, normalize each named scope to
  `0..n-1` in display order, then position each move. A cross-collection move
  crosses list caches and updates `requests.detail` (which carries
  `staleTime: Infinity`, so a stale `collectionId` there would outlive every
  refetch).
- `onSuccess` re-applies the rows the engine actually wrote, which the response
  carries. They are normally what was drawn, but a normalization is authoritative
  from the engine, so the tree settles on real positions rather than a guess.
- `onError` restores the snapshots wholesale and reports through
  `useSaveStore.failSave` - the one channel every save failure reaches the Dock
  and the toast through. The mutation owns this rather than its caller, so the
  gesture layer cannot forget it.
- `onSettled` invalidates the affected keys **once** - the collections list only
  if a collection moved, and only the request lists the plan named.

Every write goes through `setQueryData` with a fresh array, never a mutation in
place: the map `useMultipleCollectionRequests` builds is compared by reference by
the reveal effect, so an in-place edit would move a row on screen that the tree
never notices. The plan itself comes from
`modules/collections/reorder-math.ts` - a pure module, node-tested, that turns
sibling lists and a drop index into the minimal set of rows to rewrite.

#### Environments & Variables

- **`useEnvironmentsQuery()`** - Fetch all environments
- **`useGlobalsQuery()`** - Fetch global variables
- **`useCookiesQuery()`** / **`useClearCookiesMutation()`** (`queries/cookies.ts`) -
  The engine's cookie jars, one per environment, read and cleared by
  `CookiesCard` in Settings. The mutation invalidates rather than patching the
  cache: a clear that raced a request in flight would otherwise leave the panel
  claiming an empty jar the engine has already refilled

**Mutations:**
- **`useCreateEnvironmentMutation()`**
- **`useUpdateEnvironmentMutation()`**
- **`useSetActiveEnvironmentMutation()`** - The only writer of the active
  environment; PUTs `isActive` and mirrors it into `session-store`, rolling the
  store back if the engine refuses
- **`useDeleteEnvironmentMutation()`**
- **`useUpdateGlobalsMutation()`**

#### Runs & History

- **`useRunsQuery(q?)`** - Run history as an **infinite query** over the
  paginated `GET /runs` `{data, pagination}` envelope, newest first. Mirrors
  `useRunTimeSeriesQuery`'s `getNextPageParam` on the same envelope shape;
  `fetchNextPage` pages older runs in on demand. `q` is the optional
  server-side search.
  - **Polling is gated to the unpaged state** (`runsPollInterval`): 5s while
    only page 1 is loaded, **off** once the user has paged older runs in.
    Refetching an infinite query re-fetches *every* loaded page in sequence, so
    a user ten pages deep drove ~10 engine requests per tick. Only page 1 can
    gain rows (`start_time DESC`) anyway; a paged list refreshes on the next
    mutation or invalidation instead of on a timer.
  - **`flattenRunPages(data)`** - flatten the pages into a de-duped `Run[]`
    (dedupe by id guards the momentary double-row a head insertion can cause
    across two refetched pages). **`runsTotal(data)`** - the server's total from
    the first page.
- **`useAllRunsQuery()`** - Every run (all pages) as a flat list, for callers
  that need the whole set rather than a polled page (Settings' count + clear).
  Not polled.
- **`useLastDesignRunQuery(requestId)`** - The most recent completed design run
  for a request, in **one** filtered call
  (`?requestId=&type=design&status=completed&limit=1`) - the server sorts
  `start_time DESC`, so its single row is the answer. No client-side
  download-and-filter. It caches a **plain `RunListResponse`**, so it has its
  own key family (`queryKeys.runs.lastDesign(requestId)`) and deliberately does
  **not** sit under `runs.lists()`: `RequestBuilderProvider` mounts it for every
  open request tab, and the delete-run patch walks that prefix as
  `InfiniteData`. Keeping the two shapes apart at the root is the rule - a
  prefix patch must never meet a cache shape it did not write.
- **`useRunQuery(runId)`** / **`runDetailOptions(runId)`** - Fetch a single run
  (full `configSnapshot`). Same 404 contract as `requestDetailOptions`: only an
  `ApiError` with `statusCode === 404` becomes **`RunNotFoundError`** (test it
  with `isRunNotFound`, never by message), and that error is **never retried** -
  a run tab is persisted and outlives its run, so a deleted run used to retry
  forever behind a "Try again" that could not work. Everything else - a 5xx, an
  unreachable engine - is rethrown untouched and keeps the default retry budget.
  `HistoryDetail` renders the two cases differently: "this run no longer exists"
  with **Close tab**, versus "couldn't load this run" with **Try again**.
- **`useRunReportQuery(runId)`** - Fetch final report for a run. Also written by
  `LoadTestService` at stream end via `queryClient.fetchQuery`, so opening the
  run in History reads the cached copy rather than re-fetching a report that
  cannot change.

- **`useRunTimeSeriesQuery(runId)`** (`@/queries/runs`) - The stored per-tick
  series behind the History charts, as an infinite query over the same
  `{data, pagination}` envelope. Historical data cannot change, so
  `staleTime: Infinity`.

**Mutations:**
- **Stopping a run is not a mutation hook.** It is
  `useEngine().stopLoadTest(runId)`, which calls `apiService.stopRun` and
  returns a boolean rather than throwing - the dashboard's Stop button reports
  the refusal itself.
- **`useDeleteRunMutation()`** - Delete a run. Patches every infinite-list cache
  variant in place (drops the row, decrements the mirrored `total`) plus the
  all-runs cache, and evicts the run's report. The list updater shape-guards
  (`!Array.isArray(old.pages)`) as a belt to `lastDesign`'s braces.

**Deleting a run closes its tabs.** Both delete flows - `HistoryList`'s row
delete and Settings' *Clear run history* - call
`closeTabsForEntities(ids, "run")` for the runs the engine actually accepted (a
409'd run keeps its tab, because the run is still there). Tabs are persisted, so
a run tab left open after its run is gone is not merely stale: it rehydrates
into a pane that can never load on every restart.

#### Engine Health, Config & OAuth

- **`useHealthQuery()`** - Health check, polled every
  `TIMING.HEALTH_CHECK_INTERVAL_MS`; it is what sets `isEngineConnected` /
  `engineError` on `engine-store`, so the connection indicator follows it
- **`useConfigQuery()`** / **`useUpdateConfigMutation()`** - Engine configuration
  (`QUERY_CACHE.CONFIG_STALE_TIME_MS`); also the home of the live chart window,
  which is engine config rather than a renderer preference
- **`useScriptCompletionsQuery()`** / **`useScriptTypeDefinitionsQuery()`** - the
  `pm.*` completion list and the engine-generated `.d.ts` behind Monaco's hover
  text and diagnostics. Both derive from one engine-side table that changes only
  with the engine binary, so both take
  `QUERY_CACHE.SCRIPT_COMPLETIONS_STALE_TIME_MS` and the same gc time; the type
  definitions also cap retries at `SCRIPT_COMPLETIONS_RETRY`, since losing them
  costs hover text rather than the editor
- **`useOAuth2TokenStatusQuery(cacheKey)`**,
  **`useFetchOAuth2TokenMutation()`**, **`useClearOAuth2TokenMutation()`** - the
  engine-side OAuth 2.0 token cache
- **`queryKeys.compose.forRequest(requestId, environmentId)`** - `POST /compose`
  for a stored request, behind an inline `useQuery` in the context bar's Code
  section. Keyed by environment as well as request, because the same request
  composes differently per environment and one key for both would serve the
  wrong snippet after a switch. `staleTime: Infinity` with an explicit
  recompose: the section is only mounted while expanded, so this is the "compose
  on expand, not per keystroke" rule

### Query Keys & Cache Invalidation

Centralized in `app/src/queries/keys.ts`, using TanStack Query's hierarchical key
factory pattern. **Copy the shapes from that file rather than hand-writing a
key** - a key that differs by one segment is not an error, it is a silent cache
miss that presents as a data bug:

```typescript
// app/src/queries/keys.ts (abridged)
collections: {
  all: ["collections"],                                   // a constant, not a call
  lists: () => ["collections", "list"],
  list: () => ["collections", "list"],
  details: () => ["collections", "detail"],
  detail: (id) => ["collections", "detail", id],
},
requests: {
  all: ["requests"],
  lists: () => ["requests", "list"],
  listByCollection: (collectionId) => ["requests", "list", { collectionId }],
  details: () => ["requests", "detail"],
  detail: (id) => ["requests", "detail", id],
},
runs: {
  all: ["runs"],
  lists: () => ["runs", "list"],
  list: (filters = {}) => ["runs", "list", filters],      // keyed by its server-side filters (q)
  lastDesign: (requestId) => ["runs", "lastDesign", requestId],
  allRuns: () => ["runs", "allRuns"],
  detail: (id) => ["runs", "detail", id],
  report: (id) => ["runs", "report", id],
  timeSeries: (id) => ["runs", "timeSeries", id],
  samples: (id) => ["runs", "samples", id],               // captured response bodies, fetched lazily
},
// environments mirrors collections; globals / cookies / health / config /
// scriptCompletions / scriptTypes / oauth / prefetch each own a root.
```

The `lists()` / `details()` levels exist to be invalidated as prefixes; what a
query is keyed on is `list()` / `detail(id)`. `runs.lastDesign` sits under
`runs.all` but deliberately **not** under `runs.lists()` - see below.

**Automatic Invalidation:**
- Mutations automatically invalidate related queries (e.g., creating a request invalidates the collection's request list)
- Some mutations use optimistic updates and cache updates for instant UI feedback
- **A cascade delete invalidates coarsely, on purpose.** Deleting a collection
  deletes its descendant collections and all their requests *engine-side*, and
  which rows those are is engine-side knowledge - a client that re-derives the
  subtree to patch caches surgically will drift from the engine's definition of
  "descendant". So `useDeleteCollectionMutation` invalidates
  `collections.all` + `requests.all` wholesale. `requests.detail` entries carry
  `staleTime: Infinity`, so without this a deleted request stays fresh forever
  and keeps feeding restored tabs.
- **A single-request update invalidates narrowly, for the same reason.** Which
  lists a request write can affect *is* client-side knowledge: the request's own
  collection, plus the one it left if the write was a move. So
  `useUpdateRequestMutation` invalidates `requests.listByCollection(id)` per
  affected collection rather than `requests.lists()`. It used to refetch every
  collection's list on any rename, which a reorder (a run of sibling PUTs) turns
  into one full-tree refetch per row. The source collection of a move is read
  from the `requests.detail` cache, which still holds the pre-update row at that
  point - the response carries only the new owner.
- **The warm-cache prefetch is a query too.** `usePrefetchCollectionsAndRequests`
  is keyed as `queryKeys.prefetch.allRequests()` rather than an inline key, so
  creating a collection can invalidate it - it succeeds once at startup and
  would otherwise never re-run for a collection created mid-session.

**Writes from outside the renderer: `mcp:data-changed`.** An MCP tool call
mutates the engine from the Electron **main** process, so no mutation runs here
and no query notices - and with `refetchOnWindowFocus: false` (below) nothing
ever catches up on its own. A request an agent created stayed invisible in the
collection tree until some unrelated renderer mutation happened to invalidate
the lists. The main process now sends one event per data family a successful
call touched; `useMcpDataInvalidation()` (registered once, in `App.tsx`) maps it
to keys through `lib/mcp-invalidation.ts`:

| Entity | Invalidates | Why that key |
|--------|-------------|--------------|
| `request` | `requests.listByCollection(collectionId)`, or `requests.lists()` when the call named no collection | The same narrowing `useUpdateRequestMutation` does; without a named owner the owner is unknowable here |
| `environment` | `environments.all`, `compose.all` | Variables are read through the detail cache as well as the list; `POST /compose` substitutes those same variables, and nothing refetches a composition on its own |
| `run` | `runs.lists()`, `runs.allRuns()`, plus `runs.lastDesign(requestId)` when the call named one | The history list polls, but Settings' count and a request tab's restored response do not |
| `cookie` | `cookies.all` | One key for every jar - the engine reports them together |
| `config` | `config.all` | |

The event carries no engine data, only which family went stale, so a row still
reaches the UI by exactly one path: the query layer. Per-run reports and time
series are deliberately left alone - a new run cannot have changed an existing
run's report. The entity list is duplicated across the process boundary
(`MCP_DATA_ENTITIES` in `electron/mcp/tools.ts`, `McpDataEntity` in
`types/domain.ts`) because production code under `electron/` cannot import from
`app/src`; `data-changed.conformance.test.ts` is what keeps the copies equal,
and the map above is a `Record` over the union so a new family fails to compile
until it names a reader. The emitting side is documented in
[`docs/engine/mcp.md`](../engine/mcp.md).

**Retry policy:** the shared default is `shouldRetryQuery` (`lib/query-client.ts`),
not a bare count. A 4xx from the engine is a verdict, not a hiccup - a 404 for a
deleted row answers identically every time, so retrying it only delays the error
the caller is waiting on. 4xx is never retried; everything else (5xx, timeout,
unreachable engine - which `http-client.ts` throws as a plain `Error`, not an
`ApiError`) keeps the `DEFAULT_QUERY_RETRY` budget.

**Cache policy lives in `config/cache.ts` (`QUERY_CACHE`), not in the call
sites.** Name the constant when you need a duration; restating the number here
is how this section drifted before. The current shape:

| Query | Policy |
|-------|--------|
| Collections, requests lists, environments, globals, runs list | `DEFAULT_STALE_TIME_MS` (30s) via the shared client |
| Request detail (`requestDetailOptions`) | `staleTime: Infinity` - a restored tab reads it once and mutations invalidate it |
| Run detail, run report | `RUNS_STALE_TIME_MS` (5m); completed runs are immutable |
| Run time series | `staleTime: Infinity`, `RUNS_GC_TIME_MS` (30m) |
| Engine config | `CONFIG_STALE_TIME_MS` (1m) |
| Script completions | `SCRIPT_COMPLETIONS_STALE_TIME_MS` (1h), same gc time |
| Health | `staleTime: 0`, refetched every `TIMING.HEALTH_CHECK_INTERVAL_MS` (30s) |

Polling intervals are separate from staleness: the runs list polls every 5s
**only while unpaged** (`runsPollInterval`), health polls on
`TIMING.HEALTH_CHECK_INTERVAL_MS`, and the shared client sets
`refetchOnWindowFocus: false` - a desktop app that refetched everything on focus
would fight the editor the user just came back to.

## Custom Hooks

### `useEngine()` - Compose, Execute, Stop

Wraps the three engine calls that are not queries, with `isExecuting` / `error`
for the caller to render.

**API:**
```typescript
const {
  composeRequest: (params: ComposeRequestRequest) => Promise<ComposedRequest>
  executeRequest: (params: ExecuteRequestRequest, environmentId?: string) => Promise<SanityResult | null>
  stopLoadTest: (runId: string) => Promise<boolean>
  isExecuting: boolean
  error: string | null
} = useEngine();
```

- **`composeRequest`** is `POST /compose` - the engine resolves `{{variables}}`
  and `inherit` auth and hands back the execute-ready payload (issue #226). It
  **throws** on failure; the caller surfaces it like an execute failure.
- **`executeRequest`** takes an *already composed* payload. It never throws:
  a failure comes back as a `SanityResult` with `status: 0` and an
  `errorCode`, because the response pane renders the failure the same way it
  renders a response.
- **`stopLoadTest`** returns `false` rather than throwing when the engine
  refuses.
- **Starting a load test is not here.** The request builder composes, then calls
  `apiService.startLoadTest()` (`POST /runs`), `useDashboardStore().startRun()`
  and `loadTestService.startMonitoring()` in that order, at one call site -
  registering the run before attaching the stream is what keeps the dashboard
  from showing a stream with no run behind it.

### Live Metrics Streaming - `loadTestService` + `sseClient`

There is **no React hook for the metrics stream**, on purpose. The stream has to
outlive whichever view is mounted (navigate away from the dashboard mid-run and
the run keeps streaming), so it is a module singleton:
`services/load-test-service.ts` holds the state machine and
`services/sse-client.ts` the `EventSource`.

```typescript
import { loadTestService } from "@/services/load-test-service";

loadTestService.startMonitoring(runId);  // after useDashboardStore().startRun(...)
loadTestService.stopMonitoring();
```

- Connects to `GET /runs/:runId/live`, a **replayable** tick topic read from
  offset 0 - so attaching, or re-attaching from History mid-run, rebuilds the
  charts rather than starting blank.
- Every tick is buffered; commits into `useDashboardStore().addMetricsBatch()`
  are throttled to `METRICS_UI_THROTTLE_MS` so `historicalMetrics` keeps the
  full 10 Hz signal while renders stay bounded.
- The engine sends an explicit `complete` event, so a `CLOSED` readyState is a
  genuine failure. **There is no custom reconnect**: `EventSource` cannot set
  `Last-Event-ID` on a fresh connection, so a manual reconnect would replay the
  whole topic and duplicate every tick already plotted. The browser's own
  intra-connection retry does carry it and is left alone; once the browser gives
  up, recovery is converging on `GET /runs/:id/report`, which the service does in
  its close handler.

### `useVariableResolver()` - Variable Resolution

Resolves `{{variableName}}` patterns in strings and objects using environment, collection, and global variables.

**API:**
```typescript
const {
  resolveString: (input: string) => string
  resolveObject: <T>(obj: T) => T
  getVariable: (name: string) => ResolvedVariable | null
  getAllVariables: () => Record<string, ResolvedVariable>
  getVariableOrigins: (name: string) => VariableOrigin[]
} = useVariableResolver({ collectionId?: string });
```

**Resolution Priority (highest to lowest):**
1. Environment variables
2. Collection variables
3. Global variables

Collection scope comes from the `collectionId` option and nowhere else - a
caller that passes none resolves against globals + environment. See
`docs/app/variable-resolution.md` for why the session-store fallback was
removed.

**`collectionId` is the only option.** The environment is *not* passed in: the
hook reads `useSessionStore().activeEnvironmentId` itself, so every caller
resolves against the environment the user has actually selected and no caller
can scope a preview to a different one. This page documented an
`environmentId` option for a while; nothing has ever accepted one. The two
scopes are asymmetric on purpose - the active environment is app-wide state,
while the collection is a property of whatever the caller is rendering.

`ResolvedVariable` carries `sourceId` / `sourceName` - the specific environment
or collection the winning value came from (absent for `global`).

`getVariableOrigins` returns **every** definition of a name, lowest precedence
first, including disabled ones that never resolve. Display-only; the variable
popover renders it as "also defined". See `docs/app/variable-resolution.md` for
why the losers are kept and why the MCP copy is not given the same accessor.

### `RequestBuilderContext` - variable members

The request builder re-exposes the resolver plus two things only it can derive:

```typescript
getVariableOrigins: (name: string) => VariableOrigin[]
updateVariable: (name: string, value: string, scope: VariableScope) => void
writableScopes: VariableScope[]
```

`writableScopes` lists the scopes `updateVariable` would actually write to.
Each of its branches opens with a guard (`if (!activeEnvironmentId) return`), so
a write to a scope with no active target is a **silent no-op** - the variable
popover uses this list so its "create in" picker cannot offer one.

A write through `updateVariable` always sets `enabled: true`. Setting a value
means "make this value apply"; enabling and disabling belongs to the variables
editor. Without it, creating a value for a name that was disabled everywhere
preserved `enabled: false` and the token stayed unresolved.

**Usage:**
```typescript
const { resolveString } = useVariableResolver({ collectionId });
const resolvedUrl = resolveString("https://{{baseUrl}}/api/users");
```

### `RequestBuilderContext` - body drafts

```typescript
bodyDrafts: React.MutableRefObject<BodyDrafts>
```

What the body modes you are not looking at were holding. A request stores
**one** body - the shape is a discriminated union, `{"mode":"json","content":
"..."}` - so JSON, text and GraphQL share `request.body`, and switching mode
handed the same string to a different reader. Switching from JSON to GraphQL
therefore read the payload as a raw query string and destroyed it.

Two buckets, not six: `json` and `text` are one raw string differing only in
highlighting, so text carries between them deliberately; `graphql` is an
envelope and keeps its own; the two form modes use `formData` / `urlEncoded`
and never touch `body`. The rule lives in
`modules/request-builder/utils/body-drafts.ts`.

Two things about it are deliberate and easy to undo by accident:

- **It lives in the provider, not in `BodyPanel`.** Radix unmounts an inactive
  `TabsContent`, so a panel-local ref is discarded the moment you glance at the
  Headers tab, taking the stashed body with it.
- **The provider does *not* reset it** on a request change. The drafts carry
  their own `requestId` and `switchBody` drops any belonging to another
  request, so a second reset would duplicate that rule - and would fire on the
  request-change effect, which re-runs on more than the id.

Deliberately **not** persisted: a request has one body, and storing payloads it
will never send would put them in exports and in the engine's schema.

### `RequestBuilderContext` - the added Content-Type row

```typescript
getAutoContentType: () => AutoContentType | null
setAutoContentType: (auto: AutoContentType | null) => void
```

Which `Content-Type` row a body mode added on its way in, so that leaving the
mode can take it back. GraphQL is sent as a JSON envelope and genuinely needs
`Content-Type: application/json`, so `BodyPanel` appends one - but nothing
removed it, so a single visit to GraphQL left the header on the request for
good, including after switching back to `none`, which sends no body at all.

The record is `{ requestId, rowId, value }` and the rule that reads it is
`switchContentType` in
`modules/request-builder/components/RequestTabs/panels/body/content-type.ts`,
called once per mode change: it removes the remembered row when the new mode
does not need that same header, then adds whatever the new mode does need.

Three things it is deliberate about:

- **By row id, not by value.** A `Content-Type` the user typed and the row the
  panel wrote are identical apart from their id, and only ours may be removed.
- **A row whose value has been edited is no longer ours** - retyping it is a
  decision, so it stays and the record is dropped. Merely disabling it is not.
- **A record naming another request is dropped, not applied.** One provider
  serves every request tab, and row ids are not unique across a duplicated
  request.

In the provider rather than in `BodyPanel` for the drafts' reason and one of its
own: Radix unmounts an inactive `TabsContent`, so a panel-local record is gone
by the next mode change - and then nothing removes the header, which is the bug
the record exists to fix. Ephemeral, like the drafts: what is persisted is the
header row itself, in `request.headers`.

### `useSaveManager()` - Auto-Save Manager

Orchestrates auto-save for a saveable entity (request, environment, etc.) with debouncing, context registration, and centralized save state tracking. Located in `app/src/hooks/useSaveManager.ts`.

**API:**
```typescript
const {
  forceSave: () => Promise<void>
  status: "idle" | "pending" | "saving" | "saved" | "error"
  isSaving: boolean
} = useSaveManager({
  entityId: string | null           // Unique ID for this entity
  contextName?: string              // Display name (e.g., "Request: GET /api")
  onSave: () => Promise<void>       // Function to persist changes
  hasChanges: boolean               // Whether unsaved changes exist
  enabled?: boolean                 // Disable auto-save (default: true)
});
```

**Features:**
- **Debounced auto-save:** Triggers after the delay the user chose in Settings → General, defaulting to 5000ms (`autoSave.delayMs` in `client-settings-store`, options in `constants/client-settings.ts`)
- **Context registration:** Automatically registers with `useSaveStore()` for app-wide Ctrl/Cmd+S integration and tab LRU coordination
- **Save status:** Updates centralized save store so UI can show "Saving..." or "Saved" indicators
- **Entity switching:** Flushes pending saves when entity ID changes (in cleanup, before unmounting)
- **Saves are queued, never skipped:** a caller arriving while another save is in
  flight waits behind it and gets its own write, so its promise resolves only
  once *its* edits are persisted. Skipping (the old behaviour) meant Cmd/Ctrl+S,
  the quit flush and the entity-switch flush all reported "saved" for edits that
  were never in the flying snapshot - and the switch then reset the provider,
  making them unrecoverable. `performSave` binds `onSaveRef.current` at call
  time rather than when the queue reaches it, so a save queued by the
  entity-switch cleanup still writes the entity being left
- **No `debounceMs` parameter:** the delay is a user preference, not a per-caller
  one, so the hook reads it from the store rather than taking it as an option.
  Turning auto-save off in Settings leaves the entity marked dirty - Ctrl/Cmd+S
  still saves it - but schedules nothing.

`app/src/config/timing.ts` used to carry an `AUTO_SAVE_DELAY_MS: 3000` that
nothing read and that this section documented as the source of truth. It is
deleted; `timing-keys-have-readers.test.ts` now fails on any TIMING key without
a reader, and `useSaveManager.autosave-setting.test.tsx` pins the Settings value
to the timer that actually runs.

**Usage:**
```typescript
const { forceSave, status, isSaving } = useSaveManager({
  entityId: requestId,
  contextName: `Request: ${request.method} ${request.url}`,
  onSave: () => apiService.updateRequest(requestId, changes),
  hasChanges: JSON.stringify(draft) !== JSON.stringify(saved),
  enabled: true
});
```

### `useEntityDraft()` - Manual Draft/Save Model

The other save model, and the counterpart to `useSaveManager()`: an editable draft, a Save button gated on `isDirty`, and a Reset that discards it. Located in `app/src/hooks/useEntityDraft.ts`. Used by all three editing tabs of `CollectionDetail` (`AuthTab`, `InfoTab`, `ScriptTab`), where a save is a deliberate button press rather than a keystroke that persists itself.

**API:**
```typescript
const {
  draft: T                                 // The editable copy
  setDraft: Dispatch<SetStateAction<T>>    // Standard setState signature
  isDirty: boolean                         // Draft differs from the persisted value
  reset: () => void                        // Discard the draft
} = useEntityDraft<T>({
  entityKey: string                        // Identity of the thing being edited
  value: T                                 // The persisted value
  mutation: { reset: () => void }          // The save mutation this editor reports through
});
```

**Behaviour:**
- **Seeds and resyncs:** the draft follows `value` when it changes - a save landing, a background refetch. In `InfoTab` this is what clears the post-trim divergence, since the tab persists `name.trim()`.
- **Tracks by JSON value, not identity:** `value` may be a fresh object literal every render (`InfoTab` builds `{ name, description }` inline); callers do not have to memoize it.
- **`entityKey` is a switch, not an edit:** a change reseeds the draft *and* calls `mutation.reset()`. These editors render without a React `key`, so a different entity arrives via props on the same instance, and a TanStack mutation holds `isError` until the next `mutate` - without the reset, a failed save is reported against an entity the user never tried to save. `ScriptTab` passes `${collection.id}:${fieldKey}`, since pre- and post-request scripts are two different things to edit under one collection id.
- **Requiring the mutation is the point:** the three hand-rolled copies this replaced had drifted, and the one that omitted the reset had exactly that bug.

**Usage:**
```typescript
const { draft, setDraft, isDirty, reset } = useEntityDraft({
  entityKey: collection.id,
  value: collection.auth,
  mutation: updateCollection,
});
```

**The draft lives in component state, so its panel must not unmount.** Radix
unmounts an inactive `TabsContent`; `CollectionDetail` therefore force-mounts the
four draft-holding tabs (Info, Auth, Pre-request, Post-request) from their first
visit onwards, so an intra-collection tab switch stops discarding the draft.
This is the same call, for the same reason, as the request builder's body drafts
living in `RequestBuilderProvider` rather than in `BodyPanel` (see
`request-builder/utils/body-drafts.ts`). The Variables tab is deliberately not
force-mounted: it autosaves and claims the store's active context on mount, so
keeping it alive behind another tab would point Ctrl/Cmd+S at the wrong editor.

A *collection* switch still reseeds and discards, deliberately - it is the
hook's documented behaviour above, and pinned by `useEntityDraft.test.ts`.

### `useDraftSaveContext()` - Registering a Manual Draft

The counterpart to `useSaveManager`'s registration half, for editors using the
`useEntityDraft` model. Located in `app/src/hooks/useDraftSaveContext.ts`. Used
by `InfoTab`, `AuthTab` and `ScriptTab`.

```typescript
useDraftSaveContext({
  id: `collection-${collection.id}-auth`,  // Unique per editor
  name: `Collection auth: ${collection.name}`,
  isDirty,                                 // From useEntityDraft
  isActive: active,                        // Is this the tab on screen?
  save: persist,                           // Rejecting is how failure is reported
});
```

**Behaviour:**
- **Registration only.** It schedules nothing; the Save button stays the primary
  affordance. The defect it fixes is that the *other* ways to save - Ctrl/Cmd+S,
  the quit flush, tab eviction - could not reach these editors at all, because
  none of the three tabs ever called `registerContext`.
- **`isActive` decides who owns Ctrl/Cmd+S.** `triggerSave` prefers the active
  context, and these editors stay mounted while hidden, so without it the last
  sibling to mount would answer for the panel on screen.
- **A failure toasts rather than resolving quietly.** The editors render an
  inline `SaveFailed` callout for a button press, but a quit flush has no callout
  on screen, and `runSave` reads a resolved promise as success - swallowing here
  would report "Saved" for a write that failed.
- **The save must carry its own validity guard.** A disabled button does not stop
  the store-driven paths, which is why `InfoTab` refuses a blank collection name
  inside `persist` and not only on the button.

## State Flow Examples

### Executing a Single Request

1. User clicks "Send" button in request builder
2. `useEngine().executeRequest()` is called with request and (optionally) environment ID
3. `useVariableResolver()` resolves any `{{variables}}` in the request URL, headers, body
4. Request is transformed (frontend → backend format) and sent via HTTP
5. Response is stored in `useResponseStore()` keyed by request ID
6. Response viewer component reads the response and displays it
7. On **request tab switch**, the response persists in `response-store` and is displayed if the user returns
8. If any script ran, the environment / globals / collection query families are invalidated so values the script wrote are visible in the variables editor and the resolver. The gate is `scriptsMayWriteVariables(pre, post)` (`request-builder/utils/execute-mapping.ts`), shared by the builder's send path and the History run view's resend. **Both** script kinds count: `pm.environment.set` and friends persist engine-side from a Tests-tab script exactly as from a pre-request one, and with `refetchOnWindowFocus: false` nothing else is coming to correct a stale value

### Starting a Load Test Run

1. User configures load test in the dashboard modal (duration, concurrency, etc.)
2. The request half is composed engine-side (`useEngine().composeRequest()`), then `apiService.startLoadTest()` sends the composed payload plus the load config to `POST /runs`
3. Engine responds with `runId`
4. `useDashboardStore().startRun(runId, config, requestInfo, requestId)` initializes dashboard state
5. `loadTestService.startMonitoring(runId)` connects to `/runs/:runId/live`
6. As metrics stream in, `addMetricsBatch()` folds them into historical metrics (trimmed to `liveWindowSeconds`, backstopped by `maxRetainedTicks`) and updates running aggregates (peak concurrency, SLO breakpoint)
7. Dashboard view shows live metrics, request/response (from the SSE stream's final response), and aggregates
8. When the run completes, the engine sends a `complete` event
9. `LoadTestService.handleClose()` fetches the final report through the query cache (under `queryKeys.runs.report(runId)`, so History reuses it) and stores it in `dashboard-store.finalReport` - **only if the dashboard is still showing that run**. The store is re-read after the await: finishing run A and immediately starting run B otherwise landed A's report on B's dashboard, flipping a running test to "completed" with A's percentiles.
10. Dashboard switches to "completed" mode showing the final report; the runs lists are invalidated so the terminal status lands without waiting for a poll

### Saving a Request with Auto-Save

1. User opens or creates a request tab via `useTabsStore().openTab()`
2. Component mounts `useSaveManager()` with the request ID and save callback
3. Hook registers the context with `useSaveStore()` for Ctrl/Cmd+S integration
4. User edits the request (URL, headers, body, etc.)
5. `hasChanges` is marked true, triggering the debounce timer - `autoSave.delayMs` from `client-settings-store`, 5s by default (Settings → General offers 5s / 30s / 1m)
6. A further change within that window resets the timer
7. After the delay elapses with no edit, `performSave()` is called, which calls the `onSave` callback
8. Save status updates in `useSaveStore()`, and the Dock shows "Saving..." then "Saved" for `TIMING.SAVED_STATUS_DURATION_MS`
9. On **tab switch or unmount**, any pending save is flushed before the context is unregistered
10. On **app quit** (Electron `before-quit`) *and* on **window close** (the X
    button), `useSaveStore().flushAll()` saves all dirty contexts

**Both window-destroying paths flush, through one coordinator.** `before-quit`
always did; `close` did not, and `close` is what the X button fires - it
destroys the WebContents and nulls the window handle, so the `before-quit` that
followed found no renderer to ask and skipped the flush entirely (on macOS,
`close` does not quit at all, so the edits were simply gone with the app still
running). `electron/save-flush.ts` owns the once-only flush and the 2s ACK
ceiling for both, which is also why "already flushed" is shared state: a quit
that flushed and then closes the window must not ask a dying renderer twice.
It lives outside `main.ts` so it can be tested - `main.ts` creates windows and
starts the engine at import time.

### Variable Resolution Priority

1. User activates a request in a tab. The environment comes from `useSessionStore().activeEnvironmentId`; the collection comes from the request's own `collectionId` - **not** from the session store, which has held no collection scope since the `vayu.session` v2 migration
2. Component calls `useVariableResolver({ collectionId })` - the environment is not passed, the hook reads it from the session store
3. Hook fetches globals, collection variables, and environment variables via TanStack Query
4. When `resolveString("https://{{baseUrl}}/{{path}}")` is called:
   - First, check environment variables for `baseUrl` and `path`
   - If not found, check collection variables
   - If still not found, check global variables
   - Replace with the first match found, or leave `{{variableName}}` unreplaced if no match

## Best Practices

1. **Cross-cutting vs. module-local:** Store cross-cutting UI state (tabs, layout, engine, save) in `app/src/stores/`; store feature-specific UI state (collections tree, history filters, variables category, settings category) in `app/src/modules/<feature>/<feature>-store.ts`.

2. **Zustand for transient UI state:** Use Zustand for UI state that doesn't persist to disk (or is ephemeral per session). Decorate with `persist` middleware to survive page reloads if needed (e.g., open tabs, drawer state).

3. **TanStack Query for server state:** Use TanStack Query for collections, requests, environments, globals, runs, and reports. It is the single source of truth and ensures consistency across the app.

4. **Save manager integration:** Use `useSaveManager()` in any component that edits a persistable entity (request, environment, etc.) that autosaves. It handles debouncing, context registration, and centralized save state. Do not manually call `useSaveStore()` for auto-save. For an editor that saves on an explicit button instead, use `useEntityDraft()` **plus `useDraftSaveContext()`** - the first owns the draft, the second puts it in the registry - and do not hand-roll the draft/resync/`isDirty`/mutation-reset parts again.

5. **Centralized save on app quit:** On Electron's `before-quit` event, call `useSaveStore().flushAll()` to persist any pending changes before the app closes. An editor that is not registered is not merely unsaved here, it is invisible - which is how the collection tabs lost drafts silently for as long as they existed.

    Corollary: **an editing surface must never fail without saying so.** There is no global `MutationCache.onError` in `lib/query-client.ts`, so a bare `mutation.mutate(...)` reports nothing at all. Route the failure through `failSave` (toast + status) or render the mutation's `isError`, and roll an uncontrolled input back to the stored value while you are at it - the context bar's variables section did neither, so a rejected edit sat on screen looking committed.

6. **Leaving an editor saves or asks; it does not drop.** A settings category switch, an unmount, a tab switch - each used to discard dirty state silently in at least one place. Settings flushes its valid edits on the way out (engine config writes are cheap merge-patches); the collection tabs keep their panels mounted so there is nothing to discard.

7. **Tab LRU and dirty state:** The tab store reads the save registry and refuses to evict a dirty tab (`isTabDirty`, matched by tab *type* - the registry is keyed by editor and the two do not line up). Nothing is flushed during eviction, because the predicate has already declined to take unsaved work; over the cap with every candidate dirty, no tab closes at all.

8. **Response persistence:** Responses are stored in memory (not localStorage) so they survive tab switches but are cleared on page reload. This balances UX (quick switch back) with memory (responses can be large).

9. **Live metric retention is a time window, not a point count.** `addMetricsBatch` trims ticks older than `liveWindowSeconds` (the engine's `liveReplayWindowMs`, 5m by default, `null` = full run), with `maxRetainedTicks` (`DEFAULT_MAX_RETAINED_TICKS`, 50,000) as a memory backstop. Both are engine config so the replayed span and the displayed span cannot disagree. The only knob in `config/metrics.ts` is `METRICS_UI_THROTTLE_MS`, the SSE commit throttle; chart cost is bounded by bucketing (`chartBucketSeconds`), not by dropping ticks.

10. **Variable resolution priority:** Always resolve variables in priority order: environment > collection > global. Use `useVariableResolver({ collectionId })` to scope a preview to a collection; the active environment comes from the session store and is not a parameter.

11. **Lazy loading and prefetch:** Use `usePrefetchCollectionsAndRequests()` on app init to warm up caches. Lazily fetch environments, globals, and run reports only when needed to reduce initial bundle size and API load.
