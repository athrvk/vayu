# Vayu Engine API Reference

Base URL: `http://localhost:9876`

## Health

### GET /health
Check engine status.

**Response:**
```json
{ "status": "ok", "version": "0.1.1" }
```

## Collections

### GET /api/collections
List all collections.

### POST /api/collections
Create collection.
```json
{ "name": "My API", "parentId": null }
```

### PUT /api/collections/:id
Update collection.

### DELETE /api/collections/:id
Delete collection (cascades to requests).

## Requests

### GET /api/requests
List requests. Query: `?collectionId=xxx`

### POST /api/requests
Create request.
```json
{
  "collectionId": "uuid",
  "name": "Get Users",
  "method": "GET",
  "url": "{{baseUrl}}/users",
  "headers": [{"key": "Authorization", "value": "Bearer {{token}}"}],
  "body": { "type": "none", "content": "" }
}
```

### PUT /api/requests/:id
Update request.

### DELETE /api/requests/:id
Delete request.

## Environments

### GET /api/environments
List environments.

### POST /api/environments
Create environment.
```json
{
  "name": "Production",
  "variables": [
    { "key": "baseUrl", "value": "https://api.example.com", "enabled": true }
  ]
}
```

### PUT /api/environments/:id
Update environment.

### DELETE /api/environments/:id
Delete environment.

## Execution

### POST /api/execute
Execute a request.

**Request:**
```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": [{"key": "Content-Type", "value": "application/json"}],
  "body": { "type": "json", "content": "{\"name\":\"John\"}" },
  "environmentId": "uuid",
  "collectionId": "uuid",
  "testScript": "pm.test('OK', () => pm.expect(pm.response.code).to.equal(200));"
}
```

**Response:**
```json
{
  "runId": "uuid",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"id\":1,\"name\":\"John\"}",
  "time": 245,
  "size": 28,
  "testResults": [{ "name": "OK", "passed": true }]
}
```

## Load Testing

### POST /api/load-test/start
Start load test.

**Request:**
```json
{
  "request": { },
  "virtualUsers": 100,
  "duration": 60,
  "rampUp": 10,
  "iterations": 0
}
```

**Response:**
```json
{ "testId": "uuid", "status": "running" }
```

### GET /api/load-test/:id/metrics (SSE)
Stream real-time metrics.

**Event data:**
```json
{
  "timestamp": 1234567890,
  "requestsPerSecond": 150.5,
  "avgLatency": 45.2,
  "p50": 42,
  "p95": 89,
  "p99": 156,
  "errorRate": 0.5,
  "activeUsers": 100,
  "totalRequests": 9030,
  "totalErrors": 45
}
```

### POST /api/load-test/:id/stop
Stop running test.

### GET /api/load-test/:id/report
Get final report.

## History

### GET /api/runs
List execution history. Query: `?requestId=xxx&limit=50`

### GET /api/runs/:id
Get run details.

### DELETE /api/runs/:id
Delete run.

## Global Variables

### GET /api/globals
List global variables.

### PUT /api/globals
Set global variables.
```json
{
  "variables": [
    { "key": "apiKey", "value": "xxx", "enabled": true }
  ]
}
```

## Common Response Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request |
| 404 | Not found |
| 500 | Server error |

## Error Response

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```
