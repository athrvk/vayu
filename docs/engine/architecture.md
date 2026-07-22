# Vayu Engine Architecture

**Version:** 0.3.0  
**Last Updated:** June 2026

## Overview

The Vayu Engine is a high-performance C++ daemon that executes HTTP requests and load tests. It uses a sidecar architecture pattern, running as a separate process from the Electron UI and communicating via HTTP on `localhost:9876` (configurable).

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Vayu Engine (C++)                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐      ┌─────────────────────────────┐  │
│  │  HTTP Server     │      │      Event Loop             │  │
│  │ (cpp-httplib)    │      │    (curl_multi)             │  │
│  │  Port: 9876      │      │  • Multi-worker              │  │
│  │                  │      │  • Lock-free SPSC queues     │  │
│  └────────┬─────────┘      │  • Rate limiting             │  │
│           │                └──────────┬──────────────────┘  │
│           │                           │                      │
│           ▼                           ▼                      │
│  ┌──────────────────┐      ┌─────────────────────────────┐  │
│  │  Route Handlers  │      │    Metrics Collector        │  │
│  │  • Collections   │      │  • In-memory aggregation     │  │
│  │  • Requests      │      │  • Batch DB writes           │  │
│  │  • Environments  │      │  • Real-time stats           │  │
│  │  • Execution     │      └──────────┬──────────────────┘  │
│  │  • Metrics       │                 │                      │
│  └────────┬─────────┘                 ▼                      │
│           │                ┌─────────────────────────────┐  │
│           ▼                │   Script Engine (QuickJS)   │  │
│  ┌──────────────────┐      │  • Pre-request scripts      │  │
│  │  Run Manager     │      │  • Test scripts             │  │
│  │  • Active runs   │      │  • Postman-compatible API   │  │
│  │  • Lifecycle     │      └─────────────────────────────┘  │
│  └────────┬─────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           SQLite Database (sqlite_orm)                 │ │
│  │  • Collections  • Requests  • Environments            │ │
│  │  • Runs         • Metrics   • Results                 │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### HTTP Server (`cpp-httplib`)

The HTTP server handles all API requests from the Electron UI. It runs on `127.0.0.1:9876` by default (configurable via `--port`).

**Key Features:**
- RESTful API endpoints for collections, requests, environments, and runs
- Server-Sent Events (SSE) for real-time metrics streaming
- Single-threaded request handling (non-blocking I/O)

### Event Loop (`curl_multi`)

The event loop manages concurrent HTTP request execution using libcurl's multi interface.

**Architecture:**
- **Multi-worker design**: One event loop per CPU core (auto-detected)
- **SPSC queues**: Lock-free single-producer single-consumer queues for request submission
- **Rate limiting**: Token bucket algorithm for precise RPS control
- **Connection pooling**: Reuses connections with keep-alive
- **DNS caching**: 5-minute cache to avoid resolver saturation

**Configuration:**
- Max concurrent requests per worker: 1000 (configurable)
- Max connections per host: 100
- Poll timeout: 10ms
- TCP keep-alive: 60s idle, 30s probe interval

### Run Manager

Manages the lifecycle of load test runs:

- **Run registration**: Tracks active runs by ID
- **Run context**: Stores configuration, event loop, metrics collector, and an in-memory
  **tick topic** (ring of wire-ready metric snapshots) per run
- **Retained finished runs**: Completed/failed/stopped runs are moved to a separate retained
  map rather than unregistered immediately, so a late SSE client still receives the full metric
  series. A TTL sweep evicts them after `liveRetentionMs` (default 60s).
- **Graceful shutdown**: Stops active runs on daemon shutdown

### Metrics Collector

High-performance in-memory metrics collection optimized for 60k+ RPS:

- **Pre-allocated storage**: Avoids reallocation during tests
- **Lock-free atomics + HdrHistogram**: Zero-contention counter updates; latency recorded in a
  lock-free HdrHistogram (µs resolution)
- **Perceived latency**: Latency is measured as `completion − submitted_at` (the full time a
  request spent inside the engine), not just libcurl's wire time. Wire time and the
  generator-internal `queue_wait` are tracked separately.
- **Rich counters**: bytes sent/received, dropped requests (backpressure), queue-wait average,
  peak in-flight, and a full per-status-code distribution
- **Batch DB writes**: Per-request results written after test completion; per-tick time-series
  metrics persisted by the metrics thread during the run
- **Error preservation**: All errors stored, success results sampled
- **Response sampling**: Stores samples for deferred script validation

### Script Engine (`QuickJS`)

JavaScript execution engine for pre-request and test scripts:

- **Postman-compatible API**: `pm.test()`, `pm.expect()`, `pm.response`, etc.
- **Memory limit**: 64MB per script execution
- **Timeout**: 5 seconds per script
- **Sandboxed**: No filesystem or network access

**Platform Support:**
- **Linux/macOS**: Original QuickJS
- **Windows**: QuickJS-NG (MSVC-compatible fork)

### Auth Resolution & OAuth 2.0

The engine resolves request auth server-side - the persisted `auth` object is
applied to the outgoing request rather than being left to the UI. This lives in
`vayu_core` (so both the design and load paths share it):

- **`request_builder`** (`build_request`) - the single request-construction
  pipeline: deserialize the payload, apply the resolved timeout, then resolve
  auth. Both `POST /request` and `POST /run` go through it.
- **`auth_resolver`** (`apply_auth` / `preflight_auth`) - a typed `Auth` variant
  with an exhaustive per-mode handler: bearer/basic/api-key are injected inline;
  `oauth2` delegates to the token client. A user-supplied `Authorization` header
  always wins.
- **`oauth_client`** (`acquire_token`) - grant handling (client_credentials,
  password, authorization_code), the [`oauth_tokens`](db-schema.md#oauth_tokens)
  cache (45s expiry skew, refresh-token rotation), and RFC 6749 client auth. It
  never logs token bodies/headers.
- **`oauth_authorize`** - the interactive Authorization Code manager: an
  engine-hosted `127.0.0.1` loopback listener + PKCE (S256) and `state`, so the
  entire flow (including the code exchange) stays in-process; the app only opens
  the browser. Owned by the `Server` for a clean shutdown.

PKCE hashing uses the vendored MIT **picosha2** single-header (no OpenSSL). See
the [API reference](api-reference.md#authentication) for the `/oauth2/*` routes.

### Request composition boundary (client-side today)

The engine composes a request only **partway**. On `POST /request` it loads the
environment, globals, and the request's collection variables (into the QuickJS
script context), resolves/applies concrete auth, and runs the pre/post scripts -
but it does **not**:

- interpolate `{{variables}}` into the URL / headers / body (no `{{}}` handling
  exists anywhere in `engine/`),
- resolve `inherit` auth by walking the collection ancestor chain (`parse_auth`
  drops `{"mode":"inherit"}` as "resolved app-side"), or
- compose the collection-chain pre/post scripts with the request's own.

Those three steps are done **client-side**, so they are duplicated in the app
renderer and the MCP layer (`app/electron/mcp/resolve.ts`). Consolidating them
into the engine - so clients pass a `requestId` + `environmentId` and the engine
composes - is a deferred maintainability item: see
`docs/plans/pending-backlog.md` → **A1**. Do not start it without an explicit ask.

### Database (`SQLite`)

Persistent storage using sqlite_orm:

**Schema:**
- `collections`: Folder hierarchy for organizing requests
- `requests`: Saved HTTP requests with headers, body, scripts
- `environments`: Variable sets for different environments
- `globals`: Singleton global variables
- `runs`: Test execution records (design mode or load test)
- `metrics`: Time-series metrics (RPS, latency percentiles, bytes, dropped, status codes, …)
- `results`: Individual request results (errors + sampled successes)
- `oauth_tokens`: Cached OAuth 2.0 access/refresh tokens (keyed by config identity)
- `config_entries`: Engine configuration registry (read/written via `/config`)

See [Database Schema](db-schema.md) for the full column list.

## Request Flow

### Design Mode (Single Request)

```
1. POST /request
   ↓
2. Build request: parse JSON + apply timeout + resolve auth (bearer/basic/
   apikey/oauth2). Auth is resolved BEFORE the script so pm.request is accurate
   ↓
3. Create Run record (type: Design)
   ↓
4. Execute pre-request script (if provided)
   ↓
5. Send HTTP request via libcurl
   ↓
6. Execute test script (if provided)
   ↓
7. Save result to database
   ↓
8. Return response with test results
```

### Load Test Mode

```
1. POST /run
   ↓
2. Parse config + pre-flight auth (oauth2 tokens acquired & cache warmed;
   409 up front if interactive sign-in is required)
   ↓
3. Create Run record (type: Load)
   ↓
4. Create RunContext with EventLoop
   ↓
5. Start worker thread (execute_load_test)
   ↓
6. Start metrics thread (collect_metrics)
   ↓
7. Strategy submits requests via SPSC queue → event loop
   ↓
8. Metrics collector aggregates results in-memory; metrics thread
   writes per-tick snapshots into the retained tick topic + DB
   ↓
9. Client streams ticks via SSE (/metrics/live/:runId), replayed
   from offset 0 then tailed to the `complete` event
   ↓
10. On completion: batch-write results to DB; run retained (TTL) so
    late clients still get the full series
```

## Load Test Strategies

Four load test modes are supported (`LoadTestType` in `types.hpp`). Three are **closed-loop** -
the engine holds in-flight requests at a target and issues a new request as each completes, so
throughput is a *result* (`concurrency ÷ latency`), not an input. One is **open-loop**.

### 1. `constant_rps` (open-loop)

Dispatches at a fixed `targetRps` regardless of how fast responses return. `maxInFlight` caps how
many requests may be outstanding before new ones are dropped (and counted as `dropped_requests`).

```json
{ "mode": "constant_rps", "targetRps": 1000, "duration": "60s", "maxInFlight": 10000 }
```

### 2. `constant_concurrency` (closed-loop)

Holds a constant number of in-flight requests for the duration via the shared
`maintain_concurrency` controller.

```json
{ "mode": "constant_concurrency", "concurrency": 100, "duration": "60s" }
```

### 3. `ramp_up` (closed-loop)

Interpolates the concurrency target from `startConcurrency` to `concurrency` over
`rampUpDuration`, then holds for the remainder of `duration` (which is **total** test time).

```json
{ "mode": "ramp_up", "startConcurrency": 1, "concurrency": 100,
  "rampUpDuration": "10s", "duration": "60s" }
```

### 4. `iterations` (closed-loop, bounded)

Issues a fixed total number of requests at the target concurrency, then stops - exact count at
run end.

```json
{ "mode": "iterations", "concurrency": 10, "iterations": 1000 }
```

### Closed-loop controller

`constant_concurrency`, `ramp_up`, and `iterations` share a `maintain_concurrency` loop driven by
a pure `compute_refill_deficit` primitive: each tick, refill exactly `target − in_flight` new
requests (where `in_flight = requests_sent − completed`). On stop the controller is notified for
prompt cancellation rather than waiting for in-flight requests to drain.

## Thread Model

- **Main Thread**: HTTP server, request routing
- **Worker Threads**: One per active load test (executes load strategy)
- **Metrics Thread**: One per active load test (aggregates and streams metrics)
- **Event Loop Threads**: One per CPU core (handles curl_multi I/O)

## Performance Characteristics

- **Throughput**: 60,000+ requests per second (on capable hardware)
- **Latency**: P99 < 50ms overhead
- **Memory**: Pre-allocated buffers minimize allocations during tests
- **Database**: Batch writes avoid contention during high-RPS tests

## Configuration

Default configuration values (from `constants.hpp`):

| Setting | Default | Description |
|---------|---------|-------------|
| Port | 9876 | HTTP server port |
| Max Concurrent | 1000 | Per worker event loop |
| Max Per Host | 100 | Connections per hostname |
| Poll Timeout | 10ms | Event loop poll interval |
| DNS Cache | 300s | DNS cache timeout |
| Script Memory | 64MB | QuickJS memory limit |
| Script Timeout | 5s | Script execution timeout |
| Stats Interval | 100ms | Metrics collection interval |

## Data Directory Structure

```
data/
├── db/
│   └── vayu.db          # SQLite database
├── logs/
│   └── vayu_*.log       # Rotating log files
└── vayu.lock            # Single-instance lock file
```

## Security

- **Local-only binding**: Server only listens on `127.0.0.1`
- **Script sandboxing**: QuickJS contexts have no filesystem/network access
- **Single instance**: File lock prevents multiple daemon instances
- **Secret handling (v1 posture)**: auth credentials and cached OAuth 2.0 tokens
  are stored in **plaintext** in SQLite; `runs.config_snapshot` redacts its
  `auth` object to `{mode}` before persistence; and curl verbose logs redact the
  values of sensitive headers (`Authorization`, cookies, etc.). Token request
  bodies/responses are never logged. On-disk encryption (`safeStorage`) and
  mid-run token refresh are deferred.

## Dependencies

- **libcurl**: HTTP client library
- **cpp-httplib**: HTTP server library
- **nlohmann-json**: JSON parsing/serialization
- **sqlite3**: Embedded database
- **sqlite-orm**: C++ ORM for SQLite
- **QuickJS**: JavaScript engine (vendored)
- **picosha2**: SHA-256 single-header for PKCE (vendored, MIT)
