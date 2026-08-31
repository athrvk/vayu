---
description: >-
  Structure of the Vayu desktop app: the Electron main and renderer split, process boundaries, and the renderer's own architecture.
---

# Vayu App Architecture

The Vayu Manager is an Electron-based desktop application built with React and TypeScript. It provides a user interface for designing API requests, executing them, and running load tests. The app communicates with the Vayu Engine (a C++ daemon) via HTTP on `localhost:9876`.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                │
│  ┌──────────────────────────────────────────────────┐  │
│  │  main.ts                                         │  │
│  │  - Creates BrowserWindow                        │  │
│  │  - Manages EngineSidecar lifecycle              │  │
│  │  - Handles app lifecycle events                 │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  sidecar.ts                                      │  │
│  │  - Spawns/manages C++ engine process            │  │
│  │  - Monitors engine health                        │  │
│  │  - Handles binary path resolution                │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        │
                        │ IPC (preload.js)
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Electron Renderer Process (React)           │
│  ┌──────────────────────────────────────────────────┐  │
│  │  App.tsx                                         │  │
│  │  - Root component                                │  │
│  │  - Initializes health checks                     │  │
│  │  - Prefetches data                              │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Shell.tsx                                        │  │
│  │  - Main layout (sidebar + content)              │  │
│  │  - Routes to screens based on state              │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Components                                       │  │
│  │  - RequestBuilder, LoadTestDashboard, etc.       │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Services Layer                                   │  │
│  │  - api.ts: HTTP client for engine API            │  │
│  │  - sse-client.ts: Server-Sent Events            │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  State Management                                 │  │
│  │  - Zustand stores (UI state)                     │  │
│  │  - TanStack Query (server state)                 │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        │
                        │ HTTP/SSE (localhost:9876)
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Vayu Engine (C++ Daemon)                    │
│  - HTTP Server (cpp-httplib)                            │
│  - Request Execution (libcurl)                         │
│  - Load Testing                                         │
│  - SQLite Database                                      │
└─────────────────────────────────────────────────────────┘
```

## Core Components

### Electron Main Process (`electron/main.ts`)

The main process is responsible for:

- **Window Management**: Creates and manages the Electron `BrowserWindow`
- **Engine Lifecycle**: Starts and stops the C++ engine via `EngineSidecar`
- **App Lifecycle**: Handles app ready, window close, and quit events

**Key Responsibilities:**
- Spawns the engine binary as a child process
- Monitors engine health and restarts if needed
- Ensures graceful shutdown (stops engine before quitting)

### Engine Sidecar (`electron/sidecar.ts`)

The `EngineSidecar` class manages the C++ engine process:

- **Binary Resolution**: Locates the engine binary (dev vs production paths)
- **Process Management**: Spawns, monitors, and terminates the engine process
- **Health Checking**: Polls `/health` on a ramped interval - 50ms doubling to a
  500ms ceiling - so a healthy engine is caught in tens of milliseconds instead
  of paying a flat poll quantum, while the 45-second budget it spends against a
  live child is unchanged. It still gives up the moment the spawned child exits
  rather than spending the rest of that budget against a dead port, and that
  failure carries the exit code/signal and the engine's last stderr lines. A
  child still alive when the budget runs out raises `EngineNotReadyError`
  instead, which the launch path treats as "not yet" rather than as fatal
- **Build guidance**: A missing binary names `python build.py -e` and
  `docs/building.md` - the single build entry point, not per-platform scripts
- **Port Management**: Checks if port 9876 is available or if engine is already running
- **Ownership**: Tracks whether the engine was *spawned* or *adopted* (already
  running at startup). An adopted engine is owned just as fully - `isRunning()`
  reports it, `restart()` really replaces it, and quit shuts it down by PID.
  See [Ownership model](../architecture.md#ownership-model)
- **System seam**: The process/port/clock calls sit behind a `SidecarSystem`
  interface (`defaultSidecarSystem` in production), so `sidecar.test.ts` can
  drive adoption, shutdown and the restart-versus-quit race without real
  engines or 45-second health waits

**Development vs Production:**
- **Development**: Binary at `../engine/build/vayu-engine` (or `Debug/vayu-engine.exe` on Windows)
- **Production**: Binary at `resources/bin/vayu-engine` (packaged with Electron app)

### React Application (`src/`)

The React app follows a component-based architecture:

#### Application Structure

```
src/
├── components/          # Shared UI components
│   ├── layout/         # Shell, TitleBar, TabStrip, Drawer, Dock, ContextBar
│   ├── shared/         # Cross-feature shared components
│   └── ui/             # UI primitives (Radix UI)
├── lib/                # Shared libraries
│   ├── graphql/        # GraphQL support: diagnostics, introspection, schema cache, Monaco providers, variables JSON Schema, explorer tree + insertion
│   ├── monaco-setup.ts # Monaco local-bundle config + GraphQL provider registration (loaded on the first editor mount)
│   ├── monaco-loader.ts # The lazy boundary in front of it: ensureMonaco() / useLoadedMonaco()
│   └── utils.ts        # General utilities (cn, etc.)
├── modules/            # Feature modules
│   ├── request-builder/  # API request editor and execution
│   ├── dashboard/        # Load test metrics and visualization
│   ├── history/          # Run history and reports
│   ├── collections/      # Collections and requests tree
│   ├── variables/        # Environment and variable editors
│   ├── settings/         # App settings
│   └── welcome/          # Onboarding screen
├── stores/             # Cross-cutting Zustand stores (UI state)
│   ├── tabs-store.ts        # Active tab state (determines main content)
│   ├── layout-store.ts      # Drawer/sidebar visibility
│   ├── session-store.ts     # Session and user info
│   ├── engine-store.ts      # Engine health and connectivity
│   ├── dashboard-store.ts   # Live metrics and test state
│   ├── response-store.ts    # Response viewer state
│   ├── save-store.ts        # Auto-save orchestration
│   └── import-modal-store.ts # Import dialog state
├── queries/            # TanStack Query hooks (server state)
├── hooks/              # Custom React hooks
├── services/           # API client, SSE client, HTTP client
├── types/              # TypeScript type definitions
└── config/             # Configuration (API endpoints, metrics thresholds)
```

#### State Management

The app uses a dual-state management approach:

1. **Zustand Stores** (`stores/` and `lib/`): UI state, navigation, temporary data
   - `tabs-store.ts`: Active tab state; determines which feature module renders in the main content area
   - `layout-store.ts`: Drawer and sidebar visibility/state
   - `session-store.ts`: Active environment id (mirrored from the engine) and the last-used collection
   - `engine-store.ts`: Engine health, connectivity status
   - `dashboard-store.ts`: Load test metrics (retained by time window, see `state-management.md`), streaming state
   - `response-store.ts`: The last response per request id - status, headers, body, script results
   - `client-settings-store.ts`: Renderer preferences (editor, charts, auto-save, notifications)
   - `toast-store.ts`: The transient notification queue
   - `save-store.ts`: Auto-save orchestration and progress
   - `import-modal-store.ts`: Import dialog visibility and state
   - `lib/graphql/schema-cache.ts`: Introspected GraphQL schemas, keyed by resolved endpoint URL + collection + environment + a digest of the **resolved** credentials (so an upstream auth or variable edit is a different entry, not a stale hit). LRU-bounded, and a failed refresh keeps the last good schema
   - `lib/graphql/explorer-store.ts`: The schema explorer's view - whether the pane is open, and per schema identity the search text, expanded rows, scroll position and whether descriptions are shown in full. Read-only over the schema cache: the explorer renders whatever that store holds and triggers no introspection of its own beyond its Refresh button
   - Module-local stores (e.g., `modules/collections/collections-store.ts`) co-locate with their feature

2. **TanStack Query** (`queries/`): Server state, caching, synchronization
   - Collections, Requests, Environments, Globals
   - Runs, Health checks
   - Automatic caching, refetching, and optimistic updates

#### The context bar's section registry

The right-hand context bar renders a list rather than a component tree it owns:
`components/layout/context-bar/registry.ts` holds one ordered array of
`{ id, title, appliesTo(tab), Component }`, and both the bar (what to draw) and
the Dock's toggle (whether the button has anything to light up for) read it
through the same `sectionsForTab` / `contextBarHasContent` pair. Keeping those
two answers in one place is the point: they were a hardcoded tab type in one file
and a `return null` in another, and they drifted.

A section is a leaf component over the ordinary query layer - no bar-wide shared
state - and is **mounted only while its section is expanded**, so a collapsed
section registers no queries. That is what makes it safe for the bar to stay open
on every tab the registry has entries for - request, collection and run. See
`docs/app/COMPONENTS.md` for the sections themselves.

#### Services Layer

- **`api.ts`**: HTTP client wrapper for all engine API endpoints
  - Transforms between frontend (snake_case) and backend (camelCase) formats
  - Handles error transformation and user-friendly messages

- **`codegen/`**: Snippet generation (curl, JS fetch, Python requests, HTTPie,
  PowerShell) - the outbound half of the
  symmetry `services/curl/` opens by parsing curl in. Pure functions over a
  `SnippetRequest`, fed `POST /compose`'s output, so a generated snippet is what
  Vayu would actually send rather than the template it was written as

- **`sse-client.ts`**: Server-Sent Events client for a run's live stream
  - Connects to `/runs/:runId/live` (replayable tick topic - no attach race)
  - No custom reconnect loop: the engine sends an explicit `complete` event, so `CLOSED` is terminal and transient errors are left to the browser's `EventSource` retry
  - **Two event types, one client and one stream.** A load run publishes `metrics` ticks; a scenario (collection) run publishes `step` events, on the same ring with the same monotonic ids, and both end with `complete`. The `step` listener is registered only when a caller passes `onStep` - a load run never emits one, so an unconditional listener would be dead wiring. `parseStepEvent` narrows the payload and **drops** a malformed one rather than defaulting it: the step list keys on `(iteration, stepIndex)`, so a defaulted `0:0` would collide with the real first step's row rather than merely say nothing.
  - Metrics go to `dashboard-store` (via `loadTestService`); steps go to `scenario-run-store` (via `scenarioRunService`)

- **`http-client.ts`**: Low-level fetch wrapper
  - Request/response transformation
  - Error handling and timeout management
  - Base URL configuration

#### Custom Hooks

- **`useEngine()`**: Compose (`POST /compose`), execute, and stop
- **`useVariableResolver()`**: Resolve `{{variables}}` in strings/objects for previews (the engine resolves what is sent)
- **`useSaveManager()`**: Auto-save orchestration with debouncing
- **`useEntityDraft()`**: The manual counterpart - draft, `isDirty`, reset, for editors that save on a button

## Data Flow

### Request Execution Flow

1. User clicks "Send" in RequestBuilder
2. `useEngine().composeRequest()` sends the editor state to `POST /compose`; the engine resolves `{{variables}}` and `inherit` auth and returns an execute-ready payload
3. Request is transformed to backend format (camelCase)
4. `apiService.executeRequest()` sends the composed payload to `POST /execute`
5. Response is transformed back to frontend format (snake_case)
6. Response is displayed in ResponseViewer

### Load Test Flow

1. User configures load test and clicks "Start Load Test"
2. The composed request plus the load config go to `POST /runs` via `apiService.startLoadTest()`
3. Engine returns `runId`
4. `useDashboardStore().startRun()` initializes dashboard state
5. `loadTestService.startMonitoring(runId)` connects to the `/runs/:runId/live` SSE endpoint
6. Metrics stream in real-time and update dashboard
7. When test completes, final report is fetched via `GET /runs/:id/report`

### Collection Run Flow

1. User picks **Run collection** in a collection row's ⋯ menu and confirms `RunCollectionDialog` (Recursive, Iterations)
2. `useStartScenarioRunMutation()` sends a `scenario` block to the same `POST /runs`; the engine resolves the whole plan first, so an empty collection or a step that will not compose comes back as a `400` with no run created
3. Engine returns `runId` (`202`), and the dialog attaches `scenarioRunService.startMonitoring(runId)` and opens the run's tab
4. `step` events stream into `scenario-run-store` and `ScenarioRunView` renders them live
5. On `complete` the service invalidates the run and fetches `GET /runs/:id/report`; the view switches to the stored per-step rows, which are the ones carrying an exchange to expand

### Variable Resolution Flow

Variables are resolved with priority: **Bound data row (while one is picked) >
Environment > Collection > Global**

The **engine** owns resolution for anything that is sent (`POST /compose`). The
renderer's `useVariableResolver()` is a preview of the same rules - tab titles,
the variable popover, unresolved-token painting, and, where a caller passes a
picked row (`boundRow`), the bind itself - pinned to the engine's by a
cross-language conformance fixture. See `variable-resolution.md`.

1. `useVariableResolver()` fetches globals, collections, and environments
2. Builds a flat map with resolution priority
3. `resolveString()` replaces `{{variableName}}` with resolved values
4. Used for previews in RequestBuilder, never as the payload

## Build System

### Development

- **Vite**: Dev server on port 5173 with HMR
- **TypeScript**: Type checking and compilation
- **Electron**: Runs renderer process, connects to Vite dev server

### Production

- **Vite Build**: Bundles React app to `dist/`
- **Electron Builder**: Packages app with engine binary
- **Platform Targets**: macOS (DMG), Windows (NSIS), Linux (AppImage/Deb)

## Key Technologies

- **React 19**: UI framework
- **TypeScript**: Type safety - 5.9 compiles and lints, 7 runs the `pnpm type-check` gate (see [building](building.md#two-compilers-one-on-purpose))
- **Electron 28**: Desktop app framework
- **Zustand**: Lightweight state management
- **TanStack Query**: Server state and caching
- **Radix UI**: Accessible component primitives
- **Tailwind CSS**: Utility-first styling
- **Monaco Editor**: Code editing - scripts, JSON body, and GraphQL (with syntax diagnostics, autocomplete, hover, and formatting via `graphql-language-service`)
- **uPlot**: Charts for metrics visualization (all dashboard/history charts centralize on one Canvas primitive; see `modules/dashboard/components/charts/uplot/`)
- **Vite**: Build tool and dev server

## Electron Preload Bridge

The preload script (`electron/preload.ts`) exposes a minimal, context-isolated API bridge via `window.electronAPI`:

- **Engine Management**: `restartEngine()` for engine lifecycle control. Engine liveness is *not* on this bridge - the renderer polls `GET /health` directly (`src/queries/health.ts`), so there is one answer rather than two
- **Theme Management**: `getTheme()`, `setTheme()`, `onThemeChanged()` for OS theme synchronization
- **Window Controls**: `windowMinimize()`, `windowMaximize()`, `windowClose()`, `windowIsMaximized()`, `onWindowMaximized()` for custom titlebar
- **Auto-update**: Listeners for `onUpdateAvailable()`, `onUpdateDownloaded()`, plus `restartToInstallUpdate()`, `openReleasePage()`
- **Menu Integration**: `onOpenSettings()` to receive open-settings commands from the app menu
- **Platform & Paths**: `platform` constant and `getAppPaths()` for OS and directory detection
- **Graceful Shutdown**: `onBeforeQuit()` to allow the renderer to flush state (saves, pending requests) before app termination

## Security Considerations

- **Context Isolation**: Enabled in Electron (renderer cannot access Node.js APIs)
- **No Node Integration**: Renderer runs in isolated context
- **Preload Script**: Minimal IPC bridge through `contextBridge.exposeInMainWorld()`
- **Window Navigation**: The main window refuses any navigation that is not the app's own document and denies `window.open` (`electron/window-navigation.ts`). The preload re-runs on whatever the window navigates to, so this is what keeps `window.electronAPI` off a third-party origin. The app's own document is the entry `file:` URL in production and the dev server's origin in development, where a Vite full reload is a real navigation. Outbound links go to the user's browser through the scheme-validated `openExternalUrl` IPC instead. There is no CSP
- **Local Communication**: Engine runs on localhost only (127.0.0.1:9876)

## Performance Optimizations

- **Code Splitting**: React vendor and charts have their own chunks (`vite.config.ts`), and the rest of the app loads on demand. `Shell` mounts every tab surface except `RequestBuilder` through `React.lazy` behind one Suspense boundary; Monaco (`lib/monaco-loader.ts`), the markdown pipeline (`ui/markdown-renderer.tsx`), the GraphQL body pane and the context bar's GraphQL section each sit behind their own boundary - the last two are what keep `graphql` and `graphql-language-service` off the startup path, since both are reached from surfaces that are otherwise eager. The entry chunk is what the window needs in order to appear - everything else arrives with the tab, editor or description that wants it (#1146)
- **Monaco loads with the first editor, not at startup**: nothing imports `lib/monaco-setup.ts` statically. `ensureMonaco()` brings it in when a `CodeEditor` mounts, which is also what keeps `loader.config({ monaco })` ahead of `@monaco-editor/react`'s `loader.init()` - an `init()` that runs first fetches Monaco from the jsDelivr CDN instead of using the bundled copy. The app-level completion providers subscribe through `useLoadedMonaco()`, which never triggers the load
- **Query Caching**: TanStack Query caches server responses
- **Optimistic Updates**: UI updates immediately, syncs with server
- **Debounced Saves**: Auto-save waits for user to stop typing
- **Metrics Retention**: Dashboard store trims live ticks to the configured window (`liveWindowSeconds`, 5m default) with a `maxRetainedTicks` backstop - a memory bound, not a rendering one
- **Metrics Bucketing**: Charts collapse ticks into `chartBucketSeconds` buckets (0.5s default) before uPlot sees them, so a full window reaches the canvas as a few thousand points
- **Throttled SSE commits**: Every tick is buffered; store commits are throttled to `METRICS_UI_THROTTLE_MS`
