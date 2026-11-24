---
description: >-
  The tables that hold the saved tree: collections, requests and a request's saved examples.
---

# Collections, requests and request examples

## `collections`

Stores folder/group hierarchy for requests.

| Column               | Type    | Notes                                        |
|----------------------|---------|----------------------------------------------|
| `id`                 | TEXT PK | `col_` + UUID                                |
| `parent_id`          | TEXT    | NULL for root collections; never `''` ([the empty-parent pass](startup-and-recovery.md#the-empty-parent-pass)) |
| `name`               | TEXT    |                                              |
| `description`        | TEXT    | Default `""`                                 |
| `variables`          | TEXT    | JSON: `Record<string, VariableValue>`        |
| `auth`               | TEXT    | JSON: `RequestAuth` (`POST`/`PUT /collections` refuse `inherit`, #3445; a row stored before that is read as no auth of its own) |
| `elements`           | TEXT    | JSON array of elements (issue #1513, run by #1514); default `"[]"` |
| `data_schema`        | TEXT    | JSON: the declared data contract; default `"{}"` |
| `openapi`            | TEXT    | JSON: the bound spec document; default `"{}"` |
| `spec_file`          | TEXT    | JSON: the spec file the Spec tab was picked from (issue #2765); default `"{}"` |
| `data_file`          | TEXT    | JSON: the data file a run reads its rows from (issue #2765); default `"{}"` |
| `order`              | INTEGER | Position among the parent's children, its sub-folders and requests in one space (#2535, [Ordering](../api-reference/resource-writes.md#ordering)); default 0 |
| `created_at`         | INTEGER | Unix ms                                      |
| `updated_at`         | INTEGER | Unix ms                                      |
| `deleted_at`         | INTEGER | Unix ms; NULL while the collection is live (issue #988) |

**elements** - the ordered, typed behaviours attached to this collection (issue #1512): extractors, assertions, timers, controllers, scripts and metrics, each `{"id", "kind", "enabled", "name"?, "config"}` and validated against the registry `GET /elements/kinds` serves (`vayu::core::Registry::validate`, `engine/include/vayu/core/elements.hpp`).
`[]` - the default, and what an explicit `null` on `PUT` resets to - means no elements.
The only script source (#1514): a pre-cutover collection's scripts are folded in here as `script.pre` / `script.post` entries by [`migrate_before_sync`](startup-and-recovery.md#the-script-to-elements-migration), and `preRequestScript` / `postRequestScript` are refused (`400`, naming `elements`) on every route.
`POST /compose` resolves a request's whole chain of these (its own collection's, root to leaf, then the request's) into one list, minus anything a `inherit.disable` entry names.

**data_schema** - which columns this collection's data files are expected to carry, so `{{data.column}}` and `pm.iterationData` can be checked before a run (issue #599):

```json
{"columns":["id","email"],"declaredAt":1700000000000,"fileName":"users.csv"}
```

`{}` - the default, and what an explicit `null` on `PUT` resets to - means the collection declares no contract.
`columns` must be an array of unique, non-empty strings (at most 1024 of them, each at most 256 characters); `declaredAt` is epoch ms and `fileName` is a display label, both optional.
Validation lives in `apply_collection_fields`, so `POST`, `PUT` and `POST /import/apply` all enforce it.
NOT NULL with a `default_value`, which is what lets `sync_schema` `ALTER TABLE ADD COLUMN` it onto an existing collections table - pre-existing rows backfill to `{}` (the same migration shape as `config_entries.keywords`).

The **schema** is stored; the **rows** never are.
A data file's contents are user data of unknown sensitivity and are persisted nowhere - not here, not in a run snapshot, which records the row count (`dataRowCount`) plus the file's name and content hash (`dataFileName`, `dataFileHash`, issue #2051) and whether its numbers were read as numbers (`dataFileCastNumbers`, issue #2540), never its path or rows.
The file's location is [`data_file`](#collections), below.
See [Data-driven runs](../../app/data-driven-runs.md).

**openapi** - the OpenAPI document this collection is bound to (issue #637):

```json
{"specId":"spec_3f2b1c9a-...","specHash":"<hex sha256>","syncedAt":1700000000000}
```

`{}` - the default, and what an explicit `null` on `PUT` resets to - means the collection is bound to nothing, so unbinding needs no verb of its own.
A non-empty object is a binding and must carry a `specId` that resolves to a row in [`spec_documents`](specs.md#spec_documents); `specHash` records which *version* of the document the collection was last synced to, and `syncedAt` when.
Shape validation lives in `apply_collection_fields` so the write paths that accept a binding enforce it, and the resolvability check sits in the route cores beside `reject_missing_collection` - `POST /import/apply` binds specs it is about to write in the same transaction.

**The version half is the engine's** (issue #709).
A client sends the `specId`; whichever write path receives it fills in `specHash` from the document that id names and `syncedAt` from the moment of the write - the same division `spec_documents.hash` itself draws.
A `specHash` or `syncedAt` a client sends on `POST /collections` or `POST /import/apply` is dropped first (issue #3348), so the pair always comes from the store; a stale one arises only when the document under a binding is replaced, and a run then reports `hash_mismatch`.
This matters because both contract readers - coverage and response-schema validation - require the binding's hash to equal the stored document's before they engage: a binding of `{specId}` alone (#709) leaves every run of the collection with no contract at all.
`Database::stamp_hashless_spec_bindings()` repairs the rows written before that rule, on every startup, stamping the document's `fetched_at` (when the import that made the binding stored it, not the moment of the restart) and skipping any binding whose document is gone.

The **edge** is stored here; the **document** is not.
Several collections may bind the same spec, so nothing here owns it: no cascade reaches `spec_documents`, and `DELETE /specs/:id` is refused while any collection names the row.
NOT NULL with a `default_value`, the same migration shape as `data_schema` above.

**spec_file** and **data_file** - the files this collection's Spec and Data tabs are bound to (issue #2765), stored on the row so a [workspace backup](../architecture.md#workspace-backups) carries them:

```json
{"path":"/home/me/specs/pets.yaml","fileName":"pets.yaml"}
{"path":"/home/me/data/users.csv","fileName":"users.csv","hash":"<hex sha256>","castNumbers":true}
```

`{}` - the default, and what an explicit `null` on `PUT` resets to - means no file.
A non-empty binding must carry `path` and `fileName` as non-empty strings and nothing beyond its members: `spec_file` holds those two, `data_file` adds an optional `hash` (the SHA-256 of the file's bytes as 64 lowercase hex characters, the digest a run records as `dataFileHash`) and an optional boolean `castNumbers` (how the app reads the file's numbers, issue #2540).
Validation lives in `apply_collection_fields`, so `POST` and `PUT` enforce it; `POST /import/apply` refuses either field on a collection item, because an import describes a document from elsewhere.

The path's form is not judged.
It is true of the machine that picked the file, so a Windows path restored onto Linux is stored and read back as written, and the app shows it as a file it cannot find.
**A stored path is not a grant**: whether a request body may send a file is still the [`file_roots`](credentials-and-files.md#file_roots) and [`file_grants`](credentials-and-files.md#file_grants) decision, and nothing reads these columns to send one.
The engine never opens either file.
Neither column leaves the machine through an export: `POST /export/postman` and `POST /specs/export` copy their own fields off the row and name no binding.
Deleting the collection keeps both on the trashed row, a restore brings them back unchanged and a purge removes them with the row.
NOT NULL with a `default_value`, the same migration shape as `data_schema` above.

**auth** is a JSON discriminated union: `{"mode":"none"}` | `{"mode":"bearer","token":"..."}` | `{"mode":"basic","username":"...","password":"..."}` | `{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}` | `{"mode":"oauth2","config":{…}}` (see [`requests.auth`](#requests) and [`oauth_tokens`](credentials-and-files.md#oauth_tokens)).
Collections are always auth sources - they never store `{"mode":"inherit"}`.
They may store `{"mode":"noauth"}`, the inheritance terminator meaning "descendants inherit no credentials" (distinct from `none`, which means nothing is set at that level); `POST /compose` resolves both during the inherit walk (`request_composer.cpp`), so neither reaches the engine's `parse_auth` - which would treat them as no auth anyway.

**Cap.**
(issue #1485) `variables`, `auth`, `data_schema`, `openapi`, `spec_file` and `data_file` are each refused at write time with a `413` naming the field, its size and the cap, when the serialized value is over `json::MAX_FIELD_SIZE` (10 MiB, `engine/include/vayu/core/constants.hpp`) - through the same shared `apply_json_field` the [`requests`](#requests) columns are capped by.
A file binding's `path` over `file_binding::MAX_PATH_BYTES` (96 KiB) or `fileName` over `MAX_FILE_NAME_BYTES` (1 KiB) is a `413` naming the member the same way; both sit above the longest path and file name any of the three platforms can open.
Unlike `requests`, no collection column is ever substituted on read: `GET /collections` carries the same whole value `GET /collections/:id` does, so there is no `truncatedFields` here.

**Cascade delete**: deleting a collection performs BFS to collect all descendant IDs and stamps `deleted_at` on them and their requests in one transaction (`Database::delete_collection()`, issue #988).
The hard cascade is the purge (`DELETE /trash/:id`, or retention): BFS over the *stamped* descendants only, re-parenting a live collection it meets to the root (issue #1883), then all their requests before the collections deepest-first, wrapped in a single transaction so a crash mid-cascade cannot leave a half-deleted subtree.
See `Database::purge_collection_locked()`.

`parent_id` forms a tree, but SQLite enforces no such constraint, so the BFS carries a visited set and is **cycle-safe**: a self-parent (`parent_id == id`) or an `A -> B -> A` loop terminates instead of growing the work list forever under the global DB mutex (which would hang every endpoint, including `/health`).
`POST /collections` rejects the writes that would create such a cycle (see [api-reference/index.md](../api-reference/index.md) - POST /collections), so cycles only arise from data written before that validation existed; the visited set is what lets deletion recover from it.

---

## `requests`

Stores individual HTTP request definitions.

| Column                | Type    | Notes                                                |
|-----------------------|---------|------------------------------------------------------|
| `id`                  | TEXT PK | `req_` + UUID                                        |
| `collection_id`       | TEXT    | FK → `collections.id` (not enforced by SQLite FK)   |
| `name`                | TEXT    |                                                      |
| `description`         | TEXT    | Default `""`                                         |
| `method`              | TEXT    | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / etc.  |
| `method_source`       | TEXT    | Which app setting wrote `method`; NULL when none    |
| `url`                 | TEXT    |                                                      |
| `params`              | TEXT    | JSON array of `KeyValueEntry[]`                      |
| `headers`             | TEXT    | JSON array of `KeyValueEntry[]`                      |
| `body`                | TEXT    | JSON discriminated union (see below)                 |
| `body_type`           | TEXT    | Denormalized mirror of `body.mode`; kept for queries |
| `auth`                | TEXT    | JSON discriminated union (see below)                 |
| `elements`            | TEXT    | JSON array of elements (issue #1513, run by #1514); default `"[]"` |
| `order`               | INTEGER | Position among the collection's children, its sub-folders and requests in one space (#2535, [Ordering](../api-reference/resource-writes.md#ordering)); default 0 |
| `follow_redirects`    | INTEGER | Boolean; default 1 (follow)                          |
| `max_redirects`       | INTEGER | Hops allowed while following; default 10             |
| `timeout_ms`          | INTEGER | The request's own whole-transfer timeout in ms, `1`-`86400000`; NULL for the `defaultTimeout` setting (issue #2937) |
| `http_version`        | TEXT    | `'auto'` \| `'http1.1'` \| `'http2'`; default `'auto'` |
| `verify_ssl`          | INTEGER | Boolean; verify the TLS certificate; default 1       |
| `stream`              | INTEGER | Boolean; consume the response as SSE; default 0      |
| `stream_text_path`    | TEXT    | The JSONPath each event's `data` is read through for the reply's text, in the elements' subset; NULL when none. Read only while `stream` is set, and kept while it is off (issue #3773, schema version 11) |
| `stream_first_content_marker` | TEXT | The literal byte string (1-256 bytes, no NUL) a run's stream is watched for, timed as `stream.timeToFirstMatch`; NULL when none. Read only while `stream` is set, and kept while it is off (issue #3774, schema version 11) |
| `disable_cookies`     | INTEGER | Boolean; keep the cookie jar out of this request's transfer; default 0 (issue #1765) |
| `disabled_system_headers` | TEXT | JSON array of lowercased header names the engine does not add on its own; default `"[]"` (issue #1765) |
| `disable_url_encoding` | INTEGER | Boolean; write path values and an api-key query parameter as typed; default 0 (issue #1765) |
| `postman_protocol_behavior` | TEXT | The imported Postman item's `protocolProfileBehavior`, JSON text in source member order; NULL when none (issue #1765) |
| `spec_operation`      | TEXT    | JSON: which spec operation this is; NULL when none   |
| `mock_response_mode`  | TEXT    | Which saved example a mock server answers with; default `'first'` (issue #481 phase 3) |
| `mock_example_id`     | TEXT    | The example id `mock_response_mode == 'fixed'` names; NULL when none. Cleared when that example is deleted through its route, and not set again by its restore (issue #3422) |
| `created_at`          | INTEGER | Unix ms                                              |
| `updated_at`          | INTEGER | Unix ms                                              |
| `deleted_at`          | INTEGER | Unix ms; NULL while the request is live (issue #988) |

**params / headers** - stored as a JSON array of objects:
```json
[{"key":"Content-Type","value":"application/json","enabled":true,"description":""}]
```
Disabled rows (`"enabled":false`) are preserved in storage and filtered at HTTP-execution time only.
Duplicate keys are allowed.
A query row may carry `"valueless": true` for a bare `key` with no `=` (issue #1772).
The enabled query rows of `params` follow `url`: a write that states `url` and no `params` reconciles them with the URL's query, and rewrites the column only when that changes a row (issue #3551, see [`POST /requests`](../api-reference/requests.md#post-requests)); no startup pass touches rows stored before it.
A pre-#1229 renderer also wrote its own `X-Vayu-Version`, `X-Request-ID` and `User-Agent` rows here; [the header-strip pass](startup-and-recovery.md#the-header-strip-pass) disables them once, at startup, leaving each row in place with `source: "legacy-default"`.
An optional `source` key (`"body-mode"` | `"stream"` | `"legacy-default"`) marks a row an app setting or that repair pass wrote rather than the user - the auto `Content-Type` a body-mode change adds, the `Accept` the Event stream toggle adds, or a row the header-strip pass disabled - so it can tell its own row apart from a hand-typed one across a reload;
retyping the row's key or value clears it (issues #1481, #1491).
A Postman import also keeps two keys nothing sends, for the Postman export to write back: a header row's `type` other than `"text"` (`"default"`) and a query row's boolean `equals`.

**elements** - same shape, and the same script-to-elements cut-over, as [`collections.elements`](#collections) above; see that entry.

**body** - discriminated union:
```json
{"mode":"none"}
{"mode":"json"|"text"|"graphql"|"jsonrpc"|"mcp"|"xml","content":"..."}
{"mode":"mcp","content":"...","mcpTool":{"name":"...","inputSchema":{...},"outputSchema":{...}}}
{"mode":"form-data"|"x-www-form-urlencoded","fields":[{"key":"...","value":"...","enabled":true}]}
{"mode":"binary","file":{"src":"/abs/a.bin","fileName":"a.bin","contentType":"image/png"}}
```
An `mcp` body may carry `mcpTool`, the called tool, its input schema and optional output schema (stored, never read by a send), whose `x-mcp-header` annotations the send mirrors as `Mcp-Param-*` headers (#3762); it is part of the blob, so it needed no column and no schema version.
A `form-data` file part carries `"type":"file"` and, in place of `value`, the same file members a binary body's `file` does: `src` (an absolute path, stored as written) and `fileName` and `contentType` (both optional, omitted when empty).
No trust is stored: whether `src` may be sent is decided by the [`file_roots`](credentials-and-files.md#file_roots) and [`file_grants`](credentials-and-files.md#file_grants) at each send, and the `unresolved` a read answers is derived then (#2356).
Every write drops the key an older client sends (`apply_request_fields`), and the [schema version 6 migration](startup-and-recovery.md#the-file-grants-migration-schema-version-6) removed it from every row written before.
A text part may also carry `"type":"text"`.
No file's bytes are ever stored; a binary body needs a `file` object (schema version 3).
A `json` or `text` body a Postman import produced from a raw body also carries `rawLanguage`: the `options.raw.language` the document declared when it named no Vayu mode (`"javascript"`, `"html"`, `"yaml"`; the body is `text`), or `""` when it declared none (the body was sniffed).
Nothing sends it, though the import wrote the `Content-Type` row `html` and `javascript` need as an ordinary `body-mode` header row.
The Postman exporter writes it back while importing the body again would still give its stored mode, so an unlabelled body exports without `options` as Postman wrote it.

**auth** - discriminated union (same shape as collection auth, plus `inherit`):
```json
{"mode":"none"}
{"mode":"inherit"}                                        // resolved at execution time
{"mode":"bearer","token":"..."}
{"mode":"basic","username":"...","password":"..."}
{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}
{"mode":"oauth2","config":{ /* OAuth2Config */ }}
```

A Postman import may add `postman` to any of these: the document's own `auth` block (`{"type":"oauth2","oauth2":[{"key","value","type"}]}`), kept when the Postman exporter could not otherwise write it back as it was.
Nothing sends it; the exporter writes it verbatim while it still maps to the stored auth, and every secret-blanking export blanks its credential attributes, the PKCE `code_verifier` and the credentials among an `oauth2` block's `tokenRequestParams` / `authRequestParams` / `refreshRequestParams` rows included.
Every write of an `auth` column drops it once it no longer maps to the auth being written (`without_stale_postman_source`), so an edited credential does not stay behind in it.

The `oauth2` `config` holds the grant type, endpoints, client id/secret, placement options, etc.
Three optional lists hold extra request parameters (issue #2536): `tokenParams`, `authorizationParams` and `refreshParams`, each an array of `{key, value, enabled, sendAs?}` rows.
`sendAs` is `body`, `url` or `header` and, when absent, `body`; an `authorizationParams` row stores none, because the authorization request carries its parameters in the authorize URL's query.
A config with no extra parameters omits the lists.
What the engine sends from them, and how they enter the token cache key, is in [api-reference/authentication.md](../api-reference/authentication.md#post-oauth2token).
A Postman import fills them from the block's `tokenRequestParams`, `authRequestParams` and `refreshRequestParams` ([postman.md](../../app/import-collections/postman.md#oauth-20-extra-request-parameters)).
Secret fields (`clientSecret`, `password`) are stored **in plaintext** here, same as bearer/basic credentials - the v1 posture.
The resolved access tokens live separately in [`oauth_tokens`](credentials-and-files.md#oauth_tokens).

**Cap.**
(issue #1485) `params`, `headers`, `body` and `auth` are each refused at write time - `400` if the value is not an object/array of the shape above, `413` naming the field, its size and the cap - when the serialized value is over `json::MAX_FIELD_SIZE` (10 MiB, `engine/include/vayu/core/constants.hpp`), the same limit `GET /requests` (the list route) has always read a column against.
A row written before this cap existed can still be oversized:
`GET /requests/:id` answers with it whole, however large, but `GET /requests?collectionId=` substitutes the field's documented default and adds `truncatedFields` (an array of the substituted field names, e.g. `["body"]`, omitted when nothing was substituted) to that row, so a caller reading the list can tell a genuinely empty field from one it cannot see the whole of.
Nothing recomputes `truncatedFields` at write time or stores it - it is derived fresh on every list read from the same size check.

**follow_redirects / max_redirects / http_version / stream** - the request's execution options, surfaced in the request builder's **Settings** tab and serialized as `followRedirects` / `maxRedirects` / `httpVersion` / `stream`.
The first three mirror the executable `vayu::Request` fields of the same name, so the saved options are what `POST /execute` and `POST /runs` apply - `http_version` governs both Send and load test alike; there is no separate per-run protocol control.

**`stream` has no `vayu::Request` mirror**, deliberately (issue #574).
It is not a transfer option the executor applies but a choice of *which delivery path* runs, read off the `POST /execute` payload by `read_stream_flag`; the column is where the app's Event stream toggle persists so the choice survives a tab switch and a bulk import carries it.
`payload_from_stored` does not add it to a by-id composition, so a client that pipes `POST /compose` into `POST /execute` - MCP's `run_collection_smoke`, among others - still gets a buffered send rather than a `202` it never asked to parse.
**That stays true now that MCP can stream** (issue #575): `run_request` sets `stream` from its own argument on every call rather than inheriting it from a row, and the app's Code panel reads the flag off the request row rather than out of the composed payload, for the same reason.

All four columns are `NOT NULL` with a `DEFAULT`, which is what lets `sync_schema()` add them to an existing, non-empty `requests` table - a `NOT NULL` column with no default cannot be added by `ALTER TABLE ADD COLUMN`.
Rows written before the columns existed backfill to `1` / `10` / `'auto'` / `0`, i.e. the behaviour they already had (a row predating `http_version` could only ever have run HTTP/1.1, since nghttp2 was not yet linked).
`max_redirects` is clamped to `0..100` on write.

**timeout_ms** - the request's own timeout (issue #2937, schema version `9`), serialized as `timeout` and edited in the same **Settings** tab.
Unlike the four above it is nullable with no `DEFAULT`, on the `spec_operation` precedent, and `sync_schema()` adds it the same way: NULL means "use the `defaultTimeout` setting", which is what every row written before the column existed backfills to.
A stored number would freeze the setting at the value it had on the day the row was saved, so the default is never written into the row.
A value outside `1`-`86400000`, or not a number, is refused on write with the `400` `POST /execute` answers (`REQUEST_TIMEOUT_FIELD`), never clamped.
`payload_from_stored` emits `timeout` only when the column holds one, so a by-id composition of a request that states none leaves the setting to `/execute` and `/runs`.

**disable_cookies / disabled_system_headers / disable_url_encoding / postman_protocol_behavior** - Postman's per-request `protocolProfileBehavior` settings (issue #1765), serialized as `disableCookies` / `disabledSystemHeaders` / `disableUrlEncoding` / `postmanProtocolBehavior` and surfaced beside the redirect options in the **Settings** tab.
The three typed ones mirror `vayu::Request` fields and ride every composed payload:

- `disable_cookies` keeps the cookie jar out of the transfer, both halves - no jar cookie is attached and no `Set-Cookie` is stored - on the buffered and streaming design sends and a scenario load run's per-virtual-user session.
  A pre-request script's `pm.cookies.jar()` write is still persisted, applied directly because no transfer carries it.
- `disabled_system_headers` is unioned into the per-send `suppressed_default_headers`, so `user-agent`, `accept-encoding` and the correlation id are refused as a per-send opt-out refuses them, and two more names gain meaning:
  `accept` removes libcurl's implicit `Accept: */*` and `content-type` removes the Content-Type a body implies (multipart keeps its boundary header) and a `headers` row marked `"source": "body-mode"`, the body's own Content-Type row (composition lists those names as `bodyModeHeaders`).
  `host`, `content-length`, `connection`, `cache-control` and `postman-token` are stored and exported but change nothing on the wire.
- `disable_url_encoding` writes a path variable's value (at composition and when a bind or the residual pass settles it) and an api-key or OAuth 2.0 query parameter as typed, and it turns off the Postman encoding of the whole URL (`wire_url`, #2465):
  with encoding on a raw space is sent as `%20` and `"` as `%22`, with the toggle on the space is refused, by a message that names the space and the toggle. libcurl's dot-segment normalisation is unchanged.

`postman_protocol_behavior` is nothing the engine sends: `POST /export/postman` starts from it and overwrites only the keys a typed column now disagrees with, so explicit defaults, keys Vayu does not apply and the source's member order survive a round trip; `GET` answers it as this text, so a copy written back from it (the app's Duplicate) keeps the same bytes.
The three typed columns are `NOT NULL` with a `DEFAULT` and the carrier is nullable, for the reason the paragraph above gives.

**spec_operation** - which operation of the collection's bound [`openapi`](#collections) document this request *is* (issue #637):

```json
{"operationId":"listPets","method":"GET","path":"/pets/{petId}"}
```

`method` and `path` are required and `operationId` is optional, because an OpenAPI operation may declare none.
`path` is the **templated** path from the document, never a concrete URL - it is the identity a re-fetched spec is diffed against and the key coverage counts by, and a substituted URL would match nothing in the document it came from, so a `path` that does not start with `/` is a `400`.
Two requests may name the same operation.

Nullable rather than `NOT NULL` with a `"{}"` default, unlike the four columns above: a request that answers to no operation declares nothing, and `NULL` is that - `{}` would be a second spelling of the same absence for every reader to handle.
A nullable column is `ALTER TABLE ADD COLUMN`-friendly without a default.
Both request serializers emit it as `specOperation`, `null` when the column is, and `apply_request_fields` applies it, so `POST`, `PUT` and `POST /import/apply` all carry it.

**method_source** - which app setting last wrote `method`, still unclaimed by the user (issue #1505).
The only writer today is the GraphQL body mode: entering it sets `method` to `POST` on a fresh `GET` and stamps `method_source: "graphql"`; leaving it reverts `method` to `GET` only while the marker is still there, and any other write to `method` clears it, the same "still ours" rule `switchAutoHeader`'s `KeyValueEntry.source` (issue #1481) applies to a header row.
Nullable on the `spec_operation` precedent directly above, for the same reason: `NULL` is the only spelling of "no marker" and the column is `ALTER TABLE ADD COLUMN`-friendly without a default.
`apply_request_fields` validates a present value against the one string the app writes (`"graphql"`) and rejects anything else with a `400`, so a marker this app does not recognize can never park itself here and revert a method the user actually chose.

**http_version** stores `Request::http_version` (the *requested* protocol, an enum member spelled as text) - a different value and a different value space from `Response::http_version`, the *negotiated* protocol string (`"HTTP/1.1"` / `"HTTP/2"` / `""`) that lands in a design run's `trace_data` (see [`results`](run-artifacts.md#results)) and the live `/execute` response.
Conflating the two would show a user a protocol they asked for but were not actually granted.
On create or on an explicit `null` reset, this column seeds from the `defaultHttpVersion` [`config_entries`](config.md#config_entries) row (`'auto'` unless changed) - a write-time default only, never consulted at execution.
Changing the global afterward does not alter a request already saved.

---

## `request_examples`

Stores saved example responses for a request (issue #481) - what an importer found next to it (Postman's `item.response[]`, an OpenAPI operation's `responses`) and, once the mock server lands, what that server answers with.

| Column         | Type    | Notes                                             |
|----------------|---------|---------------------------------------------------|
| `id`           | TEXT PK | `exa_` + UUID                                     |
| `request_id`   | TEXT    | FK → `requests.id` (not enforced by SQLite FK)   |
| `name`         | TEXT    | Required on write; no default                     |
| `status`       | INTEGER | HTTP status, `200`-`599`; default 200             |
| `headers`      | TEXT    | JSON array of `KeyValueEntry[]`                   |
| `body`         | TEXT    | Response body, verbatim; capped (see below)       |
| `content_type` | TEXT    | Denormalized from `headers`; `""` when unstated   |
| `order`        | INTEGER | Sort order within the request; default 0          |
| `origin`       | TEXT    | `import` \| `user`; NOT NULL, default `import`     |
| `body_truncated` | INTEGER | `body` stops short of the captured response; NOT NULL, default `0` |
| `suppressed`   | INTEGER | A tombstone: an imported example the user deleted; NOT NULL, default `0` |
| `spec_example_key` | TEXT | The `examples` map key this was imported from; NULL when there is none |
| `postman_response` | TEXT | The Postman saved response this example has - from an import or from a save in the app - as JSON text; NULL when it has none (schema version 2) |
| `created_at`   | INTEGER | Unix ms                                           |
| `updated_at`   | INTEGER | Unix ms                                           |
| `deleted_at`   | INTEGER | Nullable, Unix ms. NULL while live; the delete's instant once a `user` example is in the trash (#2971) |

**body** is stored and read back byte-exact, a zero byte included (#3112). sqlite_orm reads a `std::string` column through `strlen`, so the mapping uses `db::BodyBytes` (declared in `types.hpp`, adapted in `database_impl.hpp`), a `std::string` whose extractor takes the length from `sqlite3_column_bytes`.
The column is still `TEXT`, so no schema version moved and a row written before the fix reads whole: the write always bound its full length.

**headers** is the same `KeyValueEntry[]` shape a request's headers use, not the JSON object [`result_bodies`](run-artifacts.md#result_bodies) and [`inbox_requests`](run-artifacts.md#inbox_requests) store.
A stored example is re-served rather than only displayed, so repeated names (`Set-Cookie`) and the author's ordering both have to survive - an object keeps neither.

**order** is what makes "the first example" a stable answer.
A bulk import writes every example of one request in the same millisecond, so `created_at` ties for all of them and an id tiebreak would return the author's list shuffled; `GET /requests/:id/examples` orders by `order`, then `created_at`, then `id`.
A create that states no `order` appends after the request's current examples, exactly as a new request appends within its collection.

**origin** records who wrote the row (issue #588).
It carries `default_value` rather than being a fresh table's column, so `sync_schema` ALTERs it onto an existing `request_examples` and every pre-existing row backfills to `import` - which is what all of them are, since import was the only writer until the app could save a live response as an example.
It exists because the OpenAPI spec sync replaces the examples a document produced and must leave the ones a person saved alone, and nothing else about a row says which it is - `POST /specs/sync` (issue #655) is the reader: applying a change to a request deletes that request's `import` rows and writes the document's in their place.
The rows are the engine's own since issue #869 - the payload says only *whether* to refresh a request's imported examples, and what is written is what the document being stored documents - so a sync cannot manufacture a row it would then refuse to replace, nor one for a response no document describes.
The write paths validate it against those two values and `400` on anything else; no read path in the app displays it.

**body_truncated** (issue #659) records that `body` is only the first slice of the response it was captured from - the trace's `maxTraceBodyBytes` cap.
Added the same ALTER-friendly way as `origin`: NOT NULL with a `default_value`, so `sync_schema()` adds it and every pre-existing row backfills to false, which is what they all are (an importer copies a whole documented body; only the app's save-as-example ever had a partial one).
It is stored rather than inferred because a short body is a legitimate body - nothing about the row says otherwise
- and a mock server serves the bytes verbatim, so an undisclosed partial example is answered as though it were complete.
The Examples panel is the reader, painting a "Partial body" chip; before the column, the fact lived only in the example's *name*, which the save dialog invites the user to edit.

**suppressed** (issue #722) marks a row as a tombstone: an `origin="import"` example the user deleted.
Added the same ALTER-friendly way as the two columns above, and `false` is right for every pre-existing row - before it, a delete removed the row.
It exists because deleting an imported example otherwise recorded nothing, while the sync refresh above rewrites every imported row of a request it applies *any* change to, so the next rename-only sync re-created what the user had removed.
The row is kept so the refresh can skip that response **status** (the identity a document's example keeps across a reworded description, which its `name` does not), and `body`, `headers`, `content_type` and `postman_response` are cleared when the flag goes on, since nothing serves a tombstone.
`get_request_example`, `get_request_examples` and `count_request_examples` all filter suppressed rows out - so the list route, a mock server and an export behave exactly as though the delete had removed it - and `get_suppressed_request_examples` is the one read that sees them, for the one caller that must.
A `user` row is never tombstoned: nothing re-creates a saved response, so there is no intent for a sync to keep, and its delete goes to the trash instead (`deleted_at`, below).

**deleted_at** (#2971) is the trash stamp of a `user` example, on the [`environments.deleted_at`](environments-and-globals.md#environments) shape: one row, no cohort, NULL while live.
`DELETE /requests/:id/examples/:exampleId` stamps it on a `user` row and tombstones an `import` row, so a row is never both suppressed and stamped.
Every read filters it exactly as it filters `suppressed` (`get_request_example`, `get_request_examples`, `count_request_examples`, and `get_suppressed_request_examples` too), so a trashed example is gone to the list route, a mock server, both exports and the spec sync's refresh, and does not count against the cap.
The trash lists it as a root while its request is live (`parentId` is the request); a restore clears the stamp alone and is refused while the request is trashed or gone, or already holds `MAX_PER_REQUEST` live examples.
The create path's id-collision check reads `request_example_id_taken`, which sees every row, so a fresh id can never overwrite a hidden one.

**spec_example_key** (issue #1457) records which entry of a 3.x response's named `examples` map the import took this example's payload from - the *first* one, unwrapped, since `firstNamedExample` never read past it.
Nullable rather than NOT NULL with a default, on the `requests.spec_operation` precedent: a row that predates the column, or one taken from a single `example` or sampled off a schema, names no entry, and NULL is the only spelling of that - there is nothing to backfill it from.
It exists because a value comparison alone cannot tell an edited example from a new one: once its body has changed, it no longer equals the entry it came from, so exporting it back would add it beside that entry rather than replace it.
The bound export reads the key to find its way back to the same entry when the document still declares it, and falls back to adding a new one when it does not.
Not a display field: no app surface reads it.

**postman_response** (schema version 2) is the Postman saved response this example has - from an import or from a save in the app - as compact JSON text in Postman's member order:
an imported one is the `item.response[]` entry the import took it from, in the source's own order, and one saved from a live response in the app (#1763) is built by the engine (`core::postman_saved_response_text`) from the request as written when it was sent and the server's reason phrase.
Every member is kept verbatim except `name` and `body`, which are `null` placeholders holding only their position - the columns are the values, so there is one copy of each.
It exists because the rest of a saved response has no Vayu column: the request it was recorded against (`originalRequest`, which differs per example and from the request's current state), the status text the server sent, the editor's preview language and type, cookies, the response time, and the header rows as written (`name` fields, numeric values).
The Postman export is the one reader (`core/postman_export.cpp`):
it writes `originalRequest`, `responseTime` and unknown members back as stored, and the status text, `header[]` and preview members only while `status` and `headers` still say what was imported, and `cookie` while the enabled `Set-Cookie` rows do, regenerating them otherwise - so an edit made in Vayu is never contradicted by a stale copy.
An import or a save in the app writes it: `POST /import/apply` and `POST /requests/:id/examples` accept a string that parses as a JSON object (capped at `request_example::MAX_POSTMAN_RESPONSE_BYTES`), `POST /requests/:id/examples` builds it from a `savedFrom` instead (left NULL, with a warning, when the result would be over that cap), and `PUT` accepts only `null`, which clears it.
The list route does not return it.

**Cascade.**
Examples are owned by their request.
`DELETE /requests/:id` and the `delete_collection` cascade stamp the requests and leave their examples untouched (issue #988): every route reaching an example checks its request first, so they are unreachable while it is in the trash and come back with it.
The purge of a request or a collection (`purge_request_locked`, `purge_collection_locked`) removes each request's examples before the request, by `request_id` and whatever their stamp, and so does the spec sync's hard delete.
Every read here is by `request_id` or by example id, so a row left behind would be unreachable rather than merely stale.
A tombstone and a trashed example are rows like any other and go with the same purges.

**Caps.**
A body over `request_example::MAX_BODY_BYTES` (1 MiB) is a `400`, never a truncation - a half-body served as if whole is worse than a refused write - and a request holds at most `MAX_PER_REQUEST` (100) examples.
Both constants live in `engine/include/vayu/core/constants.hpp`.
