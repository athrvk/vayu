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

## Deprecated aliases

The execution and run/metrics routes were consolidated behind a `/runs` family,
`/execute`, and `/runs/:id/metrics`. The old paths still work - each is
registered as a deprecated alias of its canonical route (same handler, same
behavior) and logs a `(deprecated alias)` marker per request. **These aliases
will be removed in a future minor release**; new clients should use the
canonical paths.

| Deprecated alias | Canonical route |
|------------------|-----------------|
| `POST /request` | `POST /execute` |
| `POST /run` | `POST /runs` |
| `GET /run/:id` | `GET /runs/:id` |
| `DELETE /run/:id` | `DELETE /runs/:id` |
| `POST /run/:id/stop` | `POST /runs/:id/stop` |
| `GET /run/:id/report` | `GET /runs/:id/report` |
| `GET /metrics/live/:id` | `GET /runs/:id/live` |
| `GET /stats/:id?format=json` | `GET /runs/:id/metrics` |

`GET /stats/:id` in its **SSE** mode is legacy DB-polling and is retained
wholesale (no canonical rename); prefer `GET /runs/:id/live` for live metrics.

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

### POST /shutdown

Gracefully shut down the engine. This is the shutdown path the Electron app uses
on quit (it is more reliable than a signal on Windows, where `SIGTERM` does not
behave as expected).

The response is sent **before** shutdown begins, so the client always receives
the `200`. About 100ms later, on a detached thread, the engine invokes its
shutdown callback: the daemon's main loop exits, active runs are stopped, the
lock file is released, logs are flushed, and the process exits.

**Response:** `200`
```json
{
  "status": "ok",
  "message": "Shutdown initiated"
}
```

### GET /config

Get global configuration settings. Backed by the `config_entries` table. The
response is an `entries` array; each entry carries its value plus the UI metadata
the Settings panel renders (label, description, category, default, and optional
min/max):

```json
{
  "entries": [
    {
      "key": "workers",
      "value": "8",
      "type": "integer",
      "label": "Worker Threads",
      "description": "Number of worker threads for load generation.",
      "category": "performance",
      "default": "8",
      "min": "1",
      "max": "256",
      "updatedAt": 1234567890
    }
  ]
}
```

`min` and `max` are present only for entries that declare them. `value` and
`default` are always strings; `type` is one of `integer`, `number`, `boolean`,
or `string`.

### POST /config

Update one or more configuration entries. Two body shapes are accepted:

**Batch** - update several keys at once:
```json
{ "entries": { "workers": "16", "defaultTimeout": "30000" } }
```

**Single** - update one key:
```json
{ "key": "workers", "value": "16" }
```

In both shapes, non-string values (numbers, booleans) are coerced to strings.
Each key is validated against its registered `type` and, for `integer` / `number`
entries, its `min`/`max` range; `boolean` entries must be `"true"` or `"false"`.
Validation is all-or-nothing: if any key is unknown or out of range, nothing is
applied and the response is `400` with the specific reason(s):

```json
{ "error": { "code": "invalid_config", "message": "'workers' must be at most 256 (got 9999)" } }
```

**Success response:** `200` - the full updated entries array (same shape as
`GET /config`) plus `"success": true`.

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

**Errors:** `parentId` is validated to keep the collection tree acyclic, since a
cycle would make the cascade delete below loop forever. Both cases return `400`
with the flat `{"error": message}` shape:

- `parentId` equal to the collection's own `id` - `{"error": "A collection cannot be its own parent"}`.
- `parentId` pointing at one of the collection's own descendants (a reparent that
  would form a cycle) - `{"error": "Cannot move a collection into its own descendant"}`.

Parent *existence* is intentionally not checked: the import orchestrator creates
collections in bulk, so requiring the parent to exist first would couple to
import ordering. Only self-parent and descendant cycles are rejected.

### DELETE /collections/:id

Delete a collection and all its requests (cascading delete). The cascade removes
every descendant collection and its requests in a single transaction, and
terminates even if the stored `parent_id` tree contains a cycle (see
[db-schema.md](db-schema.md) - collections).

**Response:**
```json
{
  "message": "Collection deleted successfully",
  "id": "col_1234567890"
}
```

## Requests

### GET /requests

List requests in a collection. Results are ordered by the requests' `order`
field (ascending), the same contract `GET /collections` has for collections.

**Query Parameters:**
- `collectionId` (required): Collection ID to fetch requests from

**Response:** An array of request objects, each in the same shape as a
`GET /requests/:id` response: `params`/`headers` are arrays of
`{key, value, enabled}` entries and `body` is a JSON discriminated union
(see the `requests` table in [db-schema.md](db-schema.md)).
```json
[
  {
    "id": "req_1234567890",
    "collectionId": "col_1234567890",
    "name": "Get Users",
    "description": "",
    "method": "GET",
    "url": "{{baseUrl}}/users",
    "order": 0,
    "params": [{ "key": "page", "value": "1", "enabled": true }],
    "headers": [{ "key": "Accept", "value": "application/json", "enabled": true }],
    "body": { "mode": "none" },
    "bodyType": "none",
    "auth": { "mode": "inherit" },
    "preRequestScript": "",
    "postRequestScript": "",
    "followRedirects": true,
    "maxRedirects": 10,
    "updatedAt": 1234567890,
    "createdAt": 1234567890
  }
]
```

`followRedirects` / `maxRedirects` are the request's stored redirect policy.
They are always present in the response: a request saved before these columns
existed reads back as the engine defaults (`true` / `10`), which is the
behaviour it already had.

### GET /requests/:id

Fetch a single request by id, in one lookup. The app uses this to load a
restored request tab or a design-run copy on cold start, instead of fetching
every collection's request list and scanning them for the id.

**Path Parameters:**
- `id` (required): The request ID to fetch

**Response:** The request object, in the same shape as a `GET /requests` list
entry.
```json
{
  "id": "req_1234567890",
  "collectionId": "col_1234567890",
  "name": "Get Users",
  "description": "",
  "method": "GET",
  "url": "{{baseUrl}}/users",
  "order": 0,
  "params": [],
  "headers": [],
  "body": { "mode": "none" },
  "bodyType": "none",
  "auth": { "mode": "inherit" },
  "preRequestScript": "",
  "postRequestScript": "",
  "followRedirects": true,
  "maxRedirects": 10,
  "createdAt": 1234567890,
  "updatedAt": 1234567890
}
```

**404** when the request genuinely does not exist. This is distinct from a
`5xx`: the caller relies on that difference to tell a real deletion from an
unreachable engine, and must not treat a transport failure as "deleted".

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

## Import

### POST /import/fetch

Fetch a remote collection or spec by URL, server-side, so the app can import a
resource that browser CORS would otherwise block. The engine proxies the `GET`
via libcurl and returns the raw body and content type.

**Request:**
```json
{ "url": "https://example.com/collection.json" }
```

The `url` must be a string starting with `http://` or `https://`.

**Response:** `200`
```json
{
  "content": "...raw response body...",
  "contentType": "application/json"
}
```

`contentType` echoes the fetched response's `Content-Type` header, defaulting to
`application/octet-stream` when absent. The response JSON is serialized with
invalid UTF-8 replaced rather than throwing, so binary or malformed content can
never turn into a `500`.

**Errors:**
- `400` `{ "error": "Invalid JSON body" }` - the request body did not parse.
- `400` `{ "error": "Invalid URL" }` - `url` is missing, not a string, or does
  not start with `http://` / `https://`.
- `502` `{ "error": "Failed to fetch: <detail>" }` - the upstream request failed
  (connection error, transport failure).

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
`POST /execute` and `POST /runs`) is applied to the outgoing request before it
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

### POST /execute

Execute a single HTTP request (Design Mode). Returns immediate response with test results.

> Alias: `POST /request` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

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

**Script parts.** `preRequestScript` / `postRequestScript` above are the legacy
single-string form and still work. The engine also accepts `preRequestScripts`
/ `postRequestScripts`: a list of parts, each recording where it came from, so
a stored run can say which part is the collection's and which is the
request's:

```json
{
  "preRequestScripts": [
    { "origin": "collection", "id": "c1", "name": "API", "script": "const base = pm.environment.get('baseUrl');" },
    { "origin": "request", "id": "r1", "script": "pm.environment.set('traceId', base);" }
  ]
}
```

When both forms are sent, the list wins - they are never merged. Parts are
joined with a blank line and run as a single script in one shared scope (see
[scripting.md](scripting.md#script-parts)), so a variable declared in an
earlier part is visible to a later one; parts that are empty or only
whitespace are dropped.

**Redirect policy.** `followRedirects` defaults to **true**, so omitting it
follows every 3xx and only the final response is returned - send
`followRedirects: false` to see the 3xx status and its `Location` header. Both
clients send these explicitly for exactly that reason (see
[api-integration](../app/api-integration.md)). `POST /runs` accepts the same
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
    "total": 245.5,
    "wire": 245.1,
    "queueWait": 0.4,
    "dns": 5.2,
    "connect": 12.3,
    "tls": 45.1,
    "firstByte": 180.2,
    "download": 2.7
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

**Two timing dialects, on purpose.** The synchronous `/execute` response above
names the phases **without** the `Ms` suffix (`firstByte`, `dns`, `download`,
…; `serialize(Response)` in `engine/src/utils/json.cpp`). The **stored** trace
for the same exchange - written to the run's `results` row by `store_result`
(design mode) and `load_strategy` (load mode), and returned inside
`GET /runs/:runId/report` `results[].trace` - names them **with** the suffix
(`firstByteMs`, `dnsMs`, `downloadMs`, …). The renderer consumes the first
directly (`ResponseTiming`) and adapts the second at one boundary when it
restores a design run (`restore-response.ts`). The two dialects are the wire
contract; do not "fix" one to match the other without updating that adapter.

### POST /runs

Start a load test run (Vayu Mode).

> Alias: `POST /run` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

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
  "followRedirects": true,   // Optional, default true - see POST /execute
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

**`tests` accepts both forms**, like `preRequestScripts` / `postRequestScripts`
on `POST /execute` above: the legacy single string, or a list of parts
(`[{ "origin": "collection" | "request", "id", "name", "script" }]`) that the
engine joins itself (see [scripting.md](scripting.md#script-parts)). The list
wins when both are sent. Sending the collection chain's parts means its
assertions are now actually checked under load - previously only the
request's own `tests` string was ever sent, so a collection-level assertion
passed in design mode and was silently never validated by a load run.

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

### GET /runs/:runId/metrics

Paginated **historical time-series** (JSON) for a run's charts. This is the
canonical replacement for the legacy `GET /stats/:runId?format=json`; both call
the same `run_time_series_response` core so they cannot drift. The response is
**always JSON** - any `format` query param is ignored.

**Query parameters:**
- `limit` - max records per page (default 5000, invalid/&le;0 falls back to 5000, capped at 50000).
- `offset` - skip N records (default 0, negative floored to 0).

Per-tick rows carry the **windowed** latency percentiles (`latency_p50_ms` /
`latency_p95_ms` / `latency_p99_ms`, snake_case) alongside
rps/throughput/concurrency/status codes, so the history view can rebuild the
percentiles-over-time chart, the response-time-vs-concurrency scatter, and the
capacity-breakpoint / saturation stats from stored data.

**Response:**
```json
{
  "data": [
    {
      "timestamp": 1234567890,
      "elapsed_seconds": 10.5,
      "requests_completed": 1500,
      "requests_failed": 5,
      "current_rps": 150.5,
      "current_concurrency": 100,
      "send_rate": 150.0,
      "throughput": 149.5,
      "backpressure": 0,
      "error_rate": 0.33,
      "dropped_requests": 0,
      "bytes_sent": 48000,
      "bytes_received": 1920000,
      "status_codes": { "200": 1495, "404": 3, "500": 2 },
      "latency_p50_ms": 38.5,
      "latency_p95_ms": 95.1,
      "latency_p99_ms": 12.0
    }
  ],
  "pagination": { "total": 1, "limit": 5000, "offset": 0, "hasMore": false, "returned": 1 }
}
```

A missing run returns `404` with `{"error":"Run not found"}`.

### GET /stats/:runId (deprecated)

> **Prefer `GET /runs/:runId/live`** (above) for live dashboards - it replays a retained
> in-memory tick topic with no attach race. `/stats/:runId` is the legacy DB-polling path
> and is retained wholesale (its SSE mode gets no canonical rename). Its historical
> `?format=json&limit=&offset=` retrieval is a deprecated alias of `GET /runs/:runId/metrics`
> (same core); new callers should use that path.

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

### GET /runs/:runId/live

> Alias: `GET /metrics/live/:runId` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

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
on the stored report via `GET /runs/:runId/report` (the same path used at normal
run end). This is the pattern the bundled app uses.

**Responses:**
- `200` - SSE stream (active run, or finished run still within the retention window).
- `404` - run not found or evicted past `liveRetentionMs`; the body hints
  `Use /runs/:runId/report for the stored report`. Clients should fall back to
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

### GET /runs/:runId

> Alias: `GET /run/:runId` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Get details for a specific run.

**Response:** The run object shown in `GET /runs` (`id`, `requestId`,
`environmentId`, `type`, `status`, `configSnapshot`, `startTime`, `endTime`).

For a `design` run that has at least one stored result, the response also
carries a `result` object with that run's single exchange - the only other
place it appears is `GET /runs/:runId/report`, whose `results` array and
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

### POST /runs/:runId/stop

> Alias: `POST /run/:runId/stop` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Stop a running load test.

**Response:**
```json
{
  "message": "Run stopped",
  "runId": "run_1234567890"
}
```

### GET /runs/:runId/report

> Alias: `GET /run/:runId/report` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

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

### DELETE /runs/:runId

> Alias: `DELETE /run/:runId` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

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
| 502 | Upstream network error (OAuth 2.0 token endpoint, `/import/fetch` proxy) |

## Notes

- All timestamps are Unix milliseconds (since epoch)
- Variable substitution uses `{{variableName}}` syntax
- Environment variables are resolved in order: environment → collection → global
- Load test metrics are collected every 100ms
- SSE connections timeout after 30 seconds of inactivity
