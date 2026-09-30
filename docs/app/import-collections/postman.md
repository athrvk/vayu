---
description: >-
  What carries over when you import a Postman Collection v2.0 or v2.1 export into Vayu - folders, variables, auth, scripts, and bodies.
---

# Postman Collection v2.1 / v2.0

Parses exported Postman Collection JSON (schema v2.1.0 and v2.0.0) into the Vayu draft model. Both versions share the same parse implementation; the only differences are detection and the shape of the `url`/`auth` objects (handled transparently by the shared helpers).

- **Source:** `engine/src/core/import_document.cpp`
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

  | Class | `formatName` | `formatKey` |
  |-------|--------------|-------------|
  | `PostmanV21Parser` | `Postman Collection v2.1` | `postman-v21` |
  | `PostmanV20Parser` | `Postman Collection v2.0` | `postman-v20` |

Both implement `ImportParser` (`detect` + `parse`) from `./types`.

## Detection

The factory (`core::parse_import`) parses the raw string once (JSON, then YAML fallback) and runs each parser's `detect(parsed, raw)` in registration order until one returns `true`.

| Class | `detect()` logic |
|-------|------------------|
| `PostmanV21Parser` | `parsed.info.schema` is a string **containing** `"v2.1.0"`. |
| `PostmanV20Parser` | `parsed.info.schema` is a string **containing** `"v2.0.0"`; **or** `parsed.info` is present, `parsed.item` is an array, and `schema == null` (no schema field at all → treated as v2.0). |

The match is a substring check (`schema.includes(...)`), so the full schema URL (e.g. `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`) is accepted.

**Why v2.1 is tried first:** the factory's `PARSERS` array lists `PostmanV21Parser` before `PostmanV20Parser`. v2.1 has the stricter test (exact `v2.1.0` substring), and v2.0's fallback branch is permissive (it claims any `info` + `item[]` document with no schema). Ordering v2.1 first ensures a true v2.1 file is never swallowed by v2.0's loose fallback.

## Parse flow

`parse()` on either class delegates to the module-level `parsePostman(parsed, opts, formatName)`, which:

1. Creates a mutable `Ctx` (`{ opts, requestCount, folderCount, nonExecutableAuth, skippedFileBody, skippedMalformed, skippedUnsupportedMethod, skippedUnsupportedAuth, skippedUrlWithoutRaw, skippedVariableMetadata }`) threaded through the whole walk to accumulate counters.
2. Calls `pmFolder(parsed, ctx)` on the **top-level collection object itself** - the root collection is just a folder whose `info` carries the collection name/description.
3. Builds `meta`, pushing a `SkippedItem` for each counter that is greater than zero.

### Tree walk - `pmFolder`

`pmFolder(node, ctx)` walks `node.item[]`. For each `child`:

- **Folder** (`Array.isArray(child.item)` is true) → `ctx.folderCount += 1`, recurse via `pmFolder(child, ctx)`, push into `children`.
- **Request** (`child.request` is present) → `pmRequest(child, ctx)`, push into `requests`.
- **Not an object at all** (`null`, a string, a number) → skipped, counting toward `ctx.skippedMalformed`. Hand-edited or script-filtered JSON can contain these, and the v2.0 detector's permissive fallback accepts such a file; dereferencing the entry used to throw a bare `TypeError: Cannot read properties of null` that failed the whole import naming neither the format nor an item. `event[]` entries are filtered the same way (`pmEvents`).
- Anything else (an object with no `item[]` and no `request`) is silently ignored.

Folder vs request discrimination is purely structural: **presence of an `item` array makes a node a folder**, otherwise presence of a `request` makes it a request. Nesting is unbounded (direct recursion).

The returned `CollectionDraft` carries `name`, `description`, `variables`, `auth`, the two scripts, and its `children`/`requests`. The root and every folder are built by the same function - the root is simply the outermost `pmFolder` result and becomes `collections[0]` (the only root; `parentId = null`).

### Request build - `pmRequest`

`pmRequest(item, ctx)` reads `item.request`, derives `url`/`params` via `pmUrl`, maps auth via `map_postman_auth`, increments `ctx.requestCount`, and (if the request auth mode is one of the data-only modes in `CONFIG_AUTH_TYPES`) increments `ctx.nonExecutableAuth`. Scripts come from `item.event[]` (`prerequest`, `test`); redirect settings come from `item.protocolProfileBehavior` (see [Redirect settings](#redirect-settings)).

## Field mapping

### Collection (root)

The root is produced by `pmFolder(parsed, ctx)`; `parsed` is the whole collection object.

| Postman | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `info.name` → `name` (fallback `name` → `"Imported Collection"`) | `name` | `info.name ?? name ?? "Imported Collection"` |
| `info.description` (fallback `description`) | `description` | string used directly; if object, `.content` is used; else `""` |
| `variable[]` | `variables` | via `to_var_record` |
| `auth` | `auth` | via `collectionAuth` (see [Auth](#auth-mapping)) |
| `event[]` | `elements` | via `set_event_elements` - see [Scripts](#scripts); none when `importScripts` is false |
| nested `item[]` (folders) | `children` | recursion |
| `item[]` (requests) | `requests` | |

### Collection (folder)

Same `pmFolder` mapping. A folder node has `name`/`description`/`variable`/`auth`/`event` at the top level (no `info` wrapper), but the code reads `node.info?.name ?? node.name` and `node.info?.description ?? node.description`, so both shapes work. Each nested folder increments `ctx.folderCount`.

### Request

| Postman (`item` / `item.request`) | Vayu `RequestDraft` | Notes |
|-----------------------------------|---------------------|-------|
| `item.name` | `name` | fallback `"Untitled"` |
| `request.description`, else `item.description` | `description` | string used directly; if object, `.content`; else `""`. The schema allows either place and generated collections use the item's; the export writes it on the request, where Postman's own export puts it |
| `request.method` | `method` | `toMethod`: upper-cased; if not one of GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS → `GET`, counted as `unsupported_method` (a custom verb such as `PROPFIND` or `PURGE`) |
| `request.url` | `url`, `params` | via `pmUrl` (see [URL handling](#url-handling)) |
| `request.header[]` | `headers` | via `map_key_values`; a row's `type` other than `"text"` (recent Postman writes `"default"`) is kept on the row for the export to write back |
| `request.body` | `body` | via `pmBody` (see [Body mapping](#body-mapping)) |
| `request.auth` | `auth` | via `map_postman_auth`; `inherit` allowed for requests |
| `item.event[]` | `elements` | via `set_event_elements` - see [Scripts](#scripts); none when `importScripts` is false |
| `item.protocolProfileBehavior.followRedirects` | `followRedirects` | only when it is a boolean; otherwise **absent** (engine default `true`) |
| `item.protocolProfileBehavior.maxRedirects` | `maxRedirects` | only when it is a finite number; otherwise **absent** (engine default `10`) |
| `item.protocolProfileBehavior.strictSSL` | `verifySSL` | only when it is a boolean; otherwise **absent** (engine default `true`) |
| `item.response[]` | `examples` | via `pmExamples` (see [Saved responses](#saved-responses)); **absent** when the item saved none |
| `request.certificate` | `clientCertificates[]` (top-level, not a request field) | resolved into a `client_certificates` registry entry keyed on the request's own host, applied best-effort by `POST /import/apply` after the rest of the tree commits (issue #1656) - Vayu's client certificates belong to a host, not a request. A candidate is resolved only when it would pass the same check `POST /client-certificates` runs: a readable PEM pair or PKCS#12 file, a literal (not `{{var}}`) host, and no earlier request in this import already claiming a different certificate for that (host, port). Anything else counts as `certificate` instead |
| `request.proxy` | - | not imported - Vayu has no per-request proxy override, and none is planned: `TransportPolicy` is workspace/run-scoped (`engine/CLAUDE.md`), so this stays a permanent tally rather than a mapping (issue #1656's own recorded decision); counted as `proxy_config` |

### Scripts

`set_event_elements` turns every `event[]` entry into one element, in the
order the document lists them: `prerequest` becomes `script.pre`, `test`
becomes `script.post`, and the script is `join_exec` of its `exec`. Postman
runs every event of a listen in order, and Vayu runs every script element of
a phase in order, so a second `test` event is a second element (it used to be
dropped without a count) and a level that lists `test` before `prerequest`
exports back that way. An event marked `disabled: true` is one Postman's
runtime skips, so it imports as an element with `enabled: false` rather than
a script that runs. A blank script contributes nothing, and a `listen` other
than those two has no phase in Vayu.

### Saved responses

Postman stores a request's recorded responses in `item.response[]`. They were read by nothing until the engine had a table for them (issue #481), so importing a collection whose value *was* its documented responses produced a collection with none - and the loss was not even counted.

`pmExamples(item, ctx)` maps each entry to an `ExampleDraft`:

| Postman (`item.response[]` entry) | Vayu `ExampleDraft` | Notes |
|-----------------------------------|---------------------|-------|
| `name` | `name` | fallback `"Example"` |
| `code` | `status` | only when it is a finite number; otherwise `200`, which is what Postman shows for a saved response with no code |
| `header[]` | `headers` | via `map_key_values` - source order and duplicates (`Set-Cookie`) preserved |
| `body` | `body` | stored verbatim |
| `header[]` `Content-Type` | `contentType` | `""` when the recorded response carried none |
| the whole entry | `postmanResponse` | JSON text, source member order, `name` and `body` as `null` placeholders; left out when over 1 MiB |

`_postman_previewlanguage` is deliberately **not** read into `contentType`: it is an editor mode (`"json"`, `"html"`), not a media type, and storing it would put a value in that field which is not one.

`postmanResponse` keeps what no example field models - the request the response was recorded against (`originalRequest`, which usually differs per example: its own query values, headers, body and path variables), the status text as recorded, `_postman_previewlanguage` / `_postman_previewtype`, `cookie[]`, `responseTime`, and the header rows as written (`name` fields, number values) - so an export writes them back. It is stored in `request_examples.postman_response` and read only by the Postman export; nothing is lost, so nothing is counted in `meta.skipped`. An entry whose text would pass the cap is imported without it and its export regenerates those members.

An entry that is not an object counts toward `malformed_item`, the same treatment `pmFolder` gives a malformed item. A request that saved no responses omits `examples` entirely rather than sending `[]` - the orchestrator forwards presence, and an empty array reads as "this request documents no responses".

`meta.exampleCount` totals what survived, counted off the drafts by `count_examples` (the same read-the-result approach `unattached_file_parts` uses), and the import preview shows it.

### Redirect settings

Postman writes item-level `protocolProfileBehavior` exactly when the user overrides redirect or TLS handling for that request, so it is present precisely where it matters. `pmRedirects(item)` reads the three fields Vayu stores per request and the orchestrator forwards them on `POST /import/apply`.

All three fields are **optional on the draft and omitted from the payload when the source did not state them** - the engine then applies its own defaults (`followRedirects: true`, `maxRedirects: 10`, `verifySSL: true`). An absent field must not look like a stated `true`: the engine follows redirects and verifies certificates by default, so dropping a source `false` silently follows the 3xx the request exists to inspect, or trusts a host the export deliberately did not.

Values of the wrong type are ignored rather than coerced (a `"false"` string would read as the user's setting while being its opposite). Collection- and folder-level `protocolProfileBehavior` is **not** read: Vayu stores these settings per request only, so there is nowhere to put it.

Three other item-level settings change what Postman sends and have no
per-request place in Vayu: `disabledSystemHeaders` (Postman's own default
headers turned off), `disableCookies` and `disableUrlEncoding`. A request
stating any of them is counted once as `protocol_behavior`. `disableBodyPruning`
is not counted: Vayu always sends a body, and the export writes it for a GET or
HEAD that has one.

## URL handling

`pmUrl(url)` handles both shapes:

- **String url** (v2.0, sometimes v2.1): if there is no `?`, the whole string is the base URL (`normalize_template_vars` applied), `params = []`. If there is a `?`, the substring before `?` is the base and the query string goes through `queryEntries`: split on `&`, each `key=value` pair URL-decoded, with `value` run through `normalize_template_vars`; missing `=` yields an empty value. All extracted params are `enabled: true`.
- **Object url** (v2.1): `url.raw` is split at the first `?` to get the base (`normalize_template_vars` applied); query parameters come from `url.query[]` via `map_key_values` (so disabled query params and descriptions are preserved, and a row's boolean `equals` rides on the row for the export - it does not change how the row joins into the URL). When `query[]` is absent or empty **and** `raw` carries a query string, `raw`'s query is parsed instead via the same `queryEntries` - schema-legal and produced by hand-written or script-generated collections that populate only `raw`, where the query used to be discarded silently. When `query[]` has entries it always wins, since it carries disabled state and descriptions `raw` cannot.
- **Object url with no `raw`** (schema-legal, rare - most exports always write `raw`): `host_path_url` assembles a base from `protocol` (default `https`), `host[]` (or a bare string) joined with `.`, an optional `port`, and `path[]` (string or `{value}` variable entries) joined with `/`. Counted as `url_without_raw`, informational rather than lossy - the URL is built, not dropped.

**Decoding never aborts the import.** `queryEntries` decodes through `safeDecode`, which returns the still-encoded text when `decodeURIComponent` throws. Postman does not percent-validate a typed URL, so a literal `%` in a value (`?discount=50%`, a LIKE pattern) is realistic - and a bare `decodeURIComponent` used to raise `URIError: URI malformed` out of `parseImport`, failing an entire file with no pointer to the offending request.

**That still-encoded text is not lossless on rejoin.** `joinParamsIntoUrls` (below) re-encodes every param through `encodeURIComponent` before appending it back onto `url`, and a literal `%` that `safeDecode` gave back unchanged (`%ZZ`) gets percent-encoded like any other reserved character, into `%25ZZ` - the params table still reads `%ZZ`, but the stored URL no longer matches the source text (issue #1460). `queryEntries` counts this as `invalid_percent_encoding` rather than changing the value silently.

**Path variables (`url.variable[]`, issue #1764):** the URL keeps its `:name` segments verbatim, and each `url.variable[]` entry becomes one of the request's own Params rows marked `"in": "path"` - `key` (a v2.0 entry naming itself by `id` alone is read by that name, as Postman's `Url` does), `value` (through `normalize_template_vars`), `description`, `type` and `disabled` kept, in the order the entry lists them. A `:name` the path spells that no entry declares gets no stored row, and neither does any `:name` of a string url (v2.0), which has no `url.variable[]`: the Params tab shows an empty row for it until it is edited, and an export writes `url.variable[]` only for rows that exist, so a round trip does not add an entry the source never had. A declared entry no segment uses is kept. Which segments are path variables is Postman's own rule (`core::path_variable_segments`): a whole path segment after the authority that starts with `:`, the name running to the first `.`. Nothing is promoted to a collection variable and nothing is counted: two requests on `:id` keep their own values, and composition writes each request's value into its segment at send time (see [`POST /compose`](../../engine/api-reference.md#path-variables)).

**The split is `pmUrl`'s output, not the stored shape.** `parseImport` rejoins each request's *enabled* query params (never a path row) onto its `url` afterwards, because that is where every execution path reads the query from - see [The url/params invariant](./README.md#the-urlparams-invariant). So `{{baseUrl}}/users?page=1&trace=1` with `trace` disabled parses to base + two params here, and is stored as `{{baseUrl}}/users?page=1` with both params still in the table.

## Body mapping

`pmBody(body, ctx)` switches on `body.mode`. A missing `body` or missing `body.mode` → `{ mode: "none" }`. `body.disabled: true` ("prevent request body from being sent") is checked first and also imports as `{ mode: "none" }` regardless of `mode` - counted as `disabled_body` (issue #1444) rather than sending a body the user had turned off.

| Postman `body.mode` | Vayu `RequestBody` | Notes |
|---------------------|--------------------|-------|
| `raw` | `postman_raw_body(body.raw, body.options.raw.language)` | see raw sniffing below |
| `urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `fields` = `mapKeyValues(body.urlencoded)`, a row's non-`"text"` `type` kept as on a header |
| `formdata` | `{ mode: "form-data", fields }` | text entries via `map_key_values`; a `type: "file"` entry becomes a **file row** per path in `src` (a string or an array - Postman allows several files per field), marked `unresolved`. Only a file entry naming no path adds to `ctx.skippedFileBody`. |
| `graphql` | `{ mode: "graphql", content }` | via `graphqlContent` - the graphql object is serialized to JSON with `variables` **parsed** (see below); `operationName` rides along, and the request gains a `Content-Type` (see below) |
| `file` | `{ mode: "none" }` | adds 1 to `ctx.skippedFileBody` - a whole-body file is a shape Vayu has no mode for (unlike a multipart file *part*, which imports) |
| anything else | `{ mode: "none" }` | |

**GraphQL `variables` (`graphqlContent`):** Postman stores `body.graphql` as `{ query, variables }` where `variables` is the *text* of the Variables pane - a JSON-encoded string. Vayu's own `serializeGraphQLBody` writes `variables` as an object, and the engine sends the stored content verbatim, so the string is parsed here; embedding it as-is put `"variables": "{\"limit\": 10}"` on the wire (spec-invalid) and showed a double-escaped blob in the Variables pane. Two deliberate fallbacks: a variables string that is **not valid JSON is kept as text** (the pane text is the only copy of the user's work, so an import that deletes it is worse than one that shows it unparsed - and the pane now shows a string-typed `variables` verbatim rather than as an escaped blob, converting it to an object once an edit makes it parse), and an **empty or whitespace-only** string drops the key entirely, which is what Vayu writes for an empty pane. Every other key on the object rides along untouched.

**GraphQL `operationName`:** preserved verbatim, like every other key on the object. It names which operation in a multi-operation document to execute, and Vayu's GraphQL panes carry it through an edit and expose it as an operation picker above the query pane - so an imported request keeps running the operation it was imported with.

**GraphQL `Content-Type` (`with_required_content_type` in `import_document.cpp`):** a GraphQL body is a JSON envelope, so the request needs `Content-Type: application/json` - and Vayu's request builder adds that header only when you *pick* GraphQL, which an import never does. The header was therefore absent, and libcurl defaults to `application/x-www-form-urlencoded`, which most GraphQL servers answer with a `400`; nothing in the app said why. The header is now written at import, through the same `contentTypeToAdd` rule the mode picker uses: a Content-Type the collection declares wins (including a deliberate `application/graphql`), and a **disabled** row does not count as declaring one.

**Raw language sniffing (`postman_raw_body` in `import_document.cpp`):**

| `options.raw.language` | Result |
|------------------------|--------|
| `"json"` | `{ mode: "json", content }` |
| `"text"` | `{ mode: "text", content }` |
| `"xml"` | `{ mode: "xml", content }` - and the request gains `Content-Type: application/xml` through the same `with_required_content_type` rule GraphQL uses (below) |
| absent / other | tries `JSON.parse(content)`; success → `{ mode: "json" }`, failure → `{ mode: "text" }` - with `rawLanguage` beside it: the declared language (`"javascript"`, `"html"`), or `""` when none was declared |

`rawLanguage` changes nothing about what is sent - the sniffed mode decides
that, as before. It is what the Postman export reads to write the body's
`options` back as the document had them: none at all for an unlabelled body
(the common shape in generated collections), the declared language otherwise.
`postman_raw_body` is the one mapping both directions call, so the exporter
writes a kept `rawLanguage` only while importing the body again would still
give its stored mode.

An unlabelled body is never sniffed into `xml`: without Postman's language, a
`<`-shaped document is as likely to be HTML, and guessing would hand the request
a Content-Type the server may disagree with. `"xml"` is the only new mapping -
`"html"`, `"javascript"` and the rest still fall through to the sniff.

**Dropped:** binary/file bodies (mode `file`) and per-field file uploads inside `formdata`. Both are counted into `ctx.skippedFileBody` and surface as a single `{ kind: "file_body", count }` `SkippedItem`.

## Auth mapping

Auth is mapped by `mapPostmanAuth(auth)` (`import_document.cpp`). It reads `auth.type`, then flattens the type-specific detail via `authDetail(auth[type])`.

| Postman `auth.type` | Vayu `RequestAuth` | Notes |
|---------------------|--------------------|-------|
| (absent / no `type`) | `{ mode: "inherit" }` | |
| `bearer` | `{ mode: "bearer", token }` | `token` normalized |
| `basic` | `{ mode: "basic", username, password }` | both normalized |
| `apikey` | `{ mode: "apikey", key, value, in }` | `in` = `"query"` only if detail `in === "query"`, else `"header"` |
| `oauth2` | `{ mode: "oauth2", config: OAuth2Config }` | mapped via `map_postman_oauth2` (`import_document.cpp`) - **executable**; grant normalized. `tokenName`, when present, is stored as `config.credentialsId` - Vayu's field for keeping otherwise-identical token-cache entries apart. A block holding only a seeded `accessToken` (no grant, token URL or auth URL - commercetools writes one on every request) is what Postman sends as is, so it imports as what sends the same bytes: a bearer token, or, when `addTokenTo` is `queryParams` or `headerPrefix` is not `Bearer`, an API key (`access_token` in the query, or `Authorization: <prefix> <token>`). `state` (Vayu generates and validates its own per authorization attempt) and a seeded `accessToken` beside an explicit grant (Vayu fetches through the grant) are not used when sending and are counted as `oauth2_dropped_field` (issue #1460); both are kept in the block's `postman` source below, so an export writes them back |
| `awsv4` | `{ mode: "aws", config }` | `awsv4` is the schema's enum value for AWS Signature; Vayu's internal mode is `aws`, so the name is translated rather than passed through. Matching on `"aws"` here dropped every real SigV4 export to `{mode:"none"}` *and* suppressed the `nonExecutableAuth` warning |
| `digest` / `ntlm` / `hawk` / `oauth1` / `edgegrid` / `jwt` | `{ mode: type, config }` | `config` is the raw flattened detail map; **not executed** by Vayu (counted as `nonExecutableAuth` on each request, folder or collection declaring it, as `aws` is). The table is `CONFIG_AUTH_TYPES` in `postman_format.hpp`, which the exporter reads too, so each exports back as its own type |
| `inherit` | `{ mode: "inherit" }` | |
| `noauth` | `{ mode: "none" }` | on a **request**; a collection/folder `noauth` is terminal - see below; this is the correct mapping, not a drop, so it is not counted |
| a type the schema does not define / non-string `type` | `{ mode: "none" }` | counted as `unsupported_auth` |

**The block itself, kept for the export (`with_postman_source`).** When the
Postman exporter would not write a request's or collection's `auth` back
exactly as the document had it - an attribute Vayu has no field for
(`tokenType`, `state`, `authRequestParams`), a type stored as another mode
(the seeded-token `oauth2` above), a different attribute order or attribute
`type`, `{{ x }}` spacing the importer tightened - the document's block is
stored beside the mapped auth as `postman`, in v2.1 form (a v2.0 detail object
becomes the attribute array Postman's own conversion writes). Nothing sends
it. The exporter writes it back verbatim, key order restored, while mapping it
through `map_postman_auth` again still gives the stored auth; once the auth is
edited in Vayu the block no longer describes it and the stored auth is written
instead; the engine drops it from the stored auth at that same write, so the
credential an edit replaced does not stay behind in it. Its credentials are
blanked like any other when an export leaves credentials out, including the
PKCE `code_verifier` and the credential rows (`client_secret`,
`client_assertion`, `refresh_token` and the like) of an `oauth2` block's
`tokenRequestParams`, `authRequestParams` and `refreshRequestParams`.

**`authDetail` - v2.1 array vs v2.0 object:** Postman stores auth detail either as an array of `{ key, value }` entries (v2.1) or as a plain object (v2.0). `authDetail` handles both: arrays are folded into a `{ key: value }` map (skipping entries without `key`); objects have every entry coerced to a string. The result is the same flat string map regardless of source version, so the rest of `map_postman_auth` is version-agnostic.

**Collection / folder vs request inherit rules:**

- **Requests** keep `map_postman_auth` output verbatim - `inherit` is a valid mode for a `RequestDraft` and is resolved at execution time. A request's own `noauth` becomes `{ mode: "none" }`, which already means "send nothing" for a request.
- **Collections and folders** go through `collectionAuth`, which distinguishes two states Postman keeps apart:

  | Postman collection/folder `auth` | `CollectionDraft.auth` | Inheritance |
  |---|---|---|
  | absent, or `{"type":"inherit"}` | `{ mode: "none" }` | transparent - a descendant's `inherit` keeps climbing |
  | `{"type":"noauth"}` (explicit No Auth) | `{ mode: "noauth" }` | **terminal** - descendants send no credentials |
  | any concrete type | that mode | the descendant inherits it |

  Collections never inherit (`CollectionDraft.auth` excludes `inherit`), which is why `inherit` collapses to `none`. The explicit-`noauth` case must not collapse with it: the resolution walk steps over `none`, so a request set to Inherit inside a No Auth folder used to resolve to the *root* collection's credentials - sending a bearer token to the endpoints the user had marked unauthenticated. The terminal mode is read by `resolveAuthSource` (renderer) and `composeAuth` (MCP); see [variable resolution → auth inheritance](../variable-resolution.md#auth-inheritance).

**`nonExecutableAuth` counting:** only **request** auth contributes (`pmRequest` increments the counter), and it keys off the *mapped* mode, so `awsv4` counts as `aws`. Collection/folder auth in the data-only family is stored but not counted. `oauth2` is executable and never counts.

## Variables & environments

Collection- and folder-level `variable[]` arrays map to `CollectionDraft.variables` via `to_var_record`:

- entries without a `key` are skipped;
- enabled state is `!disabled` if `disabled` is set, else `enabled` if set, else `true`;
- the value is coerced to a string (`as_string`) and run through `normalize_template_vars`;
- `type: "secret"` sets `secret: true`; `"string"`, `"number"` and `"boolean"` are Vayu's own variable types and are stored as `type` (a script reads a `number` variable as a number, as in Postman); `"default"` is Postman's unset marker and stores nothing;
- a `description` is stored on the variable for the Postman export to write back (the variables editor does not show it);
- any other declared `type` (`"any"`, a custom string) has no Vayu counterpart and is dropped, counted once per row as `variable_metadata`.

Postman **collection** files do not embed environments, so this parser always returns `environments: []` and `meta.environmentCount: 0`. Postman exports environments as separate files, which [`import_document.cpp`](./postman-environment.md) reads.

## Options & lossy behavior

**`importScripts`** is honored: when `opts.importScripts` is false, `pmRequest` and `pmFolder` write no script elements (the `set_event_elements` call is gated behind the flag). When true, each event's `script.exec` array is joined with `\n` by `join_exec` (or its string form is used, else `""`). `importEnvironments` is accepted but unused by this parser (no environments to import).

**`meta.skipped`** - this parser populates: `file_body` (from `formdata` file fields and `file`-mode bodies), `malformed_item` (non-object `item[]`/`event[]` entries), `unsupported_method` (a custom HTTP verb, falls back to `GET`), `unsupported_auth` (an auth type the schema does not define, or a non-string `type`, falls back to no auth), `oauth2_dropped_field` (an oauth2 block's `state`, or a pre-fetched `accessToken` beside an explicit grant config - see [Auth mapping](#auth-mapping)), `url_without_raw` (informational - a URL shape that was mapped rather than dropped, see [URL handling](#url-handling)), `invalid_percent_encoding` (a query key or value whose invalid `%` escape changes when rejoined into the URL, see [URL handling](#url-handling)), `variable_metadata` (a variable `type` Vayu has no counterpart for - `"any"` or a custom string - or an environment or globals variable's `description`), `disabled_body` (a request body whose own `disabled` was `true` - see [Body mapping](#body-mapping)), `certificate` (a request's own `certificate` the engine could not resolve into a `client_certificates` registry candidate - no `cert.src`/`key.src`, an unreadable file, an unresolved `{{var}}` host, or a second, different certificate for a (host, port) an earlier request in this import already claimed; a resolvable one is applied instead, see the field table above and [issue #1656](https://github.com/athrvk/vayu/issues/1656)), `protocol_behavior` (a request's `disabledSystemHeaders`, `disableCookies` or `disableUrlEncoding` - see [Redirect settings](#redirect-settings)), and `proxy_config` (a request's own `proxy` override - there is no per-request proxy mechanism to import it into, and none is planned, so this tally is permanent). It does **not** emit `websocket`, `grpc`, `api_spec`, or `unit_test` items.

**`meta.nonExecutableAuth`** - populated: incremented once per **request, folder or collection** whose own mapped auth mode is one of `CONFIG_AUTH_TYPES` (`aws`, `digest`, `ntlm`, `hawk`, `oauth1`, `edgegrid`, `jwt`), and each is named in `meta.nonExecutableAuthRequests`. A folder's or collection's is counted once where it is declared, not once per request inheriting it. These auths are stored on the draft (with their `config`) but Vayu has no execution path for them. `oauth2` is mapped to an executable config and does **not** count.

## Shared helpers used

All defined in `engine/src/core/import_document.cpp` (except `normalize_template_vars`, which is `engine/src/core/path_template.cpp`); see the [index](./README.md#shared-helpers) for full reference.

| Helper | Use in this parser |
|--------|--------------------|
| [`as_string`](./README.md#as_string) | coerce any scalar to its string form (values are stored as strings) - used inside `to_var_record`/`authDetail` |
| [`to_var_record`](./README.md#to_var_record) | collection/folder `variable[]` → `CollectionDraft.variables` |
| [`map_key_values`](./README.md#map_key_values) | `header[]`, `query[]`, `urlencoded[]`, `formdata[]` → `KeyValueEntry[]` (preserves disabled + duplicates) |
| [`map_postman_auth`](./README.md#map_postman_auth) | `auth` object → `RequestAuth` (request and, via `collectionAuth`, collection/folder) |
| `postman_raw_body` | raw-mode body → `RequestBody` with JSON/text language sniffing, keeping a declared language Vayu has no mode for (shared with the exporter) |
| [`join_exec`](./README.md#join_exec) | `event.script.exec` → joined script string |
| [`normalize_template_vars`](./README.md#normalize_template_vars--normalize_path_templates) | rewrite `{{ x }}` / `{{ _.x }}` template syntax to Vayu `{{x}}` (`path_template.cpp`); applied to URLs, values, vars, and auth fields. Called **without** `pathTemplates`, so a literal single-brace `{x}` is left alone - in Postman only `{{x}}` is a template, and rewriting `/tags/{beta}` or `fields=friends{name}` invented a variable that resolved to nothing |

## Exporting to Postman

The way back is an export, not a parse: any collection writes out as a Postman
Collection v2.1 file, from its ⋯ menu in the sidebar (**Export as Postman
Collection**) or from the Spec tab's **Export** menu (**Postman Collection
v2.1…**). The engine assembles the document
(`POST /export/postman`) from what is stored - folders, requests, variables,
auth and scripts - and the dialog offers **Copy** or **Download**, saving
`<collection name>.postman_collection.json`. Nothing is sent anywhere, and
nothing is written: an export is a read of what the collection already is.

**Credentials stay out by default.** With **Include credentials** off, auth
secrets and variables marked secret are written empty, and the dialog says how
many. Turn it on to write them as stored, which is what Postman's own export
does - only for a file that stays with you.

**Saved responses come back as they were recorded.** An example imported from
Postman keeps the request it was recorded against, its status text, preview
settings, cookies and response time, and exports with them. Change its status or
headers (through the API or an MCP agent) and the export writes that change, regenerating the status text,
header rows and preview settings that described the old value. The cookies are
rebuilt only when a `Set-Cookie` header changes, so a cookie whose `Set-Cookie`
header you removed is not exported, while fixing an unrelated header keeps the
cookies as recorded; the recorded request stays as recorded.

**A response you save as an example keeps the request that produced it**
(issue #1763). *Save as example* on a response you just sent records the
request as it was when you pressed Send - method, URL, params, headers and
body, with `{{variables}}` left unresolved and auth left out - together with
the server's own status text, the response's cookies (a `Max-Age` counted from
when the response arrived) and its response time.
The export writes those back, so editing the request afterwards does not change
what the example says it was sent with. A value typed literally into a header
or the URL at Send stays in that example after you remove it from the request,
and exports even with **Include credentials** off, the same as a header on the
request itself. A streamed response keeps the record too: the copy the
app reloads when the stream ends is matched to the Send that started it. An
example saved before this, or from a response the app fetched without a Send
of its own to match it to (the last run shown again after a restart, or a
response opened from History), has no such record and exports regenerated from
the request as it is at export time.

**What Postman has no place for is listed, not dropped.** Before you download,
the dialog states how many requests and folders the file carries and names each
kind of thing the export could not carry, with a count, in the engine's words.

An agent can ask for the same document over MCP (`export_postman`), which always
leaves credentials out.

**What an imported collection gives back as Postman wrote it.** The import
keeps, beside what Vayu uses, what the export needs to write a Postman document
back unchanged: every event in its order, a disabled one still disabled; a raw
body's declared language, or its absence (`rawLanguage`); a header's
`type: "default"` and a query row's `equals`; a request's path variables
(issue #1764), which export as the `:name` segments of `raw` and `path[]` and
their rows as `url.variable[]` (`key`, `value`, then a `type` and
`description` the import kept, and `disabled`), written after the query rows
and never into `query[]`; a variable's `string` / `number`
/ `boolean` type and its description; an item-level description; and the
document's own `auth` block whenever the mapped auth alone would not give it
back (`auth.postman`) - an `oauth2` block holding only a seeded token, the
attributes Vayu has no field for, attribute order and types, and the
Hawk, OAuth 1.0, EdgeGrid and JWT types Vayu keeps as data. Each is written
back only while it still describes what Vayu holds; after an edit in Vayu the
export writes the edit.

**What still comes back differently**, and why:

- **Method case.** A `get` or `post` typed in lower case exports upper case.
  Vayu stores the method as one of its seven verbs, and both Postman's runtime
  and Vayu's composer send it upper-cased, so the wire is the same.
- **`url.raw` is rebuilt** from the stored URL: the query rows Postman sends
  (a stale `raw` a generator left without an enabled row gains it), percent-
  encoded the way Vayu joins them (`filter[type]` as `filter%5Btype%5D`). The
  `query[]` rows themselves come back as written.
- **Variable order** within a collection or folder follows name order, the
  order the stored variables object keeps.
- **`protocolProfileBehavior`** keys other than the redirect and TLS settings
  are not stored (the unhonoured ones are counted as `protocol_behavior`), so a
  `disableBodyPruning` Postman wrote on a request with no GET-or-HEAD body is
  not written back.
- **Empty-name rows** (a disabled header with no key, an editor's trailing
  blank row) are not imported.

## Related

- [Import pipeline index](./README.md)
- [Insomnia v4](./insomnia-v4.md)
- [OpenAPI v3](./openapi-v3.md)
- [OpenAPI v2](./openapi-v2.md)
