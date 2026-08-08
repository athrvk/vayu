# API Integration

This document describes how the Vayu Manager communicates with the Vayu Engine (C++ daemon) via HTTP.

## Overview

The app communicates with the engine through:
- **HTTP REST API**: For CRUD operations and request execution
- **Server-Sent Events (SSE)**: For real-time load test metrics

All communication happens on `localhost:9876` (configurable).

## API Client Architecture

```
┌─────────────────────────────────────────┐
│         React Components                │
│  (RequestBuilder, Dashboard, etc.)     │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Hooks + singletons                     │
│  (useEngine, queries/, loadTestService) │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         Services Layer                  │
│  - api.ts (HTTP client)                │
│  - sse-client.ts (SSE client)          │
│  - http-client.ts (fetch wrapper)       │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         Vayu Engine                     │
│  (localhost:9876)                      │
└─────────────────────────────────────────┘
```

## HTTP Client (`services/http-client.ts`)

Low-level fetch wrapper with error handling and timeout management.

### Features

- **Base URL Configuration**: `http://127.0.0.1:9876` (from `config/api-endpoints.ts`)
- **Request Timeout**: 30 seconds default
- **Error Transformation**: Converts HTTP errors to `ApiError` with user-friendly messages
- **Query Parameters**: Automatic URL encoding
- **JSON Serialization**: Automatic request/response JSON handling

### Error Handling

```typescript
class ApiError extends Error {
  statusCode: number
  errorCode: string
  userFriendlyMessage: string
  response?: any
}
```

Every engine error body is `{"error": {"code", "message"}}`, so `message` is the
engine's own text (a validation reason, a not-found) and `errorCode` is its
`code` - per-status (`bad_request`, `not_found`, ...) unless the route names a
more specific one. Two fallbacks sit behind that, and both matter: a body in the
**legacy flat** shape (`{"error": "..."}`, which a pre-#173 engine sends and the
sidecar's version can lag the app's) still yields its string as the message, and
a body carrying neither falls back to `HTTP <status>: <statusText>`. `response`
keeps the raw body, which is where per-error detail lives - `error.item` on a
failed bulk import, the provider fields on `/oauth2`. See
[the engine's error contract](../engine/api-reference.md).

**Error Types:**
- `isTimeout`: Request timeout
- `isNetworkError`: Connection/DNS errors
- `isDatabaseError`: Engine database errors

## API Service (`services/api.ts`)

High-level service layer that wraps HTTP client with domain-specific methods.

### Data Transformation

The service handles transformation between frontend (snake_case) and backend (camelCase) formats:

**Frontend Format (snake_case):**
```typescript
{
  collection_id: "col_123"
  created_at: "2024-01-01T00:00:00Z"
  pre_request_script: "console.log('test')"
}
```

**Backend Format (camelCase):**
```typescript
{
  collectionId: "col_123"
  createdAt: 1704067200000
  preRequestScript: "console.log('test')"
}
```

#### Request bodies

`body` goes to the engine as the discriminated union `{ mode, content }` or -
for the two form modes - `{ mode, fields }`, built by `buildExecBody`
(`modules/request-builder/utils/execute-mapping.ts`) and passed through
untransformed. The mode strings are a contract: the engine matches
`"form-data"` and `"x-www-form-urlencoded"` exactly and reads the content out
of `fields`, so a renamed mode or a flattened `content` string sends an empty
body rather than failing. Disabled rows are sent and dropped engine-side, the
engine writes the Content-Type each form mode implies, and file parts are not
supported yet. See [the engine's `body` union](../engine/api-reference.md#the-request-body-union)
for the full contract.

### API Methods

#### Health & Configuration

```typescript
apiService.getHealth(): Promise<EngineHealth>
apiService.getConfig(): Promise<EngineConfig>
apiService.updateConfig(config): Promise<EngineConfig>
```

#### Cookie jar

```typescript
apiService.getCookies(): Promise<GetCookiesResponse>
apiService.clearCookies(scope?: { environmentId: string | null }): Promise<ClearCookiesResponse>
```

The engine keeps one cookie jar per environment for design-mode requests
(issue #301); `CookiesCard` in Settings → General shows and clears them.
`clearCookies` distinguishes three cases the way the engine does, and they are
not interchangeable: **omitted** clears every jar, `{ environmentId: null }`
clears only the jar used when no environment is selected, and an id clears that
environment's. It reaches `DELETE /cookies` with the parameter absent, present
and empty, or present with the id, respectively.

#### Create vs update

For collections, requests and environments the engine splits the write verbs:
`POST /<resource>` creates and never updates; `PUT /<resource>/:id` updates and
answers an unknown `id` with `404`. They are not interchangeable, so `apiService`
keeps one method per verb:

- `createX(data)` posts the object to the collection path **with `id` stripped**
  (`withoutId` in `api.ts`). The engine assigns every id and answers a create
  carrying one with a `400`, and the `Create*Request` types declare `id?: never` -
  but TypeScript only excess-property-checks object literals, so a call site that
  spreads a whole record (a duplicate flow, a restored tab) would slip one
  through. The strip is what actually holds. (Import used to be the exception,
  pre-assigning ids to wire `parentId` / `collectionId` across a tree before
  anything was persisted; it sends one `applyImport` call now, see below.)
- `updateX(data)` takes `data.id`, puts it in the **path**, and sends the rest
  of the object as a merge-patch body - an omitted field keeps its stored value,
  an explicit `null` resets it to the default. The `id` is not repeated in the
  body; a body `id` disagreeing with the path is a `400`.

The full contract, including the null-vs-absent table and which fields have no
default, is in [engine/api-reference.md](../engine/api-reference.md) under
"Resource writes". `src/services/api.write-verbs.test.ts` pins the method and
path of every one of these calls - a regression here is invisible at every other
layer, because the payload shape does not change.

#### Collections

```typescript
apiService.listCollections(): Promise<Collection[]>
apiService.createCollection(data): Promise<Collection>   // POST /collections
apiService.updateCollection(data): Promise<Collection>   // PUT  /collections/:id
apiService.deleteCollection(id): Promise<void>
```

#### Requests

```typescript
apiService.listRequests(params?): Promise<Request[]>
apiService.getRequest(id): Promise<Request>
apiService.createRequest(data): Promise<Request>         // POST /requests
apiService.updateRequest(data): Promise<Request>         // PUT  /requests/:id
apiService.deleteRequest(id): Promise<void>
```

#### Reorder

```typescript
apiService.reorder(data: ReorderRequest): Promise<ReorderResponse>  // POST /reorder
```

The write path behind a drop. One call repositions any number of collections and
requests, and the engine applies the whole batch in one transaction - so a drop
that displaces N siblings is one round trip, not N `updateRequest` calls that can
half-land and race a concurrent create into the middle of their range.

The payload carries `moves` (each row's new `order`, plus `parentId` /
`collectionId` when it changes owner) and `normalize` (scopes to renumber dense
`0..n-1` in display order first, for a collection whose rows all predate explicit
orders). `modules/collections/reorder-math.ts` computes both from the sibling
lists the tree is already showing; the full contract is in
[engine/api-reference.md](../engine/api-reference.md) under `POST /reorder`.

Unlike the other writes, the response is **read**: it is the rows as written, and
`useReorderMutation` settles its caches on them so a normalization the engine
performed shows up without waiting for the refetch.

#### Environments

```typescript
apiService.listEnvironments(): Promise<Environment[]>
apiService.getEnvironment(id): Promise<Environment>
apiService.createEnvironment(data): Promise<Environment> // POST /environments
apiService.updateEnvironment(data): Promise<Environment> // PUT  /environments/:id
apiService.deleteEnvironment(id): Promise<void>
```

#### Global Variables

```typescript
apiService.getGlobals(): Promise<GlobalVariables>
apiService.updateGlobals(variables): Promise<GlobalVariables>
```

#### Import

```typescript
apiService.importFetch(url): Promise<ImportFetchResponse>          // POST /import/fetch
apiService.applyImport(payload): Promise<ImportApplyResponse>      // POST /import/apply
```

`applyImport` sends a whole parsed import - collections, requests, environments -
in one atomic call. Items reference each other by opaque `tempId`s and the engine
returns the temp-id -> real-id `idMap`; a rejected payload persisted nothing, so
there is nothing to roll back. Imported **globals** are not in this payload: they
are a singleton written through `updateGlobals` after the apply succeeds. See
[import-collections/README.md](./import-collections/README.md#3-persist---orchestratorts)
for the pipeline and
[engine/api-reference.md](../engine/api-reference.md#post-importapply) for the
contract.

#### Execution

```typescript
apiService.composeRequest(data): Promise<ComposedRequest>
apiService.executeRequest(data): Promise<SanityResult>
apiService.startLoadTest(data): Promise<StartLoadTestResponse>
```

`composeRequest` (`POST /compose`, issue #226) resolves `{{variables}}` and
`inherit` auth engine-side and returns the payload the other two accept
unchanged - every send site composes first, so nothing is interpolated twice.

**GraphQL schema introspection is a send site too** (`lib/graphql/introspect.ts`,
issue #228): it composes the endpoint, overlays the introspection query onto the
composed `url` / `headers` / `auth`, and executes that - which is how an
endpoint whose credentials live in the Auth panel gets introspected at all. It
sends the composed request's auth but neither its body nor its script parts.

#### Run Management

```typescript
// Paginated, filtered history (newest first). Rows carry a compact `summary`
// (url/method/mode/duration/concurrency/comment), not the full configSnapshot.
apiService.listRuns(params?: RunListParams): Promise<RunListResponse>
// Every page as a flat list (Settings' count + clear).
apiService.listAllRuns(params?): Promise<Run[]>
apiService.getRun(id): Promise<Run>            // full configSnapshot
apiService.getRunReport(id): Promise<RunReport>
// Response headers/bodies captured for a run's samples. Its own request, not
// fields on the report - see below.
apiService.getRunSamples(id, { limit?, offset? }): Promise<RunSamplesResponse>
apiService.stopRun(id): Promise<StopRunResponse>
apiService.deleteRun(id): Promise<void>
```

`deleteRun` on a run that is still in progress stops it engine-side first, so it
takes as long as the stop does, and it **rejects with a 409** if the run's worker
has not finished writing in time - nothing is deleted in that case. Callers must
handle that rejection: `HistoryList` turns it into a toast telling the user to
retry, and Settings' *Clear run history* already counts per-run failures through
`Promise.allSettled`. The wording of that toast is the caller's, keyed off
`statusCode`, rather than the engine's message - which is a caller's choice now
that `httpClient` reads the message on every error shape (issue #173), not a
constraint.

**Captured response bodies are fetched separately, and lazily.** A load run
stores the response headers and body for its failures, its slow outliers and a
few exemplars of each status code; `GET /runs/:id/report` deliberately does not
carry them, because that endpoint loads and JSON-parses every result row for the
run on each fetch and the dashboard polls it. `useRunSamplesQuery(runId, enabled)`
(`queries/runs.ts`) wraps `getRunSamples` and is enabled **only once a reader
expands a sample** - passing `true` unconditionally would reintroduce exactly the
cost the split exists to avoid. It returns a `Map` keyed by `resultId`, joined
against `report.results[].id`.

Two surfaces consume it - the dashboard's Sampled Requests
(`RequestResponseView`) and the history Samples tab - and both render
`CapturedResponseNotice` (truncated / dropped for budget / binary) and
`CapturedDataWarning` (the run stored responses verbatim, including anything
credential-shaped). Both notices live in `components/shared`, so the wording
exists once rather than twice.

#### Scripting

```typescript
apiService.getScriptCompletions(): Promise<ScriptCompletionsResponse>
```

#### OAuth 2.0

```typescript
apiService.fetchOAuth2Token(data): Promise<OAuth2TokenResponse>        // POST   /oauth2/token
apiService.getOAuth2TokenStatus(cacheKey): Promise<OAuth2StatusResponse> // GET  /oauth2/token?key=
apiService.clearOAuth2Token(cacheKey): Promise<void>                   // DELETE /oauth2/token?key=

// Interactive Authorization Code flow (engine-hosted loopback + PKCE)
apiService.startOAuth2Authorize(data): Promise<OAuth2AuthorizeStart>
apiService.getOAuth2AuthorizeStatus(attemptId): Promise<OAuth2AuthorizeStatus>
apiService.completeOAuth2Authorize(attemptId, callbackUrl): Promise<OAuth2AuthorizeStatus>
```

These back the OAuth 2.0 auth editor. TanStack Query wraps the non-interactive
ones in `queries/oauth.ts` (`useOAuth2TokenStatusQuery` - polls status ~30s;
`useFetchOAuth2TokenMutation`, `useClearOAuth2TokenMutation`). The token
`cacheKey` is computed client-side by `services/oauth/cache-key.ts`, byte-identical
to the engine so the app and engine agree on cache slots without a round-trip.
The interactive flow is orchestrated in `services/oauth/authorize.ts` (opens the
system browser or an embedded Electron window, then polls the engine).

> **`HttpClient.delete`** takes an optional `params` argument so the token-clear
> call can pass `?key=`.

## SSE Client (`services/sse-client.ts`)

Server-Sent Events client for real-time load test metrics streaming.

### Features

- **Single endpoint**: Connects to `/runs/:runId/live`. The engine retains a replayable tick
  topic, so the client connects immediately after `POST /runs` with no attach race - it replays
  from offset 0 and tails to the `complete` event (even for sub-second runs).
- **No custom reconnect loop**: The engine sends an explicit `complete` event at normal run end,
  so a `CLOSED` readyState is treated as terminal. Transient `CONNECTING` errors are left to the
  browser's built-in `EventSource` retry. At run end the app converges on the stored report
  (`GET /runs/:id/report`) rather than reconnecting to the stream.
- **Event Handling**: `metrics` events, `complete` event, `error` handling
- **Metrics Parsing**: `mapSseMetrics()` transforms the engine's camelCase blob to the frontend
  `LoadTestMetrics` shape (includes drops, queue-wait, percentiles, bytes, status-code map)

### Usage

```typescript
sseClient.connect(
  runId: string,
  onMessage: (metrics: LoadTestMetrics) => void,
  onError: (error: Error) => void,
  onClose: () => void
);

sseClient.disconnect();
sseClient.isConnected(): boolean
```

### Event Types

- **`metrics`**: Real-time metrics update (JSON payload)
- **`complete`**: Load test completed
- **`error`**: Connection error (triggers reconnection)
- **`open`**: Connection established

## API Endpoints (`config/api-endpoints.ts`)

Centralized endpoint configuration:

```typescript
export const API_ENDPOINTS = {
  BASE_URL: "http://127.0.0.1:9876",
  
  // Health & Config
  HEALTH: "/health",
  CONFIG: "/config",
  
  // Collections
  COLLECTIONS: "/collections",
  COLLECTION_BY_ID: (id: string) => `/collections/${id}`,
  
  // Requests
  REQUESTS: "/requests",
  REQUEST_BY_ID: (id: string) => `/requests/${id}`,

  // Batch reorder for both entity kinds - one drop, one call, one transaction
  REORDER: "/reorder",
  
  // Cookie jar - GET reads every scope, DELETE clears one or all
  COOKIES: "/cookies",

  // Execution
  EXECUTE_REQUEST: "/execute",
  START_LOAD_TEST: "/runs",

  // OAuth 2.0
  OAUTH2_TOKEN: "/oauth2/token",
  OAUTH2_AUTHORIZE_START: "/oauth2/authorize/start",
  OAUTH2_AUTHORIZE_COMPLETE: "/oauth2/authorize/complete",
  OAUTH2_AUTHORIZE_STATUS: (id: string) => `/oauth2/authorize/${id}`,
  
  // Runs
  RUNS: "/runs",
  RUN_BY_ID: (id: string) => `/runs/${id}`,
  RUN_REPORT: (id: string) => `/runs/${id}/report`,
  RUN_STOP: (id: string) => `/runs/${id}/stop`,
  // Captured response headers/bodies, fetched only when a sample is expanded
  RUN_SAMPLES: (id: string, limit: number, offset: number) =>
    `/runs/${id}/samples?limit=${limit}&offset=${offset}`,
  
  // Real-time stats (SSE)
  METRICS_LIVE: (runId: string) => `/runs/${runId}/live`,

  // Time-series metrics (JSON, paginated) - used to hydrate history
  STATS_TIME_SERIES: (runId: string, limit = 5000, offset = 0) =>
    `/runs/${runId}/metrics?limit=${limit}&offset=${offset}`,
};
```

> Note: the old `STATS_STREAM` SSE constant was removed - live metrics go through
> `METRICS_LIVE` only; `/stats` is now used solely for paginated historical reads.

## Request Execution Flow

### Single Request Execution

1. **User Action**: Clicks "Send" in RequestBuilder
2. **Request Transformation**: Frontend format → backend format (raw - no
   client-side `{{variable}}` resolution)
3. **Composition**: `apiService.composeRequest()` → `POST /compose` - the
   engine resolves `{{variables}}` and `inherit` auth against the request's
   `collectionId` chain and the active `environmentId`, and returns the
   execute-ready payload (issue #226)
4. **API Call**: `apiService.executeRequest()` with the composed payload,
   unchanged → `POST /execute`
5. **Response Transformation**: Backend format → frontend format
6. **Display**: Response shown in ResponseViewer

The renderer sends the **inline** compose shape (`{ request, collectionId,
environmentId }`) rather than compose-by-id, because Send executes the *editor
state* - possibly unsaved, or a detached History replay copy that has no saved
row at all. `requestId` is attached to the execute payload afterwards purely to
link the run to the saved request in History; `environmentId` scopes both
composition and the engine's script context / variable persistence.
`useVariableResolver()` still exists but is **preview-only** (tab titles,
previews, unresolved-token painting) - see
[variable-resolution](./variable-resolution.md).

Auth (bearer/basic/api-key/oauth2) is resolved **engine-side** from the request's
`auth` object - the app no longer builds `Authorization` headers itself. When a
non-interactive OAuth 2.0 token can't be obtained, the response carries an
`errorCode` of `AUTH_REQUIRED` (interactive sign-in needed) or `AUTH_FAILED`, and
the request builder surfaces a toast pointing the user at the Auth tab.

**Example Request:**
```typescript
await apiService.executeRequest({
  method: "GET",
  url: "https://api.example.com/users",
  headers: { "Authorization": "Bearer {{token}}" },
  preRequestScripts: [
    { origin: "request", id: "req_123", script: "console.log('Pre-request');" }
  ],
  postRequestScripts: [
    {
      origin: "request",
      id: "req_123",
      script: "pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));"
    }
  ],
  followRedirects: true,
  maxRedirects: 10,
  httpVersion: "auto",
  requestId: "req_123",
  environmentId: "env_456"
});
```

`preRequestScripts` / `postRequestScripts` are an ordered list of `ScriptPart`s
(`{ origin: "collection" | "request", id?, name?, script }`), not a single
string: the collection chain's scripts (root→leaf), then the request's own.
The renderer builds the list from its editor state (`scriptParts()` in
`request-builder/utils/script-parts.ts`) and it rides through `POST /compose`
untouched - script text is never interpolated; the by-id compose path (used by
MCP) builds the same list engine-side. The **engine** joins the parts and runs
the result - see `docs/engine/architecture.md` → *Request composition boundary*.

**Redirect policy and protocol are always sent, never elided.**
`followRedirects`, `maxRedirects` and `httpVersion` all come from the request's
**Settings** tab and are included on every execute even when they equal the
defaults. The engine defaults `follow_redirects` to `true`, so omitting a
`false` would follow the 3xx the user asked to inspect - a bug the app shipped
with for a long time, when nothing in the renderer sent these fields at all.
The same three fields go out with `startLoadTest()`, so a load test exercises
the same policy and protocol the request was configured with - there is no
separate, load-test-only protocol control; the Settings tab's picker is the
only one, and it governs Send and load test alike. `httpVersion` is
`"auto" | "http1.1" | "http2"`: `"auto"` lets ALPN negotiate, `"http1.1"`
forces HTTP/1.1, and `"http2"` attempts h2 over TLS with a silent fallback to
1.1 over plain `http://` (curl's `CURL_HTTP_VERSION_2TLS` semantics).

**Example Response:**
```typescript
{
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  body: { users: [...] },
  bodyRaw: '{"users":[...]}',
  httpVersion: "HTTP/1.1",
  httpVersionDowngraded: false,
  timing: { total: 150, dns: 10, connect: 20, ... },
  testResults: [
    { name: "Status 200", passed: true }
  ],
  consoleLogs: [
    { source: "pre", level: "log", message: "Pre-request" },
    { source: "test", level: "warn", message: "slow response" }
  ]
}
```

`consoleLogs` entries name the script that wrote them and the `console.*` level
that was called. A bare `string` is the pre-structured shape an older engine
sidecar sends; `console/parse-logs.ts` decodes both and is the only place that
knows the difference (see
[the engine API reference](../engine/api-reference.md#post-execute)).

`httpVersion` here is the **negotiated** protocol (`"HTTP/1.1"` / `"HTTP/2"` /
`""` when nothing was negotiated) - an outcome, not an echo of the request's
own `httpVersion`. The Raw tab in the response viewer prints it on the
request/status line instead of a hardcoded `HTTP/1.1`.

`httpVersionDowngraded` says the request asked for `http2` and the connection
negotiated something older - the one thing neither `httpVersion` can say alone,
since neither knows about the other. The engine computes it, and the renderer
carries it as-is rather than comparing the negotiated protocol against the
tab's current setting: a restored or replayed response sits beside request
state that may have changed since, and the answer belongs to the exchange.
`ResponseStatusBar` draws it as a warning beside the status chip, and only when
it is true. Load runs carry the whole-run count as
`report.summary.httpVersionDowngraded`, which `LoadTestDetail` shows next to
the requested protocol - without it a run measured entirely over HTTP/1.1 still
read "HTTP/2" there
([#215](https://github.com/athrvk/vayu/issues/215)).

`report.sampling` carries what each of the run's bounded stores thinned away -
`successTracesDropped` / `slowTracesDropped` for the trace records behind
`report.results`, and `responseSamplesDropped` for the buffer post-run test
scripts are graded on. The renderer treats a non-zero count as "this list is a
*sample* of a larger set": `SampleRetentionNote` (shared) renders under the
dashboard's Sampled Requests, the history Samples tab and the Test Validation
card, and the sample-count badges say **shown** rather than *captured*, since
`results` is capped at 100 by the report route irrespective of retention.

An **absent** `sampling` is a run whose stored summary predates the counts, not
a run that dropped nothing, so the note stays out rather than asserting a
completeness it cannot verify - the same absent-vs-zero rule
`httpVersionDowngraded` follows above.

### Load Test Execution

1. **User Action**: Configures and starts load test
2. **Composition**: the request half (method/url/headers/body/auth/`tests`
   script parts) goes raw through `apiService.composeRequest()` → `POST
   /compose`, same as Send - so a load test measures the same composed request
   Send sends
3. **Request Transformation**: composed request half + frontend
   `LoadTestConfig` → backend format
4. **API Call**: `apiService.startLoadTest()` → `POST /runs`
4. **Response**: `{ runId: "run_123", status: "running" }`
5. **Dashboard Initialization**: `useDashboardStore().startRun(runId)`
6. **SSE Connection**: `loadTestService.startMonitoring(runId)` connects to `/runs/:runId/live` (a module singleton, so the stream outlives the view)
7. **Metrics Streaming**: Real-time metrics update dashboard
8. **Completion**: When test completes, fetch final report via `GET /runs/:id/report`

**Example Load Test Request:**
```typescript
await apiService.startLoadTest({
  request: {
    method: "POST",
    url: "https://api.example.com/data",
    headers: { "Content-Type": "application/json" },
    body: { mode: "json", content: '{"key": "value"}' }
  },
  followRedirects: true,
  maxRedirects: 10,
  httpVersion: "auto",
  mode: "constant_rps",
  duration: "30s",
  targetRps: 100,
  concurrency: 50,
  requestId: "req_123",
  environmentId: "env_456",
  comment: "Stress test"
});
```

The engine range-checks this payload before it creates the run row and answers a
violation with `400 invalid_run_config` (accepted ranges are tabulated under
[POST /runs](../engine/api-reference.md#post-runs)). The renderer's own limits
live in `LOAD_TEST_LIMITS` (`src/constants/load-test.ts`) and must stay at or
inside the engine's.

#### `success_sample_rate` is a period, not a percentage

The engine keeps a success trace when `counter % success_sample_rate == 0` - one
in every N. The dialog's control is a percentage, and the renderer converts
between them with `successSamplePeriod` (`constants/load-test.ts`): 100% becomes
a period of `1`, 1% becomes `100`, and the default 10% is the fixed point where
the two units coincide. Sending the percentage straight through, as the renderer
did before, inverts the slider - "100% - everything" kept 1%.

A `0` is a division by zero engine-side, so the control's floor is 1%. "Keep no
success traces" is the **Save timing breakdown** toggle, which gates storage
outright.

#### Dialog ceilings are a user setting

`LOAD_TEST_LIMITS` (`constants/load-test.ts`) holds the ranges the load dialog
offers, and four of its ceilings are user-adjustable in **Settings → Load
testing** (`loadTestCeilings` on `client-settings-store`). The dialog reads them
through `resolveLoadTestLimits`, never off the constant.

These are the app's policy and sit inside the engine's own bounds, which are
crash guards rather than throttles: a run's `concurrency` becomes an *eager*
per-worker curl-handle pre-allocation, so the engine caps it at 10x
`event_loop::MAX_CONCURRENT`. `LOAD_TEST_CEILING_BOUNDS` pins each settable
ceiling at that guard, so no value on the settings screen can compose a run the
engine rejects. The floors are not settable at all - below them the values are
not "small", they are unusable (a `concurrency` of 0, a sample period of 0).

## Error Handling

### HTTP Errors

All HTTP errors are transformed to `ApiError`:

```typescript
try {
  await apiService.executeRequest(...);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.userFriendlyMessage);
    console.error(error.statusCode);
    console.error(error.errorCode);
  }
}
```

### Network Errors

Network errors (timeout, connection failed) are caught and displayed:

```typescript
if (error.isTimeout) {
  // Show timeout message
} else if (error.isNetworkError) {
  // Show network error message
}
```

### SSE Errors

The SSE client does **not** reconnect. `EventSource` cannot set `Last-Event-ID`
on a fresh connection, so a manual reconnect would re-request the topic from
offset 0 and duplicate every tick already plotted.

- Transient errors (`CONNECTING`): left to the browser's own retry, which does
  carry `Last-Event-ID`
- Terminal errors (`CLOSED`): connection disposed and the close handler runs,
  which converges on `GET /runs/:id/report`

## Connection Management

### Health Checking

The app polls `/health` endpoint to verify engine connectivity:

```typescript
useHealthQuery() // Polls every TIMING.HEALTH_CHECK_INTERVAL_MS (30s)
```

**Health Response:**
```typescript
{
  status: "ok",
  version: "0.3.0",
  workers: 8
}
```

### Engine Startup

The Electron main process (`electron/sidecar.ts`) manages engine lifecycle:
- Spawns engine process on app start
- Monitors health via `/health` endpoint
- Handles graceful shutdown on app quit

## Best Practices

1. **Always use `apiService`**: Don't call `httpClient` directly
2. **Handle errors**: Always wrap API calls in try/catch
3. **Use user-friendly messages**: Display `error.userFriendlyMessage` to users
4. **Transform data**: Use service layer for format transformation
5. **Cache queries**: Use TanStack Query for automatic caching
6. **Disconnect SSE**: Always disconnect SSE when component unmounts

## Testing

### Mocking API Calls

Use TanStack Query's query client for testing:

```typescript
import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } }
});
```

### Mocking Services

Mock `apiService` methods:

```typescript
jest.spyOn(apiService, 'executeRequest').mockResolvedValue(mockResponse);
```

## Troubleshooting

### Engine Not Responding

1. Check if engine is running: `curl http://127.0.0.1:9876/health`
2. Check engine logs in Electron console
3. Verify port 9876 is not blocked

### SSE Not Connecting

1. Verify load test is running (`status: "running"`)
2. Check browser console for SSE errors
3. Verify endpoint: `/runs/:runId/live` or `/runs/:runId/metrics`

### CORS Errors

Should not occur (same-origin: localhost), but if they do:
- Verify engine CORS settings
- Check if request is going to correct origin
