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
run, load run - sends its query verbatim, and no engine path reads the query
rows of `params[]` (they are builder display state, see
[engine/api-reference.md](engine/api-reference.md)). The Params table maintains
the invariant on the app's side by rewriting `url` on every edit, keeping
disabled rows in `params[]` only.

A **path row** (`"in": "path"`, issue #1764) is the one row the engine reads:
`url` keeps the `:name` segment verbatim and composition writes the row's value
into it at send time (see
[engine/api-reference.md](engine/api-reference.md#path-variables)). A path row
never joins the query.

The URL bar keeps the same invariant the other way: typing into it **merges**
the parsed query into `params[]` rather than replacing the list, so a disabled
row (invisible in the query by design) survives, and a key removed from the URL
is removed from `params[]` too, rather than left behind as a row the URL no
longer carries (`mergeParamsFromUrl`, issue #1482).

**Query rows hold the query as the URL spells it** (issue #1771), which is
Postman's own row model: `?q=a%20b` is the row `a%20b`, never decoded, in
either encoding mode. Decoding is not reversible - `%2B` would come back as a
`+` a server reads as a space, and `%2541` as `%41` - and because the query
encoding never encodes `%`, a raw row written back is the pair it came from.

A row is written into `url` with Postman's query rule (`postman-url-encoder`'s
`QUERY_ENCODE_SET` plus `unparseSingle`'s additions): space, `"`, `#`, `'`,
`<`, `>`, controls and non-ASCII (per UTF-8 byte) become `%XX`, `&` does in
both key and value, and `=` only in a key. Everything else, `+`, `|`, `%` and
`%XX` included, goes out as typed, and a whole `{{variable}}` token is kept.
`disableUrlEncoding` writes rows as typed. The app's
`encodeQueryComponent` (`modules/request-builder/utils/query-encoding.ts`) and
the engine's `encode_query_component` are pinned to one another by
`engine/tests/fixtures/query-encoding-conformance.json`. A row with an empty
value is written as a bare `key` where Postman writes `key=` (issue #1772), and
the value a stored `{{variable}}` token resolves to at send time, and a pair a
script's `query.add` writes, are encoded by the same rule when they land in the
query (issue #1773).

**A Params table edit rewrites only the pairs it touches.** Each enabled row
takes the first unused pair of the current `url` with the same key and value
as written, and keeps that pair's bytes; then a row carried over unchanged from
before the edit (same id, key and value) may take a pair that percent-decodes
to it, which is the case an older version's decoded row needs. An edited or new
row is never matched decoded - `+` typed over `%2B` is written `+` - and a row
with no pair is encoded. The query ends at the fragment, which is put back
after the rebuilt query. So a pair written by another rule - a row an
older version stored decoded (`+05:00` for `%2B05%3A00`), an Insomnia, JMeter
or OpenAPI import's `encodeURIComponent` join, a Postman `key=` - survives an
edit of another row. Nothing re-encodes a stored `url`: it is sent verbatim,
and an import writes it once.

**Path variables are the one kind of row the engine reads** (issue #1764). A
row with `"in": "path"` names a `:name` segment the URL keeps verbatim (`key`
without the colon), and never reaches the query: the query builders skip it,
and at compose time the engine puts the value of the last enabled row with
that key into its segment, `{{variable}}`-resolved and then percent-encoded
with Postman's path encode set (space, `"`, `<`, `>`, `` ` ``, `#`, `?`, `{`,
`}`, controls and non-ASCII; a `/` in a value makes more segments, as it does
in Postman); an empty value or no enabled row leaves `:name` literal. An inline
`POST /compose` always carries the editor's path rows as `request.params`
(`[]` when there are none), since the editor may be ahead of the saved row and
an absent key falls back to the stored rows. A row keeps every member it
arrived with (`type`, `description` from a Postman import) through edits. The URL bar keeps the rows in step with
the segments, but only on an edit that changes them: a query-only edit leaves
every path row alone (a declared row no segment uses included), and a segment
renamed on its own keeps its row's value (`syncPathRows` in
`modules/request-builder/utils/path-variables.ts`). A `:name` with no stored
row is not given one until its value is edited: the Params tab shows an empty
row for it (`displayPathRows`), so opening a request does not change it, and
an import stores only the rows the source declares.

A writer that stores the query *only* in `params[]` therefore stores a request
that sends nothing of it. That was issue #590: every importer split the query
out of the URL, so an imported request dropped its query on every send until the
user happened to edit the Params table once. Imports now restore the invariant at
parse time (`parseImport`, see
[app/import-collections/README.md](app/import-collections/README.md)).

#### An empty body keeps its mode

A content-based body (`json`, `text`, `graphql`, `jsonrpc`, `xml`) is stored as
`{ "mode": "<mode>", "content": "<string>" }`, and an empty `content` is still a
body of that mode - clearing the editor to retype it is not the same action as
picking **None**. The save path tests `bodyMode` alone rather than falling back
to `mode: "none"` when the content is an empty (falsy) string, which used to
collapse a cleared JSON/text/XML/GraphQL/JSON-RPC body to `none` on save (issue
#1490) while the mode selector kept showing the old mode until the next reload.

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
