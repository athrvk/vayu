# PRD: Data Model Refactor

**Status:** Design  
**Scope:** Tier 0+1+2 (storage fixes + inheritance), no workspaces  
**Migration policy:** Breaking change, no backward compatibility (pre-release product, no users)

## 1. Motivation

Vayu's storage layer is silently losing user-entered data and forcing every import format to flatten richer source models into a poorer destination model. The frontend already models headers, params, and form-data fields as `KeyValueItem[]` with per-row `enabled` and `description` — but the storage layer collapses these into `Record<string, string>`, dropping disabled rows, duplicate keys, and descriptions. Reload the app and the user discovers their work is gone.

This refactor aligns the storage layer with what the UI already models, and adds three composition concepts (auth inheritance, folder-level scripts, hierarchical variables) that are standard in Postman and Insomnia and that several entries in the [Import Format Mappings](./import-format-mappings.md) document are forced to flatten because Vayu can't represent them.

## 2. Goals

1. **No silent data loss** for any field the UI already exposes. Toggle a header off → it stays off across reloads. Add duplicate `Accept` headers → both persist.
2. **Hierarchical composition** — auth, scripts, and variables defined at a parent collection apply to descendants without manual propagation.
3. **Eliminate ~70% of documented import compromises** by raising the floor of the data model rather than weakening parsers.
4. **No new engine execution logic.** All composition happens client-side as a pre-send step. The engine receives flat resolved values, same as today.
5. **Schema clarity over backward compatibility.** This is a pre-release product; users have no data to preserve. The DB file is wiped on upgrade.

## 3. Non-Goals

- Workspaces (deferred — see "Future Work")
- Saved response examples / Postman Examples-tab equivalent
- Tags or labels on requests
- Per-collection default environment binding
- Drag-and-drop reordering UI (the `order` column is added to unblock it, but the UI is a separate effort)
- URL stored as a structured object (host/path/query as separate columns)
- Request-level config overrides (timeout, follow_redirects per request)
- Migration infrastructure (`schema_migrations` table, numbered migration scripts). Not needed under nuke policy. Will be added before first public release.

## 4. Current State (Concise)

| Field | Engine DB | Engine wire (API) | Frontend state | Wire→state conversion |
|---|---|---|---|---|
| headers | JSON `Record<string,string>` | `Record<string,string>` | `KeyValueItem[]` with `enabled`, `description` | **Lossy:** disabled rows + descriptions dropped via `keyValueToRecord()` |
| params | JSON `Record<string,string>` | Baked into URL by frontend | `KeyValueItem[]` | Same loss; also no engine-side parse |
| body | JSON string | `{mode, content}` object | `bodyMode` + `body` string + `formData[]` + `urlEncoded[]` | `formData`/`urlEncoded` arrays serialized into flat string on save |
| auth | JSON opaque blob | JSON object | `authType: AuthType` + `authConfig: Record<string,any>` | Lossless |
| description | **No column** | Not in wire format | Used in UI for editing | Permanent loss on save |
| collection.parent_id | optional string | `parentId` | Used for tree rendering | Lossless |
| collection.variables | JSON `Record<string, VariableValue>` | same | `Record<string, VariableValue>` | Lossless; **no inheritance from parent collection** |
| collection auth/scripts | **No columns** | Not in API | No UI | N/A |
| request.order | **No column** | N/A | N/A | Requests are unordered |
| environment.variables | JSON `Record<string, VariableValue>` | same | same | Lossless; no `type` field |

**Variable resolution:** frontend-only for the HTTP request payload. Engine scripts have separate access to raw variable objects via `pm.environment` / `pm.globals` / `pm.collectionVariables`.

**Cascade delete:** `delete_collection` removes a collection's direct requests but **does not** remove child collections — they become orphans pointing at a non-existent `parent_id`.

## 5. New Data Model

### 5.1 Engine — DB Schema

#### `collections` table

```
id              TEXT PRIMARY KEY
parent_id       TEXT NULL                  -- unchanged
name            TEXT NOT NULL              -- unchanged
description     TEXT NOT NULL DEFAULT ''   -- NEW
variables       TEXT NOT NULL DEFAULT '{}' -- unchanged shape; values get `type` field
auth            TEXT NOT NULL DEFAULT '{}' -- NEW; see Auth section
pre_request_script  TEXT NOT NULL DEFAULT ''  -- NEW
post_request_script TEXT NOT NULL DEFAULT ''  -- NEW
"order"         INTEGER NOT NULL DEFAULT 0 -- unchanged
created_at      INTEGER NOT NULL
updated_at      INTEGER NOT NULL
```

#### `requests` table

```
id              TEXT PRIMARY KEY
collection_id   TEXT NOT NULL              -- unchanged
name            TEXT NOT NULL              -- unchanged
description     TEXT NOT NULL DEFAULT ''   -- NEW
method          TEXT NOT NULL              -- unchanged
url             TEXT NOT NULL              -- unchanged
params          TEXT NOT NULL DEFAULT '[]' -- CHANGED: array, not Record
headers         TEXT NOT NULL DEFAULT '[]' -- CHANGED: array, not Record
body            TEXT NOT NULL DEFAULT '{}' -- CHANGED: structured object, see Body section
body_type       TEXT NOT NULL DEFAULT 'none' -- unchanged
auth            TEXT NOT NULL DEFAULT '{}' -- unchanged shape (already structured)
pre_request_script  TEXT NOT NULL DEFAULT ''  -- unchanged
post_request_script TEXT NOT NULL DEFAULT ''  -- unchanged
"order"         INTEGER NOT NULL DEFAULT 0 -- NEW
created_at      INTEGER NOT NULL
updated_at      INTEGER NOT NULL
```

#### `environments` table

```
id              TEXT PRIMARY KEY
name            TEXT NOT NULL              -- unchanged
description     TEXT NOT NULL DEFAULT ''   -- NEW
variables       TEXT NOT NULL DEFAULT '{}' -- unchanged shape; values get `type` field
is_active       INTEGER NOT NULL DEFAULT 0 -- unchanged
created_at      INTEGER NOT NULL
updated_at      INTEGER NOT NULL
```

#### `globals` table

```
id              TEXT PRIMARY KEY  -- always 'globals'
variables       TEXT NOT NULL     -- unchanged shape; values get `type` field
updated_at      INTEGER NOT NULL
```

### 5.2 Field-Level Schemas (JSON contents)

#### Headers / Params — array of entries

```typescript
type KeyValueEntry = {
  key: string;
  value: string;
  enabled: boolean;            // false = preserved but excluded at execution
  description?: string;        // optional per-row note
};

// Stored as JSON in headers/params columns:
// [{"key":"Accept","value":"application/json","enabled":true},
//  {"key":"Accept","value":"text/html","enabled":false,"description":"alt format"}]
```

Order in the array is the user-facing order. Duplicates are allowed at any key. Disabled entries are dropped only at HTTP-execution time, not at storage time.

#### Body — discriminated by mode

```typescript
type RequestBody =
  | { mode: 'none' }
  | { mode: 'json'; content: string }
  | { mode: 'text'; content: string }
  | { mode: 'graphql'; content: string }            // JSON-stringified {query, variables}
  | { mode: 'form-data'; fields: KeyValueEntry[] }
  | { mode: 'x-www-form-urlencoded'; fields: KeyValueEntry[] };
```

`body_type` column remains as a denormalized convenience (matches `body.mode`); enables querying without JSON parsing.

#### Auth — uniform across requests and collections

```typescript
type RequestAuth =
  | { mode: 'none' }
  | { mode: 'inherit' }                              // only valid on requests, never on collections
  | { mode: 'bearer'; token: string }
  | { mode: 'basic'; username: string; password: string }
  | { mode: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | { mode: 'oauth2'; config: Record<string, unknown> }  // opaque, stored not executed
  | { mode: 'digest' | 'aws' | 'ntlm'; config: Record<string, unknown> };  // same
```

- A request's `auth.mode === 'inherit'` triggers a parent-chain walk at execution time.
- A collection's `auth.mode` can be any value **except** `'inherit'` (collections have no parent auth to inherit from in the request sense — they're the source).
- A collection with `auth.mode === 'none'` is explicit: descendants that inherit will resolve to no auth.

#### Variables (typed)

```typescript
type VariableValue = {
  value: string;
  enabled: boolean;
  secret?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'json';  // default 'string'
};
```

The `value` is always stored as a string regardless of `type`. The `type` field hints UI rendering (number input vs. text), validation, and how scripts cast the value when reading via `pm.environment.get(...)`.

### 5.3 Wire Format (HTTP API)

The HTTP API mirrors storage. The engine no longer transforms headers/params shape on read or write — it stores and returns the same JSON.

**`POST /requests`** (create or update):

```json
{
  "id": "req_optional",
  "collectionId": "col_xxx",
  "name": "List Users",
  "description": "Returns paginated user list",
  "method": "GET",
  "url": "{{baseUrl}}/users",
  "params": [
    { "key": "page", "value": "1", "enabled": true },
    { "key": "limit", "value": "20", "enabled": true, "description": "max 100" }
  ],
  "headers": [
    { "key": "Accept", "value": "application/json", "enabled": true }
  ],
  "body": { "mode": "none" },
  "bodyType": "none",
  "auth": { "mode": "inherit" },
  "preRequestScript": "",
  "postRequestScript": "pm.test('status 200', () => pm.response.to.have.status(200));",
  "order": 0
}
```

**`POST /collections`** (create or update):

```json
{
  "id": "col_optional",
  "name": "Users API",
  "description": "User management endpoints",
  "parentId": null,
  "order": 0,
  "variables": {
    "baseUrl": { "value": "https://api.example.com", "enabled": true, "type": "string" }
  },
  "auth": { "mode": "bearer", "token": "{{authToken}}" },
  "preRequestScript": "// runs before every request in this collection",
  "postRequestScript": ""
}
```

**Cascade delete:** `DELETE /collections/:id` now removes the collection's direct requests AND recursively removes child collections and their requests, depth-first.

### 5.4 Frontend Types

`/home/user/vayu/app/src/types/domain.ts`:

```typescript
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type BodyMode = 'none' | 'json' | 'text' | 'graphql' | 'form-data' | 'x-www-form-urlencoded';

export type AuthMode = 'none' | 'inherit' | 'bearer' | 'basic' | 'apikey' | 'oauth2' | 'digest' | 'aws' | 'ntlm';

export interface KeyValueEntry {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

export interface VariableValue {
  value: string;
  enabled: boolean;
  secret?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'json';
  createdAt?: number;
}

export type RequestBody =
  | { mode: 'none' }
  | { mode: 'json' | 'text' | 'graphql'; content: string }
  | { mode: 'form-data' | 'x-www-form-urlencoded'; fields: KeyValueEntry[] };

export type RequestAuth =
  | { mode: 'none' | 'inherit' }
  | { mode: 'bearer'; token: string }
  | { mode: 'basic'; username: string; password: string }
  | { mode: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | { mode: 'oauth2' | 'digest' | 'aws' | 'ntlm'; config: Record<string, unknown> };

export interface Collection {
  id: string;
  parentId?: string;
  name: string;
  description?: string;
  order: number;
  variables: Record<string, VariableValue>;
  auth: Exclude<RequestAuth, { mode: 'inherit' }>;
  preRequestScript: string;
  postRequestScript: string;
  createdAt: string;
  updatedAt: string;
}

export interface Request {
  id: string;
  collectionId: string;
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  params: KeyValueEntry[];
  headers: KeyValueEntry[];
  body: RequestBody;
  bodyType: BodyMode;          // denormalized, equals body.mode
  auth: RequestAuth;
  preRequestScript: string;
  postRequestScript: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Environment {
  id: string;
  name: string;
  description?: string;
  variables: Record<string, VariableValue>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

**The `KeyValueItem` UI-state type in `app/src/modules/request-builder/types.ts` becomes redundant.** It collapses into `KeyValueEntry` (the storage type already has `enabled` and `description`; the `id` field in UI-state was only needed for React `key` props and can be added as an ephemeral `_id` symbol or derived from array index in editor components).

### 5.5 Variable Resolution — Hierarchical Walk

`/home/user/vayu/app/src/hooks/useVariableResolver.ts`:

Replace the current flat merge with a parent-chain walk for collection variables:

```typescript
// pseudocode
function buildVariableMap(requestId, environmentId): Map<string, ResolvedVariable> {
  const map = new Map();

  // 1. Globals (lowest priority)
  for (const [k, v] of globals.entries()) {
    if (v.enabled) map.set(k, { value: castByType(v), scope: 'global', secret: v.secret });
  }

  // 2. Collection chain — walk from root to leaf, child overrides parent
  const collectionChain = walkUpToRoot(request.collectionId);  // [root, ..., direct parent]
  for (const collection of collectionChain) {
    for (const [k, v] of Object.entries(collection.variables)) {
      if (v.enabled) map.set(k, { value: castByType(v), scope: 'collection', secret: v.secret });
    }
  }

  // 3. Environment (highest priority)
  if (environmentId) {
    for (const [k, v] of Object.entries(env.variables)) {
      if (v.enabled) map.set(k, { value: castByType(v), scope: 'environment', secret: v.secret });
    }
  }

  return map;
}
```

`walkUpToRoot` traverses `parentId` from the request's direct collection up to the root, returning the array in **root-first** order. Variables defined closer to the leaf override variables defined closer to the root.

### 5.6 Auth Composition

A request with `auth.mode === 'inherit'`:

1. Frontend walks `parentId` chain from the request's direct collection upward.
2. First collection whose `auth.mode !== 'none'` wins. Its auth is applied.
3. If the entire chain has `auth.mode === 'none'`, no auth is applied.

A request with any other `auth.mode` value uses its own auth and ignores the chain.

This resolution happens in `useEngine.ts` immediately before constructing the execution payload. The engine receives a fully resolved auth blob, never `'inherit'`.

### 5.7 Script Composition

For each execution, the frontend composes the final `preRequestScript` and `postRequestScript` strings:

```
preRequestScript = [
  rootCollection.preRequestScript,
  ...intermediateCollections.map(c => c.preRequestScript),
  directParent.preRequestScript,
  request.preRequestScript,
].filter(nonEmpty).join('\n\n// ─── scope boundary ─── \n\n');

postRequestScript = [
  request.postRequestScript,
  directParent.postRequestScript,
  ...intermediateCollections.reverse().map(c => c.postRequestScript),
  rootCollection.postRequestScript,
].filter(nonEmpty).join('\n\n// ─── scope boundary ─── \n\n');
```

Pre-request scripts run **outer-first** (root → leaf → request) so child scripts see state set by parents. Post-request scripts run **inner-first** (request → leaf → root) so they tear down in reverse order. This matches Postman's behavior.

Concatenation is done client-side; the engine receives a single combined script for each phase.

### 5.8 Cascade Delete

`/home/user/vayu/engine/src/db/database.cpp` — `delete_collection`:

```cpp
void Database::delete_collection(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);

    // 1. Find all descendant collection IDs recursively
    std::vector<std::string> to_delete = {id};
    size_t idx = 0;
    while (idx < to_delete.size()) {
        auto children = impl_->storage.get_all<Collection>(
            where(c(&Collection::parent_id) == to_delete[idx])
        );
        for (const auto& child : children) to_delete.push_back(child.id);
        idx++;
    }

    // 2. Delete in reverse-discovery order (deepest first)
    for (auto it = to_delete.rbegin(); it != to_delete.rend(); ++it) {
        impl_->storage.remove_all<Request>(where(c(&Request::collection_id) == *it));
        impl_->storage.remove_all<Collection>(where(c(&Collection::id) == *it));
    }
}
```

## 6. Implementation Phases

### Phase 1 — Engine schema + API (no UI changes)

1. **DB struct changes** in `engine/include/vayu/types.hpp`:
   - Add `description`, `auth`, `pre_request_script`, `post_request_script` to `db::Collection`
   - Add `description`, `order` to `db::Request`
   - Add `description` to `db::Environment`
2. **Schema definition** in `engine/src/db/database.cpp` — update `make_table()` calls.
3. **JSON (de)serialization** in `engine/src/utils/json.cpp` — update `serialize`/`deserialize` for new fields.
4. **Cascade delete** in `database.cpp::delete_collection`.
5. **Routes** in `engine/src/http/routes/collections.cpp` and `requests.cpp` — accept and persist new fields. The engine **does not** validate `params`/`headers` array shape — it stores the JSON verbatim (same way it currently stores opaque `auth` JSON).
6. **Drop the DB file** on engine startup if it exists (single-shot nuke). Optionally guarded by a build flag so dev environments can be rebuilt fresh.

### Phase 2 — Frontend types + storage layer

1. **`types/domain.ts`** — replace types per section 5.4.
2. **`types/api.ts`** — update `CreateRequestRequest`, `UpdateRequestRequest`, `CreateCollectionRequest` shapes.
3. **`services/transformers/`** — remove `keyValueToRecord` calls; transformers now pass through `params`/`headers` as arrays.
4. **`services/api.ts`** — type updates only; HTTP shape mirrors storage.
5. **Default values** — `Request.body` defaults to `{ mode: 'none' }`, `Request.auth` defaults to `{ mode: 'inherit' }`, collection auth defaults to `{ mode: 'none' }`.

### Phase 3 — Frontend composition layer

1. **`hooks/useVariableResolver.ts`** — implement parent-chain walk per section 5.5.
2. **`hooks/useEngine.ts`** — before executing, compose auth (resolve `inherit`) and scripts (concatenate chain). Pass composed values to the engine.
3. **`queries/collections.ts`** — add a helper `useCollectionAncestors(collectionId)` that returns the chain (root → leaf) so resolution can use the TanStack Query cache.

### Phase 4 — UI updates

1. **Request builder** — header/param editor reads/writes `KeyValueEntry[]` directly; remove the dual-type dance (`KeyValueItem` UI state vs `Record<string,string>` storage). The editor already supports the richer shape; the conversion functions just go away.
2. **Collection editor** — new sections for description, auth, pre/post scripts. New routes (e.g., `/collections/:id/settings`).
3. **Auth picker** — add `'inherit'` as an option on request-level auth selector. Display resolved auth inline ("Inheriting Bearer from 'Users API' collection").
4. **Variables editor** — add `type` selector dropdown next to each variable. Inputs become typed (number input for `type: 'number'`).
5. **Order field on requests** — no UI yet; just respect it for sorting in the collection tree.

### Phase 5 — Update import PRD

1. Revise `import-format-mappings.md` — remove eliminated compromises from the tables.
2. Update parser implementations (when we build them) to use the new types directly. Postman folder-level auth/scripts now map cleanly; Insomnia disabled entries preserved; descriptions round-trip.

## 7. Detailed File Impact Map

### Engine

| File | Change |
|---|---|
| `engine/include/vayu/types.hpp` | Add fields to `db::Collection`, `db::Request`, `db::Environment` |
| `engine/src/db/database.cpp` | Update schema in `make_storage()`; rewrite `delete_collection` for cascade |
| `engine/src/utils/json.cpp` | Add (de)serialization for new fields |
| `engine/src/http/routes/collections.cpp` | Accept/return new fields in POST `/collections` |
| `engine/src/http/routes/requests.cpp` | Accept/return new fields in POST `/requests`; new `order` handling |
| `engine/src/http/routes/environments.cpp` | Accept/return `description` |
| `engine/src/daemon.cpp` (or wherever DB init lives) | One-shot nuke: delete DB file on startup if old schema detected |
| `engine/tests/` | New unit tests for cascade delete, new field round-trips |

### Frontend

| File | Change |
|---|---|
| `app/src/types/domain.ts` | Replace all types per section 5.4 |
| `app/src/types/api.ts` | Update request/response shapes |
| `app/src/services/transformers/collection-transformer.ts` | Pass through new fields; no `keyValueToRecord` |
| `app/src/services/transformers/request-transformer.ts` | Same |
| `app/src/services/api.ts` | Type updates only |
| `app/src/hooks/useVariableResolver.ts` | Parent-chain walk; type-aware casting |
| `app/src/hooks/useEngine.ts` | Compose auth + scripts before sending |
| `app/src/queries/collections.ts` | Add ancestor helper |
| `app/src/modules/request-builder/types.ts` | Delete `KeyValueItem`; use `KeyValueEntry` from domain |
| `app/src/modules/request-builder/utils/key-value.ts` | **Delete** `keyValueToRecord` and `recordToKeyValue` |
| `app/src/modules/request-builder/shared/KeyValueEditor/` | Bind directly to `KeyValueEntry[]` |
| `app/src/modules/request-builder/components/RequestTabs/panels/AuthPanel.tsx` | Add `'inherit'` mode; show resolved-from indicator |
| `app/src/modules/request-builder/components/RequestTabs/panels/ParamsPanel.tsx` | Remove `buildUrlWithParams`; engine no longer needs URL-baked params (or keep as resolver step) |
| `app/src/modules/variables/` | Add `type` dropdown per variable; typed inputs |
| `app/src/modules/collections/` (new files) | Collection settings view: description, auth, scripts editors |

## 8. Open Questions

1. **`params` execution path.** Currently, the frontend bakes query params into the URL string before sending. Should we keep doing that, or send `params` separately and let the engine append them? Sending separately would enable engine-side scripts to mutate `pm.request.params` and have it affect the final URL. Recommendation: **send separately**, append in engine. This is a small engine change but architecturally cleaner.

2. **Script scope boundary comments.** Inserting `// ─── scope boundary ───` between concatenated scripts is helpful for stack traces but is just a string. Should we use sourcemap-style metadata so errors can be attributed to the correct collection? Recommendation: defer — concat with comments is fine for V1.

3. **`auth.mode === 'inherit'` for collections?** I propose collections cannot inherit (they're the source). Alternative: collections can also inherit from their parent collection. Recommendation: keep collections non-inheriting in V1; revisit if real workflows demand it.

4. **`variables` `type: 'json'` semantics.** Should JSON-typed variables be auto-parsed when interpolated into a JSON request body (so `{{user}}` → `{"id":1}` not `"{\"id\":1}"`)? Recommendation: yes, but only when the surrounding context is JSON. Track as a follow-up; initial implementation treats it as string.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Wire format change breaks any external scripts/integrations | None exist; pre-release |
| Cascade delete becomes accidentally destructive | Add UI confirmation dialog ("Delete 'Users API' and 18 child items?") |
| Script concatenation produces hard-to-debug errors | Scope-boundary comments + future sourcemap work |
| Hierarchical variable walk is slow for deep trees | Cache the merged var map per request; invalidate on parent collection edit |
| Engine accepts arbitrary JSON in `params`/`headers` without validation | Add lightweight schema check; reject if not array of `{key, value, enabled}` |
| Frontend `KeyValueEntry` array order matters for execution but is fragile | Use stable array indices; preserve order on save |

## 10. Future Work (Explicitly Deferred)

- **Workspaces** — top-level grouping above collections
- **Saved examples** — `examples` table linked to requests
- **Tags on requests** — `tags TEXT` column with comma-separated values
- **Per-collection default environment** — `default_environment_id` on collections
- **Drag-and-drop reordering** — UI for the `order` columns we're adding now
- **Engine-side variable resolution** — pass the var map to the engine; let it resolve templates. Enables server-side scripts to see unresolved templates.
- **Migration infrastructure** — `schema_migrations` table + numbered migration scripts. Required before first public release.

## 11. Integration Review Findings

A codebase audit against this design surfaced six concrete integration points that needed explicit handling beyond the original plan.

### 11.1 Engine internal type stays flat

`vayu::Headers` is `std::map<string,string>` in `engine/include/vayu/types.hpp:110`. The HTTP client (`engine/src/http/client.cpp:247-250`) converts this to a `curl_slist`. **This internal model does not change.** What changes is the wire-format deserialization step: `engine/src/utils/json.cpp:276-280` must now parse the incoming array, drop entries where `enabled === false`, drop the `description` field, and flatten into the existing `Headers` map. Same pattern for params if we choose to send them separately (see 11.6).

Scripts continue to see headers as a flat JS object via `pm.request.headers`. **No script API break.**

### 11.2 Form-data and urlencoded body serialization moves to the engine

Today the frontend serializes form fields into a flat string (`key=value&key2=value2`) before sending. With the new wire format `body: { mode: 'form-data', fields: [...] }`, the engine must:

- For `mode: 'form-data'`: build a multipart body with proper `Content-Type: multipart/form-data; boundary=...` header
- For `mode: 'x-www-form-urlencoded'`: URL-encode each enabled field and join with `&`

This was implicit in section 5.2 but is a non-trivial addition to `engine/src/utils/json.cpp:283-312` and `engine/src/http/client.cpp`. Add a unit test that round-trips each body mode.

### 11.3 `runs.config_snapshot` becomes a one-shot loss

Run records snapshot the request config as JSON into `runs.config_snapshot`. Pre-refactor snapshots have headers as `Record<string,string>`, post-refactor as `KeyValueEntry[]`. Two options:

- **Versioned snapshot** with a `schemaVersion` field and a transform-on-read in the history viewer
- **Accept the loss** consistent with nuke policy — old runs become unviewable, treat history as ephemeral

**Decision:** Accept the loss. The runs table is wiped along with the DB. Document in release notes when we eventually ship: "Run history does not survive the V1 schema change."

### 11.4 Five call sites that depend on the old Record shape

The audit found these locations that will break and must be updated as part of Phase 4:

| File | Line | Issue |
|---|---|---|
| `app/src/modules/request-builder/index.tsx` | 261 | `Object.entries(headersRecord).map(...)` — passes flat Record to a child component |
| `app/src/modules/request-builder/index.tsx` | 312 | `Object.entries(keyValueToRecord(...))` — double conversion, will be removed |
| `app/src/hooks/useEngine.ts` | ~55 | Already passes `request.headers` as a Record at execution; type mismatch with `RequestState.headers: KeyValueItem[]` exists today and is masked by the conversion |
| `app/src/types/api.ts` | 149–154 | `StartLoadTestRequest.headers?: Record<string, string>` — must become `KeyValueEntry[]` |
| `engine/tests/json_test.cpp` | 46 | Test fixture has headers as JSON object — rewrite to array form |

### 11.5 Request ordering UI must be wired

The design doc adds `Request.order` but the audit confirmed `CollectionTree.tsx` does not currently sort requests within a collection — they render in arbitrary DB order. Add a `compareRequestOrder()` companion to the existing `compareCollectionOrder()` in `domain.ts` and apply it in the tree render. The DnD UI is still out of scope for this refactor, but the sort must work or the new `order` column has no effect.

### 11.6 Params handling — decision moved out of "open questions"

The audit confirmed:
- Engine has no `params` field in `vayu::Request` (`types.hpp:104-108`)
- Frontend bakes params into the URL via `buildUrlWithParams()` in `ParamsPanel.tsx:26-45`
- Scripts cannot read `pm.request.params` (not exposed)

**Decision for this refactor:** Keep params as `KeyValueEntry[]` on the request object in storage and wire format (for UI fidelity — disabled rows, descriptions, duplicates), but **continue baking them into the URL on the frontend** before sending to the engine. The engine receives a URL with the query string already attached, exactly as today.

Rationale: separating params at the engine level is a meaningful additional refactor (script `pm.request.params` exposure, URL builder in C++, encoding edge cases). It's clean future work but doesn't pay for itself in this PRD. Track as deferred work in section 10.

This means `params` round-trips faithfully through storage but at execution time still gets flattened to `Record<string,string>` (enabled only) and concatenated into the URL — the same lossy step that exists today, but only for the wire-to-execute hop, not for storage.

## 12. Acceptance Criteria

- [ ] User can disable a header, save, reload — disabled state persists
- [ ] User can add two headers with the same key — both persist and both are sent
- [ ] User can attach a description to a header — visible on reload
- [ ] User can set a description on a collection and a request — visible on reload
- [ ] User can set Bearer auth on a collection — every descendant request with `auth.mode: 'inherit'` sends that Bearer
- [ ] User can set a pre-request script on a collection — runs before every descendant request
- [ ] Variable defined on root collection is visible to a request in a deeply nested sub-collection
- [ ] Deleting a parent collection deletes all descendants and their requests
- [ ] Variable can be marked as `type: 'number'` — UI renders a number input
- [ ] Request reorder via API (`POST /requests` with new `order`) persists and is reflected in collection tree
- [ ] No `keyValueToRecord` / `recordToKeyValue` calls remain in the frontend codebase
