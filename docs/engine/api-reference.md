# Vayu Engine API Reference

**Version:** 1.0  
**Base URL:** `http://127.0.0.1:9876`

---

## Overview

The Vayu Engine exposes a RESTful Control API for communication with the Manager (Electron app) or any HTTP client. All endpoints are local-only for security.

### Implementation Status

| Endpoint | Status | Details |
|----------|--------|---------|
| `GET /health` | ✅ Implemented | Server status and worker info |
| `POST /request` | ✅ Implemented | Single request execution (Design Mode) |
| `POST /run` | ✅ Implemented | Start load test (Load Mode) |
| `GET /config` | ✅ Implemented | Configuration and system limits |
| `GET /collections` | ✅ Implemented | List all collections |
| `POST /collections` | ✅ Implemented | Create/Update collection |
| `GET /requests` | ✅ Implemented | List requests in a collection |
| `POST /requests` | ✅ Implemented | Save request definition |
| `GET /environments` | ✅ Implemented | List all environments |
| `POST /environments` | ✅ Implemented | Create/Update environment |
| `GET /runs` | ✅ Implemented | List all execution runs |
| `GET /run/:id` | ✅ Implemented | Get run details |
| `POST /run/:id/stop` | ✅ Implemented | Stop a running test |
| `GET /stats/:id` | ✅ Implemented | Get metrics for a run |

**Current Usage:**
- Use **CLI** (`vayu-cli`) to interact with the daemon
- Use **HTTP API** for programmatic access (Manager App)

---

## Implemented Endpoints

### Health Check

Check if the engine is running and ready.

```
GET /health
```

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "workers": 8
}
```

---

### Run Management

#### Runs

**List All Runs:**
```
GET /runs
```

**Get Run Details:**
```
GET /run/:id
```

**Stop Run:**
```
POST /run/:id/stop
```

**Response:**
```json
{
  "status": "stopped",
  "runId": "run_1704200000000"
}
```

### Statistics

**Get Run Metrics (SSE):**
```
GET /stats/:id
```

**Response:**
Stream of Server-Sent Events (`text/event-stream`).

**Events:**
- `data`: JSON object representing a `Metric`.
- `: keep-alive`: Sent periodically to keep connection open.

**Example Event:**
```
data: {"id":1,"runId":"run_1704200000000","timestamp":1704200001000,"requestsTotal":100,"requestsFailed":0,"requestsPerSecond":100.0,"latencyMin":10.0,"latencyMax":50.0,"latencyAvg":25.0,"latencyP95":45.0,"latencyP99":49.0,"bytesIn":10240,"bytesOut":5120}

```    "requestsPerSec": 50.5,
    "latencyP50": 120.5,
    "latencyP99": 250.0,
    "errorsTotal": 0
  }
]
```

---

### Project Management

#### Collections

**List Collections:**
```
GET /collections
```

**Create Collection:**
```
POST /collections
```
```json
{
  "id": "col_123",
  "name": "User API",
  "parentId": null,
  "order": 1
}
```

#### Requests

**List Requests:**
```
GET /requests?collectionId=col_123
```

**Save Request:**
```
POST /requests
```
```json
{
  "id": "req_456",
  "collectionId": "col_123",
  "name": "Get Profile",
  "method": "GET",
  "url": "https://api.example.com/me",
  "headers": {"Authorization": "Bearer token"},
  "preRequestScript": "console.log('Pre')",
  "postRequestScript": "pm.test('OK', () => pm.response.code === 200)"
}
```

#### Environments

**List Environments:**
```
GET /environments
```

**Save Environment:**
```
POST /environments
```
```json
{
  "id": "env_prod",
  "name": "Production",
  "variables": {
    "BASE_URL": "https://api.example.com"
  }
}
```

---

### Execution

#### Execute Request (Design Mode)

Execute a single request, save result to DB, and return full response.

```
POST /request
```

**Request Body:**
Standard Vayu Request Object (see below). Optional fields:
- `requestId`: Link execution to a saved request
- `environmentId`: Link execution to an environment

**Response:**
Full HTTP response with timing metrics.

#### Start Load Test (Load Mode)

Queue a load test execution.

```
POST /run
```

**Request Body:**
Standard Vayu Request Object.

**Response:**
```json
{
  "runId": "run_1704200000000",
  "status": "pending",
  "message": "Run created"
}
```
| `method` | string | ✅ | HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS) |
| `url` | string | ✅ | Request URL (supports `{{variables}}`) |
| `headers` | object | ❌ | Key-value headers |
| `body` | object | ❌ | Request body configuration |
| `body.mode` | string | ❌ | `json`, `text`, `form`, `formdata`, `binary`, `none` |
| `body.content` | any | ❌ | Body content (depends on mode) |
| `timeout` | number | ❌ | Request timeout in ms (default: 30000) |
| `followRedirects` | boolean | ❌ | Follow HTTP redirects (default: true) |
| `maxRedirects` | number | ❌ | Max redirects to follow (default: 10) |
| `environment` | object | ❌ | Variables for `{{substitution}}` |
| `script.pre` | string | ❌ | JavaScript to run before request |
| `script.post` | string | ❌ | JavaScript to run after response |

**Response (200 OK):**

```json
{
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "abc123"
  },
  "body": {
    "id": 42,
    "name": "John Doe",
    "created": true
  },
  "bodyRaw": "{\"id\":42,\"name\":\"John Doe\",\"created\":true}",
  "bodySize": 45,
  "timing": {
    "total": 234.5,
    "dns": 12.3,
    "connect": 45.6,
    "tls": 78.9,
    "firstByte": 156.7,
    "download": 77.8
  },
  "testResults": [
    {
      "name": "Status OK",
      "passed": true,
      "error": null
    }
  ],
  "consoleOutput": ["Starting request..."],
  "cookies": [
    {
      "name": "session",
      "value": "xyz789",
      "domain": "api.example.com",
      "path": "/",
      "expires": "2026-01-03T00:00:00Z",
      "httpOnly": true,
      "secure": true
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status code |
| `statusText` | string | HTTP status text |
| `headers` | object | Response headers (lowercase keys) |
| `body` | any | Parsed body (JSON if applicable) |
| `bodyRaw` | string | Raw body as string |
| `bodySize` | number | Body size in bytes |
| `timing` | object | Request timing breakdown (ms) |
| `timing.total` | number | Total request time |
| `timing.dns` | number | DNS lookup time |
| `timing.connect` | number | TCP connection time |
| `timing.tls` | number | TLS handshake time |
| `timing.firstByte` | number | Time to first byte (TTFB) |
| `timing.download` | number | Body download time |
| `testResults` | array | Results of `pm.test()` assertions |
| `consoleOutput` | array | Output from `console.log()` |
| `cookies` | array | Cookies set by response |

**Error Response (4xx/5xx):**

```json
{
  "error": {
    "code": "REQUEST_TIMEOUT",
    "message": "Request timed out after 30000ms",
    "details": {
      "url": "https://api.example.com/users",
      "timeout": 30000
    }
  }
}
```

---

### Get Configuration

Get engine configuration and system limits.

```
GET /config
```

**Response (200 OK):**

```json
{
  "workers": 8,
  "maxConnections": 10000,
  "defaultTimeout": 30000,
  "statsInterval": 100,
  "contextPoolSize": 64
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workers` | number | Number of worker threads (= CPU cores) |
| `maxConnections` | number | Maximum concurrent connections |
| `defaultTimeout` | number | Default request timeout in milliseconds |
| `statsInterval` | number | Statistics update interval in milliseconds |
| `contextPoolSize` | number | Pre-allocated QuickJS context pool size |

---

### Start Load Test (Vayu Mode) 🔨 IN PROGRESS

> **Status:** Endpoint structure is in place but implementation is pending.
> Currently returns HTTP 501 (Not Implemented) with placeholder response.
>
> **Current Workaround:** Use the CLI `batch` command for concurrent request execution:
> ```bash
> vayu-cli batch request.json request.json --concurrency 100
> ```
> See [CLI Reference](cli.md) for details.

Start a high-concurrency load test. Returns immediately with a run ID.

```
POST /run
```

**Request Body:**

```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/health",
    "headers": {
      "Authorization": "Bearer {{token}}"
    }
  },
  "config": {
    "mode": "duration",
    "duration": "60s",
    "concurrency": 100,
    "rampUp": "10s",
    "rampDown": "5s",
    "rps": 10000,
    "timeout": 5000
  },
  "environment": {
    "token": "eyJhbGciOiJIUzI1NiIs..."
  },
  "script": {
    "post": "pm.test('Fast', () => pm.response.responseTime < 100)"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `request` | object | ✅ | Same as `/request` endpoint |
| `config` | object | ✅ | Load test configuration |
| `config.mode` | string | ✅ | `duration` or `iterations` |
| `config.duration` | string | ❌ | Test duration (e.g., `"60s"`, `"5m"`) |
| `config.iterations` | number | ❌ | Total requests to send |
| `config.concurrency` | number | ✅ | Concurrent connections |
| `config.rampUp` | string | ❌ | Time to reach full concurrency |
| `config.rampDown` | string | ❌ | Time to wind down |
| `config.rps` | number | ❌ | Target requests per second (rate limit) |
| `config.timeout` | number | ❌ | Per-request timeout in ms |
| `environment` | object | ❌ | Variables for substitution |
| `script` | object | ❌ | Pre/post scripts |

**Response (202 Accepted):**

```json
{
  "runId": "run_abc123def456",
  "status": "starting",
  "streamUrl": "/stats/run_abc123def456"
}
```

---

### Get Run Status ⏳ PLANNED

> **Status:** This endpoint is designed but not yet implemented.

Get current status and final results of a load test.

```
GET /run/:runId
```

**Response (Running):**

```json
{
  "runId": "run_abc123def456",
  "status": "running",
  "progress": {
    "elapsed": "45s",
    "remaining": "15s",
    "percentage": 75
  },
  "currentStats": {
    "rps": 9845,
    "latency": {
      "avg": 12.3,
      "p99": 45.6
    }
  }
}
```

**Response (Completed):**

```json
{
  "runId": "run_abc123def456",
  "status": "completed",
  "summary": {
    "duration": 60.0,
    "totalRequests": 589234,
    "successfulRequests": 588012,
    "failedRequests": 1222,
    "rps": {
      "mean": 9820,
      "max": 10234
    },
    "latency": {
      "min": 0.8,
      "avg": 10.2,
      "p50": 8.5,
      "p90": 18.3,
      "p95": 25.7,
      "p99": 45.2,
      "max": 234.5
    },
    "throughput": {
      "sent": "125.4 MB",
      "received": "892.1 MB"
    },
    "errors": {
      "timeout": 845,
      "connection_refused": 234,
      "http_5xx": 143
    },
    "testResults": {
      "Fast": {
        "passed": 523456,
        "failed": 65778
      }
    }
  }
}
```

| Status | Description |
|--------|-------------|
| `starting` | Initializing workers |
| `running` | Test in progress |
| `stopping` | Ramping down |
| `completed` | Test finished successfully |
| `failed` | Test aborted due to error |
| `cancelled` | Test cancelled by user |

---

### Stream Stats (SSE) ⏳ PLANNED

> **Status:** This endpoint is designed but not yet implemented.

Real-time statistics stream via Server-Sent Events.

```
GET /stats/:runId
```

**Headers:**
```
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event Stream:**

```
event: stats
data: {"timestamp":1704153600000,"rps":9523,"latency":{"avg":10.5,"p99":42.1},"requests":{"total":95230,"success":95012,"failed":218}}

event: stats
data: {"timestamp":1704153600100,"rps":9845,"latency":{"avg":10.2,"p99":40.3},"requests":{"total":96078,"success":95856,"failed":222}}

event: complete
data: {"runId":"run_abc123def456","summary":{...}}
```

**Event Types:**

| Event | Description |
|-------|-------------|
| `stats` | Periodic stats update (~100ms interval) |
| `complete` | Test completed, includes full summary |
| `error` | Test failed, includes error details |

**Stats Event Data:**

```json
{
  "timestamp": 1704153600000,
  "elapsed": 45.2,
  "rps": 9845,
  "latency": {
    "min": 0.8,
    "avg": 10.2,
    "p50": 8.5,
    "p95": 25.7,
    "p99": 42.1,
    "max": 156.3
  },
  "requests": {
    "total": 443025,
    "success": 442234,
    "failed": 791
  },
  "connections": {
    "active": 100,
    "idle": 0
  },
  "throughput": {
    "sentBps": 2145678,
    "receivedBps": 15234567
  }
}
```

---

### Stop Run ⏳ PLANNED

> **Status:** This endpoint is designed but not yet implemented.

Cancel a running load test.

```
POST /run/:runId/stop
```

**Response (200 OK):**

```json
{
  "runId": "run_abc123def456",
  "status": "stopping",
  "message": "Gracefully stopping test..."
}
```

---

### List Runs ⏳ PLANNED

> **Status:** This endpoint is designed but not yet implemented.

Get all recent runs (last 100).

```
GET /runs
```

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status |
| `limit` | number | Max results (default: 50) |
| `offset` | number | Pagination offset |

**Response:**

```json
{
  "runs": [
    {
      "runId": "run_abc123def456",
      "status": "completed",
      "startedAt": "2026-01-02T10:00:00Z",
      "completedAt": "2026-01-02T10:01:00Z",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/health"
      },
      "summary": {
        "totalRequests": 589234,
        "rps": 9820
      }
    }
  ],
  "total": 23,
  "limit": 50,
  "offset": 0
}
```

---

### Configuration

Get or update engine configuration.

```
GET /config
```

**Response:**

```json
{
  "workers": 8,
  "maxConnections": 10000,
  "defaultTimeout": 30000,
  "statsInterval": 100,
  "contextPoolSize": 64,
  "logging": {
    "level": "info",
    "file": null
  }
}
```

```
PATCH /config
```

**Request Body:**

```json
{
  "defaultTimeout": 60000,
  "logging": {
    "level": "debug"
  }
}
```

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_REQUEST` | 400 | Malformed request body |
| `INVALID_URL` | 400 | URL is invalid or unreachable |
| `INVALID_METHOD` | 400 | Unsupported HTTP method |
| `SCRIPT_ERROR` | 400 | JavaScript syntax/runtime error |
| `RUN_NOT_FOUND` | 404 | Run ID does not exist |
| `RUN_ALREADY_STOPPED` | 409 | Run is not in a stoppable state |
| `REQUEST_TIMEOUT` | 504 | Request exceeded timeout |
| `CONNECTION_FAILED` | 502 | Could not connect to target |
| `SSL_ERROR` | 502 | TLS/SSL handshake failed |
| `DNS_ERROR` | 502 | DNS resolution failed |
| `INTERNAL_ERROR` | 500 | Unexpected engine error |

---

## Scripting API (pm object)

The `pm` object is available in pre/post scripts, compatible with Postman.

### pm.response

Available in post-request scripts only.

```javascript
pm.response.code          // HTTP status code (number)
pm.response.status        // Status text (string)
pm.response.body          // Parsed body (object if JSON)
pm.response.text()        // Raw body as string
pm.response.json()        // Parse body as JSON
pm.response.headers       // Headers object
pm.response.responseTime  // Total time in ms
pm.response.cookies       // Cookies array
```

### pm.request

Available in both pre and post scripts.

```javascript
pm.request.method         // HTTP method
pm.request.url            // Full URL (after variable substitution)
pm.request.headers        // Request headers
pm.request.body           // Request body
```

### pm.variables

```javascript
pm.variables.get("key")           // Get variable value
pm.variables.set("key", "value")  // Set variable (current run only)
pm.environment.get("key")         // Get environment variable
pm.environment.set("key", "val")  // Set environment variable
```

### pm.test

Define test assertions.

```javascript
pm.test("Test name", function() {
    // Assertions here
    pm.expect(pm.response.code).to.equal(200);
});
```

### pm.expect

Chai-style assertions.

```javascript
pm.expect(value).to.equal(expected)
pm.expect(value).to.not.equal(unexpected)
pm.expect(value).to.be.true
pm.expect(value).to.be.false
pm.expect(value).to.be.null
pm.expect(value).to.be.undefined
pm.expect(value).to.be.above(n)
pm.expect(value).to.be.below(n)
pm.expect(value).to.be.within(min, max)
pm.expect(array).to.include(item)
pm.expect(string).to.match(/regex/)
pm.expect(object).to.have.property("key")
pm.expect(object).to.have.property("key", value)
pm.expect(array).to.have.length(n)
pm.expect(value).to.be.a("string")
pm.expect(value).to.be.an("array")
```

### console

Standard console methods.

```javascript
console.log("message", value)
console.info("info message")
console.warn("warning")
console.error("error")
```

---

## WebSocket Support (Future)

Reserved endpoints for future WebSocket testing:

```
WS /ws/connect
WS /ws/send
WS /ws/stats/:runId
```

---

*← [Building Engine](building.md) | [Engine Architecture](architecture.md) →*
