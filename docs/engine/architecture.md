# Vayu Engine Architecture

**Version:** 0.1.1  
**Last Updated:** January 2026

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
- **Run context**: Stores configuration, event loop, and metrics collector per run
- **Graceful shutdown**: Stops active runs on daemon shutdown (5s timeout)

### Metrics Collector

High-performance in-memory metrics collection optimized for 60k+ RPS:

- **Pre-allocated storage**: Avoids reallocation during tests
- **Thread-local accumulators**: Zero-contention writes
- **Batch DB writes**: Results written after test completion
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

### Database (`SQLite`)

Persistent storage using sqlite_orm:

**Schema:**
- `collections`: Folder hierarchy for organizing requests
- `requests`: Saved HTTP requests with headers, body, scripts
- `environments`: Variable sets for different environments
- `globals`: Singleton global variables
- `runs`: Test execution records (design mode or load test)
- `metrics`: Time-series metrics (RPS, latency, error rate)
- `results`: Individual request results (errors + sampled successes)

## Request Flow

### Design Mode (Single Request)

```
1. POST /request
   ↓
2. Parse request JSON
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
2. Parse load test config
   ↓
3. Create Run record (type: Load)
   ↓
4. Create RunContext with EventLoop
   ↓
5. Start worker thread (execute_load_test)
   ↓
6. Start metrics thread (collect_metrics)
   ↓
7. Event loop submits requests via SPSC queue
   ↓
8. Metrics collector aggregates results in-memory
   ↓
9. Metrics thread streams stats via SSE (/stats/:runId)
   ↓
10. On completion: batch-write results to database
```

## Load Test Strategies

Three load test strategies are supported:

### 1. Constant (Duration-based)

Maintains a constant number of virtual users for a specified duration.

**Config:**
```json
{
  "mode": "constant",
  "virtualUsers": 100,
  "duration": 60,
  "targetRps": 1000
}
```

### 2. Ramp Up

Gradually increases virtual users over time.

**Config:**
```json
{
  "mode": "ramp_up",
  "virtualUsers": 100,
  "duration": 60,
  "rampUp": 10
}
```

### 3. Iterations

Executes a fixed number of requests per virtual user.

**Config:**
```json
{
  "mode": "iterations",
  "virtualUsers": 10,
  "iterations": 100
}
```

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

## Dependencies

- **libcurl**: HTTP client library
- **cpp-httplib**: HTTP server library
- **nlohmann-json**: JSON parsing/serialization
- **sqlite3**: Embedded database
- **sqlite-orm**: C++ ORM for SQLite
- **QuickJS**: JavaScript engine (vendored)
