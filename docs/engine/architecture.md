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
│                         EventLoop                                  │
│               (Round-robin sharding to workers)                    │
│              10k-50k RPS with token-bucket rate limiting           │
└─────────────────────────────────┬──────────────────────────────────┘
               │
    ┌──────────┼──────────┬─────────────┐
    │          │          │             │
┌───▼──────┐ ┌▼─────────┐ ┌▼──────────┐ ┌▼──────────┐
│ Worker 0 │ │ Worker 1 │ │ Worker 2  │ │ Worker N  │
├──────────┤ ├──────────┤ ├───────────┤ ├───────────┤
│ CURLM*   │ │ CURLM*   │ │ CURLM*    │ │ CURLM*    │
│ Queue    │ │ Queue    │ │ Queue     │ │ Queue     │
│ Active   │ │ Active   │ │ Active    │ │ Active    │
│ RateLim  │ │ RateLim  │ │ RateLim   │ │ RateLim   │
│          │ │          │ │           │ │           │
│ curl_    │ │ curl_    │ │ curl_     │ │ curl_     │
│ multi +  │ │ multi +  │ │ multi +   │ │ multi +   │
│ poll()   │ │ poll()   │ │ poll()    │ │ poll()    │
│          │ │          │ │           │ │           │
│ QuickJS  │ │ QuickJS  │ │ QuickJS   │ │ QuickJS   │
│ Context  │ │ Context  │ │ Context   │ │ Context   │
│          │ │          │ │           │ │           │
│ Thread-  │ │ Thread-  │ │ Thread-   │ │ Thread-   │
│ local    │ │ local    │ │ local     │ │ local     │
│ Stats    │ │ Stats    │ │ Stats     │ │ Stats     │
└──────────┘ └──────────┘ └───────────┘ └───────────┘
               │
┌──────────────▼───────────────┐
│      Stats Aggregation        │
│   (Lock-free atomic reads)    │
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

### curl_multi Event Loop (Multi-Worker)

**File:** `src/http/event_loop.cpp`, `include/vayu/http/event_loop.hpp`

Provides async HTTP request execution using curl_multi for non-blocking I/O with **multi-worker architecture** for high-RPS workloads.

#### Architecture

```cpp
// Per-worker event loop
struct EventLoopWorker {
    CURLM* multi_handle;                    // Own curl_multi handle
    std::thread thread;                     // Worker thread
    std::queue<TransferData*> pending_queue; // Worker's pending queue
    std::unordered_map<CURL*, TransferData*> active_transfers;
    RateLimiter rate_limiter;               // Token-bucket rate limiter
    std::atomic<size_t> local_processed;    // Lock-free stats
};

// EventLoop manages N workers
struct EventLoop::Impl {
    std::vector<EventLoopWorker*> workers;  // N workers (auto-detect cores)
    std::atomic<size_t> next_worker;        // Round-robin index
    std::atomic<size_t> next_request_id;    // Request ID generator
};
```

**Key Features:**
- **N Workers:** Auto-detects CPU cores (or configurable)
- **Round-Robin Sharding:** Requests distributed evenly across workers
- **Per-Worker Rate Limiting:** Token-bucket algorithm for precise RPS control
- **Lock-Free Stats:** Each worker maintains atomic counters
- **Connection Pooling:** libcurl multiplexing and keep-alive enabled
- **Performance:** 10k-50k RPS capable on modern hardware

#### Per-Request Lifecycle

```
1. Submit Request (submit/submit_async)
   ↓ Add to pending queue
   
2. Worker Thread (run_loop)
   ├─ Dequeue pending requests
   ├─ Create curl_easy handle
   ├─ curl_multi_add_handle(multi, handle)
   
3. Non-Blocking I/O (curl_multi_perform)
   ├─ curl_multi_wait() sleeps on socket activity
   ├─ Timeout: 10ms (configurable)
   
4. Completion (curl_multi_info_read)
   ├─ Extract response data
   ├─ Run test scripts via ScriptEngine
   ├─ Invoke callback or set promise
   ├─ Update statistics
   
5. Cleanup
   └─ Free curl handle and transfer data
```

#### Configuration

```cpp
struct EventLoopConfig {
    // Multi-worker settings
    size_t num_workers = 0;          // 0 = auto-detect CPU cores
    
    // Per-worker concurrency limits
    size_t max_concurrent = 1000;    // Max in-flight per worker (increased)
    size_t max_per_host = 100;       // Per-host limit per worker (increased)
    int poll_timeout_ms = 10;        // Fast polling (reduced from 100ms)
    
    // Rate limiting (NEW)
    double target_rps = 0.0;         // 0 = unlimited, >0 = token-bucket rate limiting
    double burst_size = 0.0;         // Burst capacity (default 2x target_rps)
    
    // Other settings
    std::string user_agent = "Vayu/0.1.0";
    bool verbose = false;            // curl debug output
    std::string proxy_url;           // Optional proxy
};
```

**High-RPS Example:**
```cpp
EventLoopConfig config;
config.num_workers = 0;        // Auto-detect (e.g., 8 cores)
config.max_concurrent = 1000;  // 8 × 1000 = 8000 total concurrent
config.max_per_host = 100;     // Avoids overwhelming single host
config.poll_timeout_ms = 10;   // Fast response to socket events
config.target_rps = 10000.0;   // Precise 10k RPS rate limiting
config.burst_size = 20000.0;   // Allow 2x bursts

EventLoop loop(config);
// Can handle 10k RPS with 8000 concurrent connections
```

#### API Usage

```cpp
// Basic unlimited RPS
EventLoop loop;
loop.start();

// Submit with callback (auto-sharded to workers)
loop.submit(request, [](size_t id, Result<Response> result) {
    if (result.is_ok()) {
        std::cout << result.value().status_code << "\n";
    }
});

// Or use futures
auto handle = loop.submit_async(request);
auto result = handle.future.get();

// Batch multiple requests
std::vector<Request> requests = { /* ... */ };
auto batch = loop.execute_batch(requests);

// Monitor activity (aggregated across all workers)
std::cout << loop.active_count() << " requests in flight\n";
std::cout << loop.pending_count() << " requests queued\n";
std::cout << loop.total_processed() << " total completed\n";

loop.stop();
```

**Rate-Limited High-RPS:**
```cpp
// Configure for 50k RPS with rate limiting
EventLoopConfig config;
config.num_workers = 8;         // 8 workers
config.max_concurrent = 1000;   // 8k total concurrent
config.target_rps = 50000.0;    // 50k RPS limit

EventLoop loop(config);
loop.start();

// Requests are automatically rate-limited to 50k RPS
for (int i = 0; i < 100000; ++i) {
    loop.submit_async(request);  // Token-bucket pacing
}
```

#### Why Multi-Worker curl_multi?

| Metric | Threads | Single curl_multi | Multi-Worker curl_multi |
|--------|---------|-------------------|------------------------|
| Max Connections | ~10,000 | 100,000+ | 100,000+ (N × capacity) |
| Memory per Request | 1 MB stack | <5 KB metadata | <5 KB metadata |
| Context Switches | Frequent | Minimal | Minimal (per-core) |
| CPU Utilization | High | Single core | All cores (N workers) |
| Complexity | High (locks) | Low (event-driven) | Medium (sharding) |
| RPS Capability | ~1k | ~5-10k | **10k-50k+** |

**Multi-Worker Advantages:**
- **CPU Scaling:** N workers = N × throughput
- **Lock-Free Stats:** Per-worker atomic counters
- **Rate Limiting:** Token-bucket for precise RPS control
- **Connection Pooling:** libcurl multiplexing reduces TCP overhead
- **Burst Handling:** Configurable burst capacity

**See [HIGH_RPS_IMPROVEMENTS.md](/HIGH_RPS_IMPROVEMENTS.md) for detailed implementation.**

---

### QuickJS Script Engine

**Files:** `src/runtime/script_engine.cpp`, `include/vayu/runtime/script_engine.hpp`

Executes user test scripts in JavaScript with full Postman API compatibility.

#### Architecture

```cpp
class ScriptEngine::Impl {
    JSRuntime* runtime;           // QuickJS runtime
    ScriptConfig config;          // Memory/timeout/stack limits
    
    ScriptResult execute(script, context);
};
```

**Configuration:**
- **Memory Limit:** 64MB (configurable)
- **Timeout:** 5 seconds (configurable)
- **Stack Size:** 256KB
- **Console:** Enabled for debugging

#### Script Binding - `pm` Object

**Response Access:**
```javascript
pm.response.code        // HTTP status code
pm.response.body        // Raw response body
pm.response.headers     // Response headers (object)
pm.response.json()      // Parse body as JSON
pm.response.text()      // Response body as string
```

**Request Access:**
```javascript
pm.request.method       // HTTP method
pm.request.url          // Full request URL
pm.request.headers      // Request headers (object)
pm.request.body         // Request body
```

**Environment Variables:**
```javascript
pm.environment.get("key")      // Read variable
pm.environment.set("key", val) // Set variable
```

**Testing & Assertions:**
```javascript
pm.test("description", function() {
    // Test code
});

pm.expect(value)
    .to.equal(expected)        // Strict equality
    .to.not.equal(other)       // Inequality
    .to.be.above(50)           // Greater than
    .to.be.below(100)          // Less than
    .to.include(substring)     // Contains
    .to.have.property("key")   // Has property
    .to.exist                  // Truthy
    .to.be.true                // === true
    .to.be.false               // === false
```

**Console Output:**
```javascript
console.log(msg)        // Print message
console.info(msg)       // Alias
console.warn(msg)       // Alias
console.error(msg)      // Alias
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

## Storage Layer (Database)

**File:** `src/db/database.cpp`, `include/vayu/db/database.hpp`

### Technology Stack

- **Database:** SQLite 3 (Embedded)
- **ORM:** `sqlite_orm` (C++20 type-safe wrapper)
- **File:** `vayu.db`
- **Concurrency:** WAL mode (Write-Ahead Logging)

### Schema Overview

**Project Management:**
- `collections` - Organize requests into folders/hierarchies
- `requests` - Saved HTTP requests with pre/post scripts
- `environments` - Environment variable sets

**Execution Tracking:**
- `runs` - Test execution records with status
- `metrics` - Time-series performance data
- `results` - Individual request/response details
- `kv_store` - Global key-value configuration

### Key Tables

#### `requests` Table
Stores saved HTTP request definitions with scripts.

```sql
id                  TEXT PRIMARY KEY
collection_id       TEXT FK
name                TEXT
method              TEXT (GET, POST, etc.)
url                 TEXT
headers             TEXT (JSON)
body                TEXT
auth                TEXT (JSON)
pre_request_script  TEXT (JavaScript)
post_request_script TEXT (JavaScript)
updated_at          INTEGER (timestamp)
```

#### `runs` Table
Records of test executions.

```sql
id                  TEXT PRIMARY KEY
request_id          TEXT FK
environment_id      TEXT FK
type                TEXT ('design' or 'load')
status              TEXT ('pending', 'running', 'completed', 'failed')
config_snapshot     TEXT (JSON - config at execution time)
start_time          INTEGER (milliseconds)
end_time            INTEGER (milliseconds, nullable)
```

#### `metrics` Table
Time-series metrics (auto-generated during load tests).

```sql
id          INTEGER PRIMARY KEY AUTOINCREMENT
run_id      TEXT FK
timestamp   INTEGER (milliseconds)
name        TEXT (metric name)
value       REAL (metric value)
labels      TEXT (JSON for categorization)
```

#### `results` Table
Individual request execution results.

```sql
id          INTEGER PRIMARY KEY AUTOINCREMENT
run_id      TEXT FK
timestamp   INTEGER (milliseconds)
status_code INTEGER (HTTP response code)
latency_ms  REAL (request latency)
error       TEXT (error message, nullable)
trace_data  TEXT (JSON with additional info)
```

### Features

- **WAL Mode:** Concurrent readers, sequential writes (~10μs per write)
- **ACID:** Full transaction support and crash recovery
- **Auto Schema:** `db.init()` creates tables via `sync_schema()`
- **Type Safety:** C++20 compile-time validation via sqlite_orm
- **Sync Mode:** NORMAL (fsync every 1 second for performance)

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
