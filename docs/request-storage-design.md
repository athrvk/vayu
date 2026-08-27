---
description: >-
  How Vayu stores requests and why variables are resolved at execution time rather than at save time.
---

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

#### The `url` / `params` invariant

**Enabled query parameters live inside `url`. `params[]` mirrors them for the
editor, disabled entries included.**

`url` is the wire truth: every execution path - design Send, collection scenario
run, load run - sends it verbatim, and no engine path reads `params[]` at all
(it is builder display state, see
[engine/api-reference.md](engine/api-reference.md)). The Params table maintains
the invariant on the app's side by rewriting `url` on every edit, keeping
disabled rows in `params[]` only.

A writer that stores the query *only* in `params[]` therefore stores a request
that sends nothing of it. That was issue #590: every importer split the query
out of the URL, so an imported request dropped its query on every send until the
user happened to edit the Params table once. Imports now restore the invariant at
parse time (`parseImport`, see
[app/import-collections/README.md](app/import-collections/README.md)).

### 2. Request Execution

**Process**:
1. User clicks "Send" in the UI
2. Frontend resolves variables using the selected environment
3. Resolved request is sent to `/execute` endpoint
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

### 4. Saved Example Responses (Database)

**Location**: `request_examples` table
**Format**: One stored response per row, owned by a request

Separate from execution history, and deliberately so: a `results` row records a
response that *happened* and is pruned with its run, while an example is a
response the request *documents* and lives as long as the request does. Examples
are what an importer found next to a request - Postman's saved responses, an
OpenAPI operation's documented ones - which every parser used to drop, because
there was nowhere to keep them (issue #481).

```json
{
  "id": "exa_123",
  "requestId": "req_123",
  "name": "200 - A user",
  "status": 200,
  "headers": [{ "key": "Content-Type", "value": "application/json", "enabled": true }],
  "body": "{\"id\":1}",
  "contentType": "application/json",
  "order": 0
}
```

Unlike a request definition, an example is stored **verbatim**: no `{{variable}}`
resolution happens on the way in or out, because it records what a server
answered rather than what a client should send. `order` is part of the contract -
a mock server serves the first example of a matched request.

Reached through `GET /requests/:id/examples`, written today only by import
(nested on the request item of `POST /import/apply`, so the whole tree lands in
one transaction), and shown read-only in the request builder's **Examples** tab.
Deleting the request - or the collection above it - takes its examples with it,
in the sense the next section describes: they stay on the row while the request
is in the trash, unreachable because every read of them checks the owner first,
and a purge removes them in the same transaction as the request.

### 5. The deletion lifecycle (issue #988)

**Deleting a collection or a request does not remove it.** `DELETE
/collections/:id` and `DELETE /requests/:id` stamp `deleted_at` on the row - and,
for a collection, on its whole subtree in one transaction - and every read
surface filters stamped rows out. To the sidebar, an export, an MCP tool or a
scenario plan, the row is gone; only `GET /trash` can still see it.

A row leaves that state one of three ways:

| | What happens |
|---|---|
| `POST /trash/:id/restore` | The stamp is cleared and the row is back exactly as it was - `order`, `parent_id` and every field untouched. |
| `DELETE /trash/:id` | The old hard cascade: the subtree, its requests and their examples are removed for good. |
| Retention | The same purge, run at startup for anything deleted more than `trashRetentionDays` ago (default 30; `0` keeps the trash forever). |

Two rules make a restore mean something precise:

- **The cohort.** One delete stamps its subtree with one timestamp, and a
  restore clears exactly the rows carrying the timestamp of the row it was
  given. A request the user deleted separately *before* its collection keeps its
  own stamp, so restoring the collection leaves it in the trash - as a trash
  root of its own, now that its collection is live again.
- **Re-parenting.** A restored collection whose parent is gone or itself deleted
  comes back at the tree root. A request cannot do this - `collection_id` is
  required - so restoring one whose collection is in the trash is refused with a
  `409` that names the collection to restore first.

A purge is deliberately *not* limited to the cohort: it takes the whole subtree,
because a request left under a removed collection would be reachable by no read
and restorable by nothing.

One thing a soft delete deliberately does not release: a stamped collection
still binds its OpenAPI document, so the orphan sweep leaves that document alone
until the collection is purged. Reclaiming it earlier would restore a binding
that points at nothing.

**One delete path stays hard, by decision** (issue #1046): the requests a
`POST /specs/sync` removes because the re-fetched document no longer declares
their operation. A sync is a reconciliation to a document rather than a person
removing a request, and it is the one delete whose removals are shown before
they happen - `POST /specs/diff` reports every one, the app renders them as
ticks the user can untick, and `policy: "safe"` declines deletions altogether.
Stamping them instead would fill the Trash with operations a document dropped,
where restoring one puts back a request the current document cannot explain. A
caller that wants those rows recoverable leaves them out of the sync payload and
deletes them with `DELETE /requests/:id`, which is soft like every other delete
a person makes.

### 6. Response Viewer

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
