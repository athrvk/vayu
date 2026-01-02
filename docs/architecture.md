# Vayu Architecture

**Document Version:** 1.0  
**Last Updated:** January 2, 2026

---

## Overview

Vayu uses a **Sidecar Architecture** that decouples the user interface from the execution engine. This separation allows each component to be optimized for its specific purpose:

- **The Manager** (Electron/React): Optimized for user experience
- **The Engine** (C++): Optimized for raw performance

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Vayu Application                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────┐      ┌─────────────────────────────┐  │
│  │     THE MANAGER         │      │        THE ENGINE           │  │
│  │   (Electron + React)    │      │          (C++)              │  │
│  │                         │      │                             │  │
│  │  ┌───────────────────┐  │      │  ┌───────────────────────┐  │  │
│  │  │   Request Builder │  │      │  │    Control Server     │  │  │
│  │  │   Response Viewer │  │ HTTP │  │    (cpp-httplib)      │  │  │
│  │  │   Dashboard       │◄─┼──────┼─►│    Port: 9876         │  │  │
│  │  │   Collections     │  │      │  └───────────────────────┘  │  │
│  │  └───────────────────┘  │      │             │               │  │
│  │           │             │      │             ▼               │  │
│  │           │             │      │  ┌───────────────────────┐  │  │
│  │           ▼             │      │  │    Thread Pool        │  │  │
│  │  ┌───────────────────┐  │      │  │  ┌─────┐ ┌─────┐     │  │  │
│  │  │   Sidecar Manager │  │      │  │  │ W1  │ │ W2  │ ... │  │  │
│  │  │   (spawn/kill)    │  │      │  │  └──┬──┘ └──┬──┘     │  │  │
│  │  └───────────────────┘  │      │  └─────┼──────┼─────────┘  │  │
│  │                         │      │        │      │            │  │
│  └─────────────────────────┘      │        ▼      ▼            │  │
│                                   │  ┌───────────────────────┐  │  │
│                                   │  │  curl_multi Handles   │  │  │
│                                   │  │  (Event Loops)        │  │  │
│                                   │  └───────────────────────┘  │  │
│                                   │             │               │  │
│                                   │             ▼               │  │
│                                   │  ┌───────────────────────┐  │  │
│                                   │  │  QuickJS Context Pool │  │  │
│                                   │  │  (Script Execution)   │  │  │
│                                   │  └───────────────────────┘  │  │
│                                   │                             │  │
│                                   └─────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### The Manager (Electron + React)

The Manager is the "face" of Vayu—a standard Electron application that provides the graphical interface.

#### Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **User Interaction** | Handle clicks, form inputs, keyboard shortcuts |
| **File Management** | Save/load collections, environments, settings |
| **Results Visualization** | Pretty-print JSON, render charts, display stats |
| **Engine Lifecycle** | Spawn engine on startup, kill on quit |
| **IPC Bridge** | Send commands to engine, receive stats via SSE |

#### Technology Stack

```
┌─────────────────────────────────────┐
│           Electron Shell            │
├─────────────────────────────────────┤
│  Main Process    │  Renderer        │
│  ─────────────   │  ──────────      │
│  • Node.js       │  • React 18      │
│  • Sidecar Mgr   │  • Zustand       │
│  • IPC Handlers  │  • TailwindCSS   │
│  • File System   │  • React Query   │
└─────────────────────────────────────┘
```

#### Key Files

```
app/
├── electron/
│   ├── main.ts          # Electron entry, window creation
│   ├── preload.ts       # Secure context bridge
│   └── sidecar.ts       # Engine process manager
└── src/
    ├── App.tsx          # Root component
    ├── components/      # UI components
    ├── hooks/           # Custom hooks (useEngine, useSSE)
    └── stores/          # Zustand state stores
```

---

### The Engine (C++)

The Engine is the "muscle"—a headless daemon optimized for maximum I/O throughput.

#### Responsibilities

| Responsibility | Description |
|----------------|-------------|
| **HTTP Execution** | Send requests at high concurrency |
| **Script Execution** | Run user assertions (pm.test) |
| **Stats Collection** | Track RPS, latency percentiles |
| **Control API** | Accept commands from Manager |
| **Results Streaming** | Push real-time stats via SSE |

#### Technology Stack

```
┌─────────────────────────────────────┐
│            C++20 Core               │
├─────────────────────────────────────┤
│  Networking      │  Scripting       │
│  ───────────     │  ─────────       │
│  • libcurl       │  • QuickJS       │
│  • cpp-httplib   │  • Context Pool  │
├─────────────────────────────────────┤
│  Utilities                          │
│  ─────────                          │
│  • nlohmann/json                    │
│  • Thread Pool                      │
│  • Lock-free Stats                  │
└─────────────────────────────────────┘
```

#### Key Files

```
engine/
├── src/
│   ├── main.cpp              # CLI entry (vayu-cli)
│   ├── daemon.cpp            # Daemon entry (vayu-engine)
│   ├── http/
│   │   ├── client.cpp        # libcurl wrapper
│   │   └── server.cpp        # Control API server
│   ├── runtime/
│   │   ├── script_engine.cpp # QuickJS integration
│   │   └── context_pool.cpp  # VM context reuse
│   └── core/
│       ├── thread_pool.cpp   # Worker management
│       ├── event_loop.cpp    # curl_multi loop
│       └── stats.cpp         # Statistics collector
└── include/vayu/
    └── *.hpp                 # Public headers
```

---

## Communication Protocol

### Control Plane (HTTP)

The Manager communicates with the Engine via a localhost HTTP API.

```
Manager                              Engine
   │                                    │
   │  POST /run                         │
   │  {request, config}                 │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK                            │
   │  {runId: "abc123"}                 │
   │◄───────────────────────────────────┤
   │                                    │
   │  GET /stats/abc123 (SSE)           │
   ├───────────────────────────────────►│
   │                                    │
   │  event: stats                      │
   │  data: {rps: 45000, p99: 2.3}      │
   │◄───────────────────────────────────┤
   │                                    │
   │  event: stats                      │
   │  data: {rps: 48000, p99: 2.1}      │
   │◄───────────────────────────────────┤
   │                                    │
   │  event: complete                   │
   │  data: {total: 100000, ...}        │
   │◄───────────────────────────────────┤
   │                                    │
```

### Message Formats

**Request Payload (POST /run):**
```json
{
  "request": {
    "method": "POST",
    "url": "https://api.example.com/users",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{token}}"
    },
    "body": {
      "mode": "json",
      "content": {"name": "John"}
    }
  },
  "config": {
    "mode": "vayu",
    "concurrency": 100,
    "duration": "30s",
    "rampUp": "5s"
  },
  "script": {
    "pre": "pm.variables.set('timestamp', Date.now())",
    "post": "pm.test('Status is 200', () => pm.response.status === 200)"
  },
  "environment": {
    "token": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

**Stats Event (SSE):**
```json
{
  "timestamp": 1704153600000,
  "rps": 48523,
  "latency": {
    "min": 0.8,
    "avg": 1.9,
    "p50": 1.7,
    "p95": 2.8,
    "p99": 4.1,
    "max": 12.3
  },
  "requests": {
    "total": 485230,
    "success": 484012,
    "failed": 1218
  },
  "errors": {
    "timeout": 845,
    "connection": 312,
    "http_5xx": 61
  }
}
```

---

## Concurrency Model

### The Problem

Traditional approach: 1 thread = 1 request. This fails at scale:
- OS thread limit (~10,000)
- Context switching overhead
- Memory per thread (~1MB stack)

### The Solution: Event-Driven I/O

```
┌─────────────────────────────────────────────────────────────┐
│                      Thread Pool (N = CPU Cores)            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │    Worker 0     │  │    Worker 1     │  ...             │
│  │                 │  │                 │                  │
│  │ ┌─────────────┐ │  │ ┌─────────────┐ │                  │
│  │ │ curl_multi  │ │  │ │ curl_multi  │ │                  │
│  │ │  Handle     │ │  │ │  Handle     │ │                  │
│  │ └─────────────┘ │  │ └─────────────┘ │                  │
│  │       │         │  │       │         │                  │
│  │       ▼         │  │       ▼         │                  │
│  │ ┌───┬───┬───┐   │  │ ┌───┬───┬───┐   │                  │
│  │ │S1 │S2 │S3 │...│  │ │S1 │S2 │S3 │...│  (Sockets)      │
│  │ └───┴───┴───┘   │  │ └───┴───┴───┘   │                  │
│  │  (1000+ each)   │  │  (1000+ each)   │                  │
│  │                 │  │                 │                  │
│  │ ┌─────────────┐ │  │ ┌─────────────┐ │                  │
│  │ │ QuickJS     │ │  │ │ QuickJS     │ │                  │
│  │ │ Context     │ │  │ │ Context     │ │                  │
│  │ └─────────────┘ │  │ └─────────────┘ │                  │
│  │                 │  │                 │                  │
│  │ ┌─────────────┐ │  │ ┌─────────────┐ │                  │
│  │ │ ThreadStats │ │  │ │ ThreadStats │ │  (Lock-free)    │
│  │ └─────────────┘ │  │ └─────────────┘ │                  │
│  │                 │  │                 │                  │
│  └─────────────────┘  └─────────────────┘                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 ┌─────────────────────────┐
                 │    Reporter Thread      │
                 │  (Aggregates stats      │
                 │   every 100ms)          │
                 └─────────────────────────┘
```

### How It Works

1. **Work Distribution:** Requests are distributed round-robin across workers
2. **Event Loop:** Each worker runs `curl_multi_perform()` in a loop
3. **Non-Blocking:** `curl_multi` uses `select()`/`epoll` to wait on multiple sockets
4. **Completion Callback:** When a request completes, the response is passed to QuickJS
5. **Stats Update:** Thread-local counters are incremented (no locks)

### Code Flow

```cpp
// Simplified event loop (one worker)
void Worker::run() {
    while (running) {
        // 1. Add pending requests to curl_multi
        while (auto req = queue.try_pop()) {
            auto easy = createEasyHandle(req);
            curl_multi_add_handle(multi, easy);
        }
        
        // 2. Perform I/O (non-blocking)
        int running_handles;
        curl_multi_perform(multi, &running_handles);
        
        // 3. Process completed requests
        CURLMsg* msg;
        while ((msg = curl_multi_info_read(multi, &remaining))) {
            if (msg->msg == CURLMSG_DONE) {
                auto response = extractResponse(msg->easy_handle);
                
                // 4. Run user script
                auto result = scriptEngine.execute(response, script);
                
                // 5. Update thread-local stats (no mutex!)
                stats.requests_total++;
                stats.latency_sum += response.latency;
            }
        }
        
        // 6. Wait for activity (with timeout)
        curl_multi_wait(multi, nullptr, 0, 10, nullptr);
    }
}
```

---

## Scripting Bridge

### The Challenge

Postman users expect JavaScript assertions:

```javascript
pm.test("Status is 200", function() {
    pm.expect(pm.response.code).to.equal(200);
});

pm.test("Response time < 500ms", function() {
    pm.expect(pm.response.responseTime).to.be.below(500);
});
```

Running V8 (Node.js) for every request is too slow (5ms startup, 20MB memory).

### The Solution: QuickJS + Context Pooling

**QuickJS** is a lightweight JS engine (500KB, microsecond startup).

```
┌─────────────────────────────────────────────────────────┐
│                   Context Pool                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ Context │ │ Context │ │ Context │ │ Context │  ...  │
│  │   #1    │ │   #2    │ │   #3    │ │   #4    │       │
│  │  (idle) │ │ (in use)│ │  (idle) │ │  (idle) │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│       │                       │                         │
│       │  ┌────────────────────┘                         │
│       ▼  ▼                                              │
│  Pre-initialized with:                                  │
│  • pm.test() function                                   │
│  • pm.expect() (chai-like assertions)                   │
│  • pm.variables API                                     │
│  • console.log() binding                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### C++ to JS Binding

```cpp
// Expose pm.response to JavaScript
JSValue createResponseObject(JSContext* ctx, const Response& resp) {
    JSValue obj = JS_NewObject(ctx);
    
    JS_SetPropertyStr(ctx, obj, "code", 
        JS_NewInt32(ctx, resp.statusCode));
    
    JS_SetPropertyStr(ctx, obj, "body", 
        JS_NewString(ctx, resp.body.c_str()));
    
    JS_SetPropertyStr(ctx, obj, "responseTime", 
        JS_NewFloat64(ctx, resp.latencyMs));
    
    // Headers object
    JSValue headers = JS_NewObject(ctx);
    for (const auto& [key, value] : resp.headers) {
        JS_SetPropertyStr(ctx, headers, key.c_str(),
            JS_NewString(ctx, value.c_str()));
    }
    JS_SetPropertyStr(ctx, obj, "headers", headers);
    
    return obj;
}
```

---

## Statistics Collection

### Thread-Local Aggregation

To avoid mutex contention in the hot path, each worker maintains its own stats:

```cpp
// Per-worker stats (no synchronization needed)
struct ThreadStats {
    std::atomic<uint64_t> requests_total{0};
    std::atomic<uint64_t> requests_success{0};
    std::atomic<uint64_t> requests_failed{0};
    std::atomic<uint64_t> bytes_sent{0};
    std::atomic<uint64_t> bytes_received{0};
    
    // Latency histogram (1ms buckets, 0-1000ms)
    std::array<std::atomic<uint64_t>, 1001> latency_histogram{};
};

// Global stats (aggregated by reporter)
struct GlobalStats {
    std::vector<ThreadStats*> worker_stats;
    
    AggregatedStats aggregate() {
        AggregatedStats result{};
        for (auto* ws : worker_stats) {
            result.total += ws->requests_total.load(std::memory_order_relaxed);
            // ... aggregate other fields
        }
        return result;
    }
};
```

### Reporter Thread

A dedicated thread wakes every 100ms to aggregate and stream stats:

```cpp
void ReporterThread::run() {
    while (running) {
        std::this_thread::sleep_for(100ms);
        
        auto stats = globalStats.aggregate();
        auto json = serializeStats(stats);
        
        // Push to all SSE connections
        for (auto& conn : sseConnections) {
            conn.send("event: stats\ndata: " + json + "\n\n");
        }
    }
}
```

---

## Security Considerations

### Script Sandboxing

QuickJS contexts are isolated—user scripts cannot:
- Access the filesystem
- Make network requests (only via provided APIs)
- Access process memory outside their sandbox

### Local-Only Communication

The Control API only binds to `127.0.0.1`:

```cpp
server.listen("127.0.0.1", 9876);  // Not 0.0.0.0!
```

### Secret Management

Sensitive values in environments are:
- Stored encrypted at rest (AES-256)
- Never logged in plaintext
- Masked in UI by default

---

## Future Considerations

### Potential Optimizations

1. **io_uring (Linux):** Replace `curl_multi` with io_uring for even lower latency
2. **DPDK:** Kernel bypass for extreme performance (100k+ RPS)
3. **Distributed Mode:** Multiple engines coordinated by a single Manager

### Alternative Architectures Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Pure Rust | Memory safety | Less mature ecosystem | ❌ |
| Go + cgo | Easy concurrency | GC pauses at scale | ❌ |
| Node.js worker threads | Same language | Single-threaded limitation | ❌ |
| C++ (chosen) | Max control, proven libs | Complexity | ✅ |

---

*Next: [API Reference](api-reference.md) →*
