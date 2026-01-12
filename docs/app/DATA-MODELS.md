# Data Models

Types defined in `src/types/`.

## Collection

```typescript
interface Collection {
  id: string;
  name: string;
  description?: string;
  parent_id?: string;
  order?: number;
  variables?: Record<string, VariableValue>;
  created_at: string;
  updated_at: string;
}
```

## Request

```typescript
interface Request {
  id: string;
  collection_id: string;
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  body_type?: "json" | "text" | "form-data" | "x-www-form-urlencoded";
  auth?: Record<string, any>;
  pre_request_script?: string;
  test_script?: string;
  created_at: string;
  updated_at: string;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
```

## Environment

```typescript
interface Environment {
  id: string;
  name: string;
  variables: Record<string, VariableValue>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface VariableValue {
  value: string;
  enabled: boolean;
}
```

## Run

```typescript
interface Run {
  id: string;
  type: "load" | "design";
  status: "pending" | "running" | "completed" | "stopped" | "failed";
  startTime: number;
  endTime: number;
  configSnapshot?: any;
  requestId?: string | null;
  environmentId?: string | null;
}
```

## LoadTestConfig

```typescript
interface LoadTestConfig {
  mode: "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up";
  duration_seconds?: number;
  rps?: number;
  concurrency?: number;
  iterations?: number;
  ramp_duration_seconds?: number;
  comment?: string;
}
```

## LoadTestMetrics (SSE)

```typescript
interface LoadTestMetrics {
  timestamp: number;
  elapsed_seconds: number;
  requests_completed: number;
  requests_failed: number;
  current_rps: number;
  current_concurrency: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  avg_latency_ms: number;
  bytes_sent: number;
  bytes_received: number;
}
```

## UI Types

```typescript
type SidebarTab = "collections" | "history" | "variables" | "settings";
type MainScreen = "welcome" | "request-builder" | "dashboard" | "history" | "history-detail" | "variables";
```
