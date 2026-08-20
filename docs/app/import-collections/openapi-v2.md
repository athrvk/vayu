---
description: >-
  What Vayu generates from a Swagger 2.0 specification - one collection per tag, request stubs, parameters, security schemes, and sampled bodies.
---

# OpenAPI 2.0 (Swagger)

Parses a Swagger 2.0 specification into the Vayu draft model. Swagger 2.0, like OpenAPI 3.0, is a **specification document, not a request log** - it describes endpoints, parameters, and schemas but carries no concrete values. The parser therefore emits **synthetic request stubs**: a `{{baseUrl}}` built from `schemes`/`host`/`basePath`, query and header params carrying a declared `default` when there is one (and importing disabled when there is not - see [Parameter values & enabled state](#parameter-values--enabled-state)), and a body sampled from the `in: "body"` parameter schema. Users fill in real values after import.

The document is not thrown away once it has been read. The collection it
produces is **bound** to it: the spec is stored verbatim (with the URL it was
fetched from, when there was one), and every request records which operation it
is - `operationId`, method, and the templated path. See
[OpenAPI Collections](../openapi.md) for what the binding is for and what the
collection's Spec tab does with it.

The requests this parser builds are mirrored engine-side as well (issue #865,
`core::spec_request_drafts_of`), for the reason and under the conformance
fixture written out in [OpenAPI 3.0](./openapi-v3.md#operation-identity) - both
dialects are read by that one port, so a 2.0 rule changed here changes there too.

- **Source:** `engine/src/core/import_document.cpp + openapi_drafts.cpp`
- **Exports:**

> **The parse moved engine-side** (issue
> [#877](https://github.com/athrvk/vayu/issues/877)). Every rule on this page is
> the same rule it always was - the corpus in
> `engine/tests/fixtures/import-conformance.json` was recorded from the parser
> this replaced and is asserted against on every build - it is simply read by
> `engine/src/core/import_document.cpp` now, behind
> [`POST /import/parse`](../../engine/api-reference.md#post-importparse), rather
> than in the renderer. Module names in C++ style below name that file's
> functions; the app holds no parser.

  | Symbol | `formatName` | `formatKey` |
  |--------|--------------|-------------|
  | `OpenApiV2Parser` (class, implements `ImportParser`) | `OpenAPI 2.0 (Swagger)` | `openapi-v2` |
  | `swaggerSchemeToAuth` (helper) | - | - |

  `OpenApiV2Parser` exposes `formatName` / `formatKey` as readonly fields and implements `detect` + `parse` from `./types`.

## Detection

```ts
detect(parsed) {
  const claimed = parsed?.swagger;
  return claimed === "2.0" || claimed === 2;
}
```

The top-level `swagger` field must be the string `"2.0"` or the **number** `2` (issue #719). The string is what the specification says and what every JSON export writes - JSON has no other option, since the key is quoted or the file is not valid. Hand-written YAML routinely leaves it unquoted, and js-yaml then loads `2.0` as the number `2`, so a string comparison alone reported an ordinary Swagger file as "Unrecognised format". The v3 side never had this problem for a reason that does not generalise: `3.0.3` has two dots, so it stays a string whatever the quoting. Only detection needs the widening - nothing in `parse` reads the field, and the document is stored as the bytes it arrived as, so there is no normalized copy to keep in step. OpenAPI 3.x (the `openapi` field, no `swagger`) is handled by a separate parser - see [OpenAPI v3](./openapi-v3.md). The factory (`core::parse_import`) parses the raw text once (JSON, then YAML fallback) and runs each parser's `detect` in registration order.

## Tree structure

The spec maps to a single root collection, with operations grouped into child collections by their first tag - or, for an operation that declares no tag, by the first meaningful segment of its path (issue #710).

- **Root collection** ← the whole spec (named from `info.title`). It directly holds:
  - `requests`: every operation that has neither a tag nor a groupable path.
  - `children`: one child collection per distinct folder name, in first-encounter order.
- **Child collections** ← created lazily by `OperationFolders` (`openapi_drafts.cpp`), the first time a name is seen. A tag-named folder takes its description from the matching entry in the top-level `tags[]` array (if any); a path-named folder has none.

Iteration order: `parse` loops over `spec.paths` entries, and for each path item over the fixed `HTTP_METHODS` list (`get, post, put, patch, delete, head, options`). For each present operation it calls `buildSwaggerOp(...)`, then routes by tag:

```ts
const tag  = op.tags?.[0];              // ONLY the first tag is used
const name = tag ?? pathFolderName(path);  // the fallback, per operation
if (name) folders.get(name).requests.push(req);
else      rootRequests.push(req);
```

**Multi-tag operations:** only `op.tags[0]` is consulted. An operation with `tags: ["a", "b"]` lands solely in the `a` child collection; `b` is ignored (no duplication, no extra folder).

**Untagged operations** take the same path fallback the v3 parser does, from the same `OperationFolders` - the rule, its version/`api`/`{template}` skips and `meta.folderStrategy` are written out once, in [OpenAPI 3.0](./openapi-v3.md#tree-structure).

Unlike v3 (which has a dedicated `buildBody` helper), v2 builds the root collection inline in `parse` and delegates only the per-operation draft to `buildSwaggerOp`. `$ref` resolution comes from `walk::resolve_ref` (`openapi_drafts.cpp`), the same one the v3 parser uses - both had built it by hand, identically, until issue #649.

References naming **other files** (`./definitions/pet.yaml#/Pet`) are resolved before this parser runs, by `ref-bundler.ts`; what could not be reached is counted as an `external_ref` `SkippedItem`. The rules are the same for both OpenAPI parsers and are written out in [OpenAPI 3.0](./openapi-v3.md#external-refs) and [OpenAPI Collections](../openapi.md#specs-written-across-several-files).

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
| tag and path groups | `children` | `folders.children()` |
| operations with neither | `requests` | |

### Collection (per folder)

Built by `OperationFolders` (`openapi_drafts.cpp`), shared with the v3 parser.

| Swagger | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `tag` (the string) | `name` | |
| `tags[].description` where `tags[].name === tag` | `description` | fallback `""` |
| (none) | `variables` | always `{}` (baseUrl lives only on the root) |
| (none) | `auth` | always `{ mode: "none" }` - tag collections do not carry security |
| (none) | `children` | always `[]` (tags are flat; no nesting) |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

### Request (per operation)

Built by `buildSwaggerOp(method, path, op, spec, resolveRef, pathParams, tally, specOperation)`.

| Swagger | Vayu `RequestDraft` | Notes |
|---------|---------------------|-------|
| `op.summary` → `op.operationId` → `"{METHOD} {path}"` | `name` | precedence in that order; final fallback uses upper-cased method + raw path, e.g. `"GET /users/{id}"` |
| `op.description` | `description` | fallback `""` |
| HTTP method | `method` | `method.toUpperCase()` (e.g. `get` → `GET`), cast to `HttpMethod` |
| `path` | `url` | `` `{{baseUrl}}${normalize_path_templates(path)}` `` - always prefixed with `{{baseUrl}}`, even if no `host` was defined (see [URL](#url--path-parameters)) |
| parameter `in: "query"` | `params` | `{ key: name, value, enabled, description? }` via `declared_param_row` - `description` included only when present; `value` and `enabled` follow [Parameter values & enabled state](#parameter-values--enabled-state). Only the enabled rows are joined onto the `url` by `parseImport` - see [The url/params invariant](./README.md#the-urlparams-invariant) |
| parameter `in: "header"` | `headers` | `{ key: name, value, enabled }` via the same `declared_param_row` - **no description carried** (the Headers table has no column for one); `authorization` and `content-type` headers are dropped (case-insensitive) since Vayu manages those |
| parameter `in: "body"` | `body` | sampled via `Sampler::sample`; JSON vs text decided by `consumes` (see [Parameters & body](#parameters--body)) |
| parameter `in: "formData"` | `body` | collected into form fields; the encoding (`x-www-form-urlencoded` vs `form-data`) comes from `consumes` (see [`consumes` → body mode](#consumes--body-mode)) |
| parameter `in: "path"` | - | not emitted as params/headers; path params are represented in the URL via `normalize_template_vars` |
| (none) | `auth` | always `{ mode: "inherit" }` - auth is configured once at the collection level |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |
| `op.responses` | `examples` | via `buildSwaggerExamples` (see [Documented responses](#documented-responses)); **absent** when nothing was representable |
| `op.operationId`, method, `path` | `specOperation` | the operation this request is, recorded for [sync](../openapi.md#checking-a-bound-spec-for-changes). Claimed by the one walk, so an `operationId` this document declares twice is kept on the first operation only and the second is identified by method and path - the rule and its reason are written out in [OpenAPI 3.0](./openapi-v3.md#operation-identity) |

**Parameter resolution & merge.** `buildSwaggerOp` concatenates path-item-level `parameters` (passed in as `pathParams`) with operation-level `op.parameters`, resolving any `$ref` entries via `resolveRef`. Each parameter is keyed by `` `${in}:${name}` `` in a `Map` (`byKey`), so an operation-level parameter **overrides** a path-level one with the same `in`+`name` (later writes win). Entries missing `in` or `name` after resolution are skipped.

Both lists go through the walk's `parameters` guard (`openapi_drafts.cpp`) first, shared with the v3 parser: a `parameters` value that is present but **not an array** (the missing-`-` YAML mistake) used to throw `is not iterable` and abort the whole file. It is now treated as empty and counted as a `malformed_spec` [`SkippedItem`](./README.md#draft-model-the-parser-output-contract); an absent `parameters` is normal and counted as nothing.

**Path items.** Each `spec.paths` entry goes through `walk::resolve_single_hop` (`openapi_drafts.cpp`) before its methods are read, so a path item written as `{"$ref": "..."}` contributes its target's operations instead of vanishing (Swagger 2.0 allows a path-item ref; the resolver is generic, so any in-document pointer works). One hop only. A path item that is not an object, or whose `$ref` does not resolve to one, is counted as `malformed_spec` and skipped.

### Documented responses

Saved example responses (issue #481), from the half of the spec that says what comes back. The 2.0 shape differs from v3 in where the payload lives - `examples` is keyed by MIME type and holds the value **directly** (no Example Object wrapper), and `schema` sits on the response itself rather than under a media type - so this parser supplies that half and shares everything else with v3 through `response_example` (`openapi_drafts.cpp`).

| Swagger (`op.responses[code]`) | Vayu `ExampleDraft` | Notes |
|--------------------------------|---------------------|-------|
| the key | `status` | must be a three-digit `100`-`599` code |
| `description` | `name` | `"{code} - {description}"`, or the bare code |
| `examples[<media type>]` → `sampleSchema(schema)` | `body` | documented example first, generated sample second - the same precedence this file already uses for a request body |
| `op.produces` → `spec.produces` | `contentType`, and a single `Content-Type` header | a 2.0 response does not name its own media type; the JSON entry wins, and a spec that lists no `produces` at all is treated as `application/json` |

A response that documents no body still imports (`204` is a real answer), and a key that is not a numeric status is skipped and counted: `default` as `default_response`, a wildcard or junk key as `example_no_status` - counted apart for the reason [OpenAPI 3.0](./openapi-v3.md#documented-responses) gives.

## Base URL construction

The base URL is assembled from three top-level spec fields and stored as the `baseUrl` collection variable on the root only:

```ts
const scheme   = (spec.schemes?.[0] as string) ?? "https";
const basePath = spec.basePath && spec.basePath !== "/" ? spec.basePath : "";
const baseUrl  = spec.host ? `${scheme}://${spec.host}${basePath}` : "";
```

- **Scheme** - the **first** entry of `schemes[]`; if `schemes` is absent/empty, defaults to `"https"`. Additional schemes (`http`, `ws`, `wss`, …) are **ignored** - only `schemes[0]` is used.
- **`basePath`** - appended verbatim **unless** it is missing or exactly `"/"` (in which case it contributes nothing, avoiding a trailing `//`).
- **`host`** - required for a base URL. If `host` is absent, `baseUrl` is `""`, no `baseUrl` variable is added (root `variables` stays `{}`), and request URLs still carry the literal `{{baseUrl}}` prefix (resolving to empty at runtime).

Examples (`host: "api.example.com"`):

| `schemes` | `basePath` | `baseUrl` |
|-----------|-----------|-----------|
| `["https"]` | `"/v2"` | `https://api.example.com/v2` |
| `["http", "https"]` | `"/v2"` | `http://api.example.com/v2` (first scheme only) |
| (absent) | `"/"` | `https://api.example.com` (default scheme, `/` dropped) |
| `["https"]` | (absent) | `https://api.example.com` |

When set, the value is stored as `variables.baseUrl = { value: baseUrl, enabled: true }`.

## URL & path parameters

- The request `url` is always `` `{{baseUrl}}${normalize_path_templates(path)}` ``. `{{baseUrl}}` is the Vayu collection variable described above (defined on the root collection). If the spec has no `host`, `baseUrl` is absent from the root variables and `{{baseUrl}}` resolves to empty at runtime.
- Swagger path templates `{param}` are converted to Vayu `{{param}}` by `normalize_template_vars` (`path_template.cpp`). With `pathTemplates` (which only the OpenAPI/Swagger parsers pass) it rewrites single-brace `{x}` (identifier chars `[\w$-]`) to `{{x}}`, while leaving any existing `{{...}}` pairs intact. So `/users/{userId}/posts/{postId}` becomes `/users/{{userId}}/posts/{{postId}}`. Path parameters (`in: "path"`) are **not** also emitted as `params` entries - they live only in the URL.

## Parameters & body

Swagger 2.0 has **no `requestBody` object** (unlike v3). Request bodies are expressed as ordinary `parameters` with a special `in` value. `buildSwaggerOp` iterates the resolved, deduped parameters and dispatches on `param.in`:

| `param.in` | Effect | Detail |
|------------|--------|--------|
| `query` | push to `params` | `declaredParamRow(name, param.default, param.required, description)`; `description` only when present (see [Parameter values & enabled state](#parameter-values--enabled-state)) |
| `header` | push to `headers` | `declaredParamRow(name, param.default, param.required)` - same rule, no `description`; skipped when `name.toLowerCase()` is `authorization` or `content-type` |
| `body` | set `body` | `sample = param.schema ? sampleSchema(param.schema, resolveRef) : {}`; serialized with `JSON.stringify(sample, null, 2)`. Mode is JSON or text per `consumes` (below). |
| `formData` | collect into `formFields` | `{ key: name, value: "", enabled: true }` per field; a `type: file` parameter becomes a **file part** instead (see [`type: file` fields](#type-file-fields)) |
| (anything else) | ignored | no `default` case action |

After the loop, **form data wins**: if any `formData` fields were collected, `body` is unconditionally replaced with `{ mode: formMode, fields: formFields }` - overriding any body set by an `in: "body"` parameter. (A spec mixing both would be unusual, but the code resolves it in favor of the form.) `formMode` comes from `consumes`, below.

### Parameter values & enabled state

A spec's `parameters` list declares what an operation **accepts**, not what every request should **send** - and an enabled row reaches the wire either way: a query row through the [url/params join](./README.md#the-urlparams-invariant), a header row as a header the request claims to send. `declared_param_row` (`openapi_drafts.cpp`, shared with the [OpenAPI 3 parser](./openapi-v3.md#parameter-values--enabled-state) and applied to `in: "query"` and `in: "header"` alike) decides both fields from the parameter alone:

| Parameter declares | `value` | `enabled` |
|--------------------|---------|-----------|
| a scalar `default` | that value as text (`25`, `false`) | `true` |
| `required: true`, no `default` | `""` | `true` - a query row joins as a bare key (`?tenant`), a header row is listed with an empty value; either is the cue to fill it in |
| nothing, and not required | `""` | **`false`** |

`default` is the only value keyword read: Swagger 2.0 has no `example` for a non-body parameter (the Example Object arrived with v3), and `enum` lists what is allowed rather than what to send. Only scalars become a value - an array or object `default` is serialized by `collectionFormat`, which this parser does not read (below), so such a parameter imports value-less. A declared `""` is value-less too: an empty-value row writes as a bare key, so `?q=` is not a shape the Params table can hold.

Why optional value-less parameters import **disabled** (issues #622, #658): the row is documentation ("this endpoint accepts `verbose`"), not intent ("send `verbose` always"). Enabled, a query row joined the stored URL as `?verbose`, which some APIs read as `verbose=true`, and a header row claimed an `X-Request-Id:` with nothing in it - both a wire change nobody chose. Disabled, the row is still listed in its table one click from use.

### `consumes` → body mode

`consumes` drives two decisions: JSON-vs-text for an `in: "body"` parameter, and urlencoded-vs-multipart for `formData` fields.

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

Note the text branch still serializes the sampled schema to JSON text (it does not blank the body - this differs from v3's `text/plain` handling, which emits an empty string).

#### `consumes` → form encoding

Swagger 2.0 ties `formData` encoding to `consumes`, and `application/x-www-form-urlencoded` and `multipart/form-data` are distinct wire encodings that Vayu models as distinct body modes. Importing every `formData` operation as multipart (which is what this parser did unconditionally) sent a classic urlencoded login/token endpoint out as multipart, and the server rejected it with a 400/415 that nothing in the import explained. The rule now:

| `consumes` (operation, else spec-level) | Form body mode |
|---|---|
| lists `application/x-www-form-urlencoded` and **not** `multipart/form-data` | `x-www-form-urlencoded` |
| lists `multipart/form-data` | `form-data` |
| lists **both** | `form-data` - only multipart can carry a `type: file` field |
| absent, or names neither | `form-data` (the historical default is preserved) |

Entries are compared on the media type alone, so a `charset`/`boundary` parameter (`application/x-www-form-urlencoded; charset=utf-8`) still matches.

One case overrides the table: **a form carrying a file part is always `form-data`**, whatever `consumes` says. Only multipart has a file form on the wire, so a spec that declares `type: file` under a urlencoded-only `consumes` contradicts itself, and multipart is the half of the contradiction that can carry the field.

#### `type: file` fields

A `formData` parameter with `type: file` imports as a **file part** - `{ key, value: "", enabled: true, type: "file", src: "" }` - not as a text row. Until this landed it became an ordinary empty-value text row, so an operation documenting an upload produced a request that looked healthy and sent nothing (the silent-loss class fixed for the other importers by the [file-part mapping](./postman.md), and on the wire before that).

The part carries **no path**: a spec documents *that* a field is an upload, never *which* file it uploads. The user picks the file in the request editor, and the engine refuses the send by field name until they do (`Form field 'avatar' is a file part with no file selected`). The row is deliberately **not** marked `unresolved` - that flag warns that a path came from somewhere else and was never verified here, and there is no path to warn about; the row reads "Choose file", exactly like one a user turned into a file part by hand.

The import preview counts these as `N file parts need a file`, beside the skip counters, so a spec full of uploads says so before the import rather than one failed send at a time.

## `$ref` & schema sampling

`resolveRef` resolves any JSON-pointer ref against the whole spec - Swagger model refs are `#/definitions/...`, but the resolver is generic. It strips the leading `#/`, splits on `/`, un-escapes `~1`→`/` and `~0`→`~`, and walks the spec object segment by segment.

Body schemas are turned into stub values by `Sampler::sample` (`openapi_drafts.cpp`), which walks the schema recursively. It is **bounded and recursive** - materially more capable than older "one level deep" notes:

- **Depth cap.** `MAX_DEPTH = 6`. Once `depth > 6`, the walker returns `{}`. Non-object / null nodes also return `{}`.
- **`$ref` resolution + cycle guard.** A node with a string `$ref` (e.g. `#/definitions/User`) is resolved via `resolveRef` and walked (depth +1). A `Set` of already-visited `$ref` strings is threaded down each branch; re-encountering a `$ref` already on the current path returns `{}` (breaks reference cycles). Resolution failures (`throw` or `null` result) also yield `{}`.
- **Pinned-value precedence:** `const` → `example` → `examples[0]` (checked **after** `$ref`, before composition and `type`). `const` outranks `example` because JSON Schema makes it the only permitted value; `examples` is the plural form 3.1 introduced. Swagger 2.0 schemas only ever carry `example`, so in practice this parser reads that one - the other two come along because the sampler is shared.
- **`allOf` / `oneOf` / `anyOf` - first branch.** If any of these is a non-empty array, the walker recurses into **`branch[0]` only** (precedence `allOf` → `oneOf` → `anyOf`). It does not merge `allOf` members.
- **Type arrays.** A `type` written as an array (a JSON-Schema / OpenAPI 3.1 shape, not legal Swagger 2.0) samples its first non-`"null"` member; an only-`"null"` type samples as `null`.
- **Type defaults:**

  | `schema.type` | Sample value |
  |---------------|--------------|
  | `string` | `enum[0]` if a non-empty `enum` is present, else `""` |
  | `integer` / `number` | `0` |
  | `boolean` | `false` |
  | `null` | `null` |
  | `array` | `[ sample(items) ]` if `items` is present, else `[]` (one element) |
  | `object` (or no/unknown `type`) | walks each entry of `properties`, producing `{ key: sample }`; `{}` if no `properties` |

`Sampler::sample` is shared verbatim with the v3 parser - same depth cap, cycle guard, and branch handling. Its `Sampler::form_fields` companion is v3-only: Swagger 2.0 form fields come from `formData` parameters, not from a schema, so this parser reads `param.type === "file"` where v3 reads `format: binary`.

## `collectionFormat` for array query params

**Not implemented.** Swagger 2.0's `collectionFormat` (`csv` / `ssv` / `tsv` / `pipes` / `multi`) on array parameters is **not consulted anywhere** in the parser. A `query` parameter - array or scalar - produces exactly **one** `KeyValueEntry`:

```ts
params.push(declaredParamRow(name, param.default, param.required, description));
```

There is no per-value expansion, no separator joining, and no `multi` handling. The parameter's `type` and `items` are ignored entirely, and an **array `default` is not carried as a value** for the same reason: without `collectionFormat` there is no separator to join it with, and joining on a guess would send what the spec did not declare. `multi` does **not** emit one entry per value - it emits the same single entry as any other query param.

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

`swaggerSchemeToAuth(scheme)` maps the picked scheme to a concrete collection auth (always with empty secrets - the spec has no real credentials):

| `securityDefinitions` entry | Vayu `RequestAuth` |
|-----------------------------|--------------------|
| `type: "basic"` | `{ mode: "basic", username: "", password: "" }` |
| `type: "apiKey"` | `{ mode: "apikey", key: scheme.name ?? "", value: "", in: scheme.in === "query" ? "query" : "header" }` |
| `type: "oauth2"` | `{ mode: "oauth2", config: OAuth2Config }` via `map_swagger_oauth2` - maps the Swagger `flow` (`application` → client-credentials, `accessCode` → auth-code+PKCE, `password`, `implicit`→auth-code+PKCE), fills `tokenUrl`/`authorizationUrl`/`scope`, seeds `clientId`/`clientSecret` as `{{variables}}` |
| missing scheme / missing `type` / any other type | `{ mode: "none" }` |

**`nonExecutableAuth`:** always `0` - `oauth2` now maps to an executable config (as do bearer/basic/apikey).

## Options & lossy behavior

This parser is **stub-only**: it materializes the shape of each request, and the only values it carries are the ones the spec states outright - a query or header parameter's `default` ([above](#parameter-values--enabled-state)) and a response example. The `ImportOptions` argument (`importEnvironments`, `importScripts`) is **ignored** - the parameter is `_opts` and is never read (identical to v3).

Dropped / not represented:

- **Scripts:** all `preRequestScript` / `postRequestScript` are `""` (Swagger has no scripts; `importScripts` has no effect here).
- **Environments:** none produced (`environments: []`, `meta.environmentCount: 0`). Swagger has no environment concept; the `scheme`/`host`/`basePath` triple becomes a single `baseUrl` collection variable.
- **Additional schemes:** only `schemes[0]` is used; other schemes are dropped.
- **`collectionFormat`, parameter `type` / `items`, `enum` on params:** not consumed. `required` and a scalar `default` **are** read, for query and header params alike - see [Parameter values & enabled state](#parameter-values--enabled-state); form params are still always empty-value stubs.
- **Response headers** (`responses[code].headers`): not imported. Response schemas and examples *are*, since issue #481 - see [Documented responses](#documented-responses).
- **`authorization` / `content-type` header parameters:** dropped (Vayu manages them).
- **Path parameters as params:** not emitted (path params live in the URL only).
- **Multi-tag grouping:** only the first tag groups an operation.
- **A path item, or a `parameters` list, whose shape the spec does not allow:** stepped over and counted as `malformed_spec` so the rest of the file still imports.

`meta` population: `format = "OpenAPI 2.0 (Swagger)"`, `requestCount` = total operations built, `folderCount` = number of folders (`folders.count()`), `folderStrategy` = which rule produced them, `environmentCount = 0`, `exampleCount` = example responses imported (read off the finished drafts by `count_examples`), `nonExecutableAuth = 0` (oauth2 is now executable), `unattached_file_parts` = file parts imported with no file attached (`unattached_file_parts`, read off the finished drafts), and `skipped` from the shared `ImportTally` - `malformed_spec`, `example_no_status`, `default_response` and `duplicate_operation_id` are the only kinds this parser can emit (Swagger 2.0's Path Item Object has no `trace`, so there is no `unsupported_method` case here). The three kinds issue #719 added are v3-only for the same kind of reason: Swagger 2.0 has no `in: "cookie"` parameter, no Server Object to template or leave relative - `host` is a host - and every declared body maps to one, so `cookie_param`, `unresolved_base_url` and `unmapped_body` have no case here either. Nothing to report still yields `[]`.

## Differences from OpenAPI 3.0

See [OpenAPI v3](./openapi-v3.md) for the v3 reference. Key contrasts:

| Aspect | v2 (Swagger) | v3 (OpenAPI 3.0) |
|--------|--------------|------------------|
| Detection | `swagger === "2.0"`, or the number `2` from unquoted YAML | `openapi` is a string starting with `"3."` |
| Base URL | `schemes[0]` + `host` + `basePath` | `servers[0].url` |
| Request body | `in: "body"` / `in: "formData"` parameters | dedicated `op.requestBody` with `content` map |
| Body content-type decision | `consumes` (op → spec → JSON default) | media-type keys of `requestBody.content` |
| Text/non-JSON body | sampled schema serialized as JSON text | `text/plain` → empty string |
| Form bodies | `in: "formData"` params → urlencoded or multipart per `consumes` (overrides body param) | `multipart/form-data` / `x-www-form-urlencoded` from `content`, field names resolved through the sampler |
| File parts | `type: "file"` formData parameter | `format: "binary"` (or an array of it) property under `multipart/form-data` |
| Unsupported methods | none - Swagger 2.0 defines no `trace` | `trace` counted as `unsupported_method` |
| `$ref` namespace | `#/definitions/...` | `#/components/schemas/...` (resolver is generic in both) |
| Auth schemes | `securityDefinitions` (`basic`, `apiKey`, `oauth2`) | `components.securitySchemes` (`http`/bearer/basic, `apiKey`, `oauth2`) |
| Auth helper | `swaggerSchemeToAuth` | `schemeToAuth` |
| Collection build | root inline in `parse`; folders from the shared `OperationFolders` | root inline in `parse`; folders from the shared `OperationFolders` |

Shared between both: the folder routing (`OperationFolders` - first tag, else path segment), `{{baseUrl}}`-prefixed URLs, `normalize_template_vars` path conversion, `Sampler::sample`, request `auth: inherit`, `ImportOptions` ignored, and the `openapi_drafts.cpp` helpers (`walk::resolve_single_hop`, `ImportTally`) - so a `$ref`'d path item, a malformed `parameters` list, and `meta.skipped` behave identically in both.

## Shared helpers used

| Helper | Source | Use in this parser |
|--------|--------|--------------------|
| [`normalize_template_vars`](./README.md#normalize_template_vars--normalize_path_templates) | `path_template.cpp` | convert Swagger `{param}` path templates → Vayu `{{param}}` in request URLs |
| `Sampler::sample` | `openapi_drafts.cpp` | generate a sample JSON body from an `in: "body"` parameter `schema` (bounded, ref-resolving) |
| `walk::resolve_ref`, `walk::resolve_single_hop`, `ImportTally` | `openapi_drafts.cpp` | resolve an in-document `$ref` and a `$ref`'d path item; guard `parameters` and tally what was dropped |
| `bundleExternalRefs` | `ref-bundler.ts` | resolve references to *other files* before parse, and count what it could not reach |
| `response_example`, `example_body_text`, `deref` | `openapi_drafts.cpp` | map one `responses` entry to an example draft - the half shared with the v3 parser |
| `declared_param_row`, `param_value_text` | `openapi_drafts.cpp` | one `in: "query"` or `in: "header"` parameter as a table row - the value/enabled rule both OpenAPI parsers apply |
| `count_examples` | `import_document.cpp` | total the examples across the finished drafts, for `meta.exampleCount` |

Beyond `count_examples`, this parser does **not** use the Postman/Insomnia helpers in `import_document.cpp` (`as_string`, `to_var_record`, `map_key_values`, `map_postman_auth`, `raw_body`, `join_exec`); it builds drafts directly. See the [index](./README.md#shared-helpers) for the full shared-helper reference.

## Related

- [Import pipeline index](./README.md)
- [OpenAPI v3 (OpenAPI 3.0)](./openapi-v3.md)
- [Postman Collection v2.1 / v2.0](./postman.md)
- [Insomnia v4](./insomnia-v4.md)
