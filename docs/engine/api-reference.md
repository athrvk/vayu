# Vayu Engine API Reference

**Base URL:** `http://127.0.0.1:9876` (default, configurable via `--port`)

All endpoints return JSON. Error responses follow this format:

```json
{
  "error": "Error message"
}
```

## Health & Configuration

### GET /health

Check engine status and version.

**Response:**
```json
{
  "status": "ok",
  "version": "0.1.1",
  "workers": 8
}
```

### GET /config

Get global configuration settings.

**Response:**
```json
{
  "workers": 8,
  "maxConnections": 10000,
  "defaultTimeout": 30000,
  "statsInterval": 100,
  "contextPoolSize": 64
}
```

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
    "updatedAt": 1234567890
  }
]
```

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
  "postRequestScript": ""            // Optional, JavaScript test script
}
```

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

## Execution

### POST /request

Execute a single HTTP request (Design Mode). Returns immediate response with test results.

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
  "postRequestScript": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));"
}
```

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
  "request": {
    "method": "GET",
    "url": "https://api.example.com/users",
    "headers": {},
    "body": {
      "type": "none",
      "content": ""
    }
  },
  "mode": "constant",        // "constant", "ramp_up", or "iterations"
  "virtualUsers": 100,       // Number of concurrent users
  "duration": 60,            // Duration in seconds (for constant/ramp_up)
  "rampUp": 10,              // Ramp-up time in seconds (for ramp_up mode)
  "iterations": 0,           // Number of iterations per user (for iterations mode)
  "targetRps": 1000,         // Optional, target requests per second
  "environmentId": "env_1234567890",  // Optional
  "testScript": ""           // Optional, deferred validation script
}
```

**Response:**
```json
{
  "runId": "run_1234567890",
  "status": "running"
}
```

## Metrics & Statistics

### GET /stats/:runId

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

Get current live metrics snapshot (non-streaming).

**Response:**
```json
{
  "runId": "run_1234567890",
  "status": "running",
  "totalRequests": 1500,
  "totalErrors": 5,
  "errorRate": 0.33,
  "avgLatencyMs": 45.2,
  "currentRps": 150.5,
  "activeConnections": 100,
  "elapsedSeconds": 10.5
}
```

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

**Response:** Run object with full details.

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

Get final report for a completed run.

**Response:**
```json
{
  "runId": "run_1234567890",
  "totalRequests": 6000,
  "successfulRequests": 5970,
  "failedRequests": 30,
  "errorRate": 0.5,
  "totalDurationS": 60.0,
  "avgRps": 100.0,
  "latencyMin": 12.3,
  "latencyMax": 1250.5,
  "latencyAvg": 42.1,
  "latencyP50": 38.5,
  "latencyP75": 45.2,
  "latencyP90": 78.3,
  "latencyP95": 95.1,
  "latencyP99": 156.7,
  "latencyP999": 450.2,
  "statusCodes": {
    "200": 5970,
    "500": 30
  },
  "errorTypes": {
    "timeout": 20,
    "connection_failed": 10
  }
}
```

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
| 400 | Bad request (invalid JSON, missing required fields) |
| 404 | Resource not found |
| 500 | Internal server error |

## Notes

- All timestamps are Unix milliseconds (since epoch)
- Variable substitution uses `{{variableName}}` syntax
- Environment variables are resolved in order: environment → collection → global
- Load test metrics are collected every 100ms
- SSE connections timeout after 30 seconds of inactivity
