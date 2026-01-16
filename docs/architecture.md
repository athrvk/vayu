# Vayu System Architecture

Vayu uses a **Sidecar Architecture** that decouples the user interface from the execution engine. This separation allows each component to be optimized for its specific purpose:

- **The Manager** (Electron/React): Optimized for user experience
- **The Engine** (C++): Optimized for raw performance

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Vayu Application                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────┐      ┌─────────────────────────────┐  │
│  │     THE MANAGER         │      │        THE ENGINE           │  │
│  │   (Electron + React)    │      │          (C++)              │  │
│  │                         │      │                             │  │
│  │  ┌───────────────────┐  │      │  ┌───────────────────────┐  │
│  │  │   Request Builder │  │      │  │    HTTP Server         │  │
│  │  │   Response Viewer │  │ HTTP │  │    (cpp-httplib)        │  │
│  │  │   Dashboard       │◄─┼──────┼─►│    Port: 9876           │  │
│  │  │   Collections     │  │      │  └───────────────────────┘  │  │
│  │  └───────────────────┘  │      │             │               │  │
│  │           │             │      │             ▼               │  │
│  │           │             │      │  ┌───────────────────────┐  │
│  │           ▼             │      │  │    Thread Pool        │  │
│  │  ┌───────────────────┐  │      │  │  ┌─────┐ ┌─────┐     │  │
│  │  │   Sidecar Manager │  │      │  │  │ W1  │ │ W2  │ ... │  │
│  │  │   (spawn/kill)    │  │      │  │  └──┬──┘ └──┬──┘     │  │
│  │  └───────────────────┘  │      │  └─────┼──────┼─────────┘  │
│  │                         │      │        │      │            │
│  └─────────────────────────┘      │        ▼      ▼            │
│                                   │  ┌───────────────────────┐  │
│                                   │  │  Event Loop          │  │
│                                   │  │  (curl_multi)        │  │
│                                   │  └───────────────────────┘  │
│                                   │             │               │
│                                   │             ▼               │
│                                   │  ┌───────────────────────┐  │
│                                   │  │  Script Engine        │  │
│                                   │  │  (QuickJS)            │  │
│                                   │  └───────────────────────┘  │
│                                   │             │               │
│                                   │             ▼               │
│                                   │  ┌───────────────────────┐  │
│                                   │  │  SQLite Database      │  │
│                                   │  │  (Collections, Runs)  │  │
│                                   │  └───────────────────────┘  │
│                                   │                             │
│                                   └─────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## The Manager (Electron + React)

The Manager is the "face" of Vayu—a standard Electron application that provides the graphical interface.

**Key Responsibilities:**
- Request building and editing
- Collection management
- Environment variable management
- Real-time load test dashboard
- Run history viewing

**Technology Stack:**
- **Electron 28**: Desktop app framework
- **React 19**: UI framework
- **TypeScript 5**: Type safety
- **Zustand**: UI state management
- **TanStack Query**: Server state and caching
- **Radix UI**: Accessible component primitives
- **Tailwind CSS**: Styling

See [App Architecture](app/architecture.md) for detailed information.

## The Engine (C++)

The Engine is the "muscle"—a headless daemon optimized for maximum I/O throughput.

**Key Responsibilities:**
- HTTP request execution (libcurl)
- Load test orchestration
- Script execution (QuickJS)
- Metrics collection
- Data persistence (SQLite)

**Technology Stack:**
- **C++20**: Core language
- **cpp-httplib**: HTTP server
- **libcurl**: HTTP client (HTTP/1.1, HTTP/2, HTTP/3)
- **QuickJS**: JavaScript engine for scripts
- **SQLite**: Embedded database
- **sqlite_orm**: C++ ORM

See [Engine Architecture](engine/architecture.md) for detailed information.

## Communication Protocol

The Manager communicates with the Engine via a localhost HTTP API on port 9876.

### Request/Response Flow

```
Manager                              Engine
   │                                    │
   │  POST /request                     │
   │  {method, url, headers, body}      │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK                            │
   │  {status, headers, body, timing}   │
   │◄───────────────────────────────────┤
```

### Load Test Flow

```
Manager                              Engine
   │                                    │
   │  POST /run                         │
   │  {request, mode, duration, ...}   │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK {runId}                    │
   │◄───────────────────────────────────┤
   │                                    │
   │  GET /metrics/live/{runId} (SSE)   │
   ├───────────────────────────────────►│
   │                                    │
   │  event: metrics                    │
   │  data: {rps, latency, ...}         │
   │◄───────────────────────────────────┤
   │                          (repeated) │
   │  event: complete                   │
   │◄───────────────────────────────────┤
   │                                    │
   │  GET /run/{runId}/report           │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK {summary, latency, ...}    │
   │◄───────────────────────────────────┤
```

See [Engine API Reference](engine/api-reference.md) for complete endpoint documentation.

## Sidecar Pattern

The Engine runs as a separate process managed by the Electron main process:

1. **Engine Startup**: Electron spawns the `vayu-engine` binary on app launch
2. **Health Monitoring**: Manager polls `/health` endpoint to verify connectivity
3. **Graceful Shutdown**: Engine is stopped when Electron app quits

**Development vs Production:**
- **Development**: Engine binary at `engine/build/vayu-engine`
- **Production**: Engine binary packaged in `Vayu.app/Contents/Resources/bin/vayu-engine`

See [App Architecture - Sidecar](app/architecture.md#engine-sidecar-electronsidecarts) for implementation details.

## Data Flow

### Single Request Execution

1. User builds request in RequestBuilder
2. Variables resolved in frontend (`{{baseUrl}}` → `https://api.example.com`)
3. Manager sends `POST /request` to Engine
4. Engine executes HTTP request via libcurl
5. Engine runs pre-request script (if provided)
6. Engine runs test script (if provided)
7. Engine returns response with timing and test results
8. Manager displays response in ResponseViewer

### Load Test Execution

1. User configures load test (mode, duration, concurrency)
2. Manager sends `POST /run` to Engine
3. Engine starts load test and returns `runId`
4. Manager connects to SSE stream (`/metrics/live/{runId}`)
5. Engine streams real-time metrics (RPS, latency, errors)
6. Manager updates dashboard in real-time
7. When test completes, Manager fetches final report (`/run/{runId}/report`)

### Variable Resolution

Variables are resolved with priority: **Environment > Collection > Global**

1. Manager fetches globals, collections, and environments
2. Builds flat map with resolution priority
3. Replaces `{{variableName}}` patterns in URL, headers, body
4. Resolved request sent to Engine

## Security

- **Script Sandboxing**: QuickJS contexts are isolated with no filesystem or network access
- **Local-Only Communication**: Control API only binds to `127.0.0.1:9876`
- **Context Isolation**: Electron renderer runs in isolated context (no Node.js access)
- **No Cloud Sync**: All data stored locally in SQLite database

## Performance Characteristics

- **Engine**: Capable of 10,000+ requests per second (depending on target server)
- **Lock-Free Design**: High-performance metrics collection with minimal contention
- **Async I/O**: Uses `curl_multi` for concurrent request handling
- **Efficient Caching**: TanStack Query caches server responses in Manager

## File Locations

### Development

- **Engine Binary**: `engine/build/vayu-engine`
- **Engine Data**: `engine/data/` (database, logs)
- **App Source**: `app/src/`
- **App Build**: `app/dist/`

### Production

- **macOS**: `Vayu.app/Contents/Resources/bin/vayu-engine`
- **Windows**: `resources/bin/vayu-engine.exe`
- **Linux**: `resources/bin/vayu-engine`
- **Data Directory**:
  - macOS: `~/Library/Application Support/vayu/`
  - Windows: `%APPDATA%/vayu/`
  - Linux: `~/.config/vayu/`

---

*See: [Engine Architecture](engine/architecture.md) | [App Architecture](app/architecture.md) | [Engine API Reference](engine/api-reference.md)*
