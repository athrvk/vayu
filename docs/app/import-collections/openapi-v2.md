# OpenAPI 2.0 (Swagger)

Parses a Swagger 2.0 specification into the Vayu draft model. Swagger 2.0, like OpenAPI 3.0, is a **specification document, not a request log** — it describes endpoints, parameters, and schemas but carries no concrete values. The parser therefore emits **synthetic request stubs**: a `{{baseUrl}}` built from `schemes`/`host`/`basePath`, query/header params with empty values, and a body sampled from the `in: "body"` parameter schema. Users fill in real values after import.

- **Source:** `app/src/services/importers/openapi-v2.ts`
- **Exports:**

  | Symbol | `formatName` | `formatKey` |
  |--------|--------------|-------------|
  | `OpenApiV2Parser` (class, implements `ImportParser`) | `OpenAPI 2.0 (Swagger)` | `openapi-v2` |
  | `swaggerSchemeToAuth` (helper) | — | — |

  `OpenApiV2Parser` exposes `formatName` / `formatKey` as readonly fields and implements `detect` + `parse` from `./types`.

## Detection

```ts
detect(parsed) {
  return parsed?.swagger === "2.0";
}
```

The top-level `swagger` field must equal the exact string `"2.0"`. OpenAPI 3.x (the `openapi` field, no `swagger`) is handled by a separate parser — see [OpenAPI v3](./openapi-v3.md). The factory (`factory.ts`) parses the raw text once (JSON, then YAML fallback) and runs each parser's `detect` in registration order.

## Tree structure

The spec maps to a single root collection, with operations grouped into child collections by their first tag.

- **Root collection** ← the whole spec (named from `info.title`). It directly holds:
  - `requests`: every **untagged** operation (`rootRequests`).
  - `children`: one child collection per distinct first-tag, in first-encounter order.
- **Tag child collections** ← created lazily, inline in `parse`, the first time a tag is seen, keyed in a `Map<string, CollectionDraft>` (`tagCollections`). Description comes from the matching entry in the top-level `tags[]` array (if any).

Iteration order: `parse` loops over `spec.paths` entries, and for each path item over the fixed `HTTP_METHODS` list (`get, post, put, patch, delete, head, options`). For each present operation it calls `buildSwaggerOp(...)`, then routes by tag:

```ts
const tag = op.tags?.[0];   // ONLY the first tag is used
if (tag) tagCollections.get(tag).requests.push(req);
else     rootRequests.push(req);
```

**Multi-tag operations:** only `op.tags[0]` is consulted. An operation with `tags: ["a", "b"]` lands solely in the `a` child collection; `b` is ignored (no duplication, no extra folder). An operation with no `tags` (or `tags: []`) becomes a root request.

Unlike v3 (which has dedicated `makeTagCollection` / `buildBody` helpers), v2 builds the root and tag collections inline in `parse` and delegates only the per-operation draft to `buildSwaggerOp`. A closed-over `resolveRef` handles `$ref` resolution.

## Field mapping

### Collection (root)

Built inline in `parse`.

| Swagger | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `info.title` | `name` | fallback `"Imported API"` |
| `info.description` | `description` | fallback `""` |
| `schemes` + `host` + `basePath` | `variables.baseUrl` | only added when `host` is present: `{ baseUrl: { value: baseUrl, enabled: true } }`; otherwise `variables` is `{}`. See [Base URL](#base-url-construction). |
| `security` / `securityDefinitions` | `auth` | via the picked primary scheme + `swaggerSchemeToAuth` (see [Auth](#auth--security)). Collections never inherit. |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |
| tag groups | `children` | `[...tagCollections.values()]` |
| untagged operations | `requests` | |

### Collection (per tag)

Built inline when a tag is first encountered.

| Swagger | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `tag` (the string) | `name` | |
| `tags[].description` where `tags[].name === tag` | `description` | fallback `""` |
| (none) | `variables` | always `{}` (baseUrl lives only on the root) |
| (none) | `auth` | always `{ mode: "none" }` — tag collections do not carry security |
| (none) | `children` | always `[]` (tags are flat; no nesting) |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

### Request (per operation)

Built by `buildSwaggerOp(method, path, op, spec, resolveRef, pathParams)`.

| Swagger | Vayu `RequestDraft` | Notes |
|---------|---------------------|-------|
| `op.summary` → `op.operationId` → `"{METHOD} {path}"` | `name` | precedence in that order; final fallback uses upper-cased method + raw path, e.g. `"GET /users/{id}"` |
| `op.description` | `description` | fallback `""` |
| HTTP method | `method` | `method.toUpperCase()` (e.g. `get` → `GET`), cast to `HttpMethod` |
| `path` | `url` | `` `{{baseUrl}}${normalizeVars(path)}` `` — always prefixed with `{{baseUrl}}`, even if no `host` was defined (see [URL](#url--path-parameters)) |
| parameter `in: "query"` | `params` | `{ key: name, value: "", enabled: true, description? }` — `description` included only when present |
| parameter `in: "header"` | `headers` | `{ key: name, value: "", enabled: true }` — **no description carried**; `authorization` and `content-type` headers are dropped (case-insensitive) since Vayu manages those |
| parameter `in: "body"` | `body` | sampled via `sampleSchema`; JSON vs text decided by `consumes` (see [Parameters & body](#parameters--body)) |
| parameter `in: "formData"` | `body` | collected into `form-data` fields (see below) |
| parameter `in: "path"` | — | not emitted as params/headers; path params are represented in the URL via `normalizeVars` |
| (none) | `auth` | always `{ mode: "inherit" }` — auth is configured once at the collection level |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

**Parameter resolution & merge.** `buildSwaggerOp` concatenates path-item-level `parameters` (passed in as `pathParams`) with operation-level `op.parameters`, resolving any `$ref` entries via `resolveRef`. Each parameter is keyed by `` `${in}:${name}` `` in a `Map` (`byKey`), so an operation-level parameter **overrides** a path-level one with the same `in`+`name` (later writes win). Entries missing `in` or `name` after resolution are skipped.

## Base URL construction

The base URL is assembled from three top-level spec fields and stored as the `baseUrl` collection variable on the root only:

```ts
const scheme   = (spec.schemes?.[0] as string) ?? "https";
const basePath = spec.basePath && spec.basePath !== "/" ? spec.basePath : "";
const baseUrl  = spec.host ? `${scheme}://${spec.host}${basePath}` : "";
```

- **Scheme** — the **first** entry of `schemes[]`; if `schemes` is absent/empty, defaults to `"https"`. Additional schemes (`http`, `ws`, `wss`, …) are **ignored** — only `schemes[0]` is used.
- **`basePath`** — appended verbatim **unless** it is missing or exactly `"/"` (in which case it contributes nothing, avoiding a trailing `//`).
- **`host`** — required for a base URL. If `host` is absent, `baseUrl` is `""`, no `baseUrl` variable is added (root `variables` stays `{}`), and request URLs still carry the literal `{{baseUrl}}` prefix (resolving to empty at runtime).

Examples (`host: "api.example.com"`):

| `schemes` | `basePath` | `baseUrl` |
|-----------|-----------|-----------|
| `["https"]` | `"/v2"` | `https://api.example.com/v2` |
| `["http", "https"]` | `"/v2"` | `http://api.example.com/v2` (first scheme only) |
| (absent) | `"/"` | `https://api.example.com` (default scheme, `/` dropped) |
| `["https"]` | (absent) | `https://api.example.com` |

When set, the value is stored as `variables.baseUrl = { value: baseUrl, enabled: true }`.

## URL & path parameters

- The request `url` is always `` `{{baseUrl}}${normalizeVars(path)}` ``. `{{baseUrl}}` is the Vayu collection variable described above (defined on the root collection). If the spec has no `host`, `baseUrl` is absent from the root variables and `{{baseUrl}}` resolves to empty at runtime.
- Swagger path templates `{param}` are converted to Vayu `{{param}}` by `normalizeVars` (`var-normalize.ts`). It rewrites single-brace `{x}` (identifier chars `[\w$-]`) to `{{x}}`, while leaving any existing `{{...}}` pairs intact. So `/users/{userId}/posts/{postId}` becomes `/users/{{userId}}/posts/{{postId}}`. Path parameters (`in: "path"`) are **not** also emitted as `params` entries — they live only in the URL.

## Parameters & body

Swagger 2.0 has **no `requestBody` object** (unlike v3). Request bodies are expressed as ordinary `parameters` with a special `in` value. `buildSwaggerOp` iterates the resolved, deduped parameters and dispatches on `param.in`:

| `param.in` | Effect | Detail |
|------------|--------|--------|
| `query` | push to `params` | `{ key, value: "", enabled: true, description? }`; `description` only when present |
| `header` | push to `headers` | `{ key, value: "", enabled: true }`; skipped when `name.toLowerCase()` is `authorization` or `content-type` |
| `body` | set `body` | `sample = param.schema ? sampleSchema(param.schema, resolveRef) : {}`; serialized with `JSON.stringify(sample, null, 2)`. Mode is JSON or text per `consumes` (below). |
| `formData` | collect into `formFields` | `{ key: name, value: "", enabled: true }` per field |
| (anything else) | ignored | no `default` case action |

After the loop, **form data wins**: if any `formData` fields were collected, `body` is unconditionally replaced with `{ mode: "form-data", fields: formFields }` — overriding any body set by an `in: "body"` parameter. (A spec mixing both would be unusual, but the code resolves it in favor of form-data.)

### `consumes` → body mode

The JSON-vs-text decision for an `in: "body"` parameter is driven by `consumes`:

```ts
const consumes = op.consumes ?? spec.consumes ?? [];
const isJsonConsume =
  consumes.length === 0 ||
  consumes.some(
    (c) => c === "application/json" || c.startsWith("application/json;") || c.endsWith("+json")
  );
```

- `consumes` is taken from the **operation** first, falling back to the **spec-level** `consumes`, else `[]`.
- `isJsonConsume` is `true` when `consumes` is **empty** (default assumption: JSON) **or** any entry is exactly `application/json`, starts with `application/json;` (e.g. with a charset), or ends with `+json` (e.g. `application/hal+json`).
- Body mode:
  - `isJsonConsume === true` → `{ mode: "json", content: JSON.stringify(sample, null, 2) }`
  - otherwise → `{ mode: "text", content: JSON.stringify(sample, null, 2) }`

Note the text branch still serializes the sampled schema to JSON text (it does not blank the body — this differs from v3's `text/plain` handling, which emits an empty string).

## `$ref` & schema sampling

`resolveRef` resolves any JSON-pointer ref against the whole spec — Swagger model refs are `#/definitions/...`, but the resolver is generic. It strips the leading `#/`, splits on `/`, un-escapes `~1`→`/` and `~0`→`~`, and walks the spec object segment by segment.

Body schemas are turned into stub values by `sampleSchema(schema, resolveRef)` (`schema-sampler.ts`), which walks the schema recursively. It is **bounded and recursive** — materially more capable than older "one level deep" notes:

- **Depth cap.** `MAX_DEPTH = 6`. Once `depth > 6`, the walker returns `{}`. Non-object / null nodes also return `{}`.
- **`$ref` resolution + cycle guard.** A node with a string `$ref` (e.g. `#/definitions/User`) is resolved via `resolveRef` and walked (depth +1). A `Set` of already-visited `$ref` strings is threaded down each branch; re-encountering a `$ref` already on the current path returns `{}` (breaks reference cycles). Resolution failures (`throw` or `null` result) also yield `{}`.
- **`example` preference.** If the schema node has an `example` field, that value is returned verbatim (checked **after** `$ref`, before composition and `type`). This lets authors pin exact sample values.
- **`allOf` / `oneOf` / `anyOf` — first branch.** If any of these is a non-empty array, the walker recurses into **`branch[0]` only** (precedence `allOf` → `oneOf` → `anyOf`). It does not merge `allOf` members.
- **Type defaults:**

  | `schema.type` | Sample value |
  |---------------|--------------|
  | `string` | `enum[0]` if a non-empty `enum` is present, else `""` |
  | `integer` / `number` | `0` |
  | `boolean` | `false` |
  | `array` | `[ sample(items) ]` if `items` is present, else `[]` (one element) |
  | `object` (or no/unknown `type`) | walks each entry of `properties`, producing `{ key: sample }`; `{}` if no `properties` |

`sampleSchema` is shared verbatim with the v3 parser — same depth cap, cycle guard, and branch handling.

## `collectionFormat` for array query params

**Not implemented.** Swagger 2.0's `collectionFormat` (`csv` / `ssv` / `tsv` / `pipes` / `multi`) on array parameters is **not consulted anywhere** in the parser. A `query` parameter — array or scalar — produces exactly **one** `KeyValueEntry` with an empty value:

```ts
params.push({ key: param.name, value: "", enabled: true, ...(description ? { description } : {}) });
```

There is no per-value expansion, no separator joining, and no `multi` handling. The parameter's `type`, `items`, and `collectionFormat` are ignored entirely (the parser produces empty-value stubs regardless of declared type). `multi` does **not** emit one entry per value — it emits the same single empty-value entry as any other query param.

## Auth / security

Auth is applied **only at the root collection**; every request is `{ mode: "inherit" }`, so the user configures credentials once.

Primary-scheme selection in `parse`:

```ts
const reqName       = spec.security?.[0] ? Object.keys(spec.security[0])[0] : undefined;
const defs          = spec.securityDefinitions ?? {};
const primaryScheme = (reqName && defs[reqName]) || Object.values(defs)[0];
```

1. If `spec.security[0]` exists, take its first key and look it up in `securityDefinitions`.
2. Otherwise (or if that lookup is falsy) fall back to the **first** entry of `securityDefinitions`.

`swaggerSchemeToAuth(scheme)` maps the picked scheme to a concrete collection auth (always with empty secrets — the spec has no real credentials):

| `securityDefinitions` entry | Vayu `RequestAuth` |
|-----------------------------|--------------------|
| `type: "basic"` | `{ mode: "basic", username: "", password: "" }` |
| `type: "apiKey"` | `{ mode: "apikey", key: scheme.name ?? "", value: "", in: scheme.in === "query" ? "query" : "header" }` |
| `type: "oauth2"` | `{ mode: "oauth2", config: OAuth2Config }` via `mapSwaggerOAuth2` — maps the Swagger `flow` (`application` → client-credentials, `accessCode` → auth-code+PKCE, `password`, `implicit`→auth-code+PKCE), fills `tokenUrl`/`authorizationUrl`/`scope`, seeds `clientId`/`clientSecret` as `{{variables}}` |
| missing scheme / missing `type` / any other type | `{ mode: "none" }` |

**`nonExecutableAuth`:** always `0` — `oauth2` now maps to an executable config (as do bearer/basic/apikey).

## Options & lossy behavior

This parser is **stub-only**: it materializes the shape of each request but no values. The `ImportOptions` argument (`importEnvironments`, `importScripts`) is **ignored** — the parameter is `_opts` and is never read (identical to v3).

Dropped / not represented:

- **Scripts:** all `preRequestScript` / `postRequestScript` are `""` (Swagger has no scripts; `importScripts` has no effect here).
- **Environments:** none produced (`environments: []`, `meta.environmentCount: 0`). Swagger has no environment concept; the `scheme`/`host`/`basePath` triple becomes a single `baseUrl` collection variable.
- **Additional schemes:** only `schemes[0]` is used; other schemes are dropped.
- **`collectionFormat`, parameter `type` / `items`, `required`, `default`, `enum` on params:** not consumed — query/header/form params are always empty-value stubs.
- **`produces`, response schemas, response examples:** not consumed.
- **`authorization` / `content-type` header parameters:** dropped (Vayu manages them).
- **Path parameters as params:** not emitted (path params live in the URL only).
- **Multi-tag grouping:** only the first tag groups an operation.
- **`SkippedItem`s:** never emitted — `meta.skipped` is always `[]`.

`meta` population: `format = "OpenAPI 2.0 (Swagger)"`, `requestCount` = total operations built, `folderCount` = number of tag collections (`tagCollections.size`), `environmentCount = 0`, `skipped = []`, `nonExecutableAuth = 0` (oauth2 is now executable).

## Differences from OpenAPI 3.0

See [OpenAPI v3](./openapi-v3.md) for the v3 reference. Key contrasts:

| Aspect | v2 (Swagger) | v3 (OpenAPI 3.0) |
|--------|--------------|------------------|
| Detection | `swagger === "2.0"` (exact) | `openapi` is a string starting with `"3."` |
| Base URL | `schemes[0]` + `host` + `basePath` | `servers[0].url` |
| Request body | `in: "body"` / `in: "formData"` parameters | dedicated `op.requestBody` with `content` map |
| Body content-type decision | `consumes` (op → spec → JSON default) | media-type keys of `requestBody.content` |
| Text/non-JSON body | sampled schema serialized as JSON text | `text/plain` → empty string |
| Form bodies | `in: "formData"` params → `form-data` (overrides body param) | `multipart/form-data` / `x-www-form-urlencoded` from `content` |
| `$ref` namespace | `#/definitions/...` | `#/components/schemas/...` (resolver is generic in both) |
| Auth schemes | `securityDefinitions` (`basic`, `apiKey`, `oauth2`) | `components.securitySchemes` (`http`/bearer/basic, `apiKey`, `oauth2`) |
| Auth helper | `swaggerSchemeToAuth` | `schemeToAuth` |
| Collection build | inline in `parse` | helper `makeTagCollection` |

Shared between both: tree-by-first-tag, `{{baseUrl}}`-prefixed URLs, `normalizeVars` path conversion, `sampleSchema`, request `auth: inherit`, `ImportOptions` ignored, `meta.skipped` always empty.

## Shared helpers used

| Helper | Source | Use in this parser |
|--------|--------|--------------------|
| [`normalizeVars`](./README.md#normalizevars) | `var-normalize.ts` | convert Swagger `{param}` path templates → Vayu `{{param}}` in request URLs |
| `sampleSchema` | `schema-sampler.ts` | generate a sample JSON body from an `in: "body"` parameter `schema` (bounded, ref-resolving) |

This parser does **not** use the Postman/Insomnia helpers in `shared.ts` (`asString`, `toVarRecord`, `mapKeyValues`, `mapPostmanAuth`, `rawBody`, `joinExec`); it builds drafts directly. See the [index](./README.md#shared-helpers) for the full shared-helper reference.

## Related

- [Import pipeline index](./README.md)
- [OpenAPI v3 (OpenAPI 3.0)](./openapi-v3.md)
- [Postman Collection v2.1 / v2.0](./postman.md)
- [Insomnia v4](./insomnia-v4.md)
