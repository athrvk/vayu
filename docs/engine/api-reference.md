# Vayu Engine API Reference

**Base URL:** `http://127.0.0.1:9876` (default, configurable via `--port`)

All endpoints return JSON. Most error responses follow this format:

```json
{
  "error": "Error message"
}
```

The OAuth 2.0 endpoints (`/oauth2/*`) use a **nested** error shape that also
carries a machine-readable code (and any provider detail):

```json
{
  "error": {
    "code": "oauth2_provider_error",
    "message": "Token endpoint rejected the request: invalid_client",
    "providerStatus": 401,
    "providerError": "invalid_client"
  }
}
```

## Health & Configuration

### GET /health

Check engine status and version.

**Response:**
```json
{
  "status": "ok",
  "version": "0.3.0",
  "workers": 8
}
```

### GET /config

Get global configuration settings. Backed by the `config_entries` table; each entry carries UI
metadata (label, description, category, default, min/max). Keys include:

```json
{
  "workers": 8,
  "maxConnections": 10000,
  "defaultTimeout": 30000,
  "statsInterval": 100,
  "contextPoolSize": 64,
  "liveTickIntervalMs": 100,
  "liveRetentionMs": 60000
}
```

`POST /config` validates each key against its registered type and min/max range.

## Collections

Collections are folders that organize requests in a hierarchy.

### GET /collections

List all collections.

**Response:**
```json
[
  {
    "id": "col_1234567890",
    "name": "My API",
    "parentId": null,
    "variables": {},
    "order": 0,
    "createdAt": 1234567890
  }
]
```

### POST /collections

Create or update a collection. If `id` is provided and exists, performs an update.

**Request:**
```json
{
  "id": "col_1234567890",  // Optional, auto-generated if omitted
  "name": "My API",
  "parentId": null,         // Optional, null for root
  "order": 0,               // Optional
  "variables": {}           // Optional, collection-scoped variables
}
```

**Response:** The saved collection object.

### DELETE /collections/:id

Delete a collection and all its requests (cascading delete).

**Response:**
```json
{
  "message": "Collection deleted successfully",
  "id": "col_1234567890"
}
```

## Requests

### GET /requests

List requests in a collection.

**Query Parameters:**
- `collectionId` (required): Collection ID to fetch requests from

**Response:**
```json
[
  {
    "id": "req_1234567890",
    "collectionId": "col_1234567890",
    "name": "Get Users",
    "method": "GET",
    "url": "{{baseUrl}}/users",
    "params": {},
    "headers": {},
    "body": "",
    "bodyType": "none",
    "auth": {},
    "preRequestScript": "",
    "postRequestScript": "",
    "followRedirects": true,
    "maxRedirects": 10,
    "updatedAt": 1234567890
  }
]
```

`followRedirects` / `maxRedirects` are the request's stored redirect policy.
They are always present in the response: a request saved before these columns
existed reads back as the engine defaults (`true` / `10`), which is the
behaviour it already had.

### POST /requests

Create or update a request. If `id` is provided and exists, performs an update.

**Request:**
```json
{
  "id": "req_1234567890",           // Optional, auto-generated if omitted
  "collectionId": "col_1234567890", // Required for new requests
  "name": "Get Users",               // Required for new requests
  "method": "GET",                   // Required for new requests: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
  "url": "{{baseUrl}}/users",        // Required for new requests
  "params": {},                      // Optional, query parameters
  "headers": {},                     // Optional, request headers
  "body": "",                        // Optional, request body
  "bodyType": "none",                // Optional: "none", "json", "text", "form-data", "x-www-form-urlencoded"
  "auth": {},                        // Optional, authentication config
  "preRequestScript": "",            // Optional, JavaScript pre-request script
  "postRequestScript": "",           // Optional, JavaScript test script
  "followRedirects": true,           // Optional, follow 3xx responses. Default true
  "maxRedirects": 10                 // Optional, hops while following, clamped to 0..100. Default 10
}
```

Omitting `followRedirects` / `maxRedirects` on an **update** leaves the stored
values untouched; on a **create** they fall back to the column defaults
(`true` / `10`). A non-boolean `followRedirects` or a non-integer
`maxRedirects` is ignored rather than rejected.

**Response:** The saved request object.

### DELETE /requests/:id

Delete a request.

**Response:**
```json
{
  "message": "Request deleted successfully",
  "id": "req_1234567890"
}
```

## Environments

### GET /environments

List all environments.

**Response:**
```json
[
  {
    "id": "env_1234567890",
    "name": "Production",
    "variables": {
      "baseUrl": {
        "value": "https://api.example.com",
        "enabled": true,
        "secret": false
      }
    },
    "updatedAt": 1234567890
  }
]
```

### POST /environments

Create or update an environment.

**Request:**
```json
{
  "id": "env_1234567890",  // Optional, auto-generated if omitted
  "name": "Production",    // Required for new environments
  "variables": {            // Optional
    "baseUrl": {
      "value": "https://api.example.com",
      "enabled": true,
      "secret": false
    }
  }
}
```

**Response:** The saved environment object.

### DELETE /environments/:id

Delete an environment.

**Response:**
```json
{
  "message": "Environment deleted successfully",
  "id": "env_1234567890"
}
```

## Global Variables

### GET /globals

Get global variables (singleton).

**Response:**
```json
{
  "id": "globals",
  "variables": {
    "apiKey": {
      "value": "xxx",
      "enabled": true,
      "secret": false
    }
  },
  "updatedAt": 1234567890
}
```

### POST /globals

Set global variables.

**Request:**
```json
{
  "variables": {
    "apiKey": {
      "value": "xxx",
      "enabled": true,
      "secret": false
    }
  }
}
```

**Response:** The saved globals object.

## Authentication

The engine **resolves auth server-side**. Every request's `auth` object (on
`POST /request` and `POST /run`) is applied to the outgoing request before it
hits the wire:

| `auth.mode` | Effect |
|-------------|--------|
| `none` / `inherit` | No-op (`inherit` is resolved app-side before it reaches the engine) |
| `bearer` | `Authorization: Bearer <token>` |
| `basic` | `Authorization: Basic <base64(user:pass)>` |
| `apikey` | Header `key: value`, or `?key=value` when `in: "query"` |
| `oauth2` | Acquires/caches a token (below) and injects it per `tokenPlacement` |

A user-supplied `Authorization` header always wins over `bearer`/`basic`/`oauth2`.
Header names are matched case-insensitively.

### OAuth 2.0 token cache

Tokens are acquired once and cached (SQLite `oauth_tokens`, keyed by a
deterministic `cacheKey` = `accessTokenUrl \x1f clientId \x1f credentialsId \x1f
username-if-password-grant`). Expiry uses a 45s skew; a missing `expires_in`
means non-expiring. There is **no mid-run refresh** - a token is fetched at run
start and reused for the whole run.

#### POST /oauth2/token

Acquire (or return a cached) token for an `OAuth2Config`. Supports the
`client_credentials`, `password`, and `authorization_code` grants; the
`authorization_code` grant requires an `interactive` code exchange (see below).

**Request:**
```json
{
  "config": { "grantType": "client_credentials", "accessTokenUrl": "https://idp/token",
              "clientId": "...", "clientSecret": "...", "scope": "openid" },
  "force": false,
  "interactive": { "code": "...", "codeVerifier": "...", "redirectUri": "..." }
}
```

`force: true` bypasses the cache (refreshes via the refresh token when present,
else re-acquires). `interactive` is only used for the `authorization_code` grant.

**Response (`200`):**
```json
{
  "cacheKey": "https://idp/token...",
  "accessToken": "ya29...",
  "tokenType": "Bearer",
  "scope": "openid",
  "expiresIn": 3600,
  "createdAt": 1234567890000,
  "expiresAt": 1234567893600,
  "hasRefreshToken": true
}
```

`expiresAt` is `null` for a non-expiring token; `scope` is omitted when empty.
Errors use the nested shape: `400` invalid config, `401` provider rejected the
request, `409` interactive authorization required, `502` network error.

#### GET /oauth2/token?key=&lt;cacheKey&gt;

Inspect the cached token for a key (used by the UI status row). Always `200`.

```json
{ "found": true, "expired": false, "token": { "...": "serialized token" } }
```

Returns `{ "found": false }` when no token is cached.

#### DELETE /oauth2/token?key=&lt;cacheKey&gt;

Clear a cached token. `200 { "deleted": true }` (`false` if nothing was cached).

### Interactive Authorization Code flow

For the `authorization_code` grant the engine owns PKCE (S256), the `state`
value, and the code exchange; the app only opens the browser. In **loopback**
mode the engine binds an ephemeral `127.0.0.1` listener; in **embedded** mode
(providers that reject loopback redirects) the app captures the redirect URL and
hands it back.

| Method / Path | Purpose |
|---------------|---------|
| `POST /oauth2/authorize/start` | `{config, mode?}` → `{attemptId, authorizeUrl, redirectUri}` |
| `GET /oauth2/authorize/:attemptId` | Poll status → `{state: "pending"\|"completed"\|"failed"\|"not_found", error?, cacheKey?}` |
| `POST /oauth2/authorize/complete` | `{attemptId, callbackUrl}` → status (embedded mode) |
| `DELETE /oauth2/authorize/:attemptId` | Cancel → `{cancelled: true}` |

Attempts time out after 5 minutes; on success the token is written to the cache
and `cacheKey` is returned.

## Execution

### POST /request

Execute a single HTTP request (Design Mode). Returns immediate response with test results.

The request's `auth` (see [Authentication](#authentication)) is resolved before
the pre-request script runs, so `pm.request` reflects the real outgoing headers.
If a non-interactive OAuth 2.0 token cannot be obtained, the engine still returns
`200` but the body carries `statusCode: 0`, an `errorCode` of `AUTH_REQUIRED`
(interactive sign-in needed) or `AUTH_FAILED`, and an `authErrorCode` hint.

**Request:**
```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "type": "json",
    "content": "{\"name\":\"John\"}"
  },
  "requestId": "req_1234567890",      // Optional, links to saved request
  "environmentId": "env_1234567890",  // Optional, uses environment variables
  "preRequestScript": "",              // Optional
  "postRequestScript": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));",
  "followRedirects": true,             // Optional, default true
  "maxRedirects": 10,                  // Optional, default 10
  "verifySSL": true                    // Optional, default true
}
```

**Redirect policy.** `followRedirects` defaults to **true**, so omitting it
follows every 3xx and only the final response is returned - send
`followRedirects: false` to see the 3xx status and its `Location` header. Both
clients send these explicitly for exactly that reason (see
[api-integration](../app/api-integration.md)). `POST /run` accepts the same
three fields with the same defaults, so a load test can be run under the policy
the request was configured with.

**Response:**
```json
{
  "runId": "run_1234567890",
  "statusCode": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json"
  },
  "body": "{\"id\":1,\"name\":\"John\"}",
  "bodySize": 20,
  "timing": {
    "totalMs": 245.5,
    "wireMs": 245.1,
    "queueWaitMs": 0.4,
    "dnsMs": 5.2,
    "connectMs": 12.3,
    "tlsMs": 45.1,
    "firstByteMs": 180.2,
    "downloadMs": 2.7
  },
  "testResults": [
    {
      "name": "Status is 200",
      "passed": true
    }
  ],
  "consoleLogs": []
}
```

### POST /run

Start a load test run (Vayu Mode).

**Request:**
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {},
  "body": {
    "type": "none",
    "content": ""
  },
  "mode": "constant_rps",    // "constant_rps", "constant_concurrency", "ramp_up", or "iterations"
  "concurrency": 100,        // Target in-flight requests (constant_concurrency / ramp_up target / iterations)
  "startConcurrency": 1,     // Ramp start concurrency (ramp_up mode)
  "duration": "60s",         // Duration (constant_rps / constant_concurrency / ramp_up)
  "rampUpDuration": "10s",   // Ramp-up time (ramp_up mode)
  "iterations": 0,           // Number of iterations (iterations mode)
  "targetRps": 1000,         // Target requests per second (constant_rps mode)
  "maxInFlight": 10000,      // Optional; see "maxInFlight" note below - constant_rps only
  "requestId": "req_1234567890",      // Optional, links to saved request
  "environmentId": "env_1234567890",  // Optional
  "tests": "",               // Optional, deferred validation script
  "followRedirects": true,   // Optional, default true - see POST /request
  "maxRedirects": 10         // Optional, default 10
}
```

**Response:**
```json
{
  "runId": "run_1234567890",
  "status": "running"
}
```

**Auth pre-flight.** When `auth.mode` is `oauth2`, the run route resolves the
token **before** creating the run and warms the cache for the workers. An
unauthorizable config is rejected up front with `409` (interactive sign-in
required) or `400`, using the nested `/oauth2` error shape, so a bad token never
surfaces as a silently-failed run.

**Concurrency model.** `constant_concurrency`, `ramp_up`, and `iterations` are
**closed-loop**: the engine holds in-flight requests at a target (`concurrency`,
or the ramp curve from `startConcurrency` to `concurrency`) - when a request
completes, another is issued. Throughput is a *result* (`concurrency ÷ latency`),
not an input. `constant_rps` is **open-loop**: it dispatches at `targetRps`
regardless of how fast responses return.

**`maxInFlight`.** A hard cap on concurrent in-flight requests. It applies
**only to `constant_rps`** (the open-loop rate mode), where it bounds how many
requests may be outstanding before the engine drops or queues new ones; default
≈ `max(targetRps × 10, 1000)`. For the closed-loop modes the `concurrency`
target *is* the in-flight bound, so `maxInFlight` is ignored there.

## Metrics & Statistics

### GET /stats/:runId

> **Prefer `GET /metrics/live/:runId`** (below) for live dashboards - it replays a retained
> in-memory tick topic with no attach race. `/stats/:runId` is the legacy DB-polling path; it
> remains useful for **historical** retrieval via `?format=json&limit=&offset=` (paginated
> time-series read), which the app uses to hydrate the history view.
>
> The `?format=json` per-tick rows carry the **windowed** latency percentiles
> (`latency_p50_ms` / `latency_p95_ms` / `latency_p99_ms`, snake_case) alongside
> rps/throughput/concurrency/status codes, so the history view can rebuild the
> percentiles-over-time chart, the response-time-vs-concurrency scatter, and the
> capacity-breakpoint / saturation stats from stored data.

Stream real-time metrics for a load test using Server-Sent Events (SSE).

**Response:** SSE stream with events:

```
event: stats
data: {"timestamp":1234567890,"totalRequests":1500,"totalErrors":5,"totalSuccess":1495,"errorRate":0.33,"avgLatencyMs":45.2,"currentRps":150.5,"activeConnections":100,"elapsedSeconds":10.5}

event: complete
data: {"totalRequests":6000,"totalErrors":30,"totalSuccess":5970,"errorRate":0.5,"avgLatencyMs":42.1,"finalRps":100.0,"duration":60.0}
```

**Metrics included:**
- `totalRequests`: Total requests completed
- `totalErrors`: Total errors encountered
- `totalSuccess`: Total successful requests
- `errorRate`: Error rate as percentage
- `avgLatencyMs`: Average latency in milliseconds
- `currentRps`: Current requests per second
- `activeConnections`: Active concurrent connections
- `elapsedSeconds`: Elapsed time since test start

### GET /metrics/live/:runId

Stream live metrics for a run via Server-Sent Events, replayed from a retained
in-memory tick topic. The engine produces one wire-ready `metrics` tick per
`liveTickIntervalMs` (default 100ms) into a per-run buffer; this endpoint
replays that buffer **from offset 0** and then tails new ticks until the run
finishes, ending with a `complete` event. Because the topic is retained for
`liveRetentionMs` (default 60000ms) after completion, a client that connects
late - even after a sub-second run has already finished - still receives the
full series. There is no attach race.

**Events:**
```
event: metrics
id: 0
data: {"runId":"...","timestamp":1234567890,"elapsedSeconds":10.5,
       "totalRequests":1500,"totalSuccess":1495,"totalErrors":5,"errorRate":0.33,
       "currentRps":150.5,"sendRate":150.0,"throughput":149.5,
       "activeConnections":100,"backpressure":0,"droppedRequests":0,
       "avgLatencyMs":45.2,"avgQueueWaitMs":0.4,
       "latencyP50Ms":38.5,"latencyP95Ms":95.1,"latencyP99Ms":156.7,
       "bytesSent":48000,"bytesReceived":1920000,
       "requestsSent":1500,"requestsExpected":0,
       "status2xx":1495,"status3xx":0,"status4xx":3,"status5xx":2,
       "statusCodes":{"200":1495,"404":3,"500":2}}

event: complete
data: {"event":"complete","runId":"run_1234567890"}
```

**Field reference** (all keys emitted by `MetricsCollector::get_current_stats()`):

| Field | Meaning |
|-------|---------|
| `totalRequests` / `totalSuccess` / `totalErrors` | Completed counts |
| `errorRate` | Error percentage |
| `currentRps` | Instantaneous RPS (delta over the tick window) |
| `sendRate` | Rate requests are dispatched (open model) |
| `throughput` | Rate responses are received |
| `activeConnections` | Current in-flight requests |
| `backpressure` | Queue depth (`requestsSent − totalRequests`) |
| `droppedRequests` | Requests discarded at the `maxInFlight` cap (never sent) |
| `avgLatencyMs` | Mean **perceived** latency |
| `avgQueueWaitMs` | Mean time queued inside the generator before the wire |
| `latencyP50Ms` / `latencyP95Ms` / `latencyP99Ms` | Live **windowed** percentiles - a rolling per-tick window sampled from a phaser-based `hdr_interval_recorder`, so the chart tracks recent load instead of flattening toward the all-time distribution (the final report still uses the cumulative histogram) |
| `bytesSent` / `bytesReceived` | Cumulative wire bytes |
| `requestsSent` / `requestsExpected` | Progress for bounded modes (drives ETA) |
| `status2xx`–`status5xx` | Per-class counts |
| `statusCodes` | Full per-code distribution map |

Each `metrics` event carries an `id:` equal to its zero-based offset. The
browser's built-in `EventSource` retry automatically replays this id as
`Last-Event-ID` on its **own** intra-connection retries (no application code
needed), and the stream resumes from `Last-Event-ID + 1`.

**Application-level reconnect**: clients that close the EventSource themselves
(e.g. after observing `readyState === CLOSED`) should NOT open a new connection
and rely on `Last-Event-ID` - `EventSource` does not expose a header-setting
API, so a fresh connect would request `from=0` and replay the entire retained
topic, duplicating ticks already shown. The canonical recovery is to converge
on the stored report via `GET /run/:runId/report` (the same path used at normal
run end). This is the pattern the bundled app uses.

**Responses:**
- `200` - SSE stream (active run, or finished run still within the retention window).
- `404` - run not found or evicted past `liveRetentionMs`; the body hints
  `Use /run/:runId/report for the stored report`. Clients should fall back to
  the stored report in this case.

Tuning: `liveTickIntervalMs` (live tick cadence, 10–1000ms) and
`liveRetentionMs` (post-completion retention, 0–600000ms; 0 disables retention)
are configurable via `POST /config`.

## Runs

### GET /runs

List all test runs (both design mode and load tests).

**Response:**
```json
[
  {
    "id": "run_1234567890",
    "requestId": "req_1234567890",
    "environmentId": "env_1234567890",
    "type": "design",
    "status": "completed",
    "configSnapshot": "{}",
    "startTime": 1234567890,
    "endTime": 1234567891
  }
]
```

### GET /run/:runId

Get details for a specific run.

**Response:** The run object shown in `GET /runs` (`id`, `requestId`,
`environmentId`, `type`, `status`, `configSnapshot`, `startTime`, `endTime`).

For a `design` run that has at least one stored result, the response also
carries a `result` object with that run's single exchange - the only other
place it appears is `GET /run/:runId/report`, whose `results` array and
`metadata.configuration` are load-test concepts and are absent for a design
run.

```json
{
  "id": "run_1234567890",
  "requestId": "req_1234567890",
  "environmentId": null,
  "type": "design",
  "status": "completed",
  "configSnapshot": { "...": "the raw run payload" },
  "startTime": 1234567890,
  "endTime": 1234567891,
  "result": {
    "timestamp": 1234567891,
    "statusCode": 200,
    "statusText": "OK",
    "latencyMs": 42.1,
    "error": "optional, only when the request failed",
    "trace": { "request": { "...": "..." }, "response": { "...": "..." } }
  }
}
```

### POST /run/:runId/stop

Stop a running load test.

**Response:**
```json
{
  "message": "Run stopped",
  "runId": "run_1234567890"
}
```

### GET /run/:runId/report

Get the final report for a completed run. Reconstructed from the `runs`, `metrics`, and `results`
tables (there is no stored `summary` blob). The response is a **nested** object; conditional
sections appear only when relevant (e.g. `rateControl` only for `constant_rps`, `testValidation`
only when a test script ran).

**Response:**
```json
{
  "metadata": {
    "runId": "run_1234567890",
    "runType": "load",
    "status": "completed",
    "startTime": 1234567890,
    "endTime": 1234567950,
    "requestUrl": "https://api.example.com/users",
    "requestMethod": "GET",
    "configuration": { "...": "config snapshot" }
  },
  "summary": {
    "totalRequests": 6000,
    "successfulRequests": 5970,
    "failedRequests": 30,
    "errorRate": 0.5,
    "totalDurationSeconds": 60.0,
    "avgRps": 100.0,
    "testDuration": 60.0,
    "sendRate": 100.0,
    "throughput": 99.5,
    "setupOverhead": 0.12,
    "peakConcurrency": 100,
    "droppedRequests": 0,
    "avgQueueWaitMs": 0.4,
    "bytesSent": 192000,
    "bytesReceived": 7680000,
    "throughputBytesPerSec": 128000
  },
  "latency": {
    "min": 12.3, "max": 1250.5, "avg": 42.1, "median": 38.5,
    "p50": 38.5, "p75": 45.2, "p90": 78.3, "p95": 95.1, "p99": 156.7, "p999": 450.2
  },
  "statusCodes": { "200": 5970, "500": 30 },
  "rateControl": { "targetRps": 100, "actualRps": 99.5, "achievement": 99.5 },
  "errors": {
    "total": 30,
    "withDetails": 30,
    "types": { "timeout": 20, "connection_failed": 10 },
    "byStatusCode": { "500": 30 }
  },
  "timingBreakdown": {
    "avgDnsMs": 5.2, "avgConnectMs": 12.3, "avgTlsMs": 45.1,
    "avgFirstByteMs": 180.2, "avgDownloadMs": 2.7
  },
  "slowRequests": { "count": 12, "thresholdMs": 1000, "percentage": 0.2 },
  "testValidation": { "samplesTested": 500, "testsPassed": 498, "testsFailed": 2, "successRate": 99.6 },
  "results": [ { "...": "sampled request/response outcomes" } ]
}
```

`latency.*` and the enriched `summary` fields (`peakConcurrency`, `droppedRequests`,
`avgQueueWaitMs`, `bytesSent/Received`, `throughputBytesPerSec`) come from the persisted
per-tick `metrics` rows. `latency_ms` in `results` (and therefore these percentiles) is
**perceived** latency.

### DELETE /run/:runId

Delete a run and all associated metrics/results.

**Response:**
```json
{
  "message": "Run deleted successfully",
  "runId": "run_1234567890"
}
```

## Scripting

### GET /scripting/completions

Get script engine API completions for UI autocomplete.

**Response:**
```json
{
  "version": "1.0.0",
  "engine": "quickjs",
  "completions": [
    {
      "label": "pm.test",
      "kind": 1,
      "insertText": "pm.test(\"${1:test name}\", function() {\n\t${2:// assertions}\n});",
      "detail": "pm.test(name: string, fn: () => void)",
      "documentation": "Define a test with assertions..."
    }
  ]
}
```

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (invalid JSON, missing required fields, invalid OAuth 2.0 config) |
| 401 | OAuth 2.0 provider rejected the token request |
| 404 | Resource not found |
| 409 | OAuth 2.0 interactive authorization required (`/run` pre-flight, `/oauth2/token`) |
| 500 | Internal server error |
| 502 | OAuth 2.0 token-endpoint network error |

## Notes

- All timestamps are Unix milliseconds (since epoch)
- Variable substitution uses `{{variableName}}` syntax
- Environment variables are resolved in order: environment → collection → global
- Load test metrics are collected every 100ms
- SSE connections timeout after 30 seconds of inactivity
