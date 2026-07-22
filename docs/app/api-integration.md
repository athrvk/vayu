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
│         Custom Hooks                    │
│  (useEngine, useSSE)                    │
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

### API Methods

#### Health & Configuration

```typescript
apiService.getHealth(): Promise<EngineHealth>
apiService.getConfig(): Promise<EngineConfig>
apiService.updateConfig(config): Promise<EngineConfig>
```

#### Collections

```typescript
apiService.listCollections(): Promise<Collection[]>
apiService.createCollection(data): Promise<Collection>
apiService.updateCollection(data): Promise<Collection>
apiService.deleteCollection(id): Promise<void>
```

#### Requests

```typescript
apiService.listRequests(params?): Promise<Request[]>
apiService.getRequest(id): Promise<Request>
apiService.createRequest(data): Promise<Request>
apiService.updateRequest(data): Promise<Request>
apiService.deleteRequest(id): Promise<void>
```

#### Environments

```typescript
apiService.listEnvironments(): Promise<Environment[]>
apiService.getEnvironment(id): Promise<Environment>
apiService.createEnvironment(data): Promise<Environment>
apiService.updateEnvironment(data): Promise<Environment>
apiService.deleteEnvironment(id): Promise<void>
```

#### Global Variables

```typescript
apiService.getGlobals(): Promise<GlobalVariables>
apiService.updateGlobals(variables): Promise<GlobalVariables>
```

#### Execution

```typescript
apiService.executeRequest(data): Promise<SanityResult>
apiService.startLoadTest(data): Promise<StartLoadTestResponse>
```

#### Run Management

```typescript
apiService.listRuns(): Promise<Run[]>
apiService.getRun(id): Promise<Run>
apiService.getRunReport(id): Promise<RunReport>
apiService.stopRun(id): Promise<StopRunResponse>
apiService.deleteRun(id): Promise<void>
```

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

- **Single endpoint**: Connects to `/metrics/live/:runId`. The engine retains a replayable tick
  topic, so the client connects immediately after `POST /run` with no attach race - it replays
  from offset 0 and tails to the `complete` event (even for sub-second runs).
- **No custom reconnect loop**: The engine sends an explicit `complete` event at normal run end,
  so a `CLOSED` readyState is treated as terminal. Transient `CONNECTING` errors are left to the
  browser's built-in `EventSource` retry. At run end the app converges on the stored report
  (`GET /run/:id/report`) rather than reconnecting to the stream.
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
  
  // Execution
  EXECUTE_REQUEST: "/request",
  START_LOAD_TEST: "/run",

  // OAuth 2.0
  OAUTH2_TOKEN: "/oauth2/token",
  OAUTH2_AUTHORIZE_START: "/oauth2/authorize/start",
  OAUTH2_AUTHORIZE_COMPLETE: "/oauth2/authorize/complete",
  OAUTH2_AUTHORIZE_STATUS: (id: string) => `/oauth2/authorize/${id}`,
  
  // Runs
  RUNS: "/runs",
  RUN_BY_ID: (id: string) => `/run/${id}`,
  RUN_REPORT: (id: string) => `/run/${id}/report`,
  RUN_STOP: (id: string) => `/run/${id}/stop`,
  
  // Real-time stats (SSE)
  METRICS_LIVE: (runId: string) => `/metrics/live/${runId}`,

  // Time-series metrics (JSON, paginated) - used to hydrate history
  STATS_TIME_SERIES: (runId: string, limit = 5000, offset = 0) =>
    `/stats/${runId}?format=json&limit=${limit}&offset=${offset}`,
};
```

> Note: the old `STATS_STREAM` SSE constant was removed - live metrics go through
> `METRICS_LIVE` only; `/stats` is now used solely for paginated historical reads.

## Request Execution Flow

### Single Request Execution

1. **User Action**: Clicks "Send" in RequestBuilder
2. **Variable Resolution**: `useVariableResolver()` resolves `{{variables}}` in URL, headers, body
3. **Request Transformation**: Frontend format → backend format
4. **API Call**: `apiService.executeRequest()` → `POST /request`
5. **Response Transformation**: Backend format → frontend format
6. **Display**: Response shown in ResponseViewer

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
  requestId: "req_123",
  environmentId: "env_456"
});
```

`preRequestScripts` / `postRequestScripts` are an ordered list of `ScriptPart`s
(`{ origin: "collection" | "request", id?, name?, script }`), not a single
string: the collection chain's scripts (root→leaf), then the request's own,
built client-side by `scriptParts()` (`request-builder/utils/script-parts.ts`
for the renderer, `resolve.ts` for MCP). The **engine** joins the parts and runs
the result - see `docs/engine/architecture.md` → *Request composition boundary*.

**Redirect policy is always sent, never elided.** `followRedirects` and
`maxRedirects` come from the request's **Settings** tab and are included on
every execute even when they equal the defaults. The engine defaults
`follow_redirects` to `true`, so omitting a `false` would follow the 3xx the
user asked to inspect - a bug the app shipped with for a long time, when nothing
in the renderer sent these fields at all. The same pair goes out with
`startLoadTest()`, so a load test exercises the policy the request was
configured with.

**Example Response:**
```typescript
{
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  body: { users: [...] },
  bodyRaw: '{"users":[...]}',
  timing: { total: 150, dns: 10, connect: 20, ... },
  testResults: [
    { name: "Status 200", passed: true }
  ],
  consoleLogs: ["Pre-request"]
}
```

### Load Test Execution

1. **User Action**: Configures and starts load test
2. **Request Transformation**: Frontend `LoadTestConfig` → backend format
3. **API Call**: `apiService.startLoadTest()` → `POST /run`
4. **Response**: `{ runId: "run_123", status: "running" }`
5. **Dashboard Initialization**: `useDashboardStore().startRun(runId)`
6. **SSE Connection**: `useSSE()` connects to `/metrics/live/:runId`
7. **Metrics Streaming**: Real-time metrics update dashboard
8. **Completion**: When test completes, fetch final report via `GET /run/:id/report`

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
  mode: "constant_rps",
  duration: "30s",
  targetRps: 100,
  concurrency: 50,
  requestId: "req_123",
  environmentId: "env_456",
  comment: "Stress test"
});
```

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

SSE client handles errors automatically:
- Transient errors: Logged, reconnection attempted
- Fatal errors: `onError` callback called, connection closed

## Connection Management

### Health Checking

The app polls `/health` endpoint to verify engine connectivity:

```typescript
useHealthQuery() // Polls every 5 seconds
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
3. Verify endpoint: `/metrics/live/:runId` or `/stats/:runId`

### CORS Errors

Should not occur (same-origin: localhost), but if they do:
- Verify engine CORS settings
- Check if request is going to correct origin
