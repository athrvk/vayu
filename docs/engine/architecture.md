# Engine Architecture

**Document Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

The Vayu Engine is a high-performance C++20 daemon optimized for concurrent HTTP execution with integrated JavaScript scripting.

```
┌──────────────────────────────┐
│        Control API            │
│  (HTTP Server, Port 9876)     │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│      Request Dispatcher       │
│  (Queue + Round-robin)        │
└──────────────┬───────────────┘
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

*See: [API Reference](api-reference.md) | [Building](building.md) →*
