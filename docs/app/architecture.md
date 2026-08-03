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
- **Health Checking**: Polls `/health` endpoint to verify engine readiness
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
│   ├── graphql/        # GraphQL support: diagnostics, introspection, schema cache, Monaco providers, variables JSON Schema
│   ├── monaco-setup.ts # Monaco local-bundle config + GraphQL provider registration (imported once in main.tsx)
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
   - `lib/graphql/schema-cache.ts`: Introspected GraphQL schema cache keyed by endpoint URL
   - Module-local stores (e.g., `modules/collections/collections-store.ts`) co-locate with their feature

2. **TanStack Query** (`queries/`): Server state, caching, synchronization
   - Collections, Requests, Environments, Globals
   - Runs, Health checks
   - Automatic caching, refetching, and optimistic updates

#### Services Layer

- **`api.ts`**: HTTP client wrapper for all engine API endpoints
  - Transforms between frontend (snake_case) and backend (camelCase) formats
  - Handles error transformation and user-friendly messages

- **`sse-client.ts`**: Server-Sent Events client for real-time metrics
  - Connects to `/runs/:runId/live` (replayable tick topic - no attach race)
  - No custom reconnect loop: the engine sends an explicit `complete` event, so `CLOSED` is terminal and transient errors are left to the browser's `EventSource` retry
  - Parses and forwards metrics to dashboard store

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

### Variable Resolution Flow

Variables are resolved with priority: **Environment > Collection > Global**

The **engine** owns resolution for anything that is sent (`POST /compose`). The
renderer's `useVariableResolver()` is a preview of the same rules - tab titles,
the variable popover, unresolved-token painting - pinned to the engine's by a
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
- **TypeScript 5**: Type safety
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

- **Engine Management**: `restartEngine()`, `getEngineStatus()` for engine lifecycle control
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
- **Local Communication**: Engine runs on localhost only (127.0.0.1:9876)

## Performance Optimizations

- **Code Splitting**: React vendor and charts split into separate chunks
- **Query Caching**: TanStack Query caches server responses
- **Optimistic Updates**: UI updates immediately, syncs with server
- **Debounced Saves**: Auto-save waits for user to stop typing
- **Metrics Retention**: Dashboard store trims live ticks to the configured window (`liveWindowSeconds`, 5m default) with a `maxRetainedTicks` backstop - a memory bound, not a rendering one
- **Metrics Bucketing**: Charts collapse ticks into `chartBucketSeconds` buckets (0.5s default) before uPlot sees them, so a full window reaches the canvas as a few thousand points
- **Throttled SSE commits**: Every tick is buffered; store commits are throttled to `METRICS_UI_THROTTLE_MS`
