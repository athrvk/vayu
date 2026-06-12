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
   - `session-store.ts`: User session, theme preferences
   - `engine-store.ts`: Engine health, connectivity status
   - `dashboard-store.ts`: Load test metrics (limited to 3,000 historical points per run), streaming state
   - `response-store.ts`: Response viewer state (expand/collapse, scroll position)
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
  - Connects to `/metrics/live/:runId` (replayable tick topic — no attach race)
  - No custom reconnect loop: the engine sends an explicit `complete` event, so `CLOSED` is terminal and transient errors are left to the browser's `EventSource` retry
  - Parses and forwards metrics to dashboard store

- **`http-client.ts`**: Low-level fetch wrapper
  - Request/response transformation
  - Error handling and timeout management
  - Base URL configuration

#### Custom Hooks

- **`useEngine()`**: Execute requests and start load tests
- **`useSSE()`**: Connect to metrics stream for active load tests
- **`useVariableResolver()`**: Resolve `{{variables}}` in strings/objects
- **`useSaveManager()`**: Auto-save orchestration with debouncing

## Data Flow

### Request Execution Flow

1. User clicks "Send" in RequestBuilder
2. `useEngine().executeRequest()` is called
3. Variables are resolved via `useVariableResolver()`
4. Request is transformed to backend format (camelCase)
5. `apiService.executeRequest()` sends `POST /request` to engine
6. Response is transformed back to frontend format (snake_case)
7. Response is displayed in ResponseViewer

### Load Test Flow

1. User configures load test and clicks "Start Load Test"
2. `useEngine().startLoadTest()` sends `POST /run` to engine
3. Engine returns `runId`
4. `useDashboardStore().startRun()` initializes dashboard state
5. `useSSE()` connects to `/metrics/live/:runId` SSE endpoint
6. Metrics stream in real-time and update dashboard
7. When test completes, final report is fetched via `GET /run/:id/report`

### Variable Resolution Flow

Variables are resolved with priority: **Environment > Collection > Global**

1. `useVariableResolver()` fetches globals, collections, and environments
2. Builds a flat map with resolution priority
3. `resolveString()` replaces `{{variableName}}` with resolved values
4. Used in RequestBuilder before sending requests

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
- **Monaco Editor**: Code editing — scripts, JSON body, and GraphQL (with syntax diagnostics, autocomplete, hover, and formatting via `graphql-language-service`)
- **Recharts**: Charts for metrics visualization
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
- **Metrics Limiting**: Dashboard store caps historical metrics to 3,000 points per run (`HISTORICAL_METRICS_CAP` in `config/metrics.ts`)
- **Metrics Downsampling**: Charts downsample beyond 2,000 points to avoid render thrashing
