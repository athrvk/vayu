# Import Format Mappings

Reference for how each external format maps to Vayu's internal data model.
Read alongside `import-collections-prd.md`.

> **2026-05 refresh:** This doc was updated after the data-model refactor (PR #11).
> Many compromises listed in older revisions — folder scripts dropped, descriptions
> dropped, duplicate header collapse, etc. — are no longer needed.

## Vayu Data Model Constraints

Understanding these constraints is essential before reading the format tables.
See `docs/engine/db-schema.md` for the full column-by-column reference.

**Collection** (engine `db::Collection`):
- `id: string`
- `parent_id: optional<string>` — nesting supported at any depth
- `name: string`
- `description: string` — preserved end-to-end
- `variables: string` — JSON `Record<string, {value, enabled, secret?}>`
- `auth: string` — JSON discriminated union (`none` / `bearer` / `basic` / `apikey` / …); collections are always concrete auth sources, **never** `inherit`
- `pre_request_script: string` — JS, runs in `pm.*` runtime before the request
- `post_request_script: string` — JS, runs after the response
- `order: int`

**Request** (engine `db::Request`):
- `id: string`
- `collection_id: string`
- `name: string`
- `description: string`
- `method: HttpMethod` — GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS
- `url: string`
- `params: string` — JSON **array** of `KeyValueEntry[]`; duplicates allowed; `enabled:false` preserved
- `headers: string` — JSON **array** of `KeyValueEntry[]`; same semantics
- `body: string` — JSON **discriminated union**:
  - `{"mode":"none"}`
  - `{"mode":"json"|"text"|"graphql","content":"..."}`
  - `{"mode":"form-data"|"x-www-form-urlencoded","fields":KeyValueEntry[]}`
- `body_type: string` — denormalized mirror of `body.mode`, kept for queryability
- `auth: string` — JSON discriminated union; requests can be `{"mode":"inherit"}` and are resolved against the collection chain at execution time
- `pre_request_script: string`
- `post_request_script: string`
- `order: int`

**Environment** (engine `db::Environment`):
- `id: string`
- `name: string`
- `description: string`
- `variables: string` — JSON `Record<string, {value, enabled, secret?}>`
- `is_active: bool`

`KeyValueEntry`: `{ key: string, value: string, enabled: boolean, description?: string }`.

**Cascade delete:** `delete_collection` recursively deletes all descendant collections and their requests (BFS, deepest-first).

---

## Postman Collection v2.1

### Detection
`info.schema` string contains `"v2.1.0"`

### Tree Walk
`item[]` entries are discriminated by presence of a nested `item[]` array:
- Has nested `item[]` → folder → create child Collection
- Has `request` object → create Request in current Collection

Walk is recursive. Depth is unbounded — Vayu supports arbitrary nesting via `parentId`.

### Field Mapping

**Collection (from Postman Collection root):**
| Postman field | Vayu field | Notes |
|---|---|---|
| `info.name` | `collection.name` | |
| `info.description` | `collection.description` | Postman supports string or object form; flatten to string |
| `variable[].{key,value,enabled,description?}` | `collection.variables` | Stringify non-string values; `enabled` defaults to `true` |
| `variable[].type` | dropped | Vayu stores all values as strings |
| `auth` (non-inherit) | `collection.auth` | See Auth section |
| `event[prerequest].script.exec[]` | `collection.preRequestScript` | Lines joined with `\n` |
| `event[test].script.exec[]` | `collection.postRequestScript` | Lines joined with `\n` |

**Collection (from Postman Folder):**
| Postman field | Vayu field | Notes |
|---|---|---|
| `name` | `collection.name` | |
| `description` | `collection.description` | |
| Folder-level `variable[]` | `collection.variables` | Same shape |
| Folder-level `auth` (non-inherit) | `collection.auth` | Collections cannot inherit — folders that say `inherit` are imported as `{"mode":"none"}` (parent already supplied auth via the chain) |
| Folder-level `event[]` scripts | `collection.preRequestScript` / `collection.postRequestScript` | Now supported — Vayu composes parent→child→request at execution time |

**Request:**
| Postman field | Vayu field | Notes |
|---|---|---|
| `name` | `request.name` | |
| `description` | `request.description` | |
| `request.method` | `request.method` | Uppercased |
| `request.url.raw` (object) or `request.url` (string) | `request.url` | See URL section |
| `request.url.query[]` | `request.params` | Mapped to `KeyValueEntry[]`; preserves `disabled:true` rows as `enabled:false`; duplicates preserved |
| `request.header[]` | `request.headers` | Same — `KeyValueEntry[]` with `enabled` flag |
| `request.body` | `request.body` (discriminated union) | See Body section |
| `request.auth` | `request.auth` | `inherit` → `{"mode":"inherit"}`; resolved at execution time |
| `event[prerequest].script.exec[]` | `request.preRequestScript` | Lines joined with `\n` |
| `event[test].script.exec[]` | `request.postRequestScript` | Lines joined with `\n` |

### URL Handling

Postman v2.1 URL can be a **string** or an **object**:

```json
// Object form (v2.1 standard)
"url": {
  "raw": "https://api.example.com/users/{{userId}}?page=1",
  "query": [{ "key": "page", "value": "1", "disabled": false }]
}

// String form (common in older collections and pre-request-generated URLs)
"url": "https://api.example.com/users/{{userId}}?page=1"
```

Strategy:
- If object: use `url.raw` as `request.url` (strip query string to avoid duplication). Map `url.query[]` directly to `KeyValueEntry[]`, preserving all rows including `disabled`.
- If string: use as-is. Parse the `?query` portion into `KeyValueEntry[]` with `enabled:true`.

### Body Mapping

| Postman `body.mode` | Postman detail | Vayu `body` |
|---|---|---|
| `raw` | `options.raw.language = "json"` | `{"mode":"json","content":body.raw}` |
| `raw` | `options.raw.language = "text"` | `{"mode":"text","content":body.raw}` |
| `raw` | no language set | `{"mode":"json","content":body.raw}` if `JSON.parse` succeeds, else `{"mode":"text",...}` |
| `urlencoded` | `body.urlencoded[]` | `{"mode":"x-www-form-urlencoded","fields":KeyValueEntry[]}` — `disabled:true` preserved as `enabled:false` |
| `formdata` | `body.formdata[]` text fields | `{"mode":"form-data","fields":KeyValueEntry[]}` — file fields dropped (no binary support) |
| `none` / absent | — | `{"mode":"none"}` |
| `graphql` | `body.graphql = {query, variables}` | `{"mode":"graphql","content":JSON.stringify({...})}` |
| `file` / `binary` | — | **dropped** — Vayu has no binary body support |

### Auth Mapping

Postman auth exists at three levels: collection, folder, request. Each can be `"noauth"`, a specific type, or `"inherit"`.

**New strategy (post-refactor):** preserve the hierarchy. Don't flatten at import time.
- Collection / folder `auth` is stored on the matching Vayu Collection (`{"mode":"none"}` if Postman says `noauth` or `inherit`, since collections cannot themselves inherit).
- Request `auth` set to `"inherit"` → store `{"mode":"inherit"}` on the Request; Vayu resolves it at execution time by walking the collection chain leaf-first.

| Postman auth type | Vayu `auth` JSON |
|---|---|
| `bearer` | `{"mode":"bearer","token":"<value>"}` |
| `basic` | `{"mode":"basic","username":"<u>","password":"<p>"}` |
| `apikey` | `{"mode":"apikey","key":"<k>","value":"<v>","in":"header"\|"query"}` |
| `oauth2` | `{"mode":"oauth2","config":{...}}` (stored as-is; not executed) |
| `digest` / `aws` / `ntlm` | `{"mode":"digest"\|"aws"\|"ntlm","config":{...}}` (stored as-is; not executed) |
| `noauth` | `{"mode":"none"}` |
| `inherit` (request-level only) | `{"mode":"inherit"}` |

### Environments

Postman v2.1 **collection files do not embed environments**. Collection-level `variable[]` is imported as `collection.variables`. Postman environment JSON files are a separate import (out of scope V1).

### Scripts Compatibility Note

Vayu's QuickJS runtime supports the modern `pm.*` API. Scripts using the deprecated `postman.*` namespace (e.g., `postman.setEnvironmentVariable()`) are imported as-is — they will throw runtime errors if executed.

---

## Postman Collection v2.0

Identical to v2.1 with these differences:

**Detection:** `info.schema` contains `"v2.0.0"`, or file has `info` + `item` but no `schema` field.

**URL:** Always treat as string — v2.0 predates the URL object format. Parse query string out manually. More error-prone on encoded characters.

**Auth structure:** v2.0 auth uses a slightly different key format in some types (e.g., `bearer.token` vs v2.1's array `bearer[{key:"token", value:"..."}]`). Parser must handle both shapes.

---

## Insomnia v4

### Detection
`_type === "export"` AND `__export_format === 4`

### Structure

Insomnia v4 exports are **flat arrays** of typed resources. The tree is reconstructed from `_id` / `parentId` references.

Resource types and their Vayu mapping:

| Insomnia `_type` | Vayu entity | Notes |
|---|---|---|
| `workspace` | Root Collection (parentId = null) | Multiple workspaces → multiple root Collections |
| `request_group` | Child Collection | parentId references workspace or another request_group |
| `request` | Request | parentId references request_group or workspace |
| `environment` | Environment (if opt-in) | See Environments section |
| `api_spec` | **dropped** | OpenAPI text stored alongside requests |
| `grpc_request` | **dropped** | gRPC not supported by Vayu |
| `websocket_request` | **dropped** | WebSocket not supported by Vayu |
| `unit_test_suite` / `unit_test` | **dropped** | No Vayu equivalent |

### Template Variable Normalization

Insomnia uses Nunjucks-style templates. Normalize to Vayu's `{{variable}}` syntax:

| Insomnia syntax | Vayu syntax | Notes |
|---|---|---|
| `{{ variable }}` | `{{variable}}` | Strip surrounding spaces |
| `{{ _.variable }}` | `{{variable}}` | Strip `_.` prefix — Insomnia env-scoped lookup |
| `{% now %}` / `{% uuid %}` / `{% randomInt %}` | kept as-is | **No Vayu equivalent** — will render as literal text |
| `{{ variable \| lower }}` | kept as-is | Nunjucks filter — will render as literal text |

Apply normalization to: URL, all header values, all param values, body text/fields.

### Field Mapping

**Collection (from workspace/request_group):**
| Insomnia field | Vayu field | Notes |
|---|---|---|
| `name` | `collection.name` | |
| `description` | `collection.description` | |
| `environment` (workspace-level base vars) | `collection.variables` | Only for workspace resources; normalize values |
| `authentication` (group-level) | `collection.auth` | If present and not `disabled` |

**Request:**
| Insomnia field | Vayu field | Notes |
|---|---|---|
| `name` | `request.name` | |
| `description` | `request.description` | |
| `method` | `request.method` | Uppercased |
| `url` (normalized) | `request.url` | Apply template normalization |
| `parameters[]` | `request.params` | `{name,value,disabled}` → `KeyValueEntry[]` with `enabled = !disabled` |
| `headers[]` | `request.headers` | Same shape; preserves duplicates and disabled rows |
| `body` | `request.body` (discriminated union) | See Body section |
| `authentication` | `request.auth` | See Auth section |
| `preRequestScript` | `request.preRequestScript` | Non-standard; present only in Insomnia versions with scripting |
| `afterResponseScript` | `request.postRequestScript` | Same note |

### Body Mapping

| Insomnia `body.mimeType` | Vayu `body` |
|---|---|
| `application/json` | `{"mode":"json","content":body.text}` |
| `text/plain` | `{"mode":"text","content":body.text}` |
| `application/x-www-form-urlencoded` | `{"mode":"x-www-form-urlencoded","fields":KeyValueEntry[]}` from `body.params[]` |
| `multipart/form-data` | `{"mode":"form-data","fields":KeyValueEntry[]}` from `body.params[]` text fields; file fields dropped |
| `application/graphql` | `{"mode":"graphql","content":body.text}` |
| absent / empty | `{"mode":"none"}` |

### Auth Mapping

| Insomnia `authentication.type` | Vayu `auth` JSON |
|---|---|
| `bearer` | `{"mode":"bearer","token":auth.token}` |
| `basic` | `{"mode":"basic","username":auth.username,"password":auth.password}` |
| `apikey` | `{"mode":"apikey","key":auth.key,"value":auth.value,"in":auth.addTo}` |
| `oauth2` | `{"mode":"oauth2","config":{...}}` (stored as-is; not executed) |
| `disabled: true` (any type) | `{"mode":"none"}` |

Insomnia has no first-class `"inherit"` concept; if a request has no `authentication`, it imports as `{"mode":"inherit"}` so the parent collection's auth (if any) applies at execution time.

### Environments

Insomnia environment resources have:
- `_type: "environment"`
- `data: Record<string, unknown>` — variable values (may be non-string)
- `parentId` — references a workspace (base env) or another environment (sub-env)

**Sub-environment flattening:** Insomnia's base env + sub-env inheritance is flattened at import time. Each sub-environment becomes a fully independent Vayu `Environment` with base env variables merged in (sub-env values override base).

```
Insomnia:
  Base Env: { baseUrl: "https://api.example.com", timeout: 30 }
  Sub-env "Production": { baseUrl: "https://prod.api.example.com" }
  Sub-env "Staging": { baseUrl: "https://staging.api.example.com" }

Vayu result:
  Environment "Production": { baseUrl: "https://prod.api.example.com", timeout: "30" }
  Environment "Staging":    { baseUrl: "https://staging.api.example.com", timeout: "30" }
```

All values stringified (Vayu `VariableValue.value` is always `string`).

---

## OpenAPI 3.0

### Detection
Root-level `openapi` field exists and `openapi.startsWith("3.")`

### Fundamental Difference

OpenAPI is an **API specification**, not a test collection. We generate synthetic request stubs from path/operation definitions. No real values exist — the user must fill in actual values after import.

### Tree Structure

| OpenAPI concept | Vayu entity |
|---|---|
| Spec (`info.title`) | Root Collection (parentId = null) |
| `tags[].name` | Child Collection per tag (parentId = root) |
| Untagged operations | Requests directly in root Collection |
| Operations with multiple tags | Assigned to first tag only; not duplicated |

### Field Mapping

**Collection (root):**
| OpenAPI field | Vayu field | Notes |
|---|---|---|
| `info.title` | `collection.name` | |
| `info.description` | `collection.description` | |
| `servers[0].url` | `collection.variables.baseUrl` | `{ value: url, enabled: true }` |
| Additional servers | dropped | Only first server used |

**Collection (per tag):**
| OpenAPI field | Vayu field | Notes |
|---|---|---|
| `tags[].name` | `collection.name` | |
| `tags[].description` | `collection.description` | |

**Request (per operation):**
| OpenAPI field | Vayu field | Notes |
|---|---|---|
| `summary` → `operationId` → `METHOD /path` | `request.name` | Prefers summary, falls back in order |
| `description` | `request.description` | |
| HTTP method (lowercased key) | `request.method` | Uppercased |
| `{{baseUrl}}` + path | `request.url` | Path params `{x}` → `{{x}}` |
| `parameters[in=query]` | `request.params` | Mapped to `KeyValueEntry[]`; one entry per parameter; description from spec preserved on the entry |
| `parameters[in=header]` | `request.headers` | Same; skip Authorization and Content-Type (added by Vayu) |
| `requestBody.content[application/json]` | `{"mode":"json","content":<generated>}` | See Body generation section |
| `requestBody.content[text/plain]` | `{"mode":"text","content":""}` | |
| `requestBody.content[application/x-www-form-urlencoded]` | `{"mode":"x-www-form-urlencoded","fields":KeyValueEntry[]}` | Generated stub per property |
| `requestBody.content[multipart/form-data]` | `{"mode":"form-data","fields":KeyValueEntry[]}` | Same |
| `security[]` / `securitySchemes` | `request.auth = {"mode":"inherit"}` | Lets the user set auth at the collection level once and have it apply to all child requests |
| `tags[0]` | determines parent Collection | |

### Body Generation from Schema

One level deep only — no recursion into nested objects or `$ref` chains.

| Schema type | Generated value |
|---|---|
| `string` | `""` (or `enum[0]` if present) |
| `integer` / `number` | `0` |
| `boolean` | `false` |
| `array` | `[]` |
| `object` with `properties` | `{ "key": <typed-default> }` for each property (one level) |
| `object` without `properties` | `{}` |
| `oneOf` / `anyOf` / `allOf` | `{}` — too ambiguous to resolve |
| `$ref` | resolved one level; if that resolves to another `$ref`, stops and returns `{}` |

Resulting JSON is pretty-printed and stored as `content` in `{"mode":"json","content":"..."}`.

### Path Parameters

OpenAPI path parameters use `{param}` syntax. Converted to Vayu `{{param}}`:

```
/users/{userId}/posts/{postId}  →  {{baseUrl}}/users/{{userId}}/posts/{{postId}}
```

These `{{userId}}` etc. appear in the URL but have no value set. The user sets them via collection variables or environment variables.

---

## OpenAPI 2.0 (Swagger)

### Detection
Root-level `swagger === "2.0"`

### Differences from OpenAPI 3.0

**Base URL construction:**
```
baseUrl = (schemes[0] || "https") + "://" + host + (basePath !== "/" ? basePath : "")
```
Stored as `collection.variables.baseUrl`. Multiple schemes → only the first used.

**Body content type:** Swagger doesn't define `requestBody` per-operation. Uses `consumes[]` at spec level or operation level. Strategy:
- If operation has `consumes: ["application/json"]` → generate JSON body from `parameters[in=body]` schema → `{"mode":"json","content":...}`
- If spec-level `consumes` has `application/json` → same
- If `in=body` parameter exists but no JSON consume → `{"mode":"text","content":...}`

**Parameter location:** Swagger `parameters[in=body]` is equivalent to OpenAPI `requestBody`. All other `in` values (`query`, `header`, `path`, `formData`) map the same way.

**`formData` parameters:** Swagger uses `in=formData` instead of `requestBody`. Map to `{"mode":"form-data","fields":KeyValueEntry[]}`, one entry per `formData` parameter.

**`$ref` resolution:** Swagger uses `#/definitions/ModelName`. Resolved one level deep (same constraint as OpenAPI 3.0).

**`collectionFormat` for array query params:** Now that `request.params` is `KeyValueEntry[]`, we can preserve repeated values rather than collapsing.
- `csv` → join values with `,` into a single entry value
- `multi` → **one `KeyValueEntry` per value, same key, all enabled** (no more loss)
- `ssv` / `tsv` / `pipes` → join with respective separator into single entry value

---

## Compromise Summary

### Universal (all formats)

| Loss | Root cause |
|---|---|
| File/binary upload body dropped | Vayu has no file attachment in requests |
| Variable type metadata (`type: "secret"`, etc.) reduced to `secret: boolean` | Vayu has no rich type system |

> Removed from this list after the data model refactor: `description` drops,
> duplicate-key collapse on params/headers, disabled-row loss, folder-script drops,
> auth-inheritance flattening, body-type opacity. All of these now round-trip.

### Postman v2.1 / v2.0

| Loss | Severity |
|---|---|
| Environments not in collection file | High — separate import needed |
| Disabled requests/folders silently skipped | Medium |
| `postman.*` deprecated API in scripts → runtime errors | Medium |
| OAuth2 / Digest / AWS / NTLM stored but not executed | Low |
| Variable type metadata dropped | Low |

### Insomnia v4

| Loss | Severity |
|---|---|
| gRPC / WebSocket / API spec resources dropped | High (if user has these) |
| Nunjucks template tags (`{% now %}` etc.) rendered as literals | Medium |
| Nunjucks filters (`\| lower`) rendered as literals | Low |
| Sub-environment inheritance flattened | Low |
| Folder-scoped environments dropped | Low |
| Unit test suites dropped | Low |

### OpenAPI 3.0 / 2.0

| Loss | Severity |
|---|---|
| No real values — all params/body are stubs | High — expected for spec import |
| Security schemes / auth set to inherit (user fills at collection level) | Medium — better than dropping |
| `oneOf`/`anyOf`/`allOf` body → empty `{}` | Medium |
| Multi-tag operations → first tag only (no duplication) | Medium |
| Additional servers beyond first dropped | Low |
| Deep `$ref` chains → one level resolved | Low |
| Response schemas dropped | Low |
