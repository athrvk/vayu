# Vayu - Current Project Status

> **Last Updated:** January 2, 2026  
> **Total Tests:** 96 passing  
> **Build System:** CMake + Ninja + vcpkg

---

## 🎯 Project Overview

**Vayu** is a high-performance API testing and development platform built in C++. It provides a Postman-like experience with a focus on speed, scriptability, and modern C++ design patterns.

---

## ✅ Implemented Features

### Phase 1: Core Engine

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

#### CLI (`vayu-cli`)
- **`request`** - Execute single HTTP requests from JSON files
- **`batch`** - Execute multiple requests concurrently
- **`daemon`** - Start background engine daemon
- **Colored output** with status code highlighting
- **Verbose mode** for debugging
- **Timeout configuration**

#### Daemon (`vayu-engine`)
- **Unix domain socket** communication
- **Background process** management
- **Request/response** JSON protocol
- **Health checks** and status reporting

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

## 🚀 Potential Next Steps

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
./vayu-cli request tests/fixtures/get-request.json
```

### Batch Requests
```bash
./vayu-cli batch tests/fixtures/batch-*.json --parallel 5
```

### With Script Testing
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "scripts": {
    "test": "pm.test('Status is 200', () => pm.expect(pm.response.status).to.equal(200));"
  }
}
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
