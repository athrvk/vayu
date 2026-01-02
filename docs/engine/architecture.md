# Engine Architecture

**Document Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

The Vayu Engine is a high-performance C++20 daemon optimized for concurrent HTTP execution with integrated JavaScript scripting.

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│        Manager App           │      │          Vayu CLI            │
│      (Electron/React)        │      │        (Thin Client)         │
└──────────────┬───────────────┘      └──────────────┬───────────────┘
               │                                     │
               └──────────────────┬──────────────────┘
                                  │
┌─────────────────────────────────▼──────────────────────────────────┐
│                           Control API                              │
│                     (HTTP Server, Port 9876)                       │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │
┌─────────────────────────────────▼──────────────────────────────────┐
│                        Request Dispatcher                          │
│                      (Queue + Round-robin)                         │
└─────────────────────────────────┬──────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────┐
│       Thread Pool (N = CPU Cores)                 │
├───────────┬───────────────────────────┬───────────┤
│  Worker 0 │  Worker 1                 │  Worker N │
│           │                           │           │
│  curl_    │  curl_multi + select()    │  curl_    │
│  multi    │  Non-blocking I/O         │  multi    │
│           │                           │           │
│  QuickJS  │  Context Pool             │  QuickJS  │
│  Contexts │  (64 pre-allocated)       │  Contexts │
│           │                           │           │
│  Thread   │  Lock-free Statistics     │  Thread   │
│  Stats    │  Atomic counters          │  Stats    │
└───────────┴───────────────────────────┴───────────┘
               │
┌──────────────▼───────────────┐
│      Reporter Thread          │
│  (Aggregates stats ~100ms)    │
└──────────────┬───────────────┘
               │
          SSE Broadcast
     (to Manager application)
```

---

## Components

### HTTP Control Server

**File:** `src/http/server.cpp`

Listens on `127.0.0.1:9876` for commands from the Manager.

**Key Endpoints:**
- `POST /request` - Execute single request (design mode)
- `POST /run` - Start load test (async)
- `GET /run/:id` - Get test status
- `GET /stats/:id` (SSE) - Stream real-time stats
- `POST /run/:id/stop` - Cancel test
- `GET /health` - Health check

---

### Storage Layer (New)

**File:** `src/db/database.cpp`

Embedded SQLite database for persistence of projects, requests, and execution history.

**Schema:**
- **Project Management:** `collections`, `requests`, `environments`
- **Execution:** `runs`, `metrics`, `results`
- **Config:** `kv_store`

**Features:**
- **WAL Mode:** Write-Ahead Logging for high concurrency
- **ORM:** `sqlite_orm` for type-safe C++ access
- **Automatic Logging:** All executions are automatically recorded

---

### Request Dispatcher

Receives commands from HTTP server and distributes work to thread pool.

**Queue Types:**
- **Design Mode:** Single request, wait for response
- **Vayu Mode:** Batch of requests, continuous until duration/iteration limit

---

### Thread Pool

**Files:** `src/http/thread_pool.cpp`, `src/http/event_loop.cpp`

Pool of worker threads (count = CPU cores) that execute requests concurrently.

#### Per-Worker Architecture

Each worker thread runs:

```cpp
while (running) {
    // 1. Get pending requests from queue
    while (auto req = queue.try_pop()) {
        auto handle = curl_easy_new();
        // ... configure handle
        curl_multi_add_handle(multi, handle);
    }
    
    // 2. Perform non-blocking I/O
    curl_multi_perform(multi, &still_running);
    
    // 3. Process completed requests
    for (auto msg : curl_multi_info_read()) {
        if (msg->msg == CURLMSG_DONE) {
            auto response = extract_response(msg->easy_handle);
            
            // Run user script
            script_engine.execute(response);
            
            // Update stats
            stats.requests_total++;
        }
    }
    
    // 4. Sleep on activity (epoll-based)
    curl_multi_wait(multi, timeout=10ms);
}
```

---

### curl_multi Event Loop

**File:** `src/http/client.cpp`

Each worker maintains a `CURLM` handle for multiplexed I/O.

**How It Works:**
1. `curl_easy_setopt()` configures individual request
2. `curl_multi_add_handle()` adds to multiplexor
3. `curl_multi_perform()` drives non-blocking I/O
4. `select()`/`epoll` wakes on socket activity
5. `curl_multi_info_read()` retrieves completions

**Why Not One Socket Per Thread?**
- Thread limit: OS max ~10k threads
- Memory: Each thread ~1MB stack
- curl_multi: One thread, 1000+ sockets

---

### QuickJS Script Engine

**Files:** `src/scripting/engine.cpp`, includes context pool

Executes user test scripts in JavaScript.

#### Context Pool

Pre-allocated pool of 64 QuickJS contexts to avoid allocation overhead:

```cpp
class ContextPool {
    std::vector<JSContext*> contexts;  // Pre-allocated
    std::queue<JSContext*> available;  // Lock-free
    
    JSContext* acquire() {
        if (available.try_pop(ctx)) {
            return ctx;
        }
        return create_context();  // Fallback
    }
    
    void release(JSContext* ctx) {
        available.push(ctx);
    }
};
```

#### Script Binding

Exposes `pm` object to JavaScript:

```javascript
pm.response.code      // HTTP status
pm.response.body      // Response body
pm.response.headers   // Response headers
pm.response.time      // Latency in ms

pm.request.method     // HTTP method
pm.request.url        // Full URL
pm.request.headers    // Request headers

pm.test("name", () => {
    pm.expect(value).to.equal(expected);
});
```

---

### Statistics Collection

**File:** `src/http/event_loop.cpp`

Each worker maintains thread-local statistics to avoid mutex contention:

```cpp
struct ThreadStats {
    std::atomic<uint64_t> requests_total{0};
    std::atomic<uint64_t> requests_success{0};
    std::atomic<uint64_t> requests_failed{0};
    
    // Latency histogram: 1ms buckets, 0-1000ms
    std::array<std::atomic<uint64_t>, 1001> latency{};
};
```

Every 100ms, the Reporter Thread aggregates all worker stats and broadcasts via SSE.

---

## Storage Layer (New)

### Technology Stack

- **Database:** SQLite 3 (Embedded, Serverless)
- **ORM:** `sqlite_orm` (Modern C++20 wrapper)
- **Location:** `vayu.db` (in executable directory)

### Why SQLite?

1.  **Embedded:** No external dependencies or server process required.
2.  **Reliable:** ACID compliance ensures state consistency (e.g., run status).
3.  **JSON Support:** Native support for storing request/response bodies.
4.  **Performance:** WAL (Write-Ahead Logging) mode supports high concurrency.

### Schema Design

#### 1. `runs` Table
Stores the state and configuration of each test execution.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | Unique Run ID (e.g., "run_123") |
| `status` | TEXT | `pending`, `running`, `completed`, `failed` |
| `start_time` | INTEGER | Unix timestamp |
| `end_time` | INTEGER | Unix timestamp |
| `config` | TEXT (JSON) | Full load test configuration |

#### 2. `metrics` Table
Time-series data points for reporting.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK) | Auto-increment |
| `run_id` | TEXT (FK) | Link to `runs` table |
| `timestamp` | INTEGER | Metric time |
| `rps` | INTEGER | Requests per second |
| `latency_p50` | REAL | Median latency |
| `latency_p99` | REAL | 99th percentile latency |
| `errors` | INTEGER | Error count in this interval |

#### 3. `results` Table
Detailed request/response logs (only for failures or sampling).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK) | Auto-increment |
| `run_id` | TEXT (FK) | Link to `runs` table |
| `request` | TEXT (JSON) | Full request object |
| `response` | TEXT (JSON) | Full response object |
| `error` | TEXT | Error message (if any) |

#### 4. `kv_store` Table
Global engine configuration.

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT (PK) | Config key (e.g., "max_workers") |
| `value` | TEXT | Config value |

### Persistence Strategy

1.  **WAL Mode:** Enabled for better concurrency (readers don't block writers).
2.  **Batching:** Metrics are buffered in memory and flushed to DB every 100ms-1s to avoid I/O bottlenecks.
3.  **Sync Schema:** `sqlite_orm` automatically handles schema creation and migration on startup.

---

## Request Execution Flow

### Design Mode (Single Request)

```
[HTTP POST /request]
        │
        ├─► Validate JSON
        │
        ├─► Create curl_easy handle
        │
        ├─► Add to curl_multi
        │
        ├─► Wait for completion
        │
        ├─► Run test script
        │
        └─► Return response (HTTP 200)
```

### Vayu Mode (Load Test)

```
[HTTP POST /run]
        │
        ├─► Validate JSON
        │
        ├─► Allocate resources (return 202 Accepted)
        │
        ├─► Distribute requests round-robin to workers
        │
        ├─► Each worker: curl_multi_perform loop
        │
        ├─► On completion: Run script, update stats
        │
        ├─► Reporter: Aggregate stats every 100ms → SSE broadcast
        │
        └─► On stop/timeout: Wait for in-flight requests, return summary
```

---

## Performance Characteristics

### Throughput

- **Single thread:** ~1,000 RPS (network latency dependent)
- **8-core system:** ~8,000-10,000 RPS  
- **Theoretical limit:** One handle per 1-2ms latency

### Memory

- **Baseline:** ~50 MB (contexts, buffers)
- **Per in-flight request:** ~2-5 KB (metadata)
- **10k concurrent:** ~20-50 MB total

### Latency

- **Startup:** <100ms
- **Request execution:** Network time + script time (typically 1-2ms)
- **Stats aggregation:** 100ms intervals

---

## Concurrency Model

### Why Event-Driven?

Traditional 1-thread-per-request fails at scale:

| Metric | Traditional | Event-Driven |
|--------|-------------|--------------|
| Max Connections | ~10,000 | 100,000+ |
| Memory per Request | 1 MB (stack) | <5 KB |
| Context Switches | Frequent | Rare |
| Latency Variance | High | Low |

### Lock-Free Design

Stats are updated lock-free:

```cpp
// Worker thread (no locks)
stats.requests_total.fetch_add(1, std::memory_order_relaxed);
stats.latency[bucket].fetch_add(1, std::memory_order_relaxed);

// Reporter thread (lock-free read)
auto total = stats.requests_total.load(std::memory_order_relaxed);
```

---

---

## CLI vs HTTP API: Execution Paths

### CLI Execution Path (`vayu-cli`)

```
vayu-cli run <file>
    ↓
    Parse JSON request
    ↓
    HTTP Client (libcurl)
    ↓
    Process response
    ↓
    Execute tests (QuickJS)
    ↓
    Display results
```

**Characteristics:**
- Direct binary execution
- Synchronous request/response
- No daemon required
- Per-command invocation
- Suitable for: Scripts, CI/CD pipelines, one-off requests
- Load testing: `batch` command with configurable concurrency

### CLI Batch Execution Path (`vayu-cli batch`)

```
vayu-cli batch <files...>
    ↓
    Parse all JSON requests
    ↓
    EventLoop::execute_batch()
    ├── curl_multi for async I/O
    ├── Thread pool coordination
    └── Non-blocking request handling
    ↓
    Collect response data
    ↓
    Display summary statistics
```

**Characteristics:**
- Concurrent request execution
- Event loop-based (curl_multi)
- Non-blocking I/O
- Per-request test execution
- Concurrent limit: `--concurrency N` (default 10)
- Throughput: 28+ RPS demonstrated on standard hardware

### HTTP API Load Testing Path (`vayu-engine` daemon) ✅ Phase 1 Complete

```
HTTP Client
    ↓
    GET /health, POST /request, GET /config
    ↓
    Engine HTTP Server (127.0.0.1:9876)
    ↓
    Request Handler
    ├── Parse JSON request
    ├── Validate structure
    ├── Log to DB (runs table)
    └── Execute immediately (synchronous)
    ↓
    HTTP Client (libcurl)
    ├── Non-blocking I/O
    ├── Connection pooling
    └── Timing metrics collection
    ↓
    Response back to client
    ├── Full response with timing
    ├── Test results if defined
    └── JSON formatted
    ↓
    Log Result to DB (results table)
```

**Implemented Endpoints:**
- ✅ `GET /health` - Server status (version, workers, uptime)
- ✅ `POST /request` - Single request execution (Design Mode)
- ✅ `GET /config` - Configuration and system limits
- ✅ `GET /runs` - List execution history
- ✅ `GET /run/:id` - Get run details
- ✅ `POST /run/:id/stop` - Stop active run
- ✅ `GET /stats/:id` - Get run metrics

### HTTP API Load Testing Path (🔨 Phase 2 - In Progress)

The `/run` endpoint has been added to the server and creates a DB entry, but full async execution logic is pending:

```cpp
// Current state in daemon.cpp:
server.Post("/run", [](const httplib::Request &req, httplib::Response &res) {
    // Creates "pending" run in DB
    // Returns runId immediately
    // TODO: Dispatch to worker pool
});
```

When Phase 2 is fully implemented, `POST /run` will support:

```
HTTP Client
    ↓
    POST /run
    ├── config: { concurrency, rps, duration }
    └── request: { method, url, ... }
    ↓
    Returns immediately with runId (202 Accepted)
    ↓
    Client polls GET /run/:id OR streams GET /stats/:id (SSE)
    ↓
    Real-time metrics via SSE
    ├── RPS updates (~100ms)
    ├── Latency percentiles
    ├── Error categorization
    └── Throughput metrics
    ↓
    Final results on completion
```

**Implementation Roadmap:**
1. **Phase 2.1** - Load test queue and async execution
2. **Phase 2.2** - Real-time statistics collection
3. **Phase 2.3** - SSE streaming and metrics aggregation
4. **Phase 2.4** - Advanced features (ramp-up, ramp-down, RPS limiting)

### Feature Comparison

| Feature | CLI run | CLI batch | HTTP /request | HTTP /run (Phase 2) |
|---------|---------|-----------|---------------|---------------------|
| Single request | ✅ | ❌ | ✅ | ✅ |
| Batch requests | ❌ | ✅ | ❌ | ✅ |
| Concurrent execution | ❌ | ✅ | ❌ | ✅ |
| Test scripts | ✅ | ✅ | ✅ | ✅ |
| Configurable concurrency | ❌ | ✅ | ❌ | ✅ |
| RPS limiting | ❌ | ❌ | ❌ | ✅ |
| Real-time metrics | ❌ | Summary only | ❌ | ✅ SSE |
| Latency percentiles | ❌ | Average | ❌ | ✅ |
| Current Status | ✅ Ready | ✅ Ready | ✅ Ready | 🔨 In Progress |
| Access method | CLI | CLI | HTTP | HTTP |

### Recommendation for Load Testing

**Until Phase 2 is available:**
- Use `vayu-cli batch` command for concurrent request execution
- Supports configurable concurrency: `--concurrency 100`
- Built-in summary statistics and per-request details

**When Phase 2 is available:**
- Use HTTP API `POST /run` for async load testing
- Stream results in real-time with `GET /stats/:id` (SSE)
- Access advanced metrics (percentiles, error categorization)

---

## Security

### JavaScript Sandbox

QuickJS contexts cannot:
- Access filesystem
- Make network requests (except via provided pm API)
- Access memory outside sandbox

### Local-Only API

```cpp
server.listen("127.0.0.1", 9876);  // Not 0.0.0.0
```

### No Script Persistence

Scripts are never saved to disk, only executed in-memory.

---

## Build Configuration

See [Building Engine](building.md) for compilation instructions.

**CMake Options:**
- `CMAKE_BUILD_TYPE` - Debug/Release
- `VAYU_BUILD_TESTS` - Include test suite
- `VAYU_USE_ASAN` - Address sanitizer
- `VAYU_USE_TSAN` - Thread sanitizer

---

## Troubleshooting

### High CPU Usage

- Check script complexity (O(n) in request body)
- Profile with `perf record ./vayu-engine`

### Memory Growth

- Check for script memory leaks (circular references)
- Monitor with `valgrind --leak-check=full`

### Hanging Requests

- Increase timeout with `config.timeout`
- Check `curl --verbose` to diagnose

---

*See: [CLI Reference](cli.md) | [API Reference](api-reference.md) | [Building](building.md) →*
