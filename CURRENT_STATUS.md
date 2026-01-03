# Vayu - Current Project Status

> **Last Updated:** January 4, 2026  
> **Total Tests:** 126 passing  
> **Build System:** CMake + Ninja + vcpkg  
> **Performance:** 60k+ RPS capable with high-performance optimizations

---

## 🎯 Project Overview

**Vayu** is a high-performance API testing and development platform built in C++. It provides a Postman-like experience with a focus on speed, scriptability, and modern C++ design patterns.

## 🚀 High-RPS Improvements

### Completed
- ✅ **Multiple event-loop workers** - N workers (auto-detect cores), round-robin sharding
- ✅ **Token-bucket rate limiter** - Precise RPS control (60k+ RPS)
- ✅ **Connection reuse** - libcurl multiplexing and keep-alive enabled
- ✅ **Thread-local stats** - Lock-free aggregation across workers
- ✅ **Context Pooling** - Reusing QuickJS contexts to reduce initialization overhead
- ✅ **MetricsCollector** - High-performance in-memory storage with lock-free atomics
- ✅ **DNS Pre-Resolution Cache** - Thread-safe caching eliminates DNS bottleneck
- ✅ **Curl Handle Pooling** - Handle reuse via `curl_easy_reset()` (~100x faster)
- ✅ **HTTP/2 Multiplexing** - Multiple streams over single TCP connection
- ✅ **TCP Keep-Alive** - Persistent connections with 60s intervals
- ✅ **Batch DB Flush** - Single transaction write after test completion

### Configuration
```cpp
EventLoopConfig config;
config.num_workers = 0;        // Auto-detect cores
config.max_concurrent = 1000;  // Per worker
config.max_per_host = 100;     // Per worker
config.poll_timeout_ms = 10;   // Fast polling
config.target_rps = 10000.0;   // Rate limiting
config.burst_size = 20000.0;   // Burst capacity
```

**Performance:** On an 8-core machine with above config:
- 8 workers × 1000 concurrent = 8000 total concurrent requests
- Precise rate limiting at 10k RPS (or higher if configured)
- Connection pooling reduces TCP overhead by ~90%

### Benchmark Results (January 2026)

| Optimization | RPS | Error Rate | Notes |
|-------------|-----|------------|-------|
| Baseline | ~2,000 | 92% | DB lock contention |
| MetricsCollector | ~2,000 | 67% | In-memory storage |
| DNS Cache | 628* | 0% | Zero errors |
| HTTP/2 + TCP Keep-alive | 56,702 | 0% | Phase 1 complete |
| **Handle Pooling** | **60,524** | **0%** | **Phase 2 complete** |

*Low RPS due to slow remote server; local mock server revealed true capacity.

---

## 📚 Documentation Updates

- [docs/engine/architecture.md](docs/engine/architecture.md) — refreshed with accurate QuickJS, event loop, and database architecture details
- [docs/engine/api-reference.md](docs/engine/api-reference.md) — expanded SSE `/stats/:id` streaming docs and DB persistence notes
- [docs/engine/building.md](docs/engine/building.md) — simplified to script-first workflow using [build-and-test.sh](scripts/build-and-test.sh)
- [docs/engine/scripting.md](docs/engine/scripting.md) — new Postman-compatible scripting guide covering `pm` API and assertions

---

## ✅ Implemented Features

### Phase 1: Core Engine

#### HTTP Event Loop (`vayu/http/event_loop.hpp`) 🔥 ENHANCED
- **Multi-worker architecture**: Auto-scales to CPU cores
- **Round-robin sharding**: Requests distributed across workers
- **Rate limiting**: Token-bucket algorithm for precise RPS control
- **Connection pooling**: libcurl multiplexing and keep-alive
- **Thread-local stats**: Lock-free aggregation
- **DNS caching**: Pre-resolved hostnames cached per-worker
- **Handle pooling**: curl_easy handles reused via CurlHandlePool
- **HTTP/2 multiplexing**: Multiple streams over single connection
- **Configuration**: Flexible per-worker concurrency, polling, rate limiting
- **Batch execution**: Execute multiple requests concurrently
- **Progress callbacks**: Track upload/download progress
- **Request cancellation**: Cancel pending requests
- **Performance**: **60k+ RPS** capable on modern hardware

#### Rate Limiter (`vayu/http/rate_limiter.hpp`) 🆕
- **Token bucket algorithm**: Precise RPS control
- **Burst support**: Configurable burst capacity (default 2× target)
- **Thread-safe**: Mutex-protected for concurrent access
- **Flexible**: Enable/disable, blocking/non-blocking acquire
- **Per-worker**: Independent rate limiters for each event loop worker

#### HTTP Client (`vayu/http/client.hpp`)
- **Full HTTP method support**: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- **Request configuration**: Headers, body, timeouts, redirect control
- **Response handling**: Status codes, headers, body, timing metrics
- **SSL/TLS support** via libcurl
- **Follow redirects** (configurable)
- **Custom headers** support

#### JSON Utilities (`vayu/json/utils.hpp`)
- **Request deserialization** from JSON format
- **Response serialization** to JSON
- **Validation** of JSON strings
- **Pretty printing** support
- **Error handling** with descriptive messages

#### CLI (`vayu-cli`) ✅ FULLY IMPLEMENTED (THIN CLIENT)
- **Architecture**: Thin client communicating with `vayu-engine` via HTTP
- **`run <file.json>`** - Execute single request via daemon (Design Mode)
- **`load <file.json>`** - Start load test via daemon (Load Mode)
- **`status`** - Check daemon health
- **Dependencies**: `httplib`, `nlohmann_json` (No core linkage)

#### Daemon (`vayu-engine`) ✅ PHASE 1 COMPLETE
- **HTTP Control Server** on `127.0.0.1:9876`
- **Database Integration**: SQLite + sqlite_orm (`vayu.db`)
- **Implemented Endpoints:**
  - ✅ `GET /health` - Health check
  - ✅ `POST /request` - Execute single request (Design Mode) + DB logging
  - ✅ `POST /run` - Start load test (Load Mode) + DB logging
  - ✅ `GET /config` - Configuration
  - ✅ `GET/POST /collections` - Manage Collections
  - ✅ `GET/POST /requests` - Manage Requests
  - ✅ `GET/POST /environments` - Manage Environments
  - ✅ `GET /runs` - List execution history
  - ✅ `GET /run/:id` - Get run details
  - ✅ `GET /run/:id/report` - Get detailed run report (percentiles, status codes)
  - ✅ `POST /run/:id/stop` - Stop active run
  - ✅ `GET /stats/:id` - Get run metrics (SSE Stream)
- **Infrastructure:**
  - Thread pool (N = CPU cores) with curl_multi event loop
  - Request dispatcher and queue management
  - Pre-allocated QuickJS context pool (64 contexts)
  - Lock-free statistics collection
  - Reporter thread for metrics aggregation

---

### Phase 2: Scripting & Automation

#### QuickJS Script Engine (`vayu/scripting/engine.hpp`)
- **JavaScript execution** via QuickJS
- **Pre-request scripts** - Modify requests before sending
- **Post-response scripts** - Test and validate responses

##### Postman-Compatible API
| Object | Methods |
|--------|---------|
| `pm.test()` | Define test cases with assertions |
| `pm.expect()` | Chai-style assertions (equal, include, exist, etc.) |
| `pm.response` | Access status, headers, json(), text() |
| `pm.request` | Access url, method, headers |
| `pm.environment` | Get/set environment variables |
| `console.log()` | Debug output |

##### Assertion Methods
- `.to.equal()`, `.to.not.equal()`
- `.to.be.above()`, `.to.be.below()`
- `.to.include()`, `.to.have.property()`
- `.to.be.true`, `.to.be.false`
- `.to.exist`, `.to.not.exist`

---

### Phase 3: Concurrent Execution

#### Event Loop (`vayu/http/event_loop.hpp`)
- **curl_multi** based async I/O
- **Non-blocking** request execution
- **Batch processing** with parallel requests
- **Progress callbacks** for monitoring
- **Request cancellation** support
- **Statistics tracking** (active, completed, failed counts)

#### Thread Pool (`vayu/http/thread_pool.hpp`)
- **Work-stealing** thread pool
- **Configurable thread count**
- **Future-based** result handling
- **Batch execution** with mixed success/failure handling

---

### Phase 4: Real-time Streaming

#### Server-Sent Events (`vayu/http/sse.hpp`)

##### SseParser
- **Full SSE spec compliance** (WHATWG)
- **Field parsing**: event, data, id, retry
- **Chunked input** handling
- **Comment filtering**
- **CRLF and LF** line ending support
- **Multiline data** concatenation

##### EventSource
- **Postman-like API** for SSE connections
- **Auto-reconnect** with exponential backoff (3s-30s)
- **Last-Event-ID** header for reconnection
- **State management**: Connecting → Open → Closed
- **Typed event callbacks** for specific event types

##### Callbacks
```cpp
es.on_event([](SseEvent e) { /* all events */ });
es.on("message", [](SseEvent e) { /* typed */ });
es.on_open([]() { /* connected */ });
es.on_error([](std::string err) { /* errors */ });
es.on_state_change([](EventSourceState s) { /* state */ });
```

### Phase 5: Persistence ✅ Completed

#### Storage Layer (`vayu/db/database.hpp`)
- **SQLite 3** embedded database with WAL enabled
- **sqlite_orm** for C++20 type-safe mapping
- **Schema**:
   - `collections`, `requests`, `environments`
   - `runs`, `metrics`, `results`
   - `kv_store`
- **Features**:
   - WAL mode for concurrency
   - Automatic schema migration via `sync_schema()`
   - Batched metrics/results ingestion during runs

---

## 📁 Project Structure

```
vayu/
├── engine/
│   ├── include/vayu/
│   │   ├── http/
│   │   │   ├── client.hpp      # HTTP client
│   │   │   ├── event_loop.hpp  # Async event loop
│   │   │   ├── thread_pool.hpp # Thread pool
│   │   │   └── sse.hpp         # SSE/EventSource
│   │   ├── json/
│   │   │   └── utils.hpp       # JSON utilities
│   │   └── scripting/
│   │       └── engine.hpp      # QuickJS engine
│   ├── src/
│   │   ├── http/
│   │   │   ├── client.cpp
│   │   │   ├── event_loop.cpp
│   │   │   ├── thread_pool.cpp
│   │   │   └── sse.cpp
│   │   ├── json/
│   │   │   └── utils.cpp
│   │   ├── scripting/
│   │   │   └── engine.cpp
│   │   ├── cli/
│   │   │   └── main.cpp        # CLI entry point
│   │   └── daemon/
│   │       └── main.cpp        # Daemon entry point
│   ├── tests/
│   │   ├── http_client_test.cpp
│   │   ├── json_test.cpp
│   │   ├── script_engine_test.cpp
│   │   ├── event_loop_test.cpp
│   │   ├── thread_pool_test.cpp
│   │   └── sse_test.cpp
│   └── CMakeLists.txt
├── Vayu.md                      # Project vision
└── CURRENT_STATUS.md            # This file
```

---

## 📊 Test Coverage

| Component | Tests | Status |
|-----------|-------|--------|
| HTTP Client | 9 | ✅ |
| JSON Utils | 16 | ✅ |
| Script Engine | 30 | ✅ |
| Event Loop | 10 | ✅ |
| Thread Pool | 6 | ✅ |
| SSE Parser | 18 | ✅ |
| EventSource | 7 | ✅ |
| **Total** | **96** | **✅ All Passing** |

---

## 🔧 Dependencies

| Library | Purpose |
|---------|---------|
| **libcurl** | HTTP client, SSL/TLS |
| **nlohmann/json** | JSON parsing/serialization |
| **QuickJS** | JavaScript engine |
| **Google Test** | Unit testing |
| **fmt** | String formatting |

---

## 🔨 Phase 2: Advanced Load Testing (In Progress)

### Currently In Progress

1. **HTTP API Load Test Endpoint** (`POST /run`)
   - Endpoint structure implemented (returns 501 Not Implemented)
   - TODO: Implement async load test execution
   - TODO: Connect to thread pool and event loop for concurrent execution
   - TODO: Implement request queue and rate limiting

### Planned for Phase 2

1. **Real-time Statistics Streaming** (`GET /stats/:id` SSE)
   - Server-Sent Events infrastructure ready
   - TODO: Connect to /run endpoint
   - TODO: Stream RPS, latency percentiles, error rates

2. **Advanced Load Test Metrics**
   - Requests per second (mean, max)
   - Latency percentiles: p50, p90, p95, p99
   - Error categorization and reporting

3. **Async Load Test Management**
   - `GET /run/:id` - Get test status and results
   - `POST /run/:id/stop` - Cancel running test
   - `GET /runs` - List recent test runs

### Current Workaround
Use CLI `batch` command for concurrent request execution until Phase 2 HTTP API is available.

---

## 🚀 Potential Future Enhancements

### High Priority

1. **CLI SSE Command**
   - `vayu stream <url>` - Connect to SSE endpoints
   - Real-time event display with colored output
   - Options: `--timeout`, `--no-reconnect`, `--event-filter`

2. **Environment Files**
   - Load variables from `.env` or JSON files
   - Support for multiple environments (dev, staging, prod)
   - Variable interpolation in requests: `{{base_url}}/api`

3. **Collection Runner**
   - Define request collections in JSON/YAML
   - Sequential and parallel execution modes
   - Shared variables between requests
   - Collection-level scripts

### Medium Priority

4. **WebSocket Support**
   - Bidirectional real-time communication
   - Message send/receive with callbacks
   - Auto-reconnect with backoff
   - Binary and text message support

5. **Request History**
   - SQLite-based history storage
   - Search and filter past requests
   - Re-execute from history
   - Export/import history

6. **Authentication Helpers**
   - OAuth 2.0 flows (Authorization Code, Client Credentials)
   - API Key management
   - Basic/Digest auth helpers
   - Token refresh automation

### Lower Priority

7. **GraphQL Support**
   - Query/mutation execution
   - Variable substitution
   - Schema introspection
   - Subscription support (via WebSocket)

8. **Response Visualization**
   - JSON tree viewer
   - Image preview
   - HTML rendering
   - Binary hex dump

9. **Mock Server**
   - Define mock endpoints
   - Response templating
   - Request matching rules
   - Delay simulation

10. **Performance Testing**
    - Load testing with configurable concurrency
    - Response time percentiles
    - Throughput metrics
    - HTML report generation

---

## 🏗️ Build Instructions

```bash
# Prerequisites
brew install cmake ninja

# Clone and setup vcpkg
cd engine
git clone https://github.com/microsoft/vcpkg.git
./vcpkg/bootstrap-vcpkg.sh

# Configure and build
cmake -B build -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build

# Run tests
cd build && ctest --output-on-failure

# Run CLI
./build/vayu-cli --help
```

---

## 📝 Usage Examples

### Single Request
```bash
./vayu-cli run tests/fixtures/simple-get.json
./vayu-cli run tests/fixtures/simple-get.json --verbose
```

### Batch Requests (Concurrent)
```bash
./vayu-cli batch tests/fixtures/simple-get.json tests/fixtures/simple-post.json
./vayu-cli batch tests/fixtures/*.json --concurrency 20 --verbose
```

### With Script Testing
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "tests": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));"
}
```

### Load Testing via CLI
```bash
# Run single request 100 times in parallel
for i in {1..100}; do
  ./vayu-cli run test.json &
done
wait

# Run batch with high concurrency
./vayu-cli batch test.json test.json test.json --concurrency 100
```

### SSE Connection (Programmatic)
```cpp
#include <vayu/http/sse.hpp>

vayu::http::EventSource es("https://api.example.com/events");
es.on_event([](vayu::http::SseEvent event) {
    std::cout << "[" << event.type << "] " << event.data << "\n";
});
es.connect();
```

---

## 🤝 Contributing

The project is under active development. Key areas for contribution:
- Additional test coverage
- Documentation improvements
- New protocol support (gRPC, WebSocket)
- Platform-specific optimizations

---

*Built with ❤️ using modern C++17*

### Phase 6: UI Implementation (Next Step)
- **Tech Stack**: Electron + React + TypeScript
- **Goal**: Build the visual interface for Vayu
- **Tasks**:
  - Setup Electron project structure
  - Implement "Design Mode" UI (Request Builder)
  - Implement "Load Mode" UI (Graphs & Stats)
  - Connect UI to Daemon API (`localhost:9876`)
