# Vayu Engine Architecture

C++ HTTP-based engine using sidecar pattern.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     Manager (App)                       │
│  Electron + React frontend                              │
└─────────────────────────┬───────────────────────────────┘
                          │ HTTP/SSE (localhost:9876)
┌─────────────────────────▼───────────────────────────────┐
│                   Vayu Engine (C++)                     │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  HTTP Server │  │  Thread Pool │  │  Event Loop  │  │
│  │ (cpp-httplib)│  │    (N=4)     │  │ (curl_multi) │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Run Manager  │  │   Metrics    │  │Script Engine │  │
│  │              │  │  Collector   │  │  (QuickJS)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐│
│  │               SQLite Database                       ││
│  │  Collections │ Environments │ Runs │ History        ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

## Components

| Component | Library | Purpose |
|-----------|---------|---------|
| HTTP Server | cpp-httplib | REST API on port 9876 |
| HTTP Client | libcurl | Request execution |
| Thread Pool | Custom | Concurrent request handling |
| Event Loop | curl_multi | Async I/O for load tests |
| Script Engine | QuickJS | Pre/post request scripts |
| Database | SQLite + sqlite_orm | Persistent storage |
| JSON | nlohmann-json | Serialization |

## Request Flow

```
1. App sends POST /api/execute
2. Engine parses request config
3. Run manager creates run entry
4. HTTP client executes request
5. Script engine runs test scripts
6. Results stored in database
7. Response returned to app
```

## Load Test Flow

```
1. App sends POST /api/load-test/start
2. Engine creates N virtual users
3. Event loop handles concurrent requests
4. Metrics collected every 100ms
5. SSE stream pushes metrics to app
6. Final report generated on completion
```

## Thread Model

- **Main Thread**: HTTP server, request routing
- **Worker Pool**: Request execution (4 threads default)
- **Event Loop Thread**: Async curl operations
- **Metrics Thread**: Aggregation and SSE push

## Database Schema

```sql
-- Collections (folders)
collections (id, name, parent_id, order, created_at, updated_at)

-- Saved requests
requests (id, collection_id, name, method, url, headers, body, order, ...)

-- Environments (variable sets)
environments (id, name, variables, created_at, updated_at)

-- Execution history
runs (id, request_id, environment_id, status, response, created_at)

-- Global variables
globals (key, value)
```

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 9876 | Server port |
| `--db` | `./db/vayu.db` | Database path |
| `--threads` | 4 | Worker thread count |
| `--verbose` | 1 | Log level (0-3) |
