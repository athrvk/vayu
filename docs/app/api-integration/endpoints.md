---
description: >-
  The centralized endpoint configuration the HTTP client and the SSE client read.
---

# API Endpoints (`config/api-endpoints.ts`)

Centralized endpoint configuration:

```typescript
export const API_ENDPOINTS = {
  BASE_URL: ENGINE_BASE_URL, // http://127.0.0.1:<port>, from config/network.ts
  
  // Health & Config
  HEALTH: "/health",
  CONFIG: "/config",
  // What a send adds on its own, resolved from config by the engine.
  // `?scope=design|load` selects which send - see getRequestDefaults above.
  REQUEST_DEFAULTS: "/request-defaults",
  
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

  // Workspace backup - one VACUUM INTO snapshot into `backups/` beside the
  // database, with retention. A verb path for the reason the inbox uses one:
  // the engine takes a snapshot and the file is not a row anything reads back.
  // There is no restore counterpart on purpose - restoring is a manual copy
  // with the engine stopped, which is why the card prints the path.
  WORKSPACE_BACKUP: "/workspace/backup",

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
  
  // Webhook inbox - engine-hosted listener that records what is sent to it.
  // START is a verb path: an inbox lives for the engine process, so the
  // POST-creates/PUT-updates split does not apply to it.
  INBOX: "/inbox",
  INBOX_START: "/inbox/start",
  INBOX_STOP: (inboxId: string) => `/inbox/${inboxId}/stop`,
  // PUT patches the canned response; DELETE removes the inbox and its captures.
  INBOX_BY_ID: (inboxId: string) => `/inbox/${inboxId}`,
  INBOX_CAPTURES: (inboxId: string, limit: number, offset: number) =>
    `/inbox/${inboxId}/requests?limit=${limit}&offset=${offset}`,
  INBOX_CAPTURES_CLEAR: (inboxId: string) => `/inbox/${inboxId}/requests`,
  INBOX_LIVE: (inboxId: string) => `/inbox/${inboxId}/live`,

  // Collection mock server - a loopback listener answering the collection's
  // saved examples. Verb paths for the same reason the inbox uses them. No PUT
  // and no DELETE: the route table is a start-time snapshot, so changing what a
  // mock serves means starting another one, and stopping is what ends it.
  MOCK_SERVER: "/mock",
  MOCK_SERVER_START: "/mock/start",
  MOCK_SERVER_STOP: (mockId: string) => `/mock/${mockId}/stop`,
  MOCK_SERVER_ROUTES: (mockId: string) => `/mock/${mockId}/routes`,

  // Real-time stats (SSE)
  METRICS_LIVE: (runId: string) => `/runs/${runId}/live`,

  // Time-series metrics (JSON, paginated) - used to hydrate history. With
  // maxPoints the whole series in one response, downsampled when the run has
  // more ticks than that (#2547); the History charts ask for 2000.
  STATS_TIME_SERIES: (runId: string, limit = 5000, offset = 0, maxPoints?: number) =>
    maxPoints === undefined
      ? `/runs/${runId}/metrics?limit=${limit}&offset=${offset}`
      : `/runs/${runId}/metrics?maxPoints=${maxPoints}`,

  // Server vitals scraped during the run (JSON, paginated, same envelope).
  // Fetched by the history view only when the report says the run recorded some,
  // and with maxPoints (the same contract as STATS_TIME_SERIES, #2611): one
  // response, folded when the run scraped more than that; the History charts
  // ask for 2000.
  RUN_MONITOR: (runId: string, limit = 5000, offset = 0, maxPoints?: number) =>
    maxPoints === undefined
      ? `/runs/${runId}/monitor?limit=${limit}&offset=${offset}`
      : `/runs/${runId}/monitor?maxPoints=${maxPoints}`,
};
```

> Note: there is no `STATS_STREAM` SSE constant - live metrics go through
> `METRICS_LIVE` only; `/stats` is used solely for paginated historical reads.
