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
- Integration with save-store: Dirty tabs are spared from eviction; pending saves are flushed on eviction
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
  lastSavedAt: number | null
  errorMessage: string | null
  pendingSaveId: string | null
  activeContextId: string | null
  contexts: Map<string, SaveContext>  // Saveable entities
}
```

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

**Non-persisted**. See `useSaveManager` hook for registration details.

#### `response-store.ts` - Response Cache

In-memory storage of responses per request ID, persisted across view/tab switches but not to disk.

**State:**
```typescript
{
  responses: Map<string, StoredResponse>
}
```

**StoredResponse:** Includes status, headers, body, execution time, script results, console logs, and `restoredFrom` - set only when the response was rebuilt from a stored run rather than executed, and read by the response pane's age chip.

**Key Methods:**
```typescript
const { setResponse, getResponse, clearResponse, clearAll } = useResponseStore();
```

`setResponse` stores a **fresh object** on every write. `RequestBuilderProvider` subscribes to the entry for the request it is showing and adopts it when that identity changes, which is how a design run opened from history lands in a tab that is already on screen. Identity, not contents: `executeRequest` clears the pane with `setResponse(null)` and leaves the store untouched, so a contents-keyed sync would put the old response straight back.

**Non-persisted** (responses are reloadable from backend).

#### `client-settings-store.ts` - Renderer Preferences

Central home for renderer-only preferences that aren't part of the pre-paint appearance set (theme/color/UI-font/scale/radius live in their own localStorage keys so `index.html` can apply them before React mounts). Holds editor behavior, the monospace/code font, chart granularity, the capacity SLO threshold, the live refresh rate, and auto-save preferences. Backs the Settings **panels** (`modules/settings/main/panels/`). Non-React consumers (services, the dashboard store) read via `getState()`.

**Key exports:**
```typescript
const store = useClientSettingsStore();   // editorPrefs, autoSavePrefs, monoFont, chartBucketSeconds, sloThresholdMs, liveRefreshMs, ...
import { SETTINGS_STORAGE_KEYS } from "@/stores";  // localStorage keys reset by "Reset app settings"
```

**Persisted** to localStorage (via `zustand/persist`); workspace/session state (open tabs, layout, active collection) is deliberately excluded from the reset.

#### `dashboard-store.ts` - Load Test Metrics & State

Manages live load test run state: streaming metrics, final reports, and running aggregates (peak concurrency, SLO breakpoint). Retention is **time-based, not a fixed point count**: `addMetricsBatch` trims ticks older than the user-configurable live window (`liveWindowSeconds`, sourced from `constants/live-window.ts`, default 5m, `null` = full run), backstopped by a hard `MAX_RETAINED_TICKS` safety cap (20,000). The window is kept in sync by the `useLiveChartWindow` hook and drives what the live charts plot. (`app/src/config/metrics.ts` now only holds the SSE commit throttle, `METRICS_UI_THROTTLE_MS`.)

**State:**
```typescript
{
  currentRunId: string | null
  mode: "running" | "completed" | "stopped"
  isStreaming: boolean
  currentMetrics: LoadTestMetrics | null
  historicalMetrics: LoadTestMetrics[]  // Trimmed to liveWindowSeconds (cap: MAX_RETAINED_TICKS)
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

**Helper:** `filterRuns(runs, filters)` applies filters and sorting to server data.

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

- **`useRunsQuery()`** - Fetch all runs
- **`useRunQuery(runId)`** - Fetch single run
- **`useRunReportQuery(runId)`** - Fetch final report for a run

**Mutations:**
- **`useStopRunMutation()`** - Stop a running load test
- **`useDeleteRunMutation()`** - Delete a run

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
- Connects to `/metrics/live/:runId` (engine endpoint)
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
  getVariable: (name: string) => VariableValue | null
  getAllVariables: () => Record<string, VariableValue>
  hasUnresolvedVariables: (input: string) => boolean
} = useVariableResolver({ collectionId?: string, environmentId?: string });
```

**Resolution Priority (highest to lowest):**
1. Environment variables
2. Collection variables
3. Global variables

**Usage:**
```typescript
const { resolveString } = useVariableResolver({ collectionId });
const resolvedUrl = resolveString("https://{{baseUrl}}/api/users");
```

### `useSaveManager()` - Auto-Save Manager

Orchestrates auto-save for a saveable entity (request, environment, etc.) with debouncing, context registration, and centralized save state tracking. Located in `app/src/hooks/useSaveManager.ts`.

**API:**
```typescript
const {
  forceSave: () => Promise<void>
  status: "idle" | "pending" | "saving" | "saved" | "error"
  isSaving: boolean
  errorMessage: string | null
} = useSaveManager({
  entityId: string | null           // Unique ID for this entity
  contextName?: string              // Display name (e.g., "Request: GET /api")
  onSave: () => Promise<void>       // Function to persist changes
  hasChanges: boolean               // Whether unsaved changes exist
  enabled?: boolean                 // Disable auto-save (default: true)
});
```

**Features:**
- **Debounced auto-save:** Triggers 3000ms after the last change (defined in `app/src/config/timing.ts` as `TIMING.AUTO_SAVE_DELAY_MS`)
- **Context registration:** Automatically registers with `useSaveStore()` for app-wide Ctrl/Cmd+S integration and tab LRU coordination
- **Save status:** Updates centralized save store so UI can show "Saving..." or "Saved" indicators
- **Entity switching:** Flushes pending saves when entity ID changes (in cleanup, before unmounting)
- **Fixed debounce:** Debounce is a fixed 3000ms constant; there is no `debounceMs` parameter

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

## State Flow Examples

### Executing a Single Request

1. User clicks "Send" button in request builder
2. `useEngine().executeRequest()` is called with request and (optionally) environment ID
3. `useVariableResolver()` resolves any `{{variables}}` in the request URL, headers, body
4. Request is transformed (frontend → backend format) and sent via HTTP
5. Response is stored in `useResponseStore()` keyed by request ID
6. Response viewer component reads the response and displays it
7. On **request tab switch**, the response persists in `response-store` and is displayed if the user returns

### Opening a Past Response

1. User clicks a **design** run in the history list (`useOpenRun`)
2. The run's report is fetched (`fetchRunReport`) and its single result row rebuilt into a `ResponseState` (`responseFromRunResult`)
3. The request is looked up (`fetchRequestById`); if it is gone, the run opens the run tab instead
4. The response is written to `useResponseStore()` **before** the request tab is opened, so the provider finds it on mount
5. The pane marks it with an age chip - the request editor beside it shows the request as it is *now*, which may have been edited since
6. The next Send overwrites it, chip and all

On a **cold start** the same reconstruction runs unprompted for the *last* design run of each restored tab (`useLastDesignRunQuery`), which is why nothing about a response needs to be persisted to disk.

### Starting a Load Test Run

1. User configures load test in the dashboard modal (duration, concurrency, etc.)
2. `useEngine().startLoadTest()` is called with the request, config, and optional environment ID
3. Engine responds with `runId`
4. `useDashboardStore().startRun(runId, config, requestInfo)` initializes dashboard state
5. `useSSE({ runId, enabled: true })` hook connects to `/metrics/live/:runId`
6. As metrics stream in, `addMetricsBatch()` efficiently folds them into historical metrics (capped at 3,000) and updates running aggregates (peak concurrency, SLO breakpoint)
7. Dashboard view shows live metrics, request/response (from the SSE stream's final response), and aggregates
8. When the run completes, the engine sends a `complete` event
9. `useRunReportQuery(runId)` fetches the final report and is stored in `dashboard-store.finalReport`
10. Dashboard switches to "completed" mode showing the final report

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
10. On **app quit** (Electron before-quit event), `useSaveStore().flushAll()` saves all dirty contexts

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

4. **Save manager integration:** Use `useSaveManager()` in any component that edits a persistable entity (request, environment, etc.). It handles debouncing, context registration, and centralized save state. Do not manually call `useSaveStore()` for auto-save.

5. **Centralized save on app quit:** On Electron's `before-quit` event, call `useSaveStore().flushAll()` to persist any pending changes before the app closes.

6. **Tab LRU and dirty state:** The tab store coordinates with save-store to avoid evicting dirty tabs. When a tab is evicted due to LRU, any pending saves are flushed first.

7. **Response persistence:** Responses are stored in memory (not localStorage) so they survive tab switches but are cleared on page reload. This balances UX (quick switch back) with memory (responses can be large).

8. **Metrics cap for performance:** Historical metrics are capped at **3,000 points** per run (defined in `app/src/config/metrics.ts` as `HISTORICAL_METRICS_CAP = 3000`). This provides ~5 minutes of full-fidelity data at the engine's 10 Hz tick rate, long enough for typical load test sessions but short enough to keep chart slicing efficient.

9. **Variable resolution priority:** Always resolve variables in priority order: environment > collection > global. Use `useVariableResolver({ collectionId, environmentId })` to ensure correct scoping.

10. **Lazy loading and prefetch:** Use `usePrefetchCollectionsAndRequests()` on app init to warm up caches. Lazily fetch environments, globals, and run reports only when needed to reduce initial bundle size and API load.
