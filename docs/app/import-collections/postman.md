# Postman Collection v2.1 / v2.0

Parses exported Postman Collection JSON (schema v2.1.0 and v2.0.0) into the Vayu draft model. Both versions share the same parse implementation; the only differences are detection and the shape of the `url`/`auth` objects (handled transparently by the shared helpers).

- **Source:** `app/src/services/importers/postman.ts`
- **Exports:**

  | Class | `formatName` | `formatKey` |
  |-------|--------------|-------------|
  | `PostmanV21Parser` | `Postman Collection v2.1` | `postman-v21` |
  | `PostmanV20Parser` | `Postman Collection v2.0` | `postman-v20` |

Both implement `ImportParser` (`detect` + `parse`) from `./types`.

## Detection

The factory (`factory.ts`) parses the raw string once (JSON, then YAML fallback) and runs each parser's `detect(parsed, raw)` in registration order until one returns `true`.

| Class | `detect()` logic |
|-------|------------------|
| `PostmanV21Parser` | `parsed.info.schema` is a string **containing** `"v2.1.0"`. |
| `PostmanV20Parser` | `parsed.info.schema` is a string **containing** `"v2.0.0"`; **or** `parsed.info` is present, `parsed.item` is an array, and `schema == null` (no schema field at all → treated as v2.0). |

The match is a substring check (`schema.includes(...)`), so the full schema URL (e.g. `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`) is accepted.

**Why v2.1 is tried first:** the factory's `PARSERS` array lists `PostmanV21Parser` before `PostmanV20Parser`. v2.1 has the stricter test (exact `v2.1.0` substring), and v2.0's fallback branch is permissive (it claims any `info` + `item[]` document with no schema). Ordering v2.1 first ensures a true v2.1 file is never swallowed by v2.0's loose fallback.

## Parse flow

`parse()` on either class delegates to the module-level `parsePostman(parsed, opts, formatName)`, which:

1. Creates a mutable `Ctx` (`{ opts, requestCount, folderCount, nonExecutableAuth, skippedFileBody, skippedMalformed }`) threaded through the whole walk to accumulate counters.
2. Calls `pmFolder(parsed, ctx)` on the **top-level collection object itself** - the root collection is just a folder whose `info` carries the collection name/description.
3. Builds `meta`, pushing a `file_body` `SkippedItem` only if `ctx.skippedFileBody > 0`, and a `malformed_item` one only if `ctx.skippedMalformed > 0`.

### Tree walk - `pmFolder`

`pmFolder(node, ctx)` walks `node.item[]`. For each `child`:

- **Folder** (`Array.isArray(child.item)` is true) → `ctx.folderCount += 1`, recurse via `pmFolder(child, ctx)`, push into `children`.
- **Request** (`child.request` is present) → `pmRequest(child, ctx)`, push into `requests`.
- **Not an object at all** (`null`, a string, a number) → skipped, counting toward `ctx.skippedMalformed`. Hand-edited or script-filtered JSON can contain these, and the v2.0 detector's permissive fallback accepts such a file; dereferencing the entry used to throw a bare `TypeError: Cannot read properties of null` that failed the whole import naming neither the format nor an item. `event[]` entries are filtered the same way (`pmEvents`).
- Anything else (an object with no `item[]` and no `request`) is silently ignored.

Folder vs request discrimination is purely structural: **presence of an `item` array makes a node a folder**, otherwise presence of a `request` makes it a request. Nesting is unbounded (direct recursion).

The returned `CollectionDraft` carries `name`, `description`, `variables`, `auth`, the two scripts, and its `children`/`requests`. The root and every folder are built by the same function - the root is simply the outermost `pmFolder` result and becomes `collections[0]` (the only root; `parentId = null`).

### Request build - `pmRequest`

`pmRequest(item, ctx)` reads `item.request`, derives `url`/`params` via `pmUrl`, maps auth via `mapPostmanAuth`, increments `ctx.requestCount`, and (if the request auth mode is `digest`/`aws`/`ntlm`) increments `ctx.nonExecutableAuth`. Scripts come from `item.event[]` (`prerequest`, `test`); redirect settings come from `item.protocolProfileBehavior` (see [Redirect settings](#redirect-settings)).

## Field mapping

### Collection (root)

The root is produced by `pmFolder(parsed, ctx)`; `parsed` is the whole collection object.

| Postman | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `info.name` → `name` (fallback `name` → `"Imported Collection"`) | `name` | `info.name ?? name ?? "Imported Collection"` |
| `info.description` (fallback `description`) | `description` | string used directly; if object, `.content` is used; else `""` |
| `variable[]` | `variables` | via `toVarRecord` |
| `auth` | `auth` | via `collectionAuth` (see [Auth](#auth-mapping)) |
| `event[]` (`prerequest`) | `preRequestScript` | via `joinExec`; `""` when `importScripts` is false |
| `event[]` (`test`) | `postRequestScript` | via `joinExec`; `""` when `importScripts` is false |
| nested `item[]` (folders) | `children` | recursion |
| `item[]` (requests) | `requests` | |

### Collection (folder)

Same `pmFolder` mapping. A folder node has `name`/`description`/`variable`/`auth`/`event` at the top level (no `info` wrapper), but the code reads `node.info?.name ?? node.name` and `node.info?.description ?? node.description`, so both shapes work. Each nested folder increments `ctx.folderCount`.

### Request

| Postman (`item` / `item.request`) | Vayu `RequestDraft` | Notes |
|-----------------------------------|---------------------|-------|
| `item.name` | `name` | fallback `"Untitled"` |
| `request.description` | `description` | string used directly; if object, `.content`; else `""` |
| `request.method` | `method` | `toMethod`: upper-cased; if not one of GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS → `GET` |
| `request.url` | `url`, `params` | via `pmUrl` (see [URL handling](#url-handling)) |
| `request.header[]` | `headers` | via `mapKeyValues` |
| `request.body` | `body` | via `pmBody` (see [Body mapping](#body-mapping)) |
| `request.auth` | `auth` | via `mapPostmanAuth`; `inherit` allowed for requests |
| `item.event[]` (`prerequest`) | `preRequestScript` | via `joinExec`; `""` when `importScripts` is false |
| `item.event[]` (`test`) | `postRequestScript` | via `joinExec`; `""` when `importScripts` is false |
| `item.protocolProfileBehavior.followRedirects` | `followRedirects` | only when it is a boolean; otherwise **absent** (engine default `true`) |
| `item.protocolProfileBehavior.maxRedirects` | `maxRedirects` | only when it is a finite number; otherwise **absent** (engine default `10`) |

### Redirect settings

Postman writes item-level `protocolProfileBehavior` exactly when the user overrides redirect handling for that request, so it is present precisely where it matters. `pmRedirects(item)` reads the two fields Vayu stores per request and the orchestrator forwards them on `POST /import/apply`.

Both fields are **optional on the draft and omitted from the payload when the source did not state them** - the engine then applies its own defaults (`followRedirects: true`, `maxRedirects: 10`). An absent field must not look like a stated `true`: the engine follows redirects by default, so dropping a source `false` silently follows the 3xx the request exists to inspect.

Values of the wrong type are ignored rather than coerced (a `"false"` string would read as the user's setting while being its opposite). Collection- and folder-level `protocolProfileBehavior` is **not** read: Vayu stores redirect settings per request only, so there is nowhere to put it.

## URL handling

`pmUrl(url)` handles both shapes:

- **String url** (v2.0, sometimes v2.1): if there is no `?`, the whole string is the base URL (`normalizeVars` applied), `params = []`. If there is a `?`, the substring before `?` is the base and the query string goes through `queryEntries`: split on `&`, each `key=value` pair URL-decoded, with `value` run through `normalizeVars`; missing `=` yields an empty value. All extracted params are `enabled: true`.
- **Object url** (v2.1): `url.raw` is split at the first `?` to get the base (`normalizeVars` applied); query parameters come from `url.query[]` via `mapKeyValues` (so disabled query params and descriptions are preserved). When `query[]` is absent or empty **and** `raw` carries a query string, `raw`'s query is parsed instead via the same `queryEntries` - schema-legal and produced by hand-written or script-generated collections that populate only `raw`, where the query used to be discarded silently. When `query[]` has entries it always wins, since it carries disabled state and descriptions `raw` cannot.

**Decoding never aborts the import.** `queryEntries` decodes through `safeDecode`, which returns the still-encoded text when `decodeURIComponent` throws. Postman does not percent-validate a typed URL, so a literal `%` in a value (`?discount=50%`, a LIKE pattern) is realistic - and a bare `decodeURIComponent` used to raise `URIError: URI malformed` out of `parseImport`, failing an entire file with no pointer to the offending request.

Postman path-segment variables, host arrays, and port are not separately consumed - only `raw` (base) and `query` matter for the object form.

## Body mapping

`pmBody(body, ctx)` switches on `body.mode`. A missing `body` or missing `body.mode` → `{ mode: "none" }`.

| Postman `body.mode` | Vayu `RequestBody` | Notes |
|---------------------|--------------------|-------|
| `raw` | `rawBody(body.raw, body.options.raw.language)` | see raw sniffing below |
| `urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `fields` = `mapKeyValues(body.urlencoded)` |
| `formdata` | `{ mode: "form-data", fields }` | text entries via `mapKeyValues`; a `type: "file"` entry becomes a **file row** per path in `src` (a string or an array - Postman allows several files per field), marked `unresolved`. Only a file entry naming no path adds to `ctx.skippedFileBody`. |
| `graphql` | `{ mode: "graphql", content }` | via `graphqlContent` - the graphql object is serialized to JSON with `variables` **parsed** (see below); `operationName` rides along, and the request gains a `Content-Type` (see below) |
| `file` | `{ mode: "none" }` | adds 1 to `ctx.skippedFileBody` - a whole-body file is a shape Vayu has no mode for (unlike a multipart file *part*, which imports) |
| anything else | `{ mode: "none" }` | |

**GraphQL `variables` (`graphqlContent`):** Postman stores `body.graphql` as `{ query, variables }` where `variables` is the *text* of the Variables pane - a JSON-encoded string. Vayu's own `serializeGraphQLBody` writes `variables` as an object, and the engine sends the stored content verbatim, so the string is parsed here; embedding it as-is put `"variables": "{\"limit\": 10}"` on the wire (spec-invalid) and showed a double-escaped blob in the Variables pane. Two deliberate fallbacks: a variables string that is **not valid JSON is kept as text** (the pane text is the only copy of the user's work, so an import that deletes it is worse than one that shows it unparsed - and the pane now shows a string-typed `variables` verbatim rather than as an escaped blob, converting it to an object once an edit makes it parse), and an **empty or whitespace-only** string drops the key entirely, which is what Vayu writes for an empty pane. Every other key on the object rides along untouched.

**GraphQL `operationName`:** preserved verbatim, like every other key on the object. It names which operation in a multi-operation document to execute, and Vayu's GraphQL panes carry it through an edit and expose it as an operation picker above the query pane - so an imported request keeps running the operation it was imported with.

**GraphQL `Content-Type` (`withRequiredContentType` in `shared.ts`):** a GraphQL body is a JSON envelope, so the request needs `Content-Type: application/json` - and Vayu's request builder adds that header only when you *pick* GraphQL, which an import never does. The header was therefore absent, and libcurl defaults to `application/x-www-form-urlencoded`, which most GraphQL servers answer with a `400`; nothing in the app said why. The header is now written at import, through the same `contentTypeToAdd` rule the mode picker uses: a Content-Type the collection declares wins (including a deliberate `application/graphql`), and a **disabled** row does not count as declaring one.

**Raw language sniffing (`rawBody` in `shared.ts`):**

| `options.raw.language` | Result |
|------------------------|--------|
| `"json"` | `{ mode: "json", content }` |
| `"text"` | `{ mode: "text", content }` |
| absent / other | tries `JSON.parse(content)`; success → `{ mode: "json" }`, failure → `{ mode: "text" }` |

**Dropped:** binary/file bodies (mode `file`) and per-field file uploads inside `formdata`. Both are counted into `ctx.skippedFileBody` and surface as a single `{ kind: "file_body", count }` `SkippedItem`.

## Auth mapping

Auth is mapped by `mapPostmanAuth(auth)` (`shared.ts`). It reads `auth.type`, then flattens the type-specific detail via `authDetail(auth[type])`.

| Postman `auth.type` | Vayu `RequestAuth` | Notes |
|---------------------|--------------------|-------|
| (absent / no `type`) | `{ mode: "inherit" }` | |
| `bearer` | `{ mode: "bearer", token }` | `token` normalized |
| `basic` | `{ mode: "basic", username, password }` | both normalized |
| `apikey` | `{ mode: "apikey", key, value, in }` | `in` = `"query"` only if detail `in === "query"`, else `"header"` |
| `oauth2` | `{ mode: "oauth2", config: OAuth2Config }` | mapped via `mapPostmanOAuth2` (`oauth2-import.ts`) - **executable**; grant normalized, minimal `accessToken`-only exports become a bearer token |
| `awsv4` | `{ mode: "aws", config }` | `awsv4` is the schema's enum value for AWS Signature; Vayu's internal mode is `aws`, so the name is translated rather than passed through. Matching on `"aws"` here dropped every real SigV4 export to `{mode:"none"}` *and* suppressed the `nonExecutableAuth` warning |
| `digest` / `ntlm` | `{ mode: type, config }` | `config` is the raw flattened detail map; **not executed** by Vayu (counted as `nonExecutableAuth` per request, as `aws` is) |
| `inherit` | `{ mode: "inherit" }` | |
| `noauth` | `{ mode: "none" }` | on a **request**; a collection/folder `noauth` is terminal - see below |
| any other type | `{ mode: "none" }` | includes `hawk` / `oauth1` / `edgegrid`, which are dropped without a warning counter |

**`authDetail` - v2.1 array vs v2.0 object:** Postman stores auth detail either as an array of `{ key, value }` entries (v2.1) or as a plain object (v2.0). `authDetail` handles both: arrays are folded into a `{ key: value }` map (skipping entries without `key`); objects have every entry coerced to a string. The result is the same flat string map regardless of source version, so the rest of `mapPostmanAuth` is version-agnostic.

**Collection / folder vs request inherit rules:**

- **Requests** keep `mapPostmanAuth` output verbatim - `inherit` is a valid mode for a `RequestDraft` and is resolved at execution time. A request's own `noauth` becomes `{ mode: "none" }`, which already means "send nothing" for a request.
- **Collections and folders** go through `collectionAuth`, which distinguishes two states Postman keeps apart:

  | Postman collection/folder `auth` | `CollectionDraft.auth` | Inheritance |
  |---|---|---|
  | absent, or `{"type":"inherit"}` | `{ mode: "none" }` | transparent - a descendant's `inherit` keeps climbing |
  | `{"type":"noauth"}` (explicit No Auth) | `{ mode: "noauth" }` | **terminal** - descendants send no credentials |
  | any concrete type | that mode | the descendant inherits it |

  Collections never inherit (`CollectionDraft.auth` excludes `inherit`), which is why `inherit` collapses to `none`. The explicit-`noauth` case must not collapse with it: the resolution walk steps over `none`, so a request set to Inherit inside a No Auth folder used to resolve to the *root* collection's credentials - sending a bearer token to the endpoints the user had marked unauthenticated. The terminal mode is read by `resolveAuthSource` (renderer) and `composeAuth` (MCP); see [variable resolution → auth inheritance](../variable-resolution.md#auth-inheritance).

**`nonExecutableAuth` counting:** only **request** auth contributes (`pmRequest` increments the counter), and it keys off the *mapped* mode, so `awsv4` counts as `aws`. Collection/folder auth in the `digest`/`aws`/`ntlm` family is stored but not counted. `oauth2` is executable and never counts.

## Variables & environments

Collection- and folder-level `variable[]` arrays map to `CollectionDraft.variables` via `toVarRecord`:

- entries without a `key` are skipped;
- enabled state is `!disabled` if `disabled` is set, else `enabled` if set, else `true`;
- the value is coerced to a string (`asString`) and run through `normalizeVars`.

Postman **collection** files do not embed environments, so this parser always returns `environments: []` and `meta.environmentCount: 0`. Postman exports environments as separate files, which [`postman-environment.ts`](./postman-environment.md) reads.

## Options & lossy behavior

**`importScripts`** is honored: when `opts.importScripts` is false, `pmRequest` and `pmFolder` emit `""` for both `preRequestScript` and `postRequestScript` (the `joinExec` call is gated behind the flag). When true, `joinExec` joins the event's `script.exec` array with `\n` (or returns the string form, else `""`). `importEnvironments` is accepted but unused by this parser (no environments to import).

**`meta.skipped`** - this parser populates two kinds: `file_body` when `ctx.skippedFileBody > 0` (from `formdata` file fields and `file`-mode bodies), and `malformed_item` when `ctx.skippedMalformed > 0` (non-object `item[]`/`event[]` entries). It does **not** emit `websocket`, `grpc`, `api_spec`, or `unit_test` items.

**`meta.nonExecutableAuth`** - populated: incremented once per **request** whose mapped auth mode is `digest`, `aws`, or `ntlm`. These auths are stored on the draft (with their `config`) but Vayu has no execution path for them. `oauth2` is now mapped to an executable config and does **not** count.

> Note: `types.ts` carries a TODO comment implying `skipped`/`nonExecutableAuth` are not yet wired up. That comment is stale for this parser - both fields are populated here as described above (within the limits noted: only `file_body`, and request-level non-executable auth).

## Shared helpers used

All defined in `app/src/services/importers/shared.ts` (except `normalizeVars`); see the [index](./README.md#shared-helpers) for full reference.

| Helper | Use in this parser |
|--------|--------------------|
| [`asString`](./README.md#asstring) | coerce any scalar to its string form (values are stored as strings) - used inside `toVarRecord`/`authDetail` |
| [`toVarRecord`](./README.md#tovarrecord) | collection/folder `variable[]` → `CollectionDraft.variables` |
| [`mapKeyValues`](./README.md#mapkeyvalues) | `header[]`, `query[]`, `urlencoded[]`, `formdata[]` → `KeyValueEntry[]` (preserves disabled + duplicates) |
| [`mapPostmanAuth`](./README.md#mappostmanauth) | `auth` object → `RequestAuth` (request and, via `collectionAuth`, collection/folder) |
| [`rawBody`](./README.md#rawbody) | raw-mode body → `RequestBody` with JSON/text language sniffing |
| [`joinExec`](./README.md#joinexec) | `event.script.exec` → joined script string |
| [`normalizeVars`](./README.md#normalizevars) | rewrite `{{ x }}` / `{{ _.x }}` template syntax to Vayu `{{x}}` (`var-normalize.ts`); applied to URLs, values, vars, and auth fields. Called **without** `pathTemplates`, so a literal single-brace `{x}` is left alone - in Postman only `{{x}}` is a template, and rewriting `/tags/{beta}` or `fields=friends{name}` invented a variable that resolved to nothing |

## Related

- [Import pipeline index](./README.md)
- [Insomnia v4](./insomnia-v4.md)
- [OpenAPI v3](./openapi-v3.md)
- [OpenAPI v2](./openapi-v2.md)
