# OpenAPI 3.0

Parses an OpenAPI 3.0.x specification into the Vayu draft model. OpenAPI is a **specification document, not a request log** - it describes endpoints, parameters, and schemas but carries no concrete values. The parser therefore emits **synthetic request stubs**: a `{{baseUrl}}` from the first server, query/header params with empty values, and a body sampled from the request schema. Users fill in real values after import.

- **Source:** `app/src/services/importers/openapi-v3.ts`
- **Exports:**

  | Symbol | `formatName` | `formatKey` |
  |--------|--------------|-------------|
  | `OpenApiV3Parser` (class, implements `ImportParser`) | `OpenAPI 3.0` | `openapi-v3` |
  | `schemeToAuth` (helper) | - | - |

  `OpenApiV3Parser` exposes `formatName` / `formatKey` as readonly fields and implements `detect` + `parse` from `./types`.

## Detection

```ts
detect(parsed) {
  const v = parsed?.openapi;
  return typeof v === "string" && v.startsWith("3.");
}
```

The top-level `openapi` field must be a string beginning with `"3."` (so `3.0.0`, `3.0.3`, and `3.1.x` all match). The 3.1 claim is honoured on the schema side too: `sampleSchema` reads the JSON-Schema keywords 3.1 adopted - type arrays (`type: ["string", "null"]`), `const`, and the plural `examples` (see [`sampleSchema`](#sampleschema-schema--stub-value)) - and a `{"$ref": ...}` path item, which 3.1 made common, is resolved rather than dropped. Swagger 2.0 (`swagger: "2.0"`, no `openapi` field) is handled by a separate parser - see [OpenAPI v2](./openapi-v2.md). The factory (`factory.ts`) parses the raw text once (JSON, then YAML fallback) and runs each parser's `detect` in registration order.

## Tree structure

The spec maps to a single root collection, with operations grouped into child collections by their first tag.

- **Root collection** ← the whole spec (named from `info.title`). It directly holds:
  - `requests`: every **untagged** operation.
  - `children`: one child collection per distinct first-tag, in first-encounter order.
- **Tag child collections** ← created lazily by `makeTagCollection(spec, tag)` the first time a tag is seen, keyed in a `Map<string, CollectionDraft>`. Description comes from the matching entry in the top-level `tags[]` array (if any).

Iteration order: `parse` loops over `spec.paths` entries, resolves each path item through `resolvePathItem` (`openapi-shared.ts`) so a `{"$ref": "#/components/pathItems/X"}` item is read from its target instead of contributing nothing, and then loops over the fixed `HTTP_METHODS` list (`get, post, put, patch, delete, head, options`). A path item that is not an object - or whose `$ref` does not resolve to one - is counted as a `malformed_spec` [`SkippedItem`](./README.md#draft-model-the-parser-output-contract) and skipped, so the drop is named in the preview rather than silent. The ref is followed **one hop only**, like the parameter and `requestBody` refs. For each present operation `parse` calls `buildOperation(...)`, then routes by tag:

```ts
const tag = op.tags?.[0];   // ONLY the first tag is used
if (tag) tagCollections.get(tag).requests.push(req);
else     rootRequests.push(req);
```

**Multi-tag operations:** only `op.tags[0]` is consulted. An operation with `tags: ["a", "b"]` lands solely in the `a` child collection; `b` is ignored (no duplication, no extra folder). An operation with no `tags` (or `tags: []`) becomes a root request.

**`trace` operations:** OpenAPI 3's Path Item Object also defines `trace`, which is **not** in `HTTP_METHODS` because `HttpMethod` (`types/domain.ts`) has no `"TRACE"` - Vayu cannot execute one. A `trace` operation is therefore not built, is **not** counted in `requestCount`, and is counted as an `unsupported_method` `SkippedItem` so the preview says so. `UNSUPPORTED_METHODS` in `openapi-v3.ts` is the list; `trace` is its only member, since a path item defines exactly the eight methods.

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
| `op.responses` | `examples` | via `buildExamples` (see [Documented responses](#documented-responses)); **absent** when nothing was representable |

**Parameter resolution & merge.** `buildOperation` concatenates path-item-level `parameters` with operation-level `op.parameters`, resolving any `$ref` entries via `resolveRef`. Each parameter is keyed by `` `${in}:${name}` `` in a `Map`, so an operation-level parameter **overrides** a path-level one with the same `in`+`name` (later writes win). Entries missing `in` or `name` after resolution are skipped.

Both lists go through `SkipTally.params` (`openapi-shared.ts`) first. `parameters` is an array per the spec, but a missing `-` in hand-written YAML makes it a mapping, and spreading that used to throw `is not iterable` and abort the **whole file**. A present-but-non-array `parameters` is now treated as empty and counted as a `malformed_spec` `SkippedItem` (once per offending list); an absent `parameters` is normal and counted as nothing. Every other path in the file still imports.

### Documented responses

`op.responses` was visited by no code path before issue #481 - the parser sampled request bodies and walked straight past the half of the spec that says what comes back, so an imported API description documented no responses at all. Each entry now becomes an `ExampleDraft`, stored against the request and (once the mock server lands) served from it.

| OpenAPI (`op.responses[code]`) | Vayu `ExampleDraft` | Notes |
|--------------------------------|---------------------|-------|
| the key | `status` | must be a three-digit `100`-`599` code; see below |
| `description` | `name` | `"{code} - {description}"`, or the bare code when the response describes nothing |
| the JSON media type's `example` → first `examples[*].value` → `sampleSchema(schema)` | `body` | the same precedence `buildBody` uses for a request body; a string is stored as-is, anything else is `JSON.stringify(value, null, 2)` |
| the JSON media type key | `contentType`, and a single `Content-Type` header | `application/json`, an `application/json;…` variant or a `+json` suffix, by the same rule request bodies use |

A response `$ref` is resolved (single hop, like the parser's other refs). An `examples` entry is unwrapped from its Example Object - the payload is in `value`, and storing the wrapper would put a body on disk no server would send; an `externalValue` names a URL rather than carrying a payload, so it yields nothing (an import must not fetch).

A response that documents **no body** still imports: `204 No Content` is a real answer and a mock server has to be able to give it.

A key that is not a numeric status - `default`, or a `2XX` wildcard - is **skipped and counted** as `example_no_status`. It documents a real response, but an example is served under one status line and there is no honest value to pick.
| tag groups | `children` | `[...tagCollections.values()]` |
| untagged operations | `requests` | |

### Collection (per tag)

Built by `makeTagCollection(spec, tag)`.

| OpenAPI | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `tag` (the string) | `name` | |
| `tags[].description` where `tags[].name === tag` | `description` | fallback `""` |
| (none) | `variables` | always `{}` (baseUrl lives only on the root) |
| (none) | `auth` | always `{ mode: "none" }` - tag collections do not carry security |
| (none) | `children` | always `[]` (tags are flat; no nesting) |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

### Request (per operation)

Built by `buildOperation(method, path, op, resolveRef, pathParams)`.

| OpenAPI | Vayu `RequestDraft` | Notes |
|---------|---------------------|-------|
| `op.summary` → `op.operationId` → `"{METHOD} {path}"` | `name` | precedence in that order; final fallback uses upper-cased method + raw path, e.g. `"GET /users/{id}"` |
| `op.description` | `description` | fallback `""` |
| HTTP method | `method` | `method.toUpperCase()` (e.g. `get` → `GET`), cast to `HttpMethod` |
| `path` | `url` | `` `{{baseUrl}}${normalizeVars(path, { pathTemplates: true })}` `` - always prefixed with `{{baseUrl}}`, even if no server was defined (see [URL](#url--path-parameters)) |
| parameters with `in: "query"` | `params` | `{ key: name, value: "", enabled: true, description? }` - `description` included only when present. `parseImport` also joins them onto the `url` as **bare keys** (`?verbose`), since the stub carries no value - see [The url/params invariant](./README.md#the-urlparams-invariant) |
| parameters with `in: "header"` | `headers` | `{ key: name, value: "", enabled: true }` - **no description carried**; `authorization` and `content-type` headers are dropped (case-insensitive) since Vayu manages those |
| parameters with `in: "path"` / `in: "cookie"` | - | not emitted as params/headers; path params are represented in the URL via `normalizeVars`. Cookie params are dropped. |
| `op.requestBody` | `body` | via `buildBody` (see [Request body](#request-body-generation)) |
| (none) | `auth` | always `{ mode: "inherit" }` - auth is configured once at the collection level |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

## URL & path parameters

- The request `url` is always `` `{{baseUrl}}${normalizeVars(path, { pathTemplates: true })}` ``. `{{baseUrl}}` is a Vayu collection variable resolved from `servers[0].url` at import time (defined on the root collection). If the spec has no `servers`, `baseUrl` is absent from the root variables and `{{baseUrl}}` resolves to empty at runtime.
- OpenAPI path templates `{param}` are converted to Vayu `{{param}}` by `normalizeVars` (`var-normalize.ts`). With `pathTemplates` (which only the OpenAPI/Swagger parsers pass) it rewrites single-brace `{x}` (identifier chars `[\w$-]`) to `{{x}}`, while leaving any existing `{{...}}` pairs intact. So `/users/{userId}/posts/{postId}` becomes `/users/{{userId}}/posts/{{postId}}`. Path parameters are **not** also emitted as `params` entries - they live only in the URL.

## Request body generation

`buildBody(requestBody, resolveRef)` resolves a top-level `$ref` on the `requestBody`, then inspects `content`:

| `content` media type | Vayu `RequestBody` | How content is produced |
|----------------------|--------------------|-------------------------|
| `application/json` (also any key starting with `application/json` or ending in `+json`, via `findJsonMedia`) | `{ mode: "json", content }` | `content = JSON.stringify(media.example ?? sampleSchema(media.schema), null, 2)`. The media-object `example` wins over the schema; if neither exists, `{}`. |
| `text/plain` | `{ mode: "text", content: "" }` | empty string (the schema is not sampled for text bodies) |
| `application/x-www-form-urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `fields` = one `{ key, value: "", enabled: true }` per field from `schemaFormFields(schema)` |
| `multipart/form-data` | `{ mode: "form-data", fields }` | same as urlencoded, except a `format: binary` field becomes a **file part** (see [File parts](#file-parts)) |
| no `content`, or none of the above | `{ mode: "none" }` | |

### File parts

A multipart property declared `format: "binary"` - OpenAPI 3's only spelling of "a file" - imports as a **file part**: `{ key, value: "", enabled: true, type: "file", src: "" }`. `type: array` of binary items (the multi-file field) maps to one file row, since Vayu's model is one file per row; one file the user can attach beats a text row that sends nothing. Until this landed both became ordinary empty-value text rows, so an operation documenting an upload produced a request that looked healthy and sent nothing.

The part carries **no path**: a spec documents *that* a field is an upload, never *which* file it uploads. The user picks the file in the request editor, and the engine refuses the send by field name until they do (`Form field 'avatar' is a file part with no file selected`). The row is deliberately **not** marked `unresolved` - that flag warns that a path came from somewhere else and was never verified here, and there is no path to warn about; the row reads "Choose file", exactly like one a user turned into a file part by hand.

Only under `multipart/form-data`. `application/x-www-form-urlencoded` has no file form on the wire, so a `format: binary` property there is a spec that cannot mean what it says; the field stays a text row rather than becoming a part the body could never carry.

The import preview counts these as `N file parts need a file`, beside the skip counters, so a spec full of uploads says so before the import rather than one failed send at a time.

JSON is preferred: `findJsonMedia` is checked first and takes precedence over text/form variants. The `x-www-form-urlencoded` / `multipart/form-data` branch reads property **names**, plus each property's `format` to tell an upload from a text field - `required`, defaults and nested structure are not sampled into form fields.

**Form field names resolve `$ref` and `allOf`, exactly as far as a JSON body does.** `schemaFormFields(schema, resolveRef)` (`schema-sampler.ts`) samples the schema and returns the stub's own keys, rather than reading `schema.properties` directly. That key does not exist on a schema written as `{"$ref": "#/components/schemas/TokenRequest"}` or as an `allOf` - the shape generators emit - which used to yield the right body mode with an **empty** field list and no warning anywhere. Consequences of going through the sampler: composition follows the **first** branch only (the same rule JSON bodies get, not an `allOf` merge), and a schema that samples to a non-object (a scalar, an array, or an `example` that is not an object) contributes no field names.

### `sampleSchema` (schema → stub value)

`sampleSchema(schema, resolveRef)` in `schema-sampler.ts` generates a sample JSON value by walking the schema. It is **bounded and recursive** - materially more capable than a one-level stub:

- **Depth cap.** `MAX_DEPTH = 6`. Once `depth > 6`, the walker returns `{}`. Non-object / null nodes also return `{}`.
- **`$ref` resolution + cycle guard.** A node with a string `$ref` is resolved via `resolveRef` and walked (depth +1). A `Set` of already-visited `$ref` strings is threaded down each branch; re-encountering a `$ref` already on the current path returns `{}` (breaks reference cycles). Resolution failures (`throw` or `null` result) also yield `{}`.
- **Pinned-value precedence:** `const` → `example` → `examples[0]`, all checked **after** `$ref` and before composition and `type`.
  - **`const`** (JSON Schema, so OpenAPI 3.1) is returned verbatim and **outranks `example`**: it says the value MUST be exactly this, where `example` is only an annotation. `const: null` samples as `null`.
  - **`example`** is returned verbatim - this is how authors pin exact sample values.
  - **`examples`** is 3.1's plural replacement for `example`; its **first** entry is used when there is no singular `example`. An empty `examples: []` is ignored.
- **`allOf` / `oneOf` / `anyOf` - first branch.** If any of these is a non-empty array, the walker recurses into **`branch[0]` only** (precedence `allOf` → `oneOf` → `anyOf`). It does not merge `allOf` members; it just samples the first.
- **Type arrays (3.1).** 3.1 writes a nullable field as `type: ["string", "null"]` where 3.0 wrote `nullable: true`. The walker samples the **first non-`"null"`** member, so such a field gets the typed stub the user edits rather than the `{}` an unmatched type used to produce. A type whose only member is `"null"` (and the scalar `type: "null"`) samples as `null`.
- **Type defaults:**

  | `schema.type` | Sample value |
  |---------------|--------------|
  | `string` | `enum[0]` if a non-empty `enum` is present, else `""` |
  | `integer` / `number` | `0` |
  | `boolean` | `false` |
  | `null` | `null` |
  | `array` | `[ sample(items) ]` if `items` is present, else `[]` (one element) |
  | `object` (or no/unknown `type`) | walks each entry of `properties`, producing `{ key: sample }`; `{}` if no `properties` |

  The `object`/default branch is the same fallback used for untyped schemas - a node with `properties` but no `type` is still expanded.

`schemaFormFields(schema, resolveRef)` is the form-body wrapper over this: it samples the schema, returns `Object.keys()` of the result (`[]` for a non-object sample), and marks each field text or file. The file flag is read off the **property schema**, not the sampled value: the sampler turns a `format: binary` string into `""`, which no longer says anything about the field. See [Request body generation](#request-body-generation).

> Older notes claimed sampling was "one level only" and "`oneOf` → `{}`". That is **not** what the code does: sampling recurses to depth 6, resolves and cycle-guards `$ref`s, honors `example`, and follows the first branch of `oneOf`/`anyOf`/`allOf`.

## Auth / security

Auth is applied **only at the root collection**; every request is `{ mode: "inherit" }`, so the user configures credentials once.

`pickPrimaryScheme(spec)` chooses one scheme:

1. If `spec.security[0]` exists, take its first key (`Object.keys(security[0])[0]`) and use the matching `components.securitySchemes[name]`.
2. Otherwise fall back to the **first** entry of `components.securitySchemes`.

`schemeToAuth(scheme)` maps that scheme to a concrete collection auth (always with empty secrets - the spec has no real credentials):

| `securityScheme` | Vayu `RequestAuth` |
|------------------|--------------------|
| `type: "http"`, `scheme: "bearer"` | `{ mode: "bearer", token: "" }` |
| `type: "http"`, `scheme: "basic"` | `{ mode: "basic", username: "", password: "" }` |
| `type: "apiKey"` | `{ mode: "apikey", key: scheme.name ?? "", value: "", in: scheme.in === "query" ? "query" : "header" }` |
| `type: "oauth2"` | `{ mode: "oauth2", config: OAuth2Config }` via `mapOpenApiV3OAuth2` - picks the first usable flow (`clientCredentials` → `authorizationCode`+PKCE → `password` → `implicit`→auth-code+PKCE), fills its `tokenUrl`/`authorizationUrl`/`scope`, and seeds `clientId`/`clientSecret` as `{{clientId}}`/`{{clientSecret}}` placeholders |
| missing / any other type (incl. `openIdConnect`, `http` with other schemes) | `{ mode: "none" }` |

**`nonExecutableAuth`:** always `0` - `oauth2` now maps to an executable config, and the other mapped schemes (bearer/basic/apikey) are executable too.

## Options & lossy behavior

This parser is **stub-only**: it materializes the shape of each request but no values. The `ImportOptions` argument (`importEnvironments`, `importScripts`) is **ignored** - the parameter is `_opts` and is never read.

Dropped / not represented:

- **Scripts:** all `preRequestScript` / `postRequestScript` are `""` (OpenAPI has no scripts; `importScripts` has no effect here).
- **Environments:** none produced (`environments: []`, `meta.environmentCount: 0`). OpenAPI has no environment concept; `servers[0]` becomes a single `baseUrl` collection variable.
- **Additional servers:** only `servers[0]` is used; other entries and per-operation `servers` overrides are dropped.
- **Callbacks, links, security scopes:** not consumed. (Response schemas and examples *are*, since issue #481 - see [Documented responses](#documented-responses).)
- **Response headers** (`responses[code].headers`): not imported. An example's headers carry only the media type it was stored under.
- **Cookie parameters** and **path parameters as params**: not emitted (path params live in the URL only).
- **`authorization` / `content-type` header parameters:** dropped (Vayu manages them).
- **Multi-tag grouping:** only the first tag groups an operation.
- **`trace` operations:** dropped - `HttpMethod` has no `"TRACE"`. Counted as `unsupported_method` (see [Tree structure](#tree-structure)), not silently omitted.
- **A path item, or a `parameters` list, whose shape the spec does not allow:** stepped over and counted as `malformed_spec` so the rest of the file still imports.
- **Form-field property schemas:** only field **names** and whether the field is a file (`format: binary`) are imported; `required`, other types, and nested structure are not.
- **A whole-body binary** (`application/octet-stream` and other non-form, non-JSON, non-text media types): no body is produced (`{ mode: "none" }`) and nothing is counted - unlike a multipart file part, which imports (see [File parts](#file-parts)).

`meta` population: `format = "OpenAPI 3.0"`, `requestCount` = total operations built (TRACE excluded), `folderCount` = number of tag collections, `environmentCount = 0`, `exampleCount` = example responses imported (read off the finished drafts by `countExamples`), `nonExecutableAuth = 0` (oauth2 is now executable), `unattachedFileParts` = file parts imported with no file attached (`unattachedFileParts`, read off the finished drafts), and `skipped` from the `SkipTally`:

| `SkippedItem.kind` | Counted when |
|--------------------|--------------|
| `unsupported_method` | a path item carries a `trace` operation |
| `malformed_spec` | a path item is not an object / its `$ref` does not resolve; or a `parameters` value is present but not an array |
| `example_no_status` | a response key is not a three-digit status - `default`, or a `2XX` wildcard |

An import with nothing to report still yields `skipped: []` - only non-zero kinds are emitted.

## Shared helpers used

| Helper | Source | Use in this parser |
|--------|--------|--------------------|
| [`normalizeVars`](./README.md#normalizevars) | `var-normalize.ts` | convert OpenAPI `{param}` path templates → Vayu `{{param}}` in request URLs |
| `sampleSchema` | `schema-sampler.ts` | generate a sample JSON body from a request `schema` (bounded, ref-resolving) |
| `schemaFormFields` | `schema-sampler.ts` | field names for an urlencoded / multipart body, resolved through the sampler, each flagged text or file |
| `importedFilePart`, `unattachedFileParts` | `shared.ts` | build a file form row; count the rows that still need a file, for `meta` |
| `resolvePathItem`, `SkipTally` | `openapi-shared.ts` | resolve a `$ref`'d path item; guard `parameters` and tally what was dropped |
| `responseExample`, `findJsonMediaType`, `firstNamedExample`, `exampleBodyText`, `deref` | `openapi-shared.ts` | map one `responses` entry to an example draft; the halves the two OpenAPI parsers share |
| `countExamples` | `shared.ts` | total the examples across the finished drafts, for `meta.exampleCount` |

This parser does **not** use the Postman/Insomnia-shaped helpers in `shared.ts` (`asString`, `toVarRecord`, `mapKeyValues`, `mapPostmanAuth`, `rawBody`, `joinExec`); it builds drafts directly. See the [index](./README.md#shared-helpers) for the full shared-helper reference.

## Related

- [Import pipeline index](./README.md)
- [OpenAPI v2 (Swagger 2.0)](./openapi-v2.md)
- [Postman Collection v2.1 / v2.0](./postman.md)
- [Insomnia v4](./insomnia-v4.md)
