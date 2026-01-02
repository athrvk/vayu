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


---

### RunManager and Load Strategies

**Files:** `src/core/run_manager.cpp`, `src/core/load_strategy.cpp`, `include/vayu/core/run_manager.hpp`

Manages load test execution with multiple strategies for different testing scenarios.

#### RunManager Architecture

```cpp
class RunManager {
    Database& db;
    EventLoop& event_loop;
    std::unordered_map<std::string, RunContext> active_runs;
    std::thread metrics_thread;
    
public:
    void start_run(const std::string& run_id, const LoadConfig& config);
    void stop_run(const std::string& run_id);
    RunStatus get_status(const std::string& run_id);
};

struct RunContext {
    std::string run_id;
    LoadConfig config;
    std::atomic<bool> should_stop{false};
    std::atomic<size_t> requests_sent{0};      // Progress tracking
    std::atomic<size_t> requests_expected{0};  // Total expected
    std::thread worker_thread;
    // ... metrics tracking ...
};
```

**Key Responsibilities:**
- Async load test execution in separate threads
- Real-time metrics collection (every 1 second)
- Progress tracking with sent/expected counters
- Graceful termination via stop signals

#### Load Strategies

Three strategies for different load testing patterns:

##### 1. ConstantLoadStrategy - Rate-Limited

Maintains constant RPS using precise interval-based scheduling.

```cpp
// Configuration
{
  "mode": "constant",
  "duration": 30,        // 30 seconds
  "targetRps": 50        // 50 requests per second
}

// Implementation
interval_us = 1,000,000 / target_rps;  // 20,000µs for 50 RPS
for each request:
    submit to event_loop
    sleep(interval_us)
    requests_sent++
```

**Characteristics:**
- Precise timing: 20ms intervals for 50 RPS
- No concurrency limit needed
- Rate-limited by time, not connections
- Best for: Sustained load testing, API rate limit testing

##### 2. ConstantLoadStrategy - Concurrency-Based

Maintains constant concurrent connections (legacy mode when targetRps not specified).

```cpp
// Configuration
{
  "mode": "constant",
  "duration": 30,
  "concurrency": 100   // 100 parallel connections
}

// Implementation
maintain 100 active requests at all times
when one completes, submit another immediately
```

**Characteristics:**
- Connection-based throttling
- Maximum throughput limited by server response time
- Best for: Max throughput testing, connection stress testing

##### 3. IterationsStrategy

Executes fixed number of iterations with optional concurrency.

```cpp
// Configuration
{
  "mode": "iterations",
  "iterations": 1000,     // Execute 1000 times
  "concurrency": 10       // 10 at a time
}

// Implementation
total_iterations = 1000
requests_expected = 1000
execute in batches of 10 until all complete
```

**Characteristics:**
- Predictable total request count
- Batch execution with concurrency control
- Best for: Functional testing, data seeding, fixed-count operations

##### 4. RampUpStrategy

Gradually increases load from start RPS to target RPS.

```cpp
// Configuration
{
  "mode": "ramp_up",
  "stages": [
    { "duration": 10, "targetRps": 10 },   // 10s @ 10 RPS
    { "duration": 20, "targetRps": 50 },   // 20s @ 50 RPS
    { "duration": 30, "targetRps": 100 }   // 30s @ 100 RPS
  ]
}

// Implementation
for each stage:
    interval_us = 1,000,000 / stage.targetRps
    execute for stage.duration seconds
    requests_expected += stage.duration * stage.targetRps
```

**Characteristics:**
- Multi-stage load patterns
- Smooth transition between RPS levels
- Best for: Soak testing, capacity planning, gradual stress testing

#### Metrics Collection

RunManager collects metrics every 1 second and streams via SSE:

```cpp
void RunManager::collect_metrics(RunContext& ctx) {
    while (!ctx.should_stop) {
        // Collect from event_loop stats
        auto rps = calculate_current_rps();
        auto latency_avg = calculate_avg_latency();
        auto error_rate = calculate_error_rate();
        
        // Progress tracking
        auto sent = ctx.requests_sent.load();
        auto expected = ctx.requests_expected.load();
        
        // Write to database
        db.insert_metric(ctx.run_id, "rps", rps, timestamp);
        db.insert_metric(ctx.run_id, "requests_sent", sent, timestamp);
        db.insert_metric(ctx.run_id, "requests_expected", expected, timestamp);
        // ... more metrics ...
        
        std::this_thread::sleep_for(1s);
    }
}
```

**Available Metrics:**
- `rps` - Requests per second (calculated over 1s window)
- `latency_avg` - Average latency in milliseconds
- `latency_p50`, `latency_p95`, `latency_p99` - Latency percentiles
- `error_rate` - Percentage of failed requests
- `total_requests` - Cumulative completed requests
- `connections_active` - Current active connections
- `requests_sent` - Total submitted to event loop (progress)
- `requests_expected` - Expected total for this run (progress)

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
- ✅ `GET /run/:id/report` - Get detailed run report
- ✅ `POST /run/:id/stop` - Stop active run
- ✅ `GET /stats/:id` - Get run metrics

### HTTP API Load Testing Path (✅ Fully Implemented)

The `/run` endpoint creates a DB entry and executes load tests asynchronously via `RunManager`:

```cpp
// Implemented in server.cpp:
server.Post("/run", [&run_mgr](const httplib::Request &req, httplib::Response &res) {
    // Parse load test configuration
    auto config = parse_load_config(req.body);
    
    // Create run in DB with "pending" status
    std::string run_id = generate_run_id();
    
    // Execute asynchronously via RunManager
    run_mgr.start_run(run_id, config);
    
    // Return runId immediately
    res.set_content(json_response(run_id), "application/json");
});
```

`POST /run` now supports:

```
HTTP Client
    ↓
    POST /run
    ├── config: { mode, duration, targetRps/iterations/stages }
    └── request: { method, url, headers, scripts, ... }
    ↓
    Returns immediately with runId (202 Accepted)
    ↓
    RunManager executes LoadStrategy asynchronously
    ├── ConstantLoadStrategy (rate-limited or concurrency-based)
    ├── IterationsStrategy (N fixed iterations)
    └── RampUpStrategy (gradual load increase)
    ↓
    Client streams GET /stats/:id (SSE) for real-time metrics
    ├── RPS (requests per second)
    ├── Latency (avg, p50, p95, p99)
    ├── Error rate
    ├── Active connections
    ├── Requests sent & expected (progress tracking)
    └── Metrics streamed every 1 second
    ↓
    Client calls GET /run/:id/report for final aggregated results
    └── Percentiles, status code distribution, error summary
```

**Implemented Features:**
1. ✅ Async load test execution via RunManager
2. ✅ Real-time statistics collection and streaming
3. ✅ SSE metrics streaming with 11 metric types
4. ✅ Three load strategies: constant (rate-limited), iterations, ramp-up
5. ✅ Precise RPS rate limiting (e.g., 20ms intervals for 50 RPS)
6. ✅ Progress tracking with requests_sent/requests_expected

### Feature Comparison

| Feature | CLI run | CLI batch | HTTP /request | HTTP /run |
|---------|---------|-----------|---------------|------------|
| Single request | ✅ | ❌ | ✅ | ✅ |
| Batch requests | ❌ | ✅ | ❌ | ✅ |
| Concurrent execution | ❌ | ✅ | ❌ | ✅ |
| Test scripts | ✅ | ✅ | ✅ | ✅ |
| Configurable concurrency | ❌ | ✅ | ❌ | ✅ |
| RPS rate limiting | ❌ | ❌ | ❌ | ✅ |
| Load strategies | ❌ | ❌ | ❌ | ✅ (3 modes) |
| Real-time metrics | ❌ | Summary only | ❌ | ✅ SSE |
| Progress tracking | ❌ | ❌ | ❌ | ✅ (sent/expected) |
| Latency percentiles | ❌ | Average | ❌ | ✅ |
| Current Status | ✅ Ready | ✅ Ready | ✅ Ready | ✅ Ready |
| Access method | CLI | CLI | HTTP | HTTP |

### Recommendation for Load Testing

**For simple concurrent execution:**
- Use `vayu-cli batch` command with `--concurrency N`
- Quick one-off tests with summary statistics

**For advanced load testing:**
- Use HTTP API `POST /run` for full-featured load testing
- Stream real-time metrics with `GET /stats/:id` (SSE)
- Choose from 3 load strategies: constant (rate-limited), iterations, ramp-up
- Track progress with requests_sent/requests_expected metrics
- Get detailed percentile analysis with `GET /run/:id/report`

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
