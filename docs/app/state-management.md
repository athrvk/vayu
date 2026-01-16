# State Management

The Vayu Manager uses a dual-state management approach: **Zustand** for UI state and **TanStack Query** for server state.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│           State Management Layers                │
├─────────────────────────────────────────────────┤
│  UI State (Zustand)                             │
│  - Navigation, screen state                     │
│  - Temporary UI state                          │
│  - User preferences                            │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Server State (TanStack Query)                  │
│  - Collections, Requests, Environments           │
│  - Runs, Metrics                                 │
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

## Zustand Stores (UI State)

Zustand stores manage client-side UI state that doesn't need to be synchronized with the server.

### `app-store.ts` - Application Navigation

Manages navigation state, screen routing, and engine connection status.

**State:**
```typescript
{
  activeSidebarTab: "collections" | "history" | "variables" | "settings"
  activeScreen: "welcome" | "request-builder" | "dashboard" | ...
  selectedCollectionId: string | null
  selectedRequestId: string | null
  selectedRunId: string | null
  isEngineConnected: boolean
  engineError: string | null
  tabMemory: Record<SidebarTab, NavigationContext>
  previousContext: NavigationContext | null
}
```

**Key Features:**
- Tab memory: Remembers last screen/selection per sidebar tab
- Navigation helpers: `navigateToRequest()`, `navigateToDashboard()`, etc.
- Back navigation: `navigateBack()` uses `previousContext`

**Usage:**
```typescript
const { activeScreen, navigateToRequest } = useAppStore();
navigateToRequest(collectionId, requestId);
```

### `dashboard-store.ts` - Load Test Dashboard

Manages load test metrics, streaming state, and final reports.

**State:**
```typescript
{
  currentRunId: string | null
  mode: "running" | "completed"
  isStreaming: boolean
  currentMetrics: LoadTestMetrics | null
  historicalMetrics: LoadTestMetrics[]
  finalReport: RunReport | null
  error: string | null
  activeView: "metrics" | "request-response"
  loadTestConfig: LoadTestRunConfig | null
  requestInfo: LoadTestRequestInfo | null
}
```

**Key Features:**
- Real-time metrics accumulation (limited to 10,000 points)
- Helper methods: `getLatestMetrics()`, `getMetricsWindow(seconds)`
- Automatic state reset on new run

**Usage:**
```typescript
const { startRun, addMetrics, setFinalReport } = useDashboardStore();
startRun(runId, config, requestInfo);
```

### `variables-store.ts` - Variables UI State

Manages variable editor UI state and active environment/collection context.

**State:**
```typescript
{
  selectedCategory: VariableCategory | null
  activeEnvironmentId: string | null
  activeCollectionId: string | null
  isEditing: boolean
}
```

**Key Features:**
- Persisted state (localStorage): Active environment and collection persist across sessions
- Category selection: Tracks which variable scope is being edited

**Usage:**
```typescript
const { activeEnvironmentId, setActiveEnvironment } = useVariablesStore();
setActiveEnvironment(envId);
```

### `collections-store.ts` - Collection Tree State

Manages collection tree expansion state.

**State:**
```typescript
{
  expandedCollectionIds: Set<string>
  toggleExpanded: (id: string) => void
}
```

**Usage:**
```typescript
const { expandedCollectionIds, toggleExpanded } = useCollectionsStore();
```

### `history-store.ts` - History Filtering

Manages run history filter state.

**State:**
```typescript
{
  filterType: "all" | "design" | "load" | null
  filterStatus: "all" | "completed" | "failed" | null
  // ... other filters
}
```

### `response-store.ts` - Response Viewer State

Manages response viewer UI state (tabs, expanded sections).

### `save-store.ts` - Auto-Save Orchestration

Manages auto-save debouncing and save state.

**State:**
```typescript
{
  isSaving: boolean
  lastSaved: number | null
  triggerSave: () => void
}
```

**Key Features:**
- Debounced saves: Waits for user to stop typing
- Save state tracking: Shows "Saving..." indicator

## TanStack Query (Server State)

TanStack Query manages server state with automatic caching, refetching, and synchronization.

### Query Hooks (`queries/`)

#### Collections & Requests

- **`useCollectionsQuery()`**: Fetch all collections
- **`useRequestsQuery(collectionId)`**: Fetch requests for a collection
- **`useRequestQuery(requestId)`**: Fetch single request (from cache)
- **`usePrefetchCollectionsAndRequests()`**: Prefetch all data on app init

**Mutations:**
- **`useCreateCollectionMutation()`**: Create collection (optimistic update)
- **`useUpdateCollectionMutation()`**: Update collection (cache update)
- **`useDeleteCollectionMutation()`**: Delete collection (cache removal)
- **`useCreateRequestMutation()`**: Create request
- **`useUpdateRequestMutation()`**: Update request
- **`useDeleteRequestMutation()`**: Delete request

#### Environments & Globals

- **`useEnvironmentsQuery()`**: Fetch all environments
- **`useEnvironmentQuery(id)`**: Fetch single environment
- **`useGlobalsQuery()`**: Fetch global variables

**Mutations:**
- **`useCreateEnvironmentMutation()`**: Create environment
- **`useUpdateEnvironmentMutation()`**: Update environment
- **`useDeleteEnvironmentMutation()`**: Delete environment
- **`useUpdateGlobalsMutation()`**: Update global variables

#### Runs

- **`useRunsQuery()`**: Fetch all runs
- **`useRunQuery(runId)`**: Fetch single run
- **`useRunReportQuery(runId)`**: Fetch run report

**Mutations:**
- **`useStopRunMutation()`**: Stop running load test
- **`useDeleteRunMutation()`**: Delete run

#### Health & Config

- **`useHealthQuery()`**: Health check with automatic polling
- **`useConfigQuery()`**: Fetch engine config
- **`useScriptCompletionsQuery()`**: Fetch script autocomplete data

### Query Keys (`queries/keys.ts`)

Centralized query key factory for consistent cache invalidation:

```typescript
export const queryKeys = {
  collections: {
    list: () => ['collections'],
    detail: (id: string) => ['collections', id],
  },
  requests: {
    lists: () => ['requests', 'list'],
    listByCollection: (collectionId: string) => ['requests', 'list', collectionId],
    detail: (id: string) => ['requests', id],
  },
  // ... etc
};
```

### Cache Management

**Automatic Invalidation:**
- Mutations automatically invalidate related queries
- Example: Updating a request invalidates its collection's request list

**Optimistic Updates:**
- UI updates immediately before server response
- Example: Creating a collection adds it to cache instantly

**Stale Time:**
- Collections/Requests: 30 seconds
- Health: 5 seconds (polling)
- Run Reports: 1 minute

## Custom Hooks

### `useEngine()` - Request Execution

Provides functions to execute requests and start load tests.

**API:**
```typescript
const {
  executeRequest: (request, environmentId?) => Promise<SanityResult>
  startLoadTest: (request, config, environmentId?) => Promise<StartLoadTestResponse>
  stopLoadTest: (runId) => Promise<boolean>
  isExecuting: boolean
  error: string | null
} = useEngine();
```

**Features:**
- Loading state management
- Error handling with user-friendly messages
- Request transformation (frontend → backend format)

### `useSSE()` - Real-Time Metrics

Connects to Server-Sent Events stream for load test metrics.

**API:**
```typescript
useSSE({
  runId: string | null
  enabled: boolean
});
```

**Features:**
- Automatic connection/disconnection
- Reconnection with exponential backoff
- Metrics forwarding to dashboard store

### `useVariableResolver()` - Variable Resolution

Resolves `{{variables}}` in strings and objects.

**API:**
```typescript
const {
  resolveString: (input: string) => string
  resolveObject: <T>(obj: T) => T
  getVariable: (name: string) => VariableSource | null
  getAllVariables: () => Record<string, VariableSource>
  hasUnresolvedVariables: (input: string) => boolean
} = useVariableResolver({ collectionId?: string });
```

**Resolution Priority:**
1. Environment variables (highest)
2. Collection variables
3. Global variables (lowest)

**Usage:**
```typescript
const { resolveString } = useVariableResolver({ collectionId });
const resolvedUrl = resolveString("https://{{baseUrl}}/api/users");
```

### `useSaveManager()` - Auto-Save

Orchestrates auto-save with debouncing.

**API:**
```typescript
useSaveManager({
  onSave: () => Promise<void>
  debounceMs?: number
});
```

**Features:**
- Debounced saves (default 1000ms)
- Save state tracking
- Keyboard shortcut integration (`Ctrl/Cmd+S`)

## State Flow Examples

### Executing a Request

1. User clicks "Send" in RequestBuilder
2. `useEngine().executeRequest()` called
3. Variables resolved via `useVariableResolver()`
4. Request transformed and sent via `apiService.executeRequest()`
5. Response stored in component state (not global store)
6. Response displayed in ResponseViewer

### Starting a Load Test

1. User configures and starts load test
2. `useEngine().startLoadTest()` sends `POST /run`
3. `useDashboardStore().startRun()` initializes dashboard state
4. `useSSE()` connects to metrics stream
5. Metrics stream in and update `dashboard-store`
6. When complete, `useRunReportQuery()` fetches final report
7. Report stored in `dashboard-store.finalReport`

### Variable Resolution

1. `useVariableResolver()` fetches globals, collections, environments
2. Builds flat map with resolution priority
3. `resolveString()` replaces `{{variableName}}` patterns
4. Used in RequestBuilder before sending requests

## Best Practices

1. **Use Zustand for UI state**: Navigation, temporary state, user preferences
2. **Use TanStack Query for server state**: Collections, requests, runs
3. **Keep stores focused**: Each store manages a specific domain
4. **Leverage query caching**: Don't refetch unnecessarily
5. **Use optimistic updates**: Update UI immediately, sync with server
6. **Handle loading/error states**: Always show appropriate UI feedback
