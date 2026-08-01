# State Management

The Vayu app uses a dual-state management approach: **Zustand** for UI state and **TanStack Query** for server state. **Cross-cutting stores** (tabs, layout, session, engine, save, response, dashboard, import modal) live in `app/src/stores/` and are exported via the barrel `app/src/stores/index.ts`. **Module-local UI stores** co-locate in `app/src/modules/<feature>/<feature>-store.ts` (collections, history, variables, settings) to keep feature-specific UI state decoupled from global app state.

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
- Persistence: `vayu.tabs` (v1)

**Key Methods:**
```typescript
const { openTab, closeTab, focusTab, replaceActiveTab, closeAll } = useTabsStore();
openTab({ type: "request", entityId: "req-123" });
replaceActiveTab({ type: "request", entityId: "req-456" }); // Replace active in place
```

#### `layout-store.ts` - Drawer, Context Bar, & Split Ratio

Manages the left drawer (collections/history/variables), the right context bar, and request/response split ratio.

**State:**
```typescript
{
  drawerOpen: boolean                    // Is the left drawer visible?
  drawerView: "collections" | "history" | "variables"
  drawerWidths: Record<DrawerView, number>  // Per-view width (220–480px)
  contextBarOpen: boolean                // Is the right context bar visible?
  requestSplitRatio: number              // 0–1; left/request pane fraction
}
```

**Key Methods:**
```typescript
const {
  drawerOpen, setDrawerOpen, toggleDrawer,
  drawerView, setDrawerView, activateDrawerView,
  setDrawerWidth,
  contextBarOpen, setContextBarOpen, toggleContextBar,
  requestSplitRatio, setRequestSplitRatio
} = useLayoutStore();
activateDrawerView("variables"); // Open drawer to variables, or toggle closed if already there
setDrawerWidth("collections", 300); // Clamp to [220, 480]
```

**Persistence:** `vayu.layout` (v1)

#### `session-store.ts` - Active Environment & Collection

Tracks the active environment (for variable resolution) and active collection context, persisted across sessions.

**State:**
```typescript
{
  activeEnvironmentId: string | null
  activeCollectionId: string | null
}
```

**Key Methods:**
```typescript
const { activeEnvironmentId, setActiveEnvironmentId } = useSessionStore();
setActiveCollectionId(collectionId);
```

**Persistence:** `vayu.session` (v1)

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
  pendingRestart, setPendingRestart, addRestartRequiredKey, clearRestartRequired,
  reset
} = useEngineStore();
```

**Non-persisted** (reset on app restart).

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
`VariableTableEditor`, `useDraftSaveContext` and `ContextBar` - and doing the
reporting here rather than at each of them means a new caller cannot forget to
report. The last two were added because both could fail in complete silence:
`ContextBar` fired three mutations with no `onError` at all, and the
manual-draft editors rendered an inline callout that a quit flush has no screen
to show.

**Only the context that set a status clears it.** `SettingsMain` used to run an
unconditional `setStatus("idle")` whenever it had nothing pending - which
included mount - so merely opening Settings wiped an `error` another context had
just published to the Dock. It now tracks whether the `pending` on screen is its
own and leaves anything else alone.

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

**Non-persisted** (responses are reloadable from backend).

#### `client-settings-store.ts` - Renderer Preferences

Central home for renderer-only preferences that aren't part of the pre-paint appearance set (theme/color/UI-font/scale/radius live in their own localStorage keys so `index.html` can apply them before React mounts). Holds editor behavior, the monospace/code font, chart granularity, the capacity SLO threshold, the live refresh rate, auto-save preferences, and the load-test dialog's ceilings. Backs the Settings **panels** (`modules/settings/main/panels/`). Non-React consumers (services, the dashboard store) read via `getState()`.

**Key exports:**
```typescript
const store = useClientSettingsStore();   // editorPrefs, autoSavePrefs, monoFont, chartBucketSeconds, sloThresholdMs, liveRefreshMs, loadTestCeilings, ...
import { SETTINGS_STORAGE_KEYS } from "@/stores";  // localStorage keys reset by "Reset app settings"
```

`loadTestCeilings` is the one slice with a bound outside the app: each value is clamped to `LOAD_TEST_CEILING_BOUNDS` (`constants/load-test.ts`) on write **and** on rehydrate, because the bounds are the engine's crash guards and a build that tightens one must not keep offering a stored ceiling above it. The load dialog turns them into its field ranges via `resolveLoadTestLimits`; nothing else reads them.

**Persisted** to localStorage (via `zustand/persist`); workspace/session state (open tabs, layout, active collection) is deliberately excluded from the reset.

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
  setLiveWindowSeconds,  // Update the live retention window (from useLiveChartWindow)
  reset,
  getLatestMetrics, getMetricsWindow
} = useDashboardStore();
```

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
const { showToast, dismissToast, dismissAll } = useToastStore();

showToast("Run history cleared", "success");   // string form, still supported
showToast({                                     // returns the toast id
  message: "Couldn't stop the run",
  variant: "error",
  action: { label: "Try again", onClick: retry },
});
```

Variants are `info` | `success` | `warning` | `error`, with durations of 4s / 4s
/ 6s / 10s from `TIMING.TOAST_DURATION_MS`. `warning` is for a refusal ("A load
test is already running") as distinct from a failure.

Two policies live here because the primitive has no opinion on them: an
identical message and variant already on screen is **collapsed rather than
stacked**, and past `MAX_TOASTS` (4) the oldest is dropped. Removal is driven by
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
  toggleCollectionExpanded, expandCollection, collapseCollection,
  reset
} = useCollectionsStore();
```

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

Located in `app/src/services/queries/` (or `hooks/`), with types and cache invalidation centralized in `app/src/services/queries/keys.ts`.

#### Collections & Requests

- **`useCollectionsQuery()`** - Fetch all collections
- **`useCollectionQuery(id)`** - Fetch single collection
- **`useRequestsQuery(collectionId)`** - Fetch requests in a collection
- **`useRequestQuery(requestId)`** - Fetch single request

**Mutations:**
- **`useCreateCollectionMutation()`** - Create collection
- **`useUpdateCollectionMutation()`** - Update collection (with cache update)
- **`useDeleteCollectionMutation()`** - Delete collection (with cache removal)
- **`useCreateRequestMutation()`** - Create request
- **`useUpdateRequestMutation()`** - Update request
- **`useDeleteRequestMutation()`** - Delete request

#### Environments & Variables

- **`useEnvironmentsQuery()`** - Fetch all environments
- **`useEnvironmentQuery(id)`** - Fetch single environment
- **`useGlobalsQuery()`** - Fetch global variables

**Mutations:**
- **`useCreateEnvironmentMutation()`**
- **`useUpdateEnvironmentMutation()`**
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

**Mutations:**
- **`useStopRunMutation()`** - Stop a running load test
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

#### Engine Health & Config

- **`useHealthQuery()`** - Health check with automatic polling (enables connection indicator)
- **`useConfigQuery()`** - Fetch engine configuration
- **`useScriptCompletionsQuery()`** - Fetch script autocomplete data (for request scripting)

### Query Keys & Cache Invalidation

Centralized in `app/src/services/queries/keys.ts`, using TanStack Query's hierarchical key factory pattern:

```typescript
export const queryKeys = {
  collections: {
    all: () => ['collections'],
    list: () => ['collections', 'list'],
    detail: (id: string) => ['collections', id],
  },
  requests: {
    all: () => ['requests'],
    listByCollection: (collectionId: string) => ['requests', { collectionId }],
    detail: (id: string) => ['requests', id],
  },
  // ... etc
};
```

**Automatic Invalidation:**
- Mutations automatically invalidate related queries (e.g., creating a request invalidates the collection's request list)
- Some mutations use optimistic updates and cache updates for instant UI feedback

**Stale Time:**
- Collections/Requests: 30 seconds
- Environments: 30 seconds
- Health: 5 seconds (polling - drives connection status)
- Runs: 10 seconds
- Run Reports: 1 minute (lazily refetched if stale when opened)

## Custom Hooks

### `useEngine()` - Request & Load Test Execution

Provides functions to execute single requests and start load tests, with loading state and error handling.

**API:**
```typescript
const {
  executeRequest: (request: Request, environmentId?: string) => Promise<ExecutionResponse>
  startLoadTest: (request: Request, config: LoadTestConfig, environmentId?: string) => Promise<{ runId: string }>
  stopLoadTest: (runId: string) => Promise<void>
  isExecuting: boolean
  error: string | null
} = useEngine();
```

**Features:**
- Request transformation (frontend format → backend format)
- Automatic error handling and user feedback
- Environment variable resolution (if needed pre-flight)

### `useSSE()` - Live Metrics Stream

Subscribes to Server-Sent Events for live load test metrics during a run.

**API:**
```typescript
useSSE({
  runId: string | null
  enabled: boolean
});
```

**Features:**
- Automatic connection/disconnection based on `runId` and `enabled`
- Connects to `/runs/:runId/live` (engine endpoint)
- Replayable tick stream with explicit `complete` event (no custom reconnect logic needed)
- Forwards metrics to `useDashboardStore().addMetricsBatch()`
- Transient errors left to browser's built-in `EventSource` retry

### `useVariableResolver()` - Variable Resolution

Resolves `{{variableName}}` patterns in strings and objects using environment, collection, and global variables.

**API:**
```typescript
const {
  resolveString: (input: string) => string
  resolveObject: <T>(obj: T) => T
  getVariable: (name: string) => ResolvedVariable | null
  getAllVariables: () => Record<string, ResolvedVariable>
  hasUnresolvedVariables: (input: string) => boolean
  getVariableOrigins: (name: string) => VariableOrigin[]
} = useVariableResolver({ collectionId?: string, environmentId?: string });
```

**Resolution Priority (highest to lowest):**
1. Environment variables
2. Collection variables
3. Global variables

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

### Starting a Load Test Run

1. User configures load test in the dashboard modal (duration, concurrency, etc.)
2. `useEngine().startLoadTest()` is called with the request, config, and optional environment ID
3. Engine responds with `runId`
4. `useDashboardStore().startRun(runId, config, requestInfo)` initializes dashboard state
5. `useSSE({ runId, enabled: true })` hook connects to `/runs/:runId/live`
6. As metrics stream in, `addMetricsBatch()` efficiently folds them into historical metrics (capped at 3,000) and updates running aggregates (peak concurrency, SLO breakpoint)
7. Dashboard view shows live metrics, request/response (from the SSE stream's final response), and aggregates
8. When the run completes, the engine sends a `complete` event
9. `LoadTestService.handleClose()` fetches the final report through the query cache (under `queryKeys.runs.report(runId)`, so History reuses it) and stores it in `dashboard-store.finalReport` - **only if the dashboard is still showing that run**. The store is re-read after the await: finishing run A and immediately starting run B otherwise landed A's report on B's dashboard, flipping a running test to "completed" with A's percentiles.
10. Dashboard switches to "completed" mode showing the final report; the runs lists are invalidated so the terminal status lands without waiting for a poll

### Saving a Request with Auto-Save

1. User opens or creates a request tab via `useTabsStore().openTab()`
2. Component mounts `useSaveManager()` with the request ID and save callback
3. Hook registers the context with `useSaveStore()` for Ctrl/Cmd+S integration
4. User edits the request (URL, headers, body, etc.)
5. `hasChanges` is marked true, triggering a 3-second debounce timer
6. If the user makes another change within 3 seconds, the timer resets
7. After 3 seconds of inactivity, `performSave()` is called, which calls the `onSave` callback
8. Save status updates in `useSaveStore()`, and UI shows "Saving..." then "Saved" for 2 seconds
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

1. User activates a request in a tab with active environment and collection selected (stored in `useSessionStore()`)
2. Component calls `useVariableResolver({ collectionId, environmentId })`
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

    Corollary: **an editing surface must never fail without saying so.** There is no global `MutationCache.onError` in `lib/query-client.ts`, so a bare `mutation.mutate(...)` reports nothing at all. Route the failure through `failSave` (toast + status) or render the mutation's `isError`, and roll an uncontrolled input back to the stored value while you are at it - `ContextBar` did neither, so a rejected edit sat on screen looking committed.

6. **Leaving an editor saves or asks; it does not drop.** A settings category switch, an unmount, a tab switch - each used to discard dirty state silently in at least one place. Settings flushes its valid edits on the way out (engine config writes are cheap merge-patches); the collection tabs keep their panels mounted so there is nothing to discard.

7. **Tab LRU and dirty state:** The tab store coordinates with save-store to avoid evicting dirty tabs. When a tab is evicted due to LRU, any pending saves are flushed first.

8. **Response persistence:** Responses are stored in memory (not localStorage) so they survive tab switches but are cleared on page reload. This balances UX (quick switch back) with memory (responses can be large).

9. **Metrics cap for performance:** Historical metrics are capped at **3,000 points** per run (defined in `app/src/config/metrics.ts` as `HISTORICAL_METRICS_CAP = 3000`). This provides ~5 minutes of full-fidelity data at the engine's 10 Hz tick rate, long enough for typical load test sessions but short enough to keep chart slicing efficient.

10. **Variable resolution priority:** Always resolve variables in priority order: environment > collection > global. Use `useVariableResolver({ collectionId, environmentId })` to ensure correct scoping.

11. **Lazy loading and prefetch:** Use `usePrefetchCollectionsAndRequests()` on app init to warm up caches. Lazily fetch environments, globals, and run reports only when needed to reduce initial bundle size and API load.
