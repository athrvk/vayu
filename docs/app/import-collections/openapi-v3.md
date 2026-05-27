# OpenAPI 3.0

Parses an OpenAPI 3.0.x specification into the Vayu draft model. OpenAPI is a **specification document, not a request log** — it describes endpoints, parameters, and schemas but carries no concrete values. The parser therefore emits **synthetic request stubs**: a `{{baseUrl}}` from the first server, query/header params with empty values, and a body sampled from the request schema. Users fill in real values after import.

- **Source:** `app/src/services/importers/openapi-v3.ts`
- **Exports:**

  | Symbol | `formatName` | `formatKey` |
  |--------|--------------|-------------|
  | `OpenApiV3Parser` (class, implements `ImportParser`) | `OpenAPI 3.0` | `openapi-v3` |
  | `schemeToAuth` (helper) | — | — |

  `OpenApiV3Parser` exposes `formatName` / `formatKey` as readonly fields and implements `detect` + `parse` from `./types`.

## Detection

```ts
detect(parsed) {
  const v = parsed?.openapi;
  return typeof v === "string" && v.startsWith("3.");
}
```

The top-level `openapi` field must be a string beginning with `"3."` (so `3.0.0`, `3.0.3`, and `3.1.x` all match). Swagger 2.0 (`swagger: "2.0"`, no `openapi` field) is handled by a separate parser — see [OpenAPI v2](./openapi-v2.md). The factory (`factory.ts`) parses the raw text once (JSON, then YAML fallback) and runs each parser's `detect` in registration order.

## Tree structure

The spec maps to a single root collection, with operations grouped into child collections by their first tag.

- **Root collection** ← the whole spec (named from `info.title`). It directly holds:
  - `requests`: every **untagged** operation.
  - `children`: one child collection per distinct first-tag, in first-encounter order.
- **Tag child collections** ← created lazily by `makeTagCollection(spec, tag)` the first time a tag is seen, keyed in a `Map<string, CollectionDraft>`. Description comes from the matching entry in the top-level `tags[]` array (if any).

Iteration order: `parse` loops over `spec.paths` entries, and for each path item over the fixed `HTTP_METHODS` list (`get, post, put, patch, delete, head, options`). For each present operation it calls `buildOperation(...)`, then routes by tag:

```ts
const tag = op.tags?.[0];   // ONLY the first tag is used
if (tag) tagCollections.get(tag).requests.push(req);
else     rootRequests.push(req);
```

**Multi-tag operations:** only `op.tags[0]` is consulted. An operation with `tags: ["a", "b"]` lands solely in the `a` child collection; `b` is ignored (no duplication, no extra folder). An operation with no `tags` (or `tags: []`) becomes a root request.

Key internal functions: `buildOperation` (per-operation `RequestDraft`), `makeTagCollection` (per-tag `CollectionDraft`), `buildBody` / `findJsonMedia` (request body), `pickPrimaryScheme` / `schemeToAuth` (collection auth), and a closed-over `resolveRef` for `$ref` resolution.

## Field mapping

### Collection (root)

Built inline in `parse`.

| OpenAPI | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `info.title` | `name` | fallback `"Imported API"` |
| `info.description` | `description` | fallback `""` |
| `servers[0].url` | `variables.baseUrl` | only added when a base URL exists: `{ baseUrl: { value, enabled: true } }`; otherwise `variables` is `{}`. Additional `servers[]` are ignored. |
| `security` / `components.securitySchemes` | `auth` | via `pickPrimaryScheme` + `schemeToAuth` (see [Auth](#auth--security)). Collections never inherit. |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |
| tag groups | `children` | `[...tagCollections.values()]` |
| untagged operations | `requests` | |

### Collection (per tag)

Built by `makeTagCollection(spec, tag)`.

| OpenAPI | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `tag` (the string) | `name` | |
| `tags[].description` where `tags[].name === tag` | `description` | fallback `""` |
| (none) | `variables` | always `{}` (baseUrl lives only on the root) |
| (none) | `auth` | always `{ mode: "none" }` — tag collections do not carry security |
| (none) | `children` | always `[]` (tags are flat; no nesting) |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

### Request (per operation)

Built by `buildOperation(method, path, op, resolveRef, pathParams)`.

| OpenAPI | Vayu `RequestDraft` | Notes |
|---------|---------------------|-------|
| `op.summary` → `op.operationId` → `"{METHOD} {path}"` | `name` | precedence in that order; final fallback uses upper-cased method + raw path, e.g. `"GET /users/{id}"` |
| `op.description` | `description` | fallback `""` |
| HTTP method | `method` | `method.toUpperCase()` (e.g. `get` → `GET`), cast to `HttpMethod` |
| `path` | `url` | `` `{{baseUrl}}${normalizeVars(path)}` `` — always prefixed with `{{baseUrl}}`, even if no server was defined (see [URL](#url--path-parameters)) |
| parameters with `in: "query"` | `params` | `{ key: name, value: "", enabled: true, description? }` — `description` included only when present |
| parameters with `in: "header"` | `headers` | `{ key: name, value: "", enabled: true }` — **no description carried**; `authorization` and `content-type` headers are dropped (case-insensitive) since Vayu manages those |
| parameters with `in: "path"` / `in: "cookie"` | — | not emitted as params/headers; path params are represented in the URL via `normalizeVars`. Cookie params are dropped. |
| `op.requestBody` | `body` | via `buildBody` (see [Request body](#request-body-generation)) |
| (none) | `auth` | always `{ mode: "inherit" }` — auth is configured once at the collection level |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

**Parameter resolution & merge.** `buildOperation` concatenates path-item-level `parameters` with operation-level `op.parameters`, resolving any `$ref` entries via `resolveRef`. Each parameter is keyed by `` `${in}:${name}` `` in a `Map`, so an operation-level parameter **overrides** a path-level one with the same `in`+`name` (later writes win). Entries missing `in` or `name` after resolution are skipped.

## URL & path parameters

- The request `url` is always `` `{{baseUrl}}${normalizeVars(path)}` ``. `{{baseUrl}}` is a Vayu collection variable resolved from `servers[0].url` at import time (defined on the root collection). If the spec has no `servers`, `baseUrl` is absent from the root variables and `{{baseUrl}}` resolves to empty at runtime.
- OpenAPI path templates `{param}` are converted to Vayu `{{param}}` by `normalizeVars` (`var-normalize.ts`). It rewrites single-brace `{x}` (identifier chars `[\w$-]`) to `{{x}}`, while leaving any existing `{{...}}` pairs intact. So `/users/{userId}/posts/{postId}` becomes `/users/{{userId}}/posts/{{postId}}`. Path parameters are **not** also emitted as `params` entries — they live only in the URL.

## Request body generation

`buildBody(requestBody, resolveRef)` resolves a top-level `$ref` on the `requestBody`, then inspects `content`:

| `content` media type | Vayu `RequestBody` | How content is produced |
|----------------------|--------------------|-------------------------|
| `application/json` (also any key starting with `application/json` or ending in `+json`, via `findJsonMedia`) | `{ mode: "json", content }` | `content = JSON.stringify(media.example ?? sampleSchema(media.schema), null, 2)`. The media-object `example` wins over the schema; if neither exists, `{}`. |
| `text/plain` | `{ mode: "text", content: "" }` | empty string (the schema is not sampled for text bodies) |
| `application/x-www-form-urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `fields` = one `{ key, value: "", enabled: true }` per `schema.properties` key |
| `multipart/form-data` | `{ mode: "form-data", fields }` | same as urlencoded; key per `schema.properties` |
| no `content`, or none of the above | `{ mode: "none" }` | |

JSON is preferred: `findJsonMedia` is checked first and takes precedence over text/form variants. The `x-www-form-urlencoded` / `multipart/form-data` branch only reads property **names** — property schemas, `required`, and nested structure are not sampled into form fields.

### `sampleSchema` (schema → stub value)

`sampleSchema(schema, resolveRef)` in `schema-sampler.ts` generates a sample JSON value by walking the schema. It is **bounded and recursive** — materially more capable than a one-level stub:

- **Depth cap.** `MAX_DEPTH = 6`. Once `depth > 6`, the walker returns `{}`. Non-object / null nodes also return `{}`.
- **`$ref` resolution + cycle guard.** A node with a string `$ref` is resolved via `resolveRef` and walked (depth +1). A `Set` of already-visited `$ref` strings is threaded down each branch; re-encountering a `$ref` already on the current path returns `{}` (breaks reference cycles). Resolution failures (`throw` or `null` result) also yield `{}`.
- **`example` preference.** If the schema node has an `example` field, that value is returned verbatim (checked **after** `$ref`, before composition and `type`). This lets authors pin exact sample values.
- **`allOf` / `oneOf` / `anyOf` — first branch.** If any of these is a non-empty array, the walker recurses into **`branch[0]` only** (precedence `allOf` → `oneOf` → `anyOf`). It does not merge `allOf` members; it just samples the first.
- **Type defaults:**

  | `schema.type` | Sample value |
  |---------------|--------------|
  | `string` | `enum[0]` if a non-empty `enum` is present, else `""` |
  | `integer` / `number` | `0` |
  | `boolean` | `false` |
  | `array` | `[ sample(items) ]` if `items` is present, else `[]` (one element) |
  | `object` (or no/unknown `type`) | walks each entry of `properties`, producing `{ key: sample }`; `{}` if no `properties` |

  The `object`/default branch is the same fallback used for untyped schemas — a node with `properties` but no `type` is still expanded.

> Older notes claimed sampling was "one level only" and "`oneOf` → `{}`". That is **not** what the code does: sampling recurses to depth 6, resolves and cycle-guards `$ref`s, honors `example`, and follows the first branch of `oneOf`/`anyOf`/`allOf`.

## Auth / security

Auth is applied **only at the root collection**; every request is `{ mode: "inherit" }`, so the user configures credentials once.

`pickPrimaryScheme(spec)` chooses one scheme:

1. If `spec.security[0]` exists, take its first key (`Object.keys(security[0])[0]`) and use the matching `components.securitySchemes[name]`.
2. Otherwise fall back to the **first** entry of `components.securitySchemes`.

`schemeToAuth(scheme)` maps that scheme to a concrete collection auth (always with empty secrets — the spec has no real credentials):

| `securityScheme` | Vayu `RequestAuth` |
|------------------|--------------------|
| `type: "http"`, `scheme: "bearer"` | `{ mode: "bearer", token: "" }` |
| `type: "http"`, `scheme: "basic"` | `{ mode: "basic", username: "", password: "" }` |
| `type: "apiKey"` | `{ mode: "apikey", key: scheme.name ?? "", value: "", in: scheme.in === "query" ? "query" : "header" }` |
| `type: "oauth2"` | `{ mode: "oauth2", config: {} }` |
| missing / any other type (incl. `openIdConnect`, `http` with other schemes) | `{ mode: "none" }` |

**`nonExecutableAuth`:** set to `1` when the picked primary scheme is `oauth2` (Vayu has no OAuth2 execution path), otherwise `0`. This is a flag for the chosen scheme, not a per-request count.

## Options & lossy behavior

This parser is **stub-only**: it materializes the shape of each request but no values. The `ImportOptions` argument (`importEnvironments`, `importScripts`) is **ignored** — the parameter is `_opts` and is never read.

Dropped / not represented:

- **Scripts:** all `preRequestScript` / `postRequestScript` are `""` (OpenAPI has no scripts; `importScripts` has no effect here).
- **Environments:** none produced (`environments: []`, `meta.environmentCount: 0`). OpenAPI has no environment concept; `servers[0]` becomes a single `baseUrl` collection variable.
- **Additional servers:** only `servers[0]` is used; other entries and per-operation `servers` overrides are dropped.
- **Response schemas, examples beyond request body, callbacks, links, security scopes:** not consumed.
- **Cookie parameters** and **path parameters as params**: not emitted (path params live in the URL only).
- **`authorization` / `content-type` header parameters:** dropped (Vayu manages them).
- **Multi-tag grouping:** only the first tag groups an operation.

`meta` population: `format = "OpenAPI 3.0"`, `requestCount` = total operations built, `folderCount` = number of tag collections, `environmentCount = 0`, `skipped = []` (this parser never emits `SkippedItem`s), `nonExecutableAuth` = `1` if primary scheme is oauth2 else `0`.

## Shared helpers used

| Helper | Source | Use in this parser |
|--------|--------|--------------------|
| [`normalizeVars`](./README.md#normalizevars) | `var-normalize.ts` | convert OpenAPI `{param}` path templates → Vayu `{{param}}` in request URLs |
| `sampleSchema` | `schema-sampler.ts` | generate a sample JSON body from a request `schema` (bounded, ref-resolving) |

This parser does **not** use the Postman/Insomnia helpers in `shared.ts` (`asString`, `toVarRecord`, `mapKeyValues`, `mapPostmanAuth`, `rawBody`, `joinExec`); it builds drafts directly. See the [index](./README.md#shared-helpers) for the full shared-helper reference.

## Related

- [Import pipeline index](./README.md)
- [OpenAPI v2 (Swagger 2.0)](./openapi-v2.md)
- [Postman Collection v2.1 / v2.0](./postman.md)
- [Insomnia v4](./insomnia-v4.md)
