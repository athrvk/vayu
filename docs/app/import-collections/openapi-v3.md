---
description: >-
  What Vayu generates from an OpenAPI 3.0 or 3.1 specification - collections per tag (or per path segment for untagged operations), request stubs, servers, security schemes, and schema-sampled bodies.
---

# OpenAPI 3.0

Parses an OpenAPI 3.0.x specification into the Vayu draft model. OpenAPI is a **specification document, not a request log** - it describes endpoints, parameters, and schemas but carries no concrete values. The parser therefore emits **synthetic request stubs**: a `{{baseUrl}}` from the first server, query and header params carrying whatever value the spec declares for them (usually none, in which case the row imports disabled - see [Parameter values & enabled state](#parameter-values--enabled-state)), and a body sampled from the request schema. Users fill in real values after import.

The document is not thrown away once it has been read. The collection it
produces is **bound** to it: the spec is stored verbatim (with the URL it was
fetched from, when there was one), and every request records which operation it
is - `operationId`, method, and the templated path. See
[OpenAPI Collections](../openapi.md) for what the binding is for and what the
collection's Spec tab does with it.

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

The top-level `openapi` field must be a string beginning with `"3."` (so `3.0.0`, `3.0.3`, and `3.1.x` all match). The 3.1 claim is honoured on the schema side too: `Sampler::sample` reads the JSON-Schema keywords 3.1 adopted - type arrays (`type: ["string", "null"]`), `const`, and the plural `examples` (see [`Sampler::sample`](#samplersample-schema--stub-value)) - and a `{"$ref": ...}` path item, which 3.1 made common, is resolved rather than dropped. Swagger 2.0 (`swagger: "2.0"`, no `openapi` field) is handled by a separate parser - see [OpenAPI v2](./openapi-v2.md). The factory (`core::parse_import`) parses the raw text once (JSON, then YAML fallback) and runs each parser's `detect` in registration order.

## Tree structure

The spec maps to a single root collection, with operations grouped into child collections by their first tag - or, for an operation that declares no tag, by the first meaningful segment of its path (issue #710).

- **Root collection** ← the whole spec (named from `info.title`). It directly holds:
  - `requests`: every operation that has neither a tag nor a groupable path.
  - `children`: one child collection per distinct folder name, in first-encounter order.
- **Child collections** ← created lazily by `OperationFolders` (`openapi_drafts.cpp`) the first time a name is seen, keyed in a `Map<string, CollectionDraft>`. A tag-named folder takes its description from the matching entry in the top-level `tags[]` array (if any); a path-named folder has none, because the document declares none.

Iteration order: `parse` loops over `spec.paths` entries, resolves each path item through `walk::resolve_single_hop` (`openapi_drafts.cpp`) so a `{"$ref": "#/components/pathItems/X"}` item is read from its target instead of contributing nothing, and then loops over the fixed `HTTP_METHODS` list (`get, post, put, patch, delete, head, options`). A path item that is not an object - or whose `$ref` does not resolve to one - is counted as a `malformed_spec` [`SkippedItem`](./README.md#draft-model-the-parser-output-contract) and skipped, so the drop is named in the preview rather than silent. The ref is followed **one hop only**, like the parameter and `requestBody` refs. For each present operation `parse` calls `buildOperation(...)`, then routes by tag:

```ts
const tag  = op.tags?.[0];              // ONLY the first tag is used
const name = tag ?? pathFolderName(path);  // the fallback, per operation
if (name) folders.get(name).requests.push(req);
else      rootRequests.push(req);
```

**Multi-tag operations:** only `op.tags[0]` is consulted. An operation with `tags: ["a", "b"]` lands solely in the `a` child collection; `b` is ignored (no duplication, no extra folder).

**Untagged operations - the path fallback.** A document whose operations carry no `tags` at all is common and not broken: Stripe's official spec declares root-level `tags:` that **no operation references**, so grouping by tag alone imported all 568 of its operations as one flat list. `path_folder_name` (`openapi_drafts.cpp`) therefore names a folder from the first path segment that names a resource:

- Leading segments that name no resource are stepped over: a version (`v1`, `v2.1`), the `api` mount point, and a whole-`{template}` segment. `/api/v2/{tenant}/orders` is `orders`.
- The segment is taken exactly as written (`account_links`), because that is the name the vendor's own documentation uses.
- A path with nothing left - `/`, `/v1`, `/{id}` - yields no folder, and its request stays on the root rather than being filed under a placeholder.

The fallback applies **per operation**, so a partly tagged document gets both rules. A path-derived name that a tag also uses is one folder holding both, not two folders with one name; the tag's description is kept. Inferring folders from root `tags[]` entries that no operation references (Stripe's `x-kind: api-group` list) is a recorded **non-goal** - matching those names onto paths is vendor-specific guesswork.

Which rule ran is reported as `meta.folderStrategy` (`"tags"`, `"paths"` or `"mixed"`), and the import preview states it whenever paths were involved: a folder tree the document never spelled out must not read as one it did.

**`trace` operations:** OpenAPI 3's Path Item Object also defines `trace`, which is **not** in `HTTP_METHODS` because `HttpMethod` (`types/domain.ts`) has no `"TRACE"` - Vayu cannot execute one. A `trace` operation is therefore not built, is **not** counted in `requestCount`, and is counted as an `unsupported_method` `SkippedItem` so the preview says so. `UNSUPPORTED_METHODS` in `import_document.cpp` is the list; `trace` is its only member, since a path item defines exactly the eight methods.

Key internal functions: `buildOperation` (per-operation `RequestDraft`), `OperationFolders` / `path_folder_name` (`openapi_drafts.cpp`, folder routing - shared with the v2 parser), `buildBody` / `findJsonMedia` (request body), `pickPrimaryScheme` / `schemeToAuth` (collection auth), and `walk::resolve_ref` (`openapi_drafts.cpp`) for `$ref` resolution - shared with the v2 parser, which built the identical closure by hand until issue #649.

## External `$ref`s

The resolver above walks `#/`-rooted pointers **inside the document it was given**, and nothing else. A reference naming another file (`./schemas/pet.yaml#/Pet`, `https://acme.dev/common.yaml#/Error`) is not such a pointer, so it used to resolve to `undefined` - which every caller reads as *the spec documented nothing here*: an empty body stub, a missing parameter, an example that never imported, and no entry in `meta.skipped` to say so.

Those references are now resolved **before** the parser runs, by `ref-bundler.ts` (issue #649): each referenced document is fetched (through the engine's `/import/fetch`) or read from beside the picked file (through the gated `specFile:read` IPC), inlined under a root `x-vayu-bundled` key, and every reference into it rewritten to an in-document pointer. What reaches `parse` is therefore always self-contained, and the parser needs no notion of files.

What could **not** be reached is counted as an `external_ref` `SkippedItem` - one per reference - and its `$ref` is left exactly as the document wrote it. See [OpenAPI Collections](../openapi.md#specs-written-across-several-files) for the user-facing rules, including which intake applies to a fetched, picked or pasted document, and why a multi-file spec is stored as the bundle.

## Field mapping

### Collection (root)

Built inline in `parse`.

| OpenAPI | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `info.title` | `name` | fallback `"Imported API"` |
| `info.description` | `description` | fallback `""` |
| `servers[0].url` | `variables.baseUrl` | resolved first (see [The base URL](#the-base-url)); only added when a base URL exists: `{ baseUrl: { value, enabled: true } }`; otherwise `variables` is `{}`. Additional `servers[]` are ignored. |
| `security` / `components.securitySchemes` | `auth` | via `pickPrimaryScheme` + `schemeToAuth` (see [Auth](#auth--security)). Collections never inherit. |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |
| `op.responses` | `examples` | via `buildExamples` (see [Documented responses](#documented-responses)); **absent** when nothing was representable |

### The base URL

`servers[0].url` is not always an address (issue #719). A Server Object may **template** its URL, and the URL may be **relative**, so the field is resolved by `resolve_server_url` before it becomes `{{baseUrl}}`:

1. **Server variables are substituted** from the defaults the document declares - `{protocol}://{hostname}/api/v3` with `variables: { protocol: { default: "https" }, hostname: { default: "api.acme.dev" } }` becomes `https://api.acme.dev/api/v3`. The specification **requires** a default on every server variable, so a complete document always resolves. Single braces are not Vayu variables - only the path goes through [`normalize_template_vars`](./README.md#normalize_template_vars--normalize_path_templates) - so before this the literal `{protocol}` survived into every request line and failed at connect with nothing said.
2. **A relative URL is resolved against the URL the document was fetched from**, which is what OpenAPI says it is relative to. `/api/v3` fetched from `https://acme.dev/specs/openapi.yaml` becomes `https://acme.dev/api/v3`. The source URL reaches the parser as the fourth argument to `parse` - the factory has always known it (it is also `spec_documents.source_url`) and now hands it over.
3. **Anything still unresolvable is kept exactly as written and counted** as an `unresolved_base_url` `SkippedItem`: a variable with no declared default, or a relative URL in a pasted or file-picked document, which has no location to be relative to. A base URL the user can see is unfinished beats a host Vayu invented.

This substitution is what a Vayu-exported skeleton round-trips through (issue #1441, see [the export doc](../openapi.md#a-free-form-collection-exports-a-skeleton)): a collection whose requests all use `{{baseUrl}}` exports a server of `{baseUrl}` with `variables: { baseUrl: { default: "<the value>" } }`, and step 1 above substitutes that default back exactly - never the self-referential value a bare, undeclared `{{baseUrl}}` used to leave behind.

An absolute URL is passed through untouched - not re-serialized through `URL`, so a stored document's own spelling survives.

**Parameter resolution & merge.** `buildOperation` concatenates path-item-level `parameters` with operation-level `op.parameters`, resolving any `$ref` entries via `resolveRef`. Each parameter is keyed by `` `${in}:${name}` `` in a `Map`, so an operation-level parameter **overrides** a path-level one with the same `in`+`name` (later writes win). Entries missing `in` or `name` after resolution are skipped.

Both lists go through the walk's `parameters` guard (`openapi_drafts.cpp`) first. `parameters` is an array per the spec, but a missing `-` in hand-written YAML makes it a mapping, and spreading that used to throw `is not iterable` and abort the **whole file**. A present-but-non-array `parameters` is now treated as empty and counted as a `malformed_spec` `SkippedItem` (once per offending list); an absent `parameters` is normal and counted as nothing. Every other path in the file still imports.

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

A key that is not a numeric status is **skipped and counted**: `default` as `default_response`, anything else (a `2XX` wildcard, junk) as `example_no_status`. Both document a real response, but an example is served under one status line and there is no honest value to pick. They are counted apart because `default` is conformant and near-universal - every one of Stripe's 568 operations declares one - so the preview names it as information while a malformed key stays a warning (issue #710).
| tag and path groups | `children` | `folders.children()` |
| operations with neither | `requests` | |

### Collection (per folder)

Built by `OperationFolders` (`openapi_drafts.cpp`), shared with the v2 parser.

| OpenAPI | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `tags[0]`, else the first meaningful path segment | `name` | see [Tree structure](#tree-structure) |
| `tags[].description` where `tags[].name === tag` | `description` | fallback `""`; a path-named folder has none unless a tag of the same name arrives |
| (none) | `variables` | always `{}` (baseUrl lives only on the root) |
| (none) | `auth` | always `{ mode: "none" }` - tag collections do not carry security |
| (none) | `children` | always `[]` (tags are flat; no nesting) |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |

### Request (per operation)

Built by `buildOperation(method, path, op, resolveRef, pathParams, tally, specOperation)`. The identity is passed in rather than derived here - see [Operation identity](#operation-identity).

| OpenAPI | Vayu `RequestDraft` | Notes |
|---------|---------------------|-------|
| `op.summary` → `op.operationId` → `"{METHOD} {path}"` | `name` | precedence in that order; final fallback uses upper-cased method + raw path, e.g. `"GET /users/{id}"` |
| `op.description` | `description` | fallback `""` |
| HTTP method | `method` | `method.toUpperCase()` (e.g. `get` → `GET`), cast to `HttpMethod` |
| `path` | `url` | `` `{{baseUrl}}${normalize_path_templates(path)}` `` - always prefixed with `{{baseUrl}}`, even if no server was defined (see [URL](#url--path-parameters)) |
| parameters with `in: "query"` | `params` | `{ key: name, value, enabled, description? }` via `declared_param_row` - `description` included only when present; `value` and `enabled` follow [Parameter values & enabled state](#parameter-values--enabled-state). Only the enabled rows are joined onto the `url` by `parseImport` - see [The url/params invariant](./README.md#the-urlparams-invariant) |
| parameters with `in: "header"` | `headers` | `{ key: name, value, enabled }` via the same `declared_param_row` - **no description carried** (the Headers table has no column for one); `authorization` and `content-type` headers are dropped (case-insensitive) since Vayu manages those |
| parameters with `in: "path"` / `in: "cookie"` | - | not emitted as params/headers; path params are represented in the URL via `normalize_template_vars`. Cookie params are dropped. |
| `op.requestBody` | `body` | via `buildBody` (see [Request body](#request-body-generation)) |
| (none) | `auth` | always `{ mode: "inherit" }` - auth is configured once at the collection level |
| (none) | `preRequestScript` / `postRequestScript` | always `""` |
| `op.operationId`, method, `path` | `specOperation` | the operation this request is, recorded for [sync](../openapi.md#checking-a-bound-spec-for-changes) - see [Operation identity](#operation-identity). Absent for a `paths` key that does not start with `/` |

### Operation identity

Every request records which operation it is - `{ operationId?, method, path }`, the templated path exactly as the document writes it (`/pets/{petId}`), never the `{{petId}}` rewrite that goes into the URL. The walk claims one identity per operation (`walk_operations`, `openapi_walk.hpp`) and stamps it on the request draft. The **declared-operation index** stored beside the document is derived by the engine from the bytes it stores (issue #853), and since #877 the stamp comes off that same walk - `walk_operations`, which is what decides an operation's identity for the index, the drafts and the import alike. Coverage matching a request's stamp against the index is therefore one answer compared with itself, rather than two readers held together by a fixture.

The **request itself** is now mirrored engine-side as well (issue #865, `core::spec_request_drafts_of`): everything this page describes - the URL and its joined query, the parameter rows and their enabled state, the sampled body, the folder an operation is filed under - the engine derives from the stored document too, because the [sync diff](../openapi.md#checking-a-bound-spec-for-changes) compares a stored request against one of those and is moving down with it. The import runs on that very builder now (issue #877): `core::import_drafts_of` is `core::spec_request_drafts_of` with the tally kept and the operations under a malformed `paths` key included, so there is one implementation of every rule on this page rather than two held to each other. The cross-language conformance fixture that used to hold them together retired with the renderer parser it pinned; what remains is `engine/tests/fixtures/import-conformance.json`, which records what that parser produced and is asserted against on every build.

**A duplicated `operationId` is kept on its first declaration only** (issue #715). Declaring one id on two operations is invalid OpenAPI and common in generated specs, and stamping it on both requests is what let a later sync resolve the second request to the *first* operation - reporting it as renamed toward an operation it never was, and rewriting its method, URL and identity on an all-defaults apply. The second operation therefore imports identified by its method and path alone, which is what sync then follows it by, and each repeated declaration is counted as a `duplicate_operation_id` [`SkippedItem`](./README.md#draft-model-the-parser-output-contract) so the preview names the drop. First declaration wins because document order is stable across re-fetches of the same file. Nothing else is lost: the operation itself imports whole, and `op.operationId` still supplies the request name when there is no `summary`. A `paths` key that does not start with `/` records no identity at all - the engine refuses one.

### Parameter values & enabled state

A spec's `parameters` list declares what an operation **accepts**, not what every request should **send** - and an enabled row reaches the wire either way: a query row through the [url/params join](./README.md#the-urlparams-invariant), a header row as a header the request claims to send. `declared_param_row` (`openapi_drafts.cpp`, shared with the [Swagger parser](./openapi-v2.md) and applied to `in: "query"` and `in: "header"` alike) decides both fields from the parameter alone:

| Parameter declares | `value` | `enabled` |
|--------------------|---------|-----------|
| a scalar `example` / `examples` / `schema.example` / `schema.default` | that value as text | `true` |
| `required: true`, no value | `""` | `true` - a query row joins as a bare key (`?tenant`), a header row is listed with an empty value; either is the cue to fill it in |
| nothing, and not required | `""` | **`false`** |

Value precedence is the parameter's own `example`, then the first entry of its `examples` map (unwrapped by `first_named_example`), then the schema's `example`, then the schema's `default` - the same "concrete example beats generated stub" order [`buildBody`](#request-body-generation) uses, and a `default` only describes what the server assumes when the parameter is **absent**, so it ranks last. The `schema` is followed one `$ref` hop (`deref`).

Only scalars become a value. An array or object is serialized by the parameter's `style`/`explode`, which this parser does not read, and one row holds one string - so such a parameter imports value-less, like one declaring nothing. A declared `""` is value-less too: an empty-value row writes as a bare key, so `?q=` is not a shape the Params table can hold.

Why optional value-less parameters import **disabled** (issues #622, #658): the row is documentation ("this endpoint accepts `verbose`"), not intent ("send `verbose` always"). Enabled, a query row joined the stored URL as `?verbose`, which some APIs read as `verbose=true`, and a header row claimed an `X-Request-Id:` with nothing in it - both a wire change nobody chose. Disabled, the row is still listed in its table one click from use.

**An explicit `x-vayu-enabled` overrides this heuristic entirely** (issue #1441). The heuristic above answers "does this look sent" for a document Vayu did not write; it cannot tell a disabled row that carries a value from an enabled one that carries none - and a Vayu-exported skeleton writes both shapes, since a toggle is not derived from its value there either. So a parameter carrying `x-vayu-enabled` (boolean) takes its `enabled` from that flag directly, and only falls back to the `required`/value-presence table when the extension is absent.

## URL & path parameters

- The request `url` is always `` `{{baseUrl}}${normalize_path_templates(path)}` ``. `{{baseUrl}}` is a Vayu collection variable resolved from `servers[0].url` at import time (defined on the root collection). If the spec has no `servers`, `baseUrl` is absent from the root variables and `{{baseUrl}}` resolves to empty at runtime.
- OpenAPI path templates `{param}` are converted to Vayu `{{param}}` by `normalize_template_vars` (`path_template.cpp`). With `pathTemplates` (which only the OpenAPI/Swagger parsers pass) it rewrites single-brace `{x}` (identifier chars `[\w$-]`) to `{{x}}`, while leaving any existing `{{...}}` pairs intact. So `/users/{userId}/posts/{postId}` becomes `/users/{{userId}}/posts/{{postId}}`. Path parameters are **not** also emitted as `params` entries - they live only in the URL.

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

**Form field names resolve `$ref` and `allOf`, exactly as far as a JSON body does.** `Sampler::form_fields` (`openapi_drafts.cpp`) samples the schema and returns the stub's own keys, rather than reading `schema.properties` directly. That key does not exist on a schema written as `{"$ref": "#/components/schemas/TokenRequest"}` or as an `allOf` - the shape generators emit - which used to yield the right body mode with an **empty** field list and no warning anywhere. Consequences of going through the sampler: composition follows the **first** branch only (the same rule JSON bodies get, not an `allOf` merge), and a schema that samples to a non-object (a scalar, an array, or an `example` that is not an object) contributes no field names.

### `Sampler::sample` (schema → stub value)

`Sampler::sample` in `openapi_drafts.cpp` generates a sample JSON value by walking the schema. It is **bounded and recursive** - materially more capable than a one-level stub:

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

`Sampler::form_fields` is the form-body wrapper over this: it samples the schema, returns `Object.keys()` of the result (`[]` for a non-object sample), and marks each field text or file. The file flag is read off the **property schema**, not the sampled value: the sampler turns a `format: binary` string into `""`, which no longer says anything about the field. See [Request body generation](#request-body-generation).

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
| `type: "oauth2"` | `{ mode: "oauth2", config: OAuth2Config }` via `map_openapi_v3_oauth2` - picks the first usable flow (`clientCredentials` → `authorizationCode`+PKCE → `password` → `implicit`→auth-code+PKCE), fills its `tokenUrl`/`authorizationUrl`/`scope`, and seeds `clientId`/`clientSecret` as `{{clientId}}`/`{{clientSecret}}` placeholders |
| missing / any other type (incl. `openIdConnect`, `http` with other schemes) | `{ mode: "none" }` |

**`nonExecutableAuth`:** always `0` - `oauth2` now maps to an executable config, and the other mapped schemes (bearer/basic/apikey) are executable too.

## Options & lossy behavior

This parser is **stub-only**: it materializes the shape of each request, and the only values it carries are the ones the spec states outright - a query or header parameter's `example`/`default` ([above](#parameter-values--enabled-state)) and a response example. The `ImportOptions` argument (`importEnvironments`, `importScripts`) is **ignored** - the parameter is `_opts` and is never read.

Dropped / not represented:

- **Scripts:** all `preRequestScript` / `postRequestScript` are `""` (OpenAPI has no scripts; `importScripts` has no effect here).
- **Environments:** none produced (`environments: []`, `meta.environmentCount: 0`). OpenAPI has no environment concept; `servers[0]` becomes a single `baseUrl` collection variable.
- **Additional servers:** only `servers[0]` is used; other entries and per-operation `servers` overrides are dropped.
- **Callbacks, links, security scopes:** not consumed. (Response schemas and examples *are*, since issue #481 - see [Documented responses](#documented-responses).)
- **Response headers** (`responses[code].headers`): not imported. An example's headers carry only the media type it was stored under.
- **Cookie parameters** and **path parameters as params**: not emitted (path params live in the URL only).
- **`authorization` / `content-type` header parameters:** dropped (Vayu manages them).
- **Multi-tag grouping:** only the first tag groups an operation.
- **Root `tags[]` entries no operation references:** not turned into folders - see the path fallback in [Tree structure](#tree-structure).
- **`trace` operations:** dropped - `HttpMethod` has no `"TRACE"`. Counted as `unsupported_method` (see [Tree structure](#tree-structure)), not silently omitted.
- **A path item, or a `parameters` list, whose shape the spec does not allow:** stepped over and counted as `malformed_spec` so the rest of the file still imports.
- **Form-field property schemas:** only field **names** and whether the field is a file (`format: binary`) are imported; `required`, other types, and nested structure are not.
- **A whole-body binary** (`application/octet-stream` and other non-form, non-JSON, non-text media types): no body is produced (`{ mode: "none" }`) and the operation is counted as `unmapped_body` (issue #719) - unlike a multipart file part, which imports (see [File parts](#file-parts)). An operation that declares no `requestBody` at all is **not** counted: it lost nothing, and the two used to be indistinguishable.
- **Cookie parameters** (`in: "cookie"`): dropped and counted as `cookie_param` (issue #719). Vayu has no cookie-parameter row - a request's cookies come from the jar - and mapping them onto a `Cookie` header is a recorded non-goal: the header is one joined value while a spec declares these one at a time, so building it would mean inventing a merge the document never wrote. `in: "path"` is neither dropped nor counted; it is already carried, as the `{{param}}` the URL template holds.

`meta` population: `format = "OpenAPI 3.0"`, `requestCount` = total operations built (TRACE excluded), `folderCount` = number of folders (`folders.count()`), `folderStrategy` = which rule produced them (`"tags"` / `"paths"` / `"mixed"`, absent when there are no folders), `environmentCount = 0`, `exampleCount` = example responses imported (read off the finished drafts by `count_examples`), `nonExecutableAuth = 0` (oauth2 is now executable), `unattached_file_parts` = file parts imported with no file attached (`unattached_file_parts`, read off the finished drafts), and `skipped` from the `ImportTally`:

| `SkippedItem.kind` | Counted when |
|--------------------|--------------|
| `unsupported_method` | a path item carries a `trace` operation |
| `malformed_spec` | a path item is not an object / its `$ref` does not resolve; or a `parameters` value is present but not an array |
| `example_no_status` | a response key is neither a three-digit status nor `default` - a `2XX` wildcard, or junk |
| `default_response` | a response keyed `default` - conformant, and reported as information rather than as a loss |
| `duplicate_operation_id` | an `operationId` another operation in this document already declared (see [Operation identity](#operation-identity)) |
| `cookie_param` | a parameter declared `in: "cookie"` - one per distinct cookie parameter per operation |
| `unmapped_body` | a `requestBody` declaring only media types with no Vayu mode - one per operation, however many such media types it listed |
| `unresolved_base_url` | `servers[0].url` still carries a `{variable}` with no declared default, or is relative in a document with no source URL (see [The base URL](#the-base-url)) |

An import with nothing to report still yields `skipped: []` - only non-zero kinds are emitted.

## Shared helpers used

| Helper | Source | Use in this parser |
|--------|--------|--------------------|
| [`normalize_template_vars`](./README.md#normalize_template_vars--normalize_path_templates) | `path_template.cpp` | convert OpenAPI `{param}` path templates → Vayu `{{param}}` in request URLs |
| `Sampler::sample` | `openapi_drafts.cpp` | generate a sample JSON body from a request `schema` (bounded, ref-resolving) |
| `Sampler::form_fields` | `openapi_drafts.cpp` | field names for an urlencoded / multipart body, resolved through the sampler, each flagged text or file |
| `imported_file_part`, `unattached_file_parts` | `import_document.cpp` | build a file form row; count the rows that still need a file, for `meta` |
| `walk::resolve_ref`, `walk::resolve_single_hop`, `ImportTally` | `openapi_drafts.cpp` | resolve an in-document `$ref` and a `$ref`'d path item; guard `parameters` and tally what was dropped |
| `bundleExternalRefs` | `ref-bundler.ts` | resolve references to *other files* before parse, and count what it could not reach |
| `declared_param_row`, `param_value_text` | `openapi_drafts.cpp` | one `in: "query"` or `in: "header"` parameter as a table row - the value/enabled rule both OpenAPI parsers apply |
| `response_example`, `find_json_media_type`, `first_named_example`, `example_body_text`, `deref` | `openapi_drafts.cpp` | map one `responses` entry to an example draft; the halves the two OpenAPI parsers share |
| `count_examples` | `import_document.cpp` | total the examples across the finished drafts, for `meta.exampleCount` |

This parser does **not** use the Postman/Insomnia-shaped helpers in `import_document.cpp` (`as_string`, `to_var_record`, `map_key_values`, `map_postman_auth`, `raw_body`, `join_exec`); it builds drafts directly. See the [index](./README.md#shared-helpers) for the full shared-helper reference.

## Related

- [Import pipeline index](./README.md)
- [OpenAPI v2 (Swagger 2.0)](./openapi-v2.md)
- [Postman Collection v2.1 / v2.0](./postman.md)
- [Insomnia v4](./insomnia-v4.md)
