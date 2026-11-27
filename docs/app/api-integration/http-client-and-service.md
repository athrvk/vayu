---
description: >-
  The renderer's HTTP client and the API service over it: errors, the snake_case to camelCase transformation and the request-body shapes.
---

# HTTP client and API service

## HTTP Client (`services/http-client.ts`)

Low-level fetch wrapper with error handling and timeout management.

### Features

- **Base URL Configuration**: `ENGINE_BASE_URL` (`config/network.ts`), re-exported as `API_ENDPOINTS.BASE_URL` by `config/api-endpoints.ts`.
  `http://127.0.0.1:9876` unless the app fell back to another port
- **Request Timeout**: 30 seconds default
- **Error Transformation**: Converts HTTP errors to `ApiError` with user-friendly messages
- **Query Parameters**: Automatic URL encoding
- **JSON Serialization**: Automatic request/response JSON handling
- **No Caching**: every request passes `cache: "no-store"`, matching the engine's own `Cache-Control: no-store` on every response (#1507) - nothing the engine answers is valid to replay from Chromium's disk cache

### Error Handling

```typescript
class ApiError extends Error {
  statusCode: number
  errorCode: string
  userFriendlyMessage: string
  response?: any
}
```

Every engine error body is `{"error": {"code", "message"}}`, so `message` is the engine's own text (a validation reason, a not-found) and `errorCode` is its `code` - per-status (`bad_request`, `not_found`, ...) unless the route names a more specific one.
Two fallbacks sit behind that, and both matter: a body in the **legacy flat** shape (`{"error": "..."}`, which a pre-#173 engine sends and the sidecar's version can lag the app's) still yields its string as the message, and a body carrying neither falls back to `HTTP <status>: <statusText>`.
`response` keeps the raw body, which is where per-error detail lives - `error.item` on a failed bulk import, the provider fields on `/oauth2`.
See [the engine's error contract](../../engine/api-reference/index.md).

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
  elements: []
}
```

**Backend Format (camelCase):**
```typescript
{
  collectionId: "col_123"
  createdAt: 1704067200000
  elements: []
}
```

#### Request bodies

`body` goes to the engine as the discriminated union `{ mode, content }` or - for the two form modes - `{ mode, fields }`, built by `buildExecBody` (`modules/request-builder/utils/execute-mapping.ts`) and passed through untransformed.
The mode strings are a contract: the engine matches `"form-data"` and `"x-www-form-urlencoded"` exactly and reads the content out of `fields`, so a renamed mode or a flattened `content` string sends an empty body rather than failing.
Disabled rows are sent and dropped engine-side, and the engine writes the Content-Type each mode implies when the request declares none: `application/json` for `json`, `graphql`, `jsonrpc` and `mcp`, `application/xml` for `xml`, `text/plain` for `text`, the form type for each form mode and the file's own type for `binary`.
A bodyless POST goes out with no Content-Type at all, where libcurl would write `application/x-www-form-urlencoded` (issue #2464).
A `form-data` row may be a **file part** (`{type: "file", src, fileName?, contentType?}`): the renderer sends the path the user picked - never the bytes - and the engine opens the file at send time.
A text part may carry just `contentType`, the type it declares for itself (a Postman import keeps one, #2539, and the form-data editor's Content type column sets it by hand, #3022); the renderer sends it, resolved like the file members, and a part without it sends none.
A **`binary`** body is one file as the whole body, `{mode: "binary", file: {src, fileName?, contentType?}}`, built from `RequestState.binaryFile`; it is sent even with an empty `src`, so the engine can refuse it as "no file selected" rather than send a bodiless request.

An **`mcp`** body (#3762) is `{mode: "mcp", content, mcpTool?}`, where `mcpTool` is `{name, inputSchema?, outputSchema?}` from `RequestState.mcpTool`: the tool a `tools/call` names, which the engine reads for the `Mcp-Param-*` headers it mirrors out of the call's arguments.
It is stored **inside the body object**, so a `PUT` that sends `body` replaces it whole and a body sent without `mcpTool` clears the stored one: `toBodyPayload` writes the key whenever a tool is set, and the builder's save sends `body` when `mcpTool` was touched.
`index.tsx`'s load reads it back for an `mcp` body only, and `buildExecBody` sends it unresolved beside the resolved `content`.
The renderer does not derive the headers or the `params._meta` block: the engine writes `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` for every client and reports them in the response's `requestHeaders` / `requestHeaderLines`, which the Body panel points to.
A run's stored snapshot carries the body's content and not its tool, so a History copy and Save to request take the saved request's tool instead.
The engine refuses a tool with a blank `name` or a non-object `inputSchema` with a 400, which is why the fields commit only a tool it would accept.

The tool may also carry `outputSchema` (#3806), the schema a server's `tools/list` states for the tool's `structuredContent`.
The engine stores it with the body and reads nothing of it; the renderer reads it.
The Body panel has an **Output schema** editor beside the input one (the same commit rule: an object, and a name beside it), and a tool kept in `mcpTool` survives an edit of either schema.
**Adding an `assert.jsonschema` element to a request in `mcp` mode whose tool has an `outputSchema` starts it as `{source: "jsonpath", path: "$.result.structuredContent", schema: <outputSchema>}`** (`startingElementConfigs` via `ElementList`'s `startingConfigs`):
the copy is written into the element's `config` at add time, never re-derived from the tool, so a later edit of the tool leaves the stored assertion as it was.
Any other body, or a tool with no `outputSchema`, starts the element blank.
The MCP server import fills `mcpTool` from a live `tools/list`, `outputSchema` included when it is an object ([`POST /import/mcp`](../../engine/api-reference/import.md#post-importmcp)); the import payload carries `body` whole, so the tool reaches the engine as the tree held it.

The `assert.jsonschema` element itself is the engine's (`docs/engine/elements.md`): `source` is `body` or `jsonpath` (with a `path`, which is refused beside `body`), `schema` is an object or a boolean, and a keyword the draft-07 validator does not evaluate fails the assertion naming it.
Its failures arrive in the response's Elements section as any other `assert.*` outcome does.
The builder offers it in the Assert group, with a multi-line schema field; see the Shared ElementList section of `COMPONENTS/shared-element-list.md`.

**`assert.snapshot` (#3807)** holds the items a list method answers to a recorded `baseline`: `method` is `tools/list` (default), `resources/list` or `prompts/list`, `baseline` is the array the list held, and a single-request run's `requestElements` accepts it.
The renderer sends it as any element (`config: {method?, baseline}`) and offers it in the Assert group with a multi-line baseline field.
Its one app-side behaviour is the **Use the current reply as the baseline** action on the Elements tab: it extracts `result.<tools|resources|prompts>` from the Response pane's body (a JSON-RPC object or an event stream ending in one) and writes the list into the element's `config.baseline`; the engine is not called.
A comparison that fails arrives as one `assert.snapshot` outcome message (`tools/list changed: removed 'a'; added 'b'; 'c' differs at /inputSchema/...`).
The engine's rules are in `docs/engine/elements.md`.

**`unresolved` comes back, never goes out** (#2356).
The engine sends a file reference only when its path was picked on this machine or lies under a folder allowed in Settings > Files ([allowed folders](methods-local.md#allowed-folders)), and decides that from its own records:
on every read that hands a body to an editor it writes `unresolved` on each file reference with a path (`true`: it would refuse it), and on every write and send it ignores the key.
So the renderer keeps the derived value for display - `RequestTransformer` and the History run seed leave it as read - and strips it from everything it sends, through `lib/file-trust.ts`: the send (`buildExecBody`), the save (`toBodyPayload`, which a pasted command's new request uses too), History's Save to request and a Duplicate.
A pick or a drop in the editor is the grant itself (the preload reports the path to the main process, which records it), so it sets `unresolved: false` locally until the next read; a typed or pasted path carries no flag and reads as not chosen until the engine answers for it.
An import's `POST /import/apply` payload echoes the parse answer's flag unchanged, because it is pinned to the engine's own apply mapping (`orchestrator.payload-conformance.test.ts`); the engine drops it there too.
A refused file comes back as a send failure (status 0, the engine's message naming the field or "Body file", the path and what to do), which the response pane's `ClientErrorView` prints as-is under "Couldn't send the request".
See [the engine's `body` union](../../engine/api-reference/request-body.md#the-request-body-union) for the full contract.
