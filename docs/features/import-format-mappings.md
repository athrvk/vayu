# Import Format Mappings

Reference for how each external format maps to Vayu's internal data model.
Read alongside `import-collections-prd.md`.

## Vayu Data Model Constraints

Understanding these constraints is essential before reading the format tables.

**Collection** (engine `db::Collection`):
- `id: string`
- `parent_id: optional<string>` — nesting supported at any depth
- `name: string`
- `variables: string` — JSON `Record<string, {value, enabled, secret?}>`
- `order: int`
- **No `description` column** — frontend type has it, engine DB does not

**Request** (engine `db::Request`):
- `id: string`
- `collection_id: string` — belongs to exactly **one** Collection node
- `name: string`
- `method: HttpMethod` — GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS
- `url: string`
- `params: string` — JSON `Record<string, string>` — **flat, no duplicate keys**
- `headers: string` — JSON `Record<string, string>` — **flat, no duplicate keys**
- `body: string` — raw string content
- `body_type: string` — `"json" | "text" | "form-data" | "x-www-form-urlencoded" | "none"`
- `auth: string` — opaque JSON; engine stores but only executes bearer/basic/apikey
- `pre_request_script: string` — JS; Vayu runtime supports `pm.*` API
- `post_request_script: string` — JS
- **No `description` column**

**Environment** (engine `db::Environment`):
- `id: string`
- `name: string`
- `variables: string` — JSON `Record<string, {value, enabled, secret?}>`
- `is_active: bool`

**Delete cascade note:** `delete_collection` removes Requests with that `collection_id` but does NOT cascade to child Collections. Deleting a parent orphans children — pre-existing limitation, not introduced by import.

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
| `variable[].key/value/enabled` | `collection.variables` | `secret` preserved if present |
| `variable[].type` | dropped | Vayu stores all values as strings |

**Collection (from Postman Folder):**
| Postman field | Vayu field | Notes |
|---|---|---|
| `name` | `collection.name` | |
| Folder-level `variable[]` | `collection.variables` | Same mapping |
| Folder-level `auth` | resolved into child requests | See Auth section |
| Folder-level `event[]` scripts | **dropped** | No folder-level scripts in Vayu |

**Request:**
| Postman field | Vayu field | Notes |
|---|---|---|
| `name` | `request.name` | |
| `request.method` | `request.method` | Uppercased |
| `request.url.raw` (object) or `request.url` (string) | `request.url` | See URL section |
| `request.url.query[]` (filtered) | `request.params` | Filter `disabled: true`; last value wins on duplicate keys |
| `request.header[]` (filtered) | `request.headers` | Filter `disabled: true`; last value wins |
| `request.body` | `request.body` + `request.bodyType` | See Body section |
| `request.auth` (resolved) | `request.auth` | See Auth section |
| `event[prerequest].script.exec[]` | `request.preRequestScript` | Lines joined with `\n` |
| `event[test].script.exec[]` | `request.postRequestScript` | Lines joined with `\n` |
| `description` | **dropped** | Engine DB has no description column |

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
- If object: use `url.raw` as `request.url`. Extract `url.query[]` (non-disabled) into `params`. Strip query string from `url.raw` to avoid duplication.
- If string: use as-is for `request.url`. Parse and strip the `?query` portion into `params`.

### Body Mapping

| Postman `body.mode` | Postman detail | Vayu `bodyType` | Vayu `body` |
|---|---|---|---|
| `raw` | `options.raw.language = "json"` | `"json"` | `body.raw` |
| `raw` | `options.raw.language = "text"` | `"text"` | `body.raw` |
| `raw` | no language set | `"json"` if `JSON.parse` succeeds, else `"text"` | `body.raw` |
| `urlencoded` | `body.urlencoded[]` | `"x-www-form-urlencoded"` | `key=value&key2=value2` (non-disabled entries) |
| `formdata` | `body.formdata[]` | `"form-data"` | `key=value&key2=value2` (text fields only, non-disabled) |
| `none` / absent | — | `"none"` | `""` |
| `graphql` | `body.graphql` | `"text"` | `JSON.stringify(body.graphql)` |
| `file` / `binary` | — | **dropped** | Vayu has no binary body support |

### Auth Resolution

Postman auth exists at three levels: collection, folder, request. Each can be `"noauth"`, a specific type, or `"inherit"`.

Resolution at parse time (bottom-up):
1. Start at the request's own `auth`
2. If `type === "inherit"` (or auth absent): walk up to parent folder, then collection
3. Apply the first non-inherit auth found

| Postman auth type | Vayu `auth` JSON |
|---|---|
| `bearer` | `{ "type": "bearer", "token": "<value>" }` |
| `basic` | `{ "type": "basic", "username": "<u>", "password": "<p>" }` |
| `apikey` | `{ "type": "apikey", "key": "<k>", "value": "<v>", "in": "header"\|"query" }` |
| `oauth2` | stored as-is (not executed by engine) |
| `digest` / `aws` / `ntlm` | stored as-is (not executed by engine) |
| `noauth` / resolved to nothing | `{}` (empty) |

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

Apply normalization to: URL, all header values, all param values, body text.

### Field Mapping

**Collection (from workspace/request_group):**
| Insomnia field | Vayu field | Notes |
|---|---|---|
| `name` | `collection.name` | |
| `description` | **dropped** | |
| `environment` (workspace-level base vars) | `collection.variables` | Only for workspace resources; normalize values |

**Request:**
| Insomnia field | Vayu field | Notes |
|---|---|---|
| `name` | `request.name` | |
| `method` | `request.method` | Uppercased |
| `url` (normalized) | `request.url` | Apply template normalization |
| `parameters[]` (non-disabled) | `request.params` | `{name, value}` → `Record<string,string>` |
| `headers[]` (non-disabled) | `request.headers` | `{name, value}` → `Record<string,string>` |
| `body` | `request.body` + `request.bodyType` | See Body section |
| `authentication` | `request.auth` | See Auth section |
| `preRequestScript` | `request.preRequestScript` | Non-standard; present only in Insomnia versions with scripting |
| `afterResponseScript` | `request.postRequestScript` | Same note |
| `description` | **dropped** | |

### Body Mapping

| Insomnia `body.mimeType` | Vayu `bodyType` | Vayu `body` |
|---|---|---|
| `application/json` | `"json"` | `body.text` |
| `text/plain` | `"text"` | `body.text` |
| `application/x-www-form-urlencoded` | `"x-www-form-urlencoded"` | rebuild from `body.params[]` |
| `multipart/form-data` | `"form-data"` | text fields from `body.params[]`; file fields dropped |
| `application/graphql` | `"text"` | `body.text` |
| absent / empty | `"none"` | `""` |

### Auth Mapping

| Insomnia `authentication.type` | Vayu `auth` JSON |
|---|---|
| `bearer` | `{ "type": "bearer", "token": auth.token }` |
| `basic` | `{ "type": "basic", "username": auth.username, "password": auth.password }` |
| `apikey` | `{ "type": "apikey", "key": auth.key, "value": auth.value, "in": auth.addTo }` |
| `oauth2` | stored as-is (not executed) |
| `disabled: true` (any type) | `{}` (empty auth) |

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
| `servers[0].url` | `collection.variables.baseUrl` | `{ value: url, enabled: true }` |
| Additional servers | **dropped** | Only first server used |
| `info.description` | **dropped** | |

**Request (per operation):**
| OpenAPI field | Vayu field | Notes |
|---|---|---|
| `summary` → `operationId` → `METHOD /path` | `request.name` | Prefers summary, falls back in order |
| HTTP method (lowercased key) | `request.method` | Uppercased |
| `{{baseUrl}}` + path | `request.url` | Path params `{x}` → `{{x}}` |
| `parameters[in=query]` | `request.params` | Example/default value used; else `""` |
| `parameters[in=header]` | `request.headers` | Skip standard headers (Authorization, Content-Type) |
| `requestBody.content[application/json]` | `body` + `bodyType="json"` | See Body generation section |
| `requestBody.content[text/plain]` | `body=""` + `bodyType="text"` | |
| `security[]` / `securitySchemes` | **dropped** | No auth set; user fills in post-import |
| `tags[0]` | determines parent Collection | |
| `description` / `externalDocs` | **dropped** | |

### Body Generation from Schema

One level deep only — no recursion into nested objects or `$ref` chains.

| Schema type | Generated value |
|---|---|
| `string` | `""` |
| `integer` / `number` | `0` |
| `boolean` | `false` |
| `array` | `[]` |
| `object` with `properties` | `{ "key": <typed-default> }` for each property (one level) |
| `object` without `properties` | `{}` |
| `oneOf` / `anyOf` / `allOf` | `{}` — too ambiguous to resolve |
| `$ref` | resolved one level; if that resolves to another `$ref`, stops and returns `{}` |

Resulting JSON is pretty-printed and stored as `body` string with `bodyType = "json"`.

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
- If operation has `consumes: ["application/json"]` → generate JSON body from `parameters[in=body]` schema
- If spec-level `consumes` has `application/json` → same
- If `in=body` parameter exists but no JSON consume → store body as `bodyType: "text"`

**Parameter location:** Swagger `parameters[in=body]` is equivalent to OpenAPI `requestBody`. All other `in` values (`query`, `header`, `path`, `formData`) map the same way.

**`formData` parameters:** Swagger uses `in=formData` instead of `requestBody`. Map to `bodyType: "form-data"` with values joined as `key=value&...`.

**`$ref` resolution:** Swagger uses `#/definitions/ModelName`. Resolved one level deep (same constraint as OpenAPI 3.0).

**`collectionFormat` for array query params:**
- `csv` → join values with `,` into a single string
- `multi` → **collapses to last value** (Vayu params is a flat Record)
- `ssv` / `tsv` / `pipes` → join with respective separator into single string

---

## Compromise Summary

### Universal (all formats)

| Loss | Root cause |
|---|---|
| `description` fields dropped | Engine DB has no description column |
| Duplicate query param keys → last value wins | `params` is `Record<string,string>` |
| Duplicate header keys → last value wins | `headers` is `Record<string,string>` |
| File/binary upload body dropped | Vayu has no file attachment in requests |

### Postman v2.1 / v2.0

| Loss | Severity |
|---|---|
| Environments not in collection file | High — separate import needed |
| Disabled requests/folders silently skipped | Medium |
| Folder-level scripts (pre/post) dropped | Medium |
| `postman.*` deprecated API in scripts → runtime errors | Medium |
| Auth inheritance resolved at import time (not dynamic) | Low |
| OAuth2 / Digest / AWS / NTLM stored but not executed | Low |
| `urlencoded`/`formdata` body rebuilt as flat string | Low |
| GraphQL body stored as text | Low |
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
| Security schemes / auth dropped | High — user fills in post-import |
| `oneOf`/`anyOf`/`allOf` body → empty `{}` | Medium |
| Multi-tag operations → first tag only (no duplication) | Medium |
| Additional servers beyond first dropped | Low |
| Deep `$ref` chains → one level resolved | Low |
| Response schemas dropped | Low |
| `collectionFormat: multi` collapses to last value | Low |
