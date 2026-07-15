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

1. Creates a mutable `Ctx` (`{ opts, requestCount, folderCount, nonExecutableAuth, skippedFileBody }`) threaded through the whole walk to accumulate counters.
2. Calls `pmFolder(parsed, ctx)` on the **top-level collection object itself** — the root collection is just a folder whose `info` carries the collection name/description.
3. Builds `meta`, pushing a `file_body` `SkippedItem` only if `ctx.skippedFileBody > 0`.

### Tree walk — `pmFolder`

`pmFolder(node, ctx)` walks `node.item[]`. For each `child`:

- **Folder** (`Array.isArray(child.item)` is true) → `ctx.folderCount += 1`, recurse via `pmFolder(child, ctx)`, push into `children`.
- **Request** (`child.request` is present) → `pmRequest(child, ctx)`, push into `requests`.
- Anything else (no `item[]`, no `request`) is silently ignored.

Folder vs request discrimination is purely structural: **presence of an `item` array makes a node a folder**, otherwise presence of a `request` makes it a request. Nesting is unbounded (direct recursion).

The returned `CollectionDraft` carries `name`, `description`, `variables`, `auth`, the two scripts, and its `children`/`requests`. The root and every folder are built by the same function — the root is simply the outermost `pmFolder` result and becomes `collections[0]` (the only root; `parentId = null`).

### Request build — `pmRequest`

`pmRequest(item, ctx)` reads `item.request`, derives `url`/`params` via `pmUrl`, maps auth via `mapPostmanAuth`, increments `ctx.requestCount`, and (if the request auth mode is `digest`/`aws`/`ntlm`) increments `ctx.nonExecutableAuth`. Scripts come from `item.event[]` (`prerequest`, `test`).

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

## URL handling

`pmUrl(url)` handles both shapes:

- **String url** (v2.0, sometimes v2.1): if there is no `?`, the whole string is the base URL (`normalizeVars` applied), `params = []`. If there is a `?`, the substring before `?` is the base, and the query string is split on `&`, each `key=value` pair URL-decoded (`decodeURIComponent`), with `value` run through `normalizeVars`; missing `=` yields an empty value. All extracted params are `enabled: true`.
- **Object url** (v2.1): `url.raw` is split at the first `?` to get the base (`normalizeVars` applied); query parameters come from `url.query[]` via `mapKeyValues` (so disabled query params and descriptions are preserved). The `url.raw` query string itself is discarded in favour of the structured `query[]`.

Postman path-segment variables, host arrays, and port are not separately consumed — only `raw` (base) and `query` matter for the object form.

## Body mapping

`pmBody(body, ctx)` switches on `body.mode`. A missing `body` or missing `body.mode` → `{ mode: "none" }`.

| Postman `body.mode` | Vayu `RequestBody` | Notes |
|---------------------|--------------------|-------|
| `raw` | `rawBody(body.raw, body.options.raw.language)` | see raw sniffing below |
| `urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `fields` = `mapKeyValues(body.urlencoded)` |
| `formdata` | `{ mode: "form-data", fields }` | only entries with `type !== "file"` kept; each dropped file entry adds to `ctx.skippedFileBody` |
| `graphql` | `{ mode: "graphql", content }` | `content = JSON.stringify(body.graphql ?? {})` — the entire graphql object (query + variables) is serialized to JSON |
| `file` | `{ mode: "none" }` | adds 1 to `ctx.skippedFileBody` |
| anything else | `{ mode: "none" }` | |

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
| `oauth2` | `{ mode: "oauth2", config: OAuth2Config }` | mapped via `mapPostmanOAuth2` (`oauth2-import.ts`) — **executable**; grant normalized, minimal `accessToken`-only exports become a bearer token |
| `digest` / `aws` / `ntlm` | `{ mode: type, config }` | `config` is the raw flattened detail map; **not executed** by Vayu (counted as `nonExecutableAuth` per request) |
| `inherit` | `{ mode: "inherit" }` | |
| `noauth` | `{ mode: "none" }` | |
| any other type | `{ mode: "none" }` | |

**`authDetail` — v2.1 array vs v2.0 object:** Postman stores auth detail either as an array of `{ key, value }` entries (v2.1) or as a plain object (v2.0). `authDetail` handles both: arrays are folded into a `{ key: value }` map (skipping entries without `key`); objects have every entry coerced to a string. The result is the same flat string map regardless of source version, so the rest of `mapPostmanAuth` is version-agnostic.

**Collection / folder vs request inherit rules:**

- **Requests** keep `mapPostmanAuth` output verbatim — `inherit` is a valid mode for a `RequestDraft` and is resolved at execution time.
- **Collections and folders** go through `collectionAuth`, which calls `mapPostmanAuth` and then rewrites `inherit` → `{ mode: "none" }`. Collections never inherit (the `CollectionDraft.auth` type excludes `inherit`). So an absent/`inherit`/`noauth` auth on a collection or folder all collapse to `{ mode: "none" }`.

**`nonExecutableAuth` counting:** only **request** auth contributes (`pmRequest` increments the counter). Collection/folder auth in the `digest`/`aws`/`ntlm` family is stored but not counted. `oauth2` is executable and never counts.

## Variables & environments

Collection- and folder-level `variable[]` arrays map to `CollectionDraft.variables` via `toVarRecord`:

- entries without a `key` are skipped;
- enabled state is `!disabled` if `disabled` is set, else `enabled` if set, else `true`;
- the value is coerced to a string (`asString`) and run through `normalizeVars`.

Postman **collection** files do not embed environments, so this parser always returns `environments: []` and `meta.environmentCount: 0`. (Postman environments are exported as separate files and are not handled here.)

## Options & lossy behavior

**`importScripts`** is honored: when `opts.importScripts` is false, `pmRequest` and `pmFolder` emit `""` for both `preRequestScript` and `postRequestScript` (the `joinExec` call is gated behind the flag). When true, `joinExec` joins the event's `script.exec` array with `\n` (or returns the string form, else `""`). `importEnvironments` is accepted but unused by this parser (no environments to import).

**`meta.skipped`** — this parser populates **only** the `file_body` kind, and only when `ctx.skippedFileBody > 0` (from `formdata` file fields and `file`-mode bodies). It does **not** emit `websocket`, `grpc`, `api_spec`, or `unit_test` items.

**`meta.nonExecutableAuth`** — populated: incremented once per **request** whose mapped auth mode is `digest`, `aws`, or `ntlm`. These auths are stored on the draft (with their `config`) but Vayu has no execution path for them. `oauth2` is now mapped to an executable config and does **not** count.

> Note: `types.ts` carries a TODO comment implying `skipped`/`nonExecutableAuth` are not yet wired up. That comment is stale for this parser — both fields are populated here as described above (within the limits noted: only `file_body`, and request-level non-executable auth).

## Shared helpers used

All defined in `app/src/services/importers/shared.ts` (except `normalizeVars`); see the [index](./README.md#shared-helpers) for full reference.

| Helper | Use in this parser |
|--------|--------------------|
| [`asString`](./README.md#asstring) | coerce any scalar to its string form (values are stored as strings) — used inside `toVarRecord`/`authDetail` |
| [`toVarRecord`](./README.md#tovarrecord) | collection/folder `variable[]` → `CollectionDraft.variables` |
| [`mapKeyValues`](./README.md#mapkeyvalues) | `header[]`, `query[]`, `urlencoded[]`, `formdata[]` → `KeyValueEntry[]` (preserves disabled + duplicates) |
| [`mapPostmanAuth`](./README.md#mappostmanauth) | `auth` object → `RequestAuth` (request and, via `collectionAuth`, collection/folder) |
| [`rawBody`](./README.md#rawbody) | raw-mode body → `RequestBody` with JSON/text language sniffing |
| [`joinExec`](./README.md#joinexec) | `event.script.exec` → joined script string |
| [`normalizeVars`](./README.md#normalizevars) | rewrite `{{ x }}` / `{{ _.x }}` / OpenAPI `{x}` template syntax to Vayu `{{x}}` (`var-normalize.ts`); applied to URLs, values, vars, and auth fields |

## Related

- [Import pipeline index](./README.md)
- [Insomnia v4](./insomnia-v4.md)
- [OpenAPI v3](./openapi-v3.md)
- [OpenAPI v2](./openapi-v2.md)
