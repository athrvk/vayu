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

## SSE Client (`services/sse-client.ts`)

Server-Sent Events client for real-time load test metrics streaming.

### Features

- **Dual Endpoint Support**: Tries `/metrics/live/:runId` first, falls back to `/stats/:runId`
- **Automatic Reconnection**: Exponential backoff (max 5 attempts)
- **Event Handling**: `metrics` events, `complete` event, `error` handling
- **Metrics Parsing**: Transforms backend format to frontend `LoadTestMetrics`

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
  
  // Runs
  RUNS: "/runs",
  RUN_BY_ID: (id: string) => `/run/${id}`,
  RUN_REPORT: (id: string) => `/run/${id}/report`,
  RUN_STOP: (id: string) => `/run/${id}/stop`,
  
  // SSE
  STATS_STREAM: (runId: string) => `/stats/${runId}`,
  METRICS_LIVE: (runId: string) => `/metrics/live/${runId}`,
};
```

## Request Execution Flow

### Single Request Execution

1. **User Action**: Clicks "Send" in RequestBuilder
2. **Variable Resolution**: `useVariableResolver()` resolves `{{variables}}` in URL, headers, body
3. **Request Transformation**: Frontend format → backend format
4. **API Call**: `apiService.executeRequest()` → `POST /request`
5. **Response Transformation**: Backend format → frontend format
6. **Display**: Response shown in ResponseViewer

**Example Request:**
```typescript
await apiService.executeRequest({
  method: "GET",
  url: "https://api.example.com/users",
  headers: { "Authorization": "Bearer {{token}}" },
  preRequestScript: "console.log('Pre-request');",
  postRequestScript: "pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));",
  requestId: "req_123",
  environmentId: "env_456"
});
```

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
  mode: "constant",
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
  version: "0.1.1",
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
