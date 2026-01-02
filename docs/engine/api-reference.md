# Vayu Engine API Reference

**Version:** 0.1.0  
**Base URL:** `http://127.0.0.1:9876`

---

## Overview

The Vayu Engine exposes a RESTful Control API for managing HTTP requests, load tests, and execution monitoring. All endpoints are local-only for security.

### Endpoint Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health check and version info |
| `/config` | GET | Get engine configuration and system limits |
| **Project Management** |
| `/collections` | GET | List all collections (folders) |
| `/collections` | POST | Create or update a collection |
| `/requests` | GET | List requests in a collection |
| `/requests` | POST | Save or update a request definition |
| `/environments` | GET | List all environments |
| `/environments` | POST | Create or update an environment |
| **Execution** |
| `/request` | POST | Execute single request (Design Mode) |
| `/run` | POST | Start load test (Vayu Mode) |
| `/runs` | GET | List all test runs |
| `/run/:runId` | GET | Get specific run details |
| `/run/:runId/report` | GET | Get detailed performance report |
| `/run/:runId/stop` | POST | Stop a running load test |
| `/stats/:runId` | GET | Stream real-time metrics (SSE) |

**Usage:**
- **CLI:** Use `vayu-cli` for command-line interaction
- **API:** Use HTTP endpoints for programmatic access (Manager App)

---

## Health & Configuration

### GET /health

Check if the engine is running and ready to accept requests.

**Response (200 OK):**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "workers": 12
}
```

**Fields:**
- `status`: Always "ok" if server is running
- `version`: Engine version string
- `workers`: Number of CPU cores/threads available

---

### GET /config

Retrieves the global configuration settings and system limits.

**Response (200 OK):**
```json
{
  "workers": 12,
  "maxConnections": 10000,
  "defaultTimeout": 30000,
  "statsInterval": 100,
  "contextPoolSize": 64
}
```

**Configuration Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `workers` | number | Number of worker threads (CPU cores) |
| `maxConnections` | number | Maximum concurrent HTTP connections |
| `defaultTimeout` | number | Default request timeout in milliseconds |
| `statsInterval` | number | Statistics update interval in ms (for load tests) |
| `contextPoolSize` | number | Pre-allocated QuickJS context pool size |

---

## Project Management

### GET /collections

Retrieves all collections from the database. Collections are folders that organize requests in a hierarchy.

**Response (200 OK):**
```json
[
  {
    "id": "col_123",
    "parentId": null,
    "name": "API Tests",
    "order": 0,
    "createdAt": 1704200000000
  },
  {
    "id": "col_456",
    "parentId": "col_123",
    "name": "User Endpoints",
    "order": 1,
    "createdAt": 1704200001000
  }
]
```

**Collection Object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique collection identifier |
| `parentId` | string\|null | Parent collection ID (null for root) |
| `name` | string | Collection name |
| `order` | number | Display order within parent |
| `createdAt` | number | Creation timestamp (milliseconds) |

---

### POST /collections

Creates a new collection in the database.

**Request Body:**
```json
{
  "id": "col_789",
  "name": "Admin Endpoints",
  "parentId": "col_123",
  "order": 2
}
```

**Required Fields:**
- `id` (string): Unique collection identifier
- `name` (string): Collection name

**Optional Fields:**
- `parentId` (string|null): Parent collection ID
- `order` (number): Display order (default: 0)

**Response (200 OK):**
Returns the created collection object with `createdAt` timestamp.

**Errors:**
- `400 Bad Request`: Invalid JSON or missing required fields

---

### GET /requests

Retrieves all requests belonging to a specific collection.

**Query Parameters:**
- `collectionId` (required): The collection ID to fetch requests from

**Example:**
```
GET /requests?collectionId=col_123
```

**Response (200 OK):**
```json
[
  {
    "id": "req_abc",
    "collectionId": "col_123",
    "name": "Get User Profile",
    "method": "GET",
    "url": "https://api.example.com/users/{{userId}}",
    "headers": {
      "Authorization": "Bearer {{token}}",
      "Accept": "application/json"
    },
    "body": {},
    "auth": {},
    "preRequestScript": "",
    "postRequestScript": "pm.test('Status OK', () => pm.response.code === 200);",
    "updatedAt": 1704200000000
  }
]
```

**Request Object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique request identifier |
| `collectionId` | string | Parent collection ID |
| `name` | string | Request display name |
| `method` | string | HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS) |
| `url` | string | Request URL (supports {{variables}}) |
| `headers` | object | HTTP headers (key-value pairs) |
| `body` | any | Request body (object or string) |
| `auth` | object | Authentication configuration |
| `preRequestScript` | string | JavaScript to run before request |
| `postRequestScript` | string | JavaScript to run after response (tests) |
| `updatedAt` | number | Last modification timestamp |

**Errors:**
- `400 Bad Request`: Missing `collectionId` parameter

---

### POST /requests

Creates or updates a request definition in the database.

**Request Body:**
```json
{
  "id": "req_xyz",
  "collectionId": "col_123",
  "name": "Update User",
  "method": "PUT",
  "url": "https://api.example.com/users/{{userId}}",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer {{token}}"
  },
  "body": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "auth": {
    "type": "bearer",
    "token": "{{token}}"
  },
  "preRequestScript": "console.log('Updating user:', pm.variables.get('userId'));",
  "postRequestScript": "pm.test('Updated', () => pm.response.code === 200);"
}
```

**Required Fields:**
- `id` (string): Unique request identifier
- `collectionId` (string): Parent collection ID
- `name` (string): Request display name
- `method` (string): HTTP method
- `url` (string): Request URL

**Optional Fields:**
- `headers` (object): HTTP headers
- `body` (any): Request body
- `auth` (object): Authentication config
- `preRequestScript` (string): Pre-request script
- `postRequestScript` (string): Post-request script (tests)

**Response (200 OK):**
Returns the saved request object with `updatedAt` timestamp.

**Errors:**
- `400 Bad Request`: Invalid JSON, missing required fields, or invalid HTTP method

---

### GET /environments

Retrieves all saved environments from the database. Environments contain variables that can be used in requests (e.g., API keys, base URLs).

**Response (200 OK):**
```json
[
  {
    "id": "env_prod",
    "name": "Production",
    "variables": {
      "BASE_URL": "https://api.example.com",
      "API_KEY": "prod_key_123",
      "userId": "12345"
    },
    "updatedAt": 1704200000000
  },
  {
    "id": "env_dev",
    "name": "Development",
    "variables": {
      "BASE_URL": "http://localhost:3000",
      "API_KEY": "dev_key_456"
    },
    "updatedAt": 1704200001000
  }
]
```

**Environment Object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique environment identifier |
| `name` | string | Environment display name |
| `variables` | object | Key-value pairs for variable substitution |
| `updatedAt` | number | Last modification timestamp |

---

### POST /environments

Creates or updates an environment in the database.

**Request Body:**
```json
{
  "id": "env_staging",
  "name": "Staging",
  "variables": {
    "BASE_URL": "https://staging-api.example.com",
    "API_KEY": "staging_key_789",
    "timeout": "5000"
  }
}
```

**Required Fields:**
- `id` (string): Unique environment identifier
- `name` (string): Environment display name

**Optional Fields:**
- `variables` (object): Variable key-value pairs (default: {})

**Response (200 OK):**
Returns the saved environment object with `updatedAt` timestamp.

**Errors:**
- `400 Bad Request`: Invalid JSON or missing required fields

---

## Execution

### POST /request

Executes a single HTTP request immediately and returns the full response. This is "Design Mode" - used for testing individual requests with immediate feedback.

**Request Body:**
```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer eyJhbGci..."
  },
  "body": {
    "name": "Jane Doe",
    "email": "jane@example.com"
  },
  "requestId": "req_123",
  "environmentId": "env_prod"
}
```

**Required Fields:**
- `method` (string): HTTP method
- `url` (string): Target URL

**Optional Fields:**
- `headers` (object): HTTP headers
- `body` (any): Request body
- `auth` (object): Authentication config
- `preRequestScript` (string): JavaScript to run before request
- `postRequestScript` (string): JavaScript to run after response
- `requestId` (string): Link execution to a saved request
- `environmentId` (string): Link execution to an environment

**Response (200 OK):**
```json
{
  "status": 201,
  "statusText": "Created",
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": "abc123"
  },
  "body": {
    "id": 789,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "createdAt": "2026-01-03T10:30:00Z"
  },
  "bodyRaw": "{\"id\":789,\"name\":\"Jane Doe\",...}",
  "timing": {
    "total_ms": 234.5,
    "dns_ms": 12.3,
    "connect_ms": 45.6,
    "tls_ms": 78.9,
    "first_byte_ms": 156.7,
    "download_ms": 77.8
  }
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status code |
| `statusText` | string | HTTP status text |
| `headers` | object | Response headers (lowercase keys) |
| `body` | any | Parsed body (JSON if applicable) |
| `bodyRaw` | string | Raw body as string |
| `timing` | object | Request timing breakdown |
| `timing.total_ms` | number | Total request time in milliseconds |
| `timing.dns_ms` | number | DNS lookup time |
| `timing.connect_ms` | number | TCP connection time |
| `timing.tls_ms` | number | TLS handshake time |
| `timing.first_byte_ms` | number | Time to first byte (TTFB) |
| `timing.download_ms` | number | Body download time |

**Automatic Persistence:**
- Creates a "design" type run in the database
- Stores full response trace including headers and body
- Links to `requestId` and `environmentId` if provided

**Error Response (502 Bad Gateway):**
```json
{
  "error": {
    "code": "timeout",
    "message": "Request timed out after 30000ms"
  }
}
```

**Error Response (400 Bad Request):**
```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid HTTP method: INVALID"
  }
}
```

---

### POST /run

Starts a load test run that executes multiple requests concurrently based on the specified load profile. Returns immediately with a run ID while the test executes asynchronously.

**Request Body:**
```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/health",
    "headers": {
      "Accept": "application/json"
    }
  },
  "mode": "constant",
  "duration": "30s",
  "targetRps": 50,
  "success_sample_rate": 10,
  "slow_threshold_ms": 1000,
  "save_timing_breakdown": true,
  "requestId": "req_123",
  "environmentId": "env_prod"
}
```

**Required Fields:**
- `request` (object): HTTP request configuration (same as `/request`)
  - `method` (string): HTTP method
  - `url` (string): Target URL
- `mode` (string): Load test strategy (see modes below)

**Load Test Modes:**

#### 1. Constant Load (Rate-Limited)
Maintains a target requests per second for a specified duration.

```json
{
  "mode": "constant",
  "duration": "30s",
  "targetRps": 100
}
```

**Parameters:**
- `duration` (string): Test duration (e.g., "10s", "5m", "1h")
- `targetRps` (number): Target requests per second

**Note:** If `targetRps` is specified, uses precise rate limiting (20ms intervals for 50 RPS). Otherwise falls back to concurrency-based mode.

#### 2. Constant Load (Concurrency-Based)
Submits requests in batches based on concurrency level.

```json
{
  "mode": "constant",
  "duration": "60s",
  "concurrency": 100
}
```

**Parameters:**
- `duration` (string): Test duration
- `concurrency` (number): Number of concurrent requests

#### 3. Iterations
Executes a fixed number of requests with specified concurrency.

```json
{
  "mode": "iterations",
  "iterations": 1000,
  "concurrency": 10
}
```

**Parameters:**
- `iterations` (number): Total number of requests to execute
- `concurrency` (number): Number of concurrent requests

#### 4. Ramp-Up
Gradually increases concurrency from start to target level.

```json
{
  "mode": "ramp_up",
  "duration": "60s",
  "rampUpDuration": "30s",
  "startConcurrency": 1,
  "concurrency": 100
}
```

**Parameters:**
- `duration` (string): Total test duration
- `rampUpDuration` (string): Time to reach target concurrency
- `startConcurrency` (number): Initial concurrency level
- `concurrency` (number): Target concurrency level

**Data Capture Settings:**

These optional fields control how much data is stored during the test:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `success_sample_rate` | number (1-100) | 100 | Percentage of successful requests to save (reduces DB size) |
| `slow_threshold_ms` | number | 1000 | Auto-save requests slower than this threshold (ms) |
| `save_timing_breakdown` | boolean | false | Capture detailed timing (DNS, TLS, TTFB, etc.) |

**Example: High-Performance Test with Smart Sampling**
```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/users"
  },
  "mode": "constant",
  "duration": "60s",
  "targetRps": 1000,
  "success_sample_rate": 5,
  "slow_threshold_ms": 500,
  "save_timing_breakdown": true
}
```
This saves only 5% of successful requests but captures all slow requests and errors.

**Response (202 Accepted):**
```json
{
  "runId": "run_1704200000000",
  "status": "pending",
  "message": "Load test started"
}
```

**Automatic Persistence:**
- Creates a "load" type run in the database
- Links to `requestId` and `environmentId` if provided
- Stores config snapshot for reproducibility
- Test executes asynchronously via RunManager

**Errors:**
- `400 Bad Request`: Missing required fields or invalid mode
- `500 Internal Server Error`: Failed to create run

**Monitoring:**
Use `GET /stats/:runId` to monitor real-time progress or `GET /run/:runId/report` for final results.

---

## Run Management

### GET /runs

Retrieves all test runs from the database (both "design" mode single requests and "load" mode test runs).

**Response (200 OK):**
```json
[
  {
    "id": "run_1704200000000",
    "requestId": "req_123",
    "environmentId": "env_prod",
    "type": "load",
    "status": "completed",
    "configSnapshot": "{\"request\":{\"method\":\"GET\"...},\"mode\":\"constant\",\"duration\":\"30s\",\"targetRps\":50}",
    "startTime": 1704200000000,
    "endTime": 1704200030234
  },
  {
    "id": "run_1704199999000",
    "requestId": "req_456",
    "environmentId": null,
    "type": "design",
    "status": "completed",
    "configSnapshot": "{\"method\":\"POST\",\"url\":\"https://api.example.com/users\"}",
    "startTime": 1704199999000,
    "endTime": 1704199999234
  }
]
```

**Run Object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique run identifier (e.g., "run_1704200000000") |
| `requestId` | string\|null | Linked request definition ID |
| `environmentId` | string\|null | Linked environment ID |
| `type` | string | "design" (single request) or "load" (load test) |
| `status` | string | "pending", "running", "completed", "stopped", "failed" |
| `configSnapshot` | string | JSON snapshot of the request configuration |
| `startTime` | number | Start timestamp in milliseconds |
| `endTime` | number | End timestamp in milliseconds |

**Errors:**
- `500 Internal Server Error`: Database query failed

---

### GET /run/:runId

Retrieves details for a specific test run by its ID.

**Path Parameters:**
- `runId` (required): The unique identifier of the run

**Example:**
```
GET /run/run_1704200000000
```

**Response (200 OK):**
```json
{
  "id": "run_1704200000000",
  "requestId": "req_123",
  "environmentId": "env_prod",
  "type": "load",
  "status": "completed",
  "configSnapshot": "{\"request\":{\"method\":\"GET\",\"url\":\"https://api.example.com/health\"},\"mode\":\"constant\",\"duration\":\"30s\",\"targetRps\":50}",
  "startTime": 1704200000000,
  "endTime": 1704200030234
}
```

**Errors:**
- `404 Not Found`: Run with specified ID does not exist
- `500 Internal Server Error`: Database query failed

---

### GET /run/:runId/report

Retrieves a detailed statistical report for a specific test run. Calculates aggregate metrics including percentiles, error rates, and status code distribution.

**Path Parameters:**
- `runId` (required): The unique identifier of the run

**Example:**
```
GET /run/run_1704200000000/report
```

**Response (200 OK):**
```json
{
  "summary": {
    "totalRequests": 100,
    "successfulRequests": 95,
    "failedRequests": 5,
    "errorRate": 5.0,
    "totalDurationSeconds": 30.5,
    "avgRps": 3.28
  },
  "latency": {
    "min": 1000.96,
    "max": 2343.64,
    "avg": 1388.23,
    "p50": 1180.22,
    "p90": 1890.45,
    "p95": 2045.19,
    "p99": 2343.64
  },
  "statusCodes": {
    "200": 95
  },
  "errors": {
    "total": 5,
    "withDetails": 5,
    "types": {
      "timeout": 3,
      "connection_failed": 2
    }
  },
  "timingBreakdown": {
    "avgDnsMs": 15.3,
    "avgConnectMs": 45.7,
    "avgTlsMs": 78.2,
    "avgFirstByteMs": 120.5,
    "avgDownloadMs": 5.1
  },
  "slowRequests": {
    "count": 12,
    "thresholdMs": 1000,
    "percentage": 12.6
  }
}
```

**Report Fields:**

**Summary:**
| Field | Type | Description |
|-------|------|-------------|
| `totalRequests` | number | Total requests executed |
| `successfulRequests` | number | Requests with HTTP 2xx/3xx status |
| `failedRequests` | number | Requests with errors or HTTP 4xx/5xx |
| `errorRate` | number | Percentage of failed requests |
| `totalDurationSeconds` | number | Total test duration in seconds |
| `avgRps` | number | Average requests per second |

**Latency:**
| Field | Type | Description |
|-------|------|-------------|
| `min` | number | Minimum latency in milliseconds |
| `max` | number | Maximum latency in milliseconds |
| `avg` | number | Average latency in milliseconds |
| `p50` | number | 50th percentile (median) |
| `p90` | number | 90th percentile |
| `p95` | number | 95th percentile |
| `p99` | number | 99th percentile |

**Status Codes:**
Object mapping HTTP status codes to their occurrence count.

**Errors:**
| Field | Type | Description |
|-------|------|-------------|
| `total` | number | Total number of errors |
| `withDetails` | number | Errors with detailed information |
| `types` | object | Error types and their counts (timeout, connection_failed, dns_failed, ssl_error, etc.) |

**Timing Breakdown:** (only if `save_timing_breakdown` was enabled)
| Field | Type | Description |
|-------|------|-------------|
| `avgDnsMs` | number | Average DNS lookup time |
| `avgConnectMs` | number | Average TCP connection time |
| `avgTlsMs` | number | Average TLS handshake time |
| `avgFirstByteMs` | number | Average time to first byte (TTFB) |
| `avgDownloadMs` | number | Average body download time |

**Slow Requests:** (only if `slow_threshold_ms` was set)
| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Number of requests slower than threshold |
| `thresholdMs` | number | Slow threshold in milliseconds |
| `percentage` | number | Percentage of total requests |

**Errors:**
- `404 Not Found`: Run with specified ID does not exist
- `500 Internal Server Error`: Database query or calculation failed

---

### POST /run/:runId/stop

Stops an active load test run gracefully. Signals the running thread to stop and waits up to 5 seconds for graceful shutdown.

**Path Parameters:**
- `runId` (required): The unique identifier of the run to stop

**Example:**
```
POST /run/run_1704200000000/stop
```

**Response (200 OK) - Run Stopped:**
```json
{
  "status": "stopped",
  "runId": "run_1704200000000",
  "summary": {
    "totalRequests": 75,
    "errors": 2,
    "errorRate": 2.67,
    "avgLatency": 145.8
  }
}
```

**Response (200 OK) - Already Completed:**
```json
{
  "status": "already_stopped",
  "runId": "run_1704200000000",
  "currentStatus": "completed",
  "message": "Run is already completed"
}
```

**Response (200 OK) - Not Active:**
```json
{
  "status": "not_running",
  "runId": "run_1704200000000",
  "message": "Run is not currently active"
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | "stopped", "already_stopped", or "not_running" |
| `runId` | string | Run identifier |
| `summary` | object | Summary metrics (if stopped successfully) |
| `summary.totalRequests` | number | Total requests completed |
| `summary.errors` | number | Total errors |
| `summary.errorRate` | number | Error percentage |
| `summary.avgLatency` | number | Average latency in milliseconds |
| `currentStatus` | string | Current run status (if already stopped) |
| `message` | string | Descriptive message |

**Graceful Shutdown:**
- Sets `should_stop` flag on the run context
- Waits up to 5 seconds for the test to complete naturally
- Updates run status to "stopped" in database
- Returns summary metrics

**Errors:**
- `404 Not Found`: Run with specified ID does not exist
- `500 Internal Server Error`: Failed to stop run

---

### GET /stats/:runId

Streams real-time statistics for a load test run using Server-Sent Events (SSE). Continuously streams metric events as they are recorded in the database until the test completes.

**Path Parameters:**
- `runId` (required): The unique identifier of the run to monitor

**Example:**
```
GET /stats/run_1704200000000
```

**Response Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event Stream:**
```
event: metric
data: {"id":99,"name":"rps","runId":"run_1704200000000","timestamp":1704200001000,"value":0.0}

event: metric
data: {"id":100,"name":"error_rate","runId":"run_1704200000000","timestamp":1704200001000,"value":0.0}

event: metric
data: {"id":101,"name":"connections_active","runId":"run_1704200000000","timestamp":1704200001000,"value":52.0}

event: metric
data: {"id":102,"name":"requests_sent","runId":"run_1704200000000","timestamp":1704200001000,"value":52.0}

event: metric
data: {"id":103,"name":"requests_expected","runId":"run_1704200000000","timestamp":1704200001000,"value":100.0}

: keep-alive

event: complete
data: {"event":"complete","runId":"run_1704200000000","status":"completed"}
```

**Event Types:**

| Event | Description |
|-------|-------------|
| `metric` | Performance metric data (sent every second during test) |
| `complete` | Test finished (sent once at the end) |
| Comments (`:`) | Keep-alive messages (every 500ms when no metrics) |

**Metric Event Data:**

```json
{
  "id": 102,
  "name": "requests_sent",
  "runId": "run_1704200000000",
  "timestamp": 1704200001000,
  "value": 52.0
}
```

**Metric Object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Metric sequence number (auto-incremented) |
| `name` | string | Metric name (see metric types below) |
| `runId` | string | Parent run identifier |
| `timestamp` | number | Metric timestamp in milliseconds |
| `value` | number | Numeric metric value |

**Metric Types:**

| Metric Name | Description | Update Frequency |
|-------------|-------------|------------------|
| `rps` | Requests per second (current rate) | Every 1s |
| `error_rate` | Error percentage | Every 1s |
| `connections_active` | Currently active HTTP connections | Every 1s |
| `requests_sent` | Total requests submitted to event loop | Every 1s |
| `requests_expected` | Expected total requests for this run | Every 1s |
| `latency_avg` | Average latency | Final summary |
| `latency_p50` | 50th percentile latency | Final summary |
| `latency_p95` | 95th percentile latency | Final summary |
| `latency_p99` | 99th percentile latency | Final summary |
| `total_requests` | Total completed requests | Final summary |
| `completed` | Test completion indicator (value: 1.0) | Once at end |

**Completion Event Data:**

```json
{
  "event": "complete",
  "runId": "run_1704200000000",
  "status": "completed"
}
```

**Usage Examples:**

**cURL:**
```bash
curl -N http://127.0.0.1:9876/stats/run_1704200000000
```

**JavaScript (Browser):**
```javascript
const es = new EventSource('http://127.0.0.1:9876/stats/run_1704200000000');

es.addEventListener('metric', (event) => {
  const metric = JSON.parse(event.data);
  console.log(`${metric.name}: ${metric.value}`);
  
  // Update UI with real-time metrics
  if (metric.name === 'requests_sent') {
    updateProgress(metric.value);
  }
});

es.addEventListener('complete', (event) => {
  const data = JSON.parse(event.data);
  console.log('Test completed:', data.status);
  es.close();
});

es.onerror = () => {
  console.error('Connection lost');
  es.close();
};
```

**Connection Management:**
- Sends keep-alive comments every 500ms when no new metrics
- Automatically closes when test completes/stops/fails
- Checks run status in database if no metrics available
- Client should close connection on `complete` event

**Errors:**
- `404 Not Found`: Run with specified ID does not exist
- `500 Internal Server Error`: Database query failed

---

## Database Integration

All endpoints automatically persist data to SQLite (`engine/db/vayu.db`).

**Persistence Mapping:**

| Endpoint | Table(s) | Operation |
|----------|----------|-----------|
| `POST /collections` | `collections` | INSERT/UPDATE |
| `POST /requests` | `requests` | INSERT/UPDATE |
| `POST /environments` | `environments` | INSERT/UPDATE |
| `POST /request` | `runs`, `results` | INSERT (type=design) |
| `POST /run` | `runs` | INSERT (type=load) |
| `GET /stats/:runId` | `metrics` | INSERT (per metric) |
| Results handler | `results` | INSERT (per response) |

**Database Schema:**

**Core Tables:**
- **collections**: Folder hierarchy for organizing requests
- **requests**: Saved request definitions
- **environments**: Variable sets for different contexts
- **runs**: Execution records (both design and load)
- **results**: Individual request/response records
- **metrics**: Time-series performance data
- **kv_store**: Key-value configuration storage

See [Architecture Documentation](architecture.md#storage-layer-database) for complete schema details.

---

## Error Codes

**Error Response Format:**
```json
{
  "error": {
    "code": "TIMEOUT",
    "message": "Request timed out after 30000ms"
  }
}
```

**Common Error Codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_REQUEST` | 400 | Malformed request body or missing required fields |
| `INVALID_URL` | 400 | URL is invalid or malformed |
| `INVALID_METHOD` | 400 | Unsupported or invalid HTTP method |
| `TIMEOUT` | 502 | Request exceeded timeout limit |
| `CONNECTION_FAILED` | 502 | Could not establish connection to target |
| `DNS_ERROR` | 502 | DNS resolution failed |
| `SSL_ERROR` | 502 | TLS/SSL handshake failed |
| `SCRIPT_ERROR` | 400 | JavaScript pre/post script syntax or runtime error |
| `RUN_NOT_FOUND` | 404 | Run ID does not exist in database |
| `INTERNAL_ERROR` | 500 | Unexpected engine error |

---

## Appendix

### Run Status Values

| Status | Description |
|--------|-------------|
| `pending` | Run created, waiting to start |
| `running` | Test is currently executing |
| `completed` | Test finished successfully |
| `stopped` | Test was stopped by user |
| `failed` | Test failed due to error |

### Run Type Values

| Type | Description |
|------|-------------|
| `design` | Single request execution (from `/request`) |
| `load` | Load test execution (from `/run`) |

### HTTP Methods Supported

GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS

---

## Version History

**v0.1.0** (Current)
- Initial API implementation
- Health and configuration endpoints
- Project management (collections, requests, environments)
- Single request execution (Design Mode)
- Load testing with multiple strategies
- Real-time metrics streaming (SSE)
- Detailed performance reporting
- Graceful run termination

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
