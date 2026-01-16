# Request Storage Design

## Overview

This document explains how requests are stored and executed in Vayu, particularly regarding variable resolution.

## Architecture

### 1. Request Definitions (Database)

**Location**: `requests` table  
**Format**: Templates with variables

Requests are stored **WITH variables** (e.g., `{{baseUrl}}/api/users`) in the database. This allows:
- ✅ Reusability across different environments
- ✅ Easy updates to request templates
- ✅ Environment-specific variable values

**Example**:
```json
{
  "id": "req_123",
  "name": "Get Users",
  "method": "GET",
  "url": "{{baseUrl}}/api/users",
  "headers": {
    "Authorization": "Bearer {{token}}"
  }
}
```

### 2. Request Execution

**Process**:
1. User clicks "Send" in the UI
2. Frontend resolves variables using the selected environment
3. Resolved request is sent to `/request` endpoint
4. Backend executes the HTTP request
5. Backend stores **both** the resolved request AND response in execution history

**Variable Resolution Happens**:
- ✅ In frontend before execution (for immediate feedback)
- ✅ In pre-request scripts (variables can be modified)
- ✅ Results are stored in execution history

### 3. Execution History (Results)

**Location**: `results` table → `trace_data` field  
**Format**: JSON containing both request and response

The `trace_data` stores the **RESOLVED** request that was actually sent:

```json
{
  "request": {
    "method": "GET",
    "url": "https://api.example.com/api/users",
    "headers": {
      "Authorization": "Bearer abc123token"
    },
    "body": "..."
  },
  "response": {
    "headers": {...},
    "body": "..."
  },
  "dnsMs": 10,
  "connectMs": 50,
  ...
}
```

### 4. Response Viewer

The Response Viewer shows the **RESOLVED** request in the "Raw Request" tab:
- Shows exactly what was sent over the wire
- Includes resolved variable values
- Complete HTTP request string with headers and body

## Benefits of This Design

1. **Template Reusability**: Keep request definitions clean and reusable
2. **Environment Flexibility**: Same request works across dev/staging/prod
3. **Full Audit Trail**: Execution history shows exactly what was sent
4. **Debugging**: See resolved values in response viewer
5. **Historical Accuracy**: Can review past executions with actual values used

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Request Definition (Database)                               │
│ { url: "{{baseUrl}}/users", headers: {"Auth": "{{token}}"} }│
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Variable Resolution (Frontend + Scripts)                    │
│ baseUrl → https://api.example.com                           │
│ token → abc123                                              │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Execute HTTP Request (Backend)                              │
│ GET https://api.example.com/users                           │
│ Headers: { "Auth": "abc123" }                               │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Store in Execution History (trace_data)                     │
│ {                                                            │
│   "request": { resolved values },                           │
│   "response": { ... }                                       │
│ }                                                            │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Details

### Backend Changes

**File**: `engine/src/http/routes/execution.cpp`

- Stores resolved request in `trace_data.request`
- Includes method, URL, headers, and body
- Works for both successful and failed requests

### Frontend Display

**File**: `app/src/components/request-builder/components/ResponseViewer/index.tsx`

- "Raw Request" tab shows the complete HTTP request
- "Headers" tab separates request headers (blue) and response headers (green)
- Request headers show the actual resolved values

## Future Enhancements

Potential improvements:
1. **Variable Diff View**: Show which variables were used and their values
2. **Request History Comparison**: Compare requests across different runs
3. **Export with Context**: Export including variable values used
