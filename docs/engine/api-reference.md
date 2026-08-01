# Vayu Engine API Reference

**Base URL:** `http://127.0.0.1:9876` (default, configurable via `--port`)

All endpoints return JSON. **Every** error response has one shape - an `error`
object carrying a machine-readable `code` and a human-readable `message`:

```json
{
  "error": {
    "code": "bad_request",
    "message": "Missing required field: name"
  }
}
```

`code` is per-status unless the route names a more specific one: `bad_request`
(400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict`
(409), `bad_gateway` (502), `unavailable` (503), `internal_error` (5xx). Routes
with their own vocabulary pass it instead - `invalid_config` (`POST /config`),
`invalid_run_config` (`POST /runs`), and the `oauth2_*` family.

Any per-error detail sits **inside** the same object, so a client reads one
place for the whole failure - `item` on `POST /import/apply`, the provider's
reply on `/oauth2/*`:

```json
{
  "error": {
    "code": "oauth2_provider_error",
    "message": "Token endpoint rejected the request: invalid_client",
    "providerStatus": 401,
    "providerError": "invalid_client"
  }
}
```

Most routes used to emit a flat `{"error": "message"}` instead, which the app's
http-client could not read - every validation message surfaced as a bare
`HTTP 400` (issue #173). The client still accepts the flat shape so a newer app
can read an older engine, but the engine no longer produces it.

## Deprecated aliases

The execution and run/metrics routes were consolidated behind a `/runs` family,
`/execute`, and `/runs/:id/metrics`. The old paths still work - each is
registered as a deprecated alias of its canonical route (same handler, same
behavior) and logs a `(deprecated alias)` marker per request. **These aliases
will be removed in a future minor release**; new clients should use the
canonical paths.

| Deprecated alias | Canonical route |
|------------------|-----------------|
| `POST /request` | `POST /execute` |
| `POST /run` | `POST /runs` |
| `GET /run/:id` | `GET /runs/:id` |
| `DELETE /run/:id` | `DELETE /runs/:id` |
| `POST /run/:id/stop` | `POST /runs/:id/stop` |
| `GET /run/:id/report` | `GET /runs/:id/report` |
| `GET /metrics/live/:id` | `GET /runs/:id/live` |
| `GET /stats/:id?format=json` | `GET /runs/:id/metrics` |

`GET /stats/:id` in its **SSE** mode is legacy DB-polling and is retained
wholesale (no canonical rename); prefer `GET /runs/:id/live` for live metrics.

`GET /runs` with **no query params** is likewise a deprecated shape: it returns
the pre-pagination bare array of full-`configSnapshot` rows. Passing any
pagination/filter param returns the `{data, pagination}` envelope with compact
`summary` rows (see [GET /runs](#get-runs)). The no-param array is removed at the
next minor release.

## Resource writes: create vs update

Collections, requests and environments follow one write contract. `/globals` is
a singleton and stays POST-only, so it is exempt from the **verb split** below -
but not from the null-vs-absent rule, which it follows with every write treated
as a create (see [POST /globals](#post-globals)).

| Verb | Path | Meaning | Wrong-target status |
|------|------|---------|---------------------|
| `POST` | `/<resource>` | **Create only.** | `400` when the body carries an `id` |
| `PUT` | `/<resource>/:id` | **Update only** (merge-patch). | `404` when the `id` does not exist |

`PUT` is used loosely as a merge-patch rather than a whole-record replace: an
omitted field keeps its stored value. We deliberately did not add a separate
`PATCH` verb - merge-patch is what the update path has always done, and every
client call site expects it. The `:id` in the path is the record's identity; the
body carries the changed fields only.

### The engine owns every id

A create must **not** carry an `id`. The engine generates one via `generate_id`,
giving the `<prefix>_<uuidv4>` form, and a body containing the field is a `400`:

```json
{"error": {"code": "bad_request", "message": "id is assigned by the engine; omit it (bulk import: POST /import/apply)"}}
```

Presence alone is rejected, `null` included - `id` is not a settable field with a
default, so the [null-vs-absent rule](#the-null-vs-absent-rule) below does not
reach it, and accepting `{"id": null}` would leave a caller believing the field
is honoured. The field existed for the import orchestrator, which pre-assigned
ids so it could wire `parentId` / `collectionId` across a whole tree before
anything was persisted; import sends one
[`POST /import/apply`](#post-importapply) instead, referencing items by opaque
`tempId` and reading the real ids back from `idMap` (issues #96, #97).

On `PUT`, the path is the identity. A body `id` matching it is accepted and
ignored; one that disagrees - including `null` - is a `400`
(message `Body 'id' must match the id in the path ('col_1') or be omitted`),
because the payload otherwise names two different records and guessing between
them is how a `PUT` to one id rewrites another. This is checked before the record
is looked up, so a malformed body answers `400` whether or not the target exists.

Since no create can select an id, the pre-existing "id already exists" `409` -
whose body names the update path, e.g.
message `Collection 'col_1' already exists; use PUT /collections/:id to update` -
is now reachable only on a `generate_id` collision, which 122 bits of entropy put
out of reach. It stays as a guard: on that draw the alternative is overwriting a
live record.

### The null-vs-absent rule

One rule, identical for every field of all three resources:

| | Field absent | Field explicitly `null` |
|---|---|---|
| **Create (`POST`)** | use the default | use the default |
| **Update (`PUT`)** | keep the current value | reset to the default |

The defaults are `{}` for `variables`, the resource's own default for `auth`
(`{"mode":"none"}` for a collection, `{"mode":"inherit"}` for a request), `[]`
for `params` / `headers`, `""` for `description` and the two script fields,
`{"mode":"none"}` for a request `body`, `0` for `order` on update, `true` for
`followRedirects`, `10` for `maxRedirects`, and `false` for `isActive`.

A request's `httpVersion` is the one field whose default is not fixed: absent
or `null` seeds it from the live `defaultHttpVersion` config entry (`"auto"`
unless changed), read fresh on every write rather than cached - see
[POST /requests](#post-requests). Unlike every other field above, an
unrecognized `httpVersion` value is rejected with a `400` rather than silently
coerced, because a typo'd protocol silently running as HTTP/1.1 is the worst
available outcome.

A field that has **no** default cannot be reset, so `null` is a `400` on either
verb rather than a silently discarded write. Those fields are a collection's
`name`, an environment's `name`, and a request's `collectionId`, `name`,
`method` and `url`. Each is also required on create.

### Accepted field shapes

A field that is present and not `null` must have the shape below, on both verbs.
Anything else is a `400` naming the field, e.g.
message `Invalid 'auth': must be a JSON object`.

| Field | Shape |
|---|---|
| `variables` (collection / environment / globals) | object |
| `auth` (collection / request) | object |
| `body` (request) | object |
| `params` / `headers` (request) | array of `{key: string, value: string, enabled: bool}` |

Object-shaped fields are stored as JSON blobs, and every reader of one degrades
quietly when it is not an object - `variables` reads back empty, a request `body`
is dropped, and `auth` resolves to none, so a request the caller believes carries
credentials goes out bare. The write is therefore rejected rather than stored:
`{"variables": 42}` and `{"auth": "bearer"}` are `400`s, and the previously
stored value is left untouched.

### Behavior change (pre-1.0)

**A create carrying an `id` is now a `400`** on all three resources. External
scripts that minted their own ids must drop the field and read the engine's id
out of the response, or use [`POST /import/apply`](#post-importapply) for a whole
tree. A `PUT` whose body `id` disagrees with the path id is a `400` for the same
reason (it used to be silently ignored, so the write landed on the path id).

`POST /<resource>` used to be a silent upsert on all three resources, so a
client could send an update as a POST. That no longer works; external scripts
that relied on POST-as-update must switch to `PUT /<resource>/:id`. Two bugs went
with the old behavior and are fixed here:

- A stale or typo'd `id` silently **created** a second record instead of
  failing, and an `id` collision silently **merged** two records into one.
- `POST /environments` had no null guard, so `{"variables": null}` stored the
  literal four-character text `null` - JSON that parses but is not an object, so
  every reader saw an environment with no variables and no error. It now resets
  to `{}` like every other resource.
- `environments.isActive` was honored only on create; it now follows the rule on
  both verbs.

## Health & Configuration

### GET /health

Check engine status and version.

**Response:**
```json
{
  "status": "ok",
  "version": "0.3.0",
  "workers": 8
}
```

### POST /shutdown

Gracefully shut down the engine. This is the shutdown path the Electron app uses
on quit (it is more reliable than a signal on Windows, where `SIGTERM` does not
behave as expected).

The response is sent **before** shutdown begins, so the client always receives
the `200`. About 100ms later, on a detached thread, the engine invokes its
shutdown callback: the daemon's main loop exits, active runs are stopped, the
lock file is released, logs are flushed, and the process exits.

**Response:** `200`
```json
{
  "status": "ok",
  "message": "Shutdown initiated"
}
```

### GET /config

Get global configuration settings. Backed by the `config_entries` table. The
response is an `entries` array; each entry carries its value plus the UI metadata
the Settings panel renders (label, description, category, default, and optional
min/max/options):

```json
{
  "entries": [
    {
      "key": "workers",
      "value": "8",
      "type": "integer",
      "label": "Worker Threads",
      "description": "Number of worker threads for load generation.",
      "category": "performance",
      "default": "8",
      "min": "1",
      "max": "256",
      "updatedAt": 1234567890
    },
    {
      "key": "defaultHttpVersion",
      "value": "auto",
      "type": "enum",
      "label": "Default HTTP Version",
      "description": "Protocol a newly created request starts with...",
      "category": "general_engine",
      "default": "auto",
      "options": [
        { "value": "auto", "label": "Auto" },
        { "value": "http1.1", "label": "HTTP/1.x" },
        { "value": "http2", "label": "HTTP/2" }
      ],
      "updatedAt": 1234567890
    }
  ]
}
```

`min` and `max` are present only for entries that declare them (numeric
types). `options` is present only for `type: "enum"` entries - a JSON array of
`{value, label}`, so the renderer can draw a picker without a second,
hand-maintained value-to-label map. `value` and `default` are always strings;
`type` is one of `integer`, `number`, `boolean`, `string`, or `enum`.

`defaultHttpVersion` is the only seeded `enum` entry today: the protocol a
**newly created** request starts with (see [POST /requests](#post-requests)).
It is a write-time seed only - changing it never alters a request that already
exists, and it is never consulted at execution time.

The Settings panel renders entries dynamically, so new keys appear without app
changes. These `observability` keys govern how much a run keeps - three of them
on disk, one in memory:

| Key                 | Default   | Range        | Effect |
|---------------------|-----------|--------------|--------|
| `maxTraceBodyBytes` | `5242880` | 1024–104857600 | Largest request/response body stored in a design run's `trace_data`. Bigger bodies are truncated with `bodyTruncated`/`bodyBytes` (see `GET /runs/:id`). |
| `maxResponseBodyBytes` | `33554432` | 1024–1073741824 | Largest response body a **load-test** transfer reads into memory. A bigger response fails that request (see `POST /runs`). Not a storage cap and unrelated to `maxTraceBodyBytes`, which truncates what a *completed* design request writes to the database. |
| `maxRunsRetained`   | `200`     | 0–100000     | Keep at most this many most-recent runs; older runs (and their metrics/results) are pruned at startup and after each run finishes. `0` = unlimited. |
| `runRetentionDays`  | `30`      | 0–3650       | Delete runs older than this many days. `0` = unlimited. |

In-progress (`running`/`pending`) runs are never pruned.

### POST /config

Update one or more configuration entries. Two body shapes are accepted:

**Batch** - update several keys at once:
```json
{ "entries": { "workers": "16", "defaultTimeout": "30000" } }
```

**Single** - update one key:
```json
{ "key": "workers", "value": "16" }
```

In both shapes, non-string values (numbers, booleans) are coerced to strings.
Each key is validated against its registered `type` and, for `integer` / `number`
entries, its `min`/`max` range; `boolean` entries must be `"true"` or `"false"`;
`enum` entries (e.g. `defaultHttpVersion`) must equal one of that entry's stored
`options` values. Validation is all-or-nothing: if any key is unknown or out of
range, nothing is applied and the response is `400` with the specific reason(s):

```json
{ "error": { "code": "invalid_config", "message": "'workers' must be at most 256 (got 9999)" } }
```

**Success response:** `200` - the full updated entries array (same shape as
`GET /config`) plus `"success": true`.

## Collections

Collections are folders that organize requests in a hierarchy.

### GET /collections

List all collections.

**Response:**
```json
[
  {
    "id": "col_1234567890",
    "name": "My API",
    "parentId": null,
    "variables": {},
    "order": 0,
    "createdAt": 1234567890
  }
]
```

### POST /collections

Create a collection. **Create only** - see
[Resource writes](#resource-writes-create-vs-update) for the shared contract and
the null-vs-absent rule.

**Request:**
```json
{
  "name": "My API",        // Required, no default (null is a 400)
  "parentId": null,         // Optional, null for root
  "order": 0,               // Optional, appended after siblings if omitted
  "variables": {}           // Optional, collection-scoped variables
}
```

**Response:** The created collection object, carrying the engine-generated `id`.

**Errors:** `400` if the body carries an `id`
([the engine owns it](#the-engine-owns-every-id)), if `name` is missing or
`null`, or on a cycle (below).

### PUT /collections/:id

Update an existing collection. **Update only** - a `404` when the id does not
exist, never a silent create. The body is a merge-patch: an omitted field keeps
its value, an explicit `null` resets it to the default.

**Request:**
```json
{
  "name": "Renamed",       // Optional; null is a 400 (no default)
  "parentId": null,         // Optional, null moves it to the root
  "variables": null         // Optional, null resets to {}
}
```

**Response:** The updated collection object.

**Errors:** `404` if the collection does not exist; `400` on a `null` `name` or
on a cycle (below).

**Cycle validation (both verbs):** `parentId` is validated to keep the
collection tree acyclic, since a
cycle would make the cascade delete below loop forever. Both cases return `400`:

- `parentId` equal to the collection's own `id` - message `A collection cannot be its own parent`.
- `parentId` pointing at one of the collection's own descendants (a reparent that
  would form a cycle) - message `Cannot move a collection into its own descendant`.

Parent *existence* is intentionally not checked: the import orchestrator creates
collections in bulk, so requiring the parent to exist first would couple to
import ordering. Only self-parent and descendant cycles are rejected.

### DELETE /collections/:id

Delete a collection and all its requests (cascading delete). The cascade removes
every descendant collection and its requests in a single transaction, and
terminates even if the stored `parent_id` tree contains a cycle (see
[db-schema.md](db-schema.md) - collections).

**Response:**
```json
{
  "message": "Collection deleted successfully",
  "id": "col_1234567890"
}
```

## Requests

### GET /requests

List requests in a collection. Results are ordered by the requests' `order`
field (ascending), the same contract `GET /collections` has for collections.

**Query Parameters:**
- `collectionId` (required): Collection ID to fetch requests from

**Response:** An array of request objects, each in the same shape as a
`GET /requests/:id` response: `params`/`headers` are arrays of
`{key, value, enabled}` entries and `body` is a JSON discriminated union
(see the `requests` table in [db-schema.md](db-schema.md)).
```json
[
  {
    "id": "req_1234567890",
    "collectionId": "col_1234567890",
    "name": "Get Users",
    "description": "",
    "method": "GET",
    "url": "{{baseUrl}}/users",
    "order": 0,
    "params": [{ "key": "page", "value": "1", "enabled": true }],
    "headers": [{ "key": "Accept", "value": "application/json", "enabled": true }],
    "body": { "mode": "none" },
    "bodyType": "none",
    "auth": { "mode": "inherit" },
    "preRequestScript": "",
    "postRequestScript": "",
    "followRedirects": true,
    "maxRedirects": 10,
    "httpVersion": "auto",
    "updatedAt": 1234567890,
    "createdAt": 1234567890
  }
]
```

`followRedirects` / `maxRedirects` / `httpVersion` are the request's stored
execution options. They are always present in the response: a request saved
before these columns existed reads back as the engine defaults
(`true` / `10` / `"auto"`), which is the behaviour it already had.
`httpVersion` is `"auto"` | `"http1.1"` | `"http2"` - what was *requested*, not
what was negotiated; see [POST /execute](#post-execute) for the negotiated
value on a response.

### GET /requests/:id

Fetch a single request by id, in one lookup. The app uses this to load a
restored request tab or a design-run copy on cold start, instead of fetching
every collection's request list and scanning them for the id.

**Path Parameters:**
- `id` (required): The request ID to fetch

**Response:** The request object, in the same shape as a `GET /requests` list
entry.
```json
{
  "id": "req_1234567890",
  "collectionId": "col_1234567890",
  "name": "Get Users",
  "description": "",
  "method": "GET",
  "url": "{{baseUrl}}/users",
  "order": 0,
  "params": [],
  "headers": [],
  "body": { "mode": "none" },
  "bodyType": "none",
  "auth": { "mode": "inherit" },
  "preRequestScript": "",
  "postRequestScript": "",
  "followRedirects": true,
  "maxRedirects": 10,
  "httpVersion": "auto",
  "createdAt": 1234567890,
  "updatedAt": 1234567890
}
```

**404** when the request genuinely does not exist. This is distinct from a
`5xx`: the caller relies on that difference to tell a real deletion from an
unreachable engine, and must not treat a transport failure as "deleted".

### POST /requests

Create a request. **Create only** - see
[Resource writes](#resource-writes-create-vs-update) for the shared contract and
the null-vs-absent rule.

**Request:**
```json
{
  "collectionId": "col_1234567890", // Required, no default (null is a 400)
  "name": "Get Users",               // Required, no default (null is a 400)
  "method": "GET",                   // Required: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
  "url": "{{baseUrl}}/users",        // Required, no default (null is a 400)
  "params": [],                      // Optional, array of {key, value, enabled}
  "headers": [],                     // Optional, array of {key, value, enabled}
  "body": {"mode": "none"},          // Optional, request body
  "bodyType": "none",                // Optional: "none", "json", "text", "form-data", "x-www-form-urlencoded"
  "auth": {},                        // Optional, authentication config
  "preRequestScript": "",            // Optional, JavaScript pre-request script
  "postRequestScript": "",           // Optional, JavaScript test script
  "order": 0,                        // Optional, position within the collection
  "followRedirects": true,           // Optional, follow 3xx responses. Default true
  "maxRedirects": 10,                // Optional, hops while following, clamped to 0..100. Default 10
  "httpVersion": "auto"              // Optional: "auto" | "http1.1" | "http2". Absent/null seeds
                                      // from the "defaultHttpVersion" config entry
}
```

**Response:** The created request object, carrying the engine-generated `id`.

**Errors:** `400` if the body carries an `id`
([the engine owns it](#the-engine-owns-every-id)), if a
required field is missing or `null`, on an unrecognized `method`, on a
`params` / `headers` entry that is not `{key: string, value: string, enabled: bool}`,
or on an `httpVersion` that is not `"auto"` / `"http1.1"` / `"http2"` (the body
names the field and lists the valid values).

### PUT /requests/:id

Update an existing request. **Update only** - a `404` when the id does not
exist, never a silent create. Merge-patch body, same rule as collections.

**Request:** any subset of the `POST /requests` fields, minus `id` (it is the
path). Omitting `followRedirects` / `maxRedirects` leaves the stored values
untouched; sending `null` resets them to `true` / `10`. A non-boolean
`followRedirects` or a non-integer `maxRedirects` is ignored rather than
rejected. `maxRedirects` is clamped to `0..100` on the way in.

**`httpVersion`** follows the same [null-vs-absent rule](#the-null-vs-absent-rule)
as the fields above, but validates more strictly: absent keeps the stored
value; explicit `null` resets it to the live `defaultHttpVersion` config value;
a recognized string stores as given; anything else - an unrecognized string, or
a non-string - is a `400` naming the field and the valid values, never silently
coerced. Changing the global `defaultHttpVersion` afterward does not
retroactively alter a request already saved; only an explicit `null` on this
request re-seeds it.

**Response:** The updated request object.

**Errors:** `404` if the request does not exist; `400` on a `null`
`collectionId` / `name` / `method` / `url`, an unrecognized `method`, a
malformed `params` / `headers` entry, or an `httpVersion` that is not
`"auto"` / `"http1.1"` / `"http2"`.

### DELETE /requests/:id

Delete a request.

**Response:**
```json
{
  "message": "Request deleted successfully",
  "id": "req_1234567890"
}
```

## Import

### POST /import/fetch

Fetch a remote collection or spec by URL, server-side, so the app can import a
resource that browser CORS would otherwise block. The engine proxies the `GET`
via libcurl and returns the raw body and content type.

**Request:**
```json
{ "url": "https://example.com/collection.json" }
```

The `url` must be a string starting with `http://` or `https://`.

**Response:** `200`
```json
{
  "content": "...raw response body...",
  "contentType": "application/json"
}
```

`contentType` echoes the fetched response's `Content-Type` header, defaulting to
`application/octet-stream` when absent. The response JSON is serialized with
invalid UTF-8 replaced rather than throwing, so binary or malformed content can
never turn into a `500`.

**Errors:**
- `400` `Invalid JSON body` - the request body did not parse.
- `400` `Invalid URL` - `url` is missing, not a string, or does
  not start with `http://` / `https://`.
- `502` `Failed to fetch: <detail>` - the upstream request failed
  (connection error, transport failure).

### POST /import/apply

Persist an entire parsed import - collections, their requests, and environments -
in **one atomic call**. Items reference each other by opaque **temp ids** the
client invents; the engine generates every real id via `generate_id` and returns
the translation in `idMap`.

This is what replaced ~500 sequential `POST /collections` + `POST /requests`
calls for a 500-request import, and with it the only reason those endpoints ever
accepted a client-supplied `id` - which they no longer do (see
[The engine owns every id](#the-engine-owns-every-id)).

**Request:**
```json
{
  "collections": [
    { "tempId": "c1", "parentTempId": null, "name": "My API", "order": 0,
      "variables": {}, "auth": {"mode":"none"},
      "preRequestScript": "", "postRequestScript": "" },
    { "tempId": "c2", "parentTempId": "c1", "name": "Users", "order": 0 }
  ],
  "requests": [
    { "tempId": "r1", "collectionTempId": "c2", "name": "List users",
      "method": "GET", "url": "https://api.example.com/users",
      "params": [], "headers": [], "body": {"mode":"none"}, "bodyType": "none",
      "auth": {"mode":"inherit"}, "order": 0 }
  ],
  "environments": [
    { "tempId": "e1", "name": "Prod", "variables": {} }
  ]
}
```

- All three sections are optional; absent or `null` means "none of that kind"
  (the [null-vs-absent rule](#the-null-vs-absent-rule)). An empty payload is a
  `200` with an empty `idMap`.
- Every item needs a non-empty string `tempId`, **unique across all three
  sections** (they share one namespace, because `idMap` is one flat map). Temp ids
  are never stored.
- A collection's `parentTempId` and a request's `collectionTempId` must name a
  collection `tempId` **in the same payload**; references may point forward, so a
  child may appear before its parent. `parentTempId` is `null` (or absent) for a
  root.
- Every other field is the one the matching `POST /<resource>` accepts, with the
  same defaults and the same null rule - the engine runs the same per-resource
  field appliers for both paths. `id` is **not** accepted here: the engine owns
  ID generation on this path.
- `order` is optional. For collections, an omitted `order` appends after the
  existing siblings and then in payload order (each sibling gets the next slot -
  the per-item default cannot do this in bulk, because none of the payload's own
  siblings are stored yet). For requests it defaults to `0`, as with
  `POST /requests`; clients that care about request order should send it.
- Up to **10,000 items** per call (collections + requests + environments).

**Response:** `200`
```json
{ "idMap": { "c1": "col_<uuid>", "c2": "col_<uuid>", "r1": "req_<uuid>", "e1": "env_<uuid>" } }
```

Every `tempId` sent appears in `idMap`.

**Atomicity:** validation runs over the whole payload before anything is written,
and the write itself is a single SQLite transaction. A `400` therefore means
**nothing was persisted** - there is no partial tree to clean up.

**Errors:** every `400` uses the standard error object, and the per-item ones add
an `item` key **inside** it (the offending `tempId`) so a large import can name
what broke:

```json
{ "error": { "code": "bad_request", "message": "Duplicate tempId 'c1'", "item": "c1" } }
```

Messages, by case:
- `400` `Invalid JSON body` - the body did not parse.
- `400` `Body must be a JSON object`.
- `400` `Invalid 'collections': must be an array` - a section was
  present but not an array (same for `requests` / `environments`).
- `400` `Invalid collection at index 2: 'tempId' must be a non-empty string`.
- `400` `Invalid collection at index 0: 'id' is not accepted - the engine assigns ids; reference items by 'tempId'`.
- `400` `Duplicate tempId 'c1'`, with `item: "c1"`.
- `400` `Unknown parentTempId 'c9'`, with `item: "c2"`, and the same for
  `collectionTempId` - including a `collectionTempId` that names an environment
  rather than a collection.
- `400` `Cycle in parentTempId references at 'c1'`, with `item: "c2"` -
  a cycle (including a self-parent) in the payload's own parent graph. The
  stored-tree walk that guards `POST /collections` cannot see this one, because
  none of these rows exist yet, and a cycle makes cascade delete loop forever
  (issue #79).
- `400` `Missing required field: name`, with `item: "c1"`, and the other
  per-field errors of the matching `POST /<resource>`, including a wrong-typed
  field (`"name": 42`), which is a `400` rather than a `500`.
- `400` `Import too large: 10001 items exceeds the limit of 10000 per call`.
- `500` `<detail>` - the transaction itself failed; nothing was
  written.

## Environments

### GET /environments

List all environments.

**Response:**
```json
[
  {
    "id": "env_1234567890",
    "name": "Production",
    "variables": {
      "baseUrl": {
        "value": "https://api.example.com",
        "enabled": true,
        "secret": false
      }
    },
    "updatedAt": 1234567890
  }
]
```

### POST /environments

Create an environment. **Create only** - see
[Resource writes](#resource-writes-create-vs-update) for the shared contract and
the null-vs-absent rule.

**Request:**
```json
{
  "name": "Production",    // Required, no default (null is a 400)
  "description": "",        // Optional
  "isActive": false,        // Optional; true deactivates every other environment
  "variables": {            // Optional, null resets to {}
    "baseUrl": {
      "value": "https://api.example.com",
      "enabled": true,
      "secret": false
    }
  }
}
```

**Response:** The created environment object, carrying the engine-generated `id`.

**Errors:** `400` if the body carries an `id`
([the engine owns it](#the-engine-owns-every-id)), or if `name` is missing or
`null`.

### PUT /environments/:id

Update an existing environment. **Update only** - a `404` when the id does not
exist, never a silent create. Merge-patch body, same rule as collections.

`variables` replaces the whole map, so a caller doing a partial edit reads the
current map first and sends the merged result (this is what the MCP
`update_environment` tool does). Sending `variables: null` resets it to `{}` -
it no longer stores the literal string `null`, which is the bug this verb split
fixed. `isActive` is honored here too; it used to be read only on create.

**Writing `isActive: true` is how a client switches the active environment**, and
one request does the whole switch: the engine deactivates whichever environment
held the flag in the same transaction, so at most one row is ever active and a
client sends no companion write to clear the old one. Clearing entirely is
`isActive: false` on the environment that holds it. The engine still never
*applies* the active environment to a request - every execution names its own
`environmentId` - but because the choice is stored rather than kept client-side,
it survives a restart and is shared by every client on the same database. See
[db-schema.md](db-schema.md#environments).

**Request:**
```json
{
  "name": "Production",    // Optional; null is a 400 (no default)
  "variables": {},          // Optional, null resets to {}
  "isActive": true          // Optional, null resets to false; true is the switch
}
```

**Response:** The updated environment object.

**Errors:** `404` if the environment does not exist; `400` on a `null` `name`.

### DELETE /environments/:id

Delete an environment.

**Response:**
```json
{
  "message": "Environment deleted successfully",
  "id": "env_1234567890"
}
```

## Global Variables

### GET /globals

Get global variables (singleton).

**Response:**
```json
{
  "id": "globals",
  "variables": {
    "apiKey": {
      "value": "xxx",
      "enabled": true,
      "secret": false
    }
  },
  "updatedAt": 1234567890
}
```

### POST /globals

Set global variables.

**Request:**
```json
{
  "variables": {
    "apiKey": {
      "value": "xxx",
      "enabled": true,
      "secret": false
    }
  }
}
```

**Response:** The saved globals object.

Globals is a singleton, so there is no create/update pair: a `POST` **replaces**
the whole set rather than merging into it. Every write is therefore a create as
far as the [null-vs-absent rule](#the-null-vs-absent-rule) goes - `variables`
absent and `variables: null` both mean the default, `{}`.

`variables: null` used to store the literal four-character text `null`, which
parses as JSON but is not an object. `GET /globals` returns `{}` for anything it
cannot read as an object, so the failure showed up as globals silently
disappearing rather than as an error. A non-object `variables` (`42`, a string,
an array) had the same effect and is now a `400` - see
[Accepted field shapes](#accepted-field-shapes).

## Authentication

The engine **resolves auth server-side**. Every request's `auth` object (on
`POST /execute` and `POST /runs`) is applied to the outgoing request before it
hits the wire:

| `auth.mode` | Effect |
|-------------|--------|
| `none` / `inherit` | No-op (`inherit` is resolved by [`POST /compose`](#post-compose) before it reaches an execution endpoint; one arriving unresolved is a warning in the logs) |
| `bearer` | `Authorization: Bearer <token>` |
| `basic` | `Authorization: Basic <base64(user:pass)>` |
| `apikey` | Header `key: value`, or `?key=value` when `in: "query"` |
| `oauth2` | Acquires/caches a token (below) and injects it per `tokenPlacement` |

A user-supplied `Authorization` header always wins over `bearer`/`basic`/`oauth2`.
Header names are matched case-insensitively.

### OAuth 2.0 token cache

Tokens are acquired once and cached (SQLite `oauth_tokens`, keyed by a
deterministic `cacheKey` = `accessTokenUrl \x1f clientId \x1f credentialsId \x1f
username-if-password-grant`). Expiry uses a 45s skew; a missing `expires_in`
means non-expiring. There is **no mid-run refresh** - a token is fetched at run
start and reused for the whole run.

#### POST /oauth2/token

Acquire (or return a cached) token for an `OAuth2Config`. Supports the
`client_credentials`, `password`, and `authorization_code` grants; the
`authorization_code` grant requires an `interactive` code exchange (see below).

**Request:**
```json
{
  "config": { "grantType": "client_credentials", "accessTokenUrl": "https://idp/token",
              "clientId": "...", "clientSecret": "...", "scope": "openid" },
  "force": false,
  "interactive": { "code": "...", "codeVerifier": "...", "redirectUri": "..." }
}
```

`force: true` bypasses the cache (refreshes via the refresh token when present,
else re-acquires). `interactive` is only used for the `authorization_code` grant.

**Response (`200`):**
```json
{
  "cacheKey": "https://idp/token...",
  "accessToken": "ya29...",
  "tokenType": "Bearer",
  "scope": "openid",
  "expiresIn": 3600,
  "createdAt": 1234567890000,
  "expiresAt": 1234567893600,
  "hasRefreshToken": true
}
```

`expiresAt` is `null` for a non-expiring token; `scope` is omitted when empty.
Errors carry an `oauth2_*` code: `400` invalid config, `401` provider rejected
the request, `409` interactive authorization required, `502` network error.

#### GET /oauth2/token?key=&lt;cacheKey&gt;

Inspect the cached token for a key (used by the UI status row). Always `200`.

```json
{ "found": true, "expired": false, "token": { "...": "serialized token" } }
```

Returns `{ "found": false }` when no token is cached.

#### DELETE /oauth2/token?key=&lt;cacheKey&gt;

Clear a cached token. `200 { "deleted": true }` (`false` if nothing was cached).

### Interactive Authorization Code flow

For the `authorization_code` grant the engine owns PKCE (S256), the `state`
value, and the code exchange; the app only opens the browser. In **loopback**
mode the engine binds an ephemeral `127.0.0.1` listener; in **embedded** mode
(providers that reject loopback redirects) the app captures the redirect URL and
hands it back.

| Method / Path | Purpose |
|---------------|---------|
| `POST /oauth2/authorize/start` | `{config, mode?}` → `{attemptId, authorizeUrl, redirectUri}` |
| `GET /oauth2/authorize/:attemptId` | Poll status → `{state: "pending"\|"completed"\|"failed"\|"not_found", error?, cacheKey?}` |
| `POST /oauth2/authorize/complete` | `{attemptId, callbackUrl}` → status (embedded mode) |
| `DELETE /oauth2/authorize/:attemptId` | Cancel → `{cancelled: true}` |

Attempts time out after 5 minutes; on success the token is written to the cache
and `cacheKey` is returned.

## Execution

### POST /compose

Compose a request without sending it: resolve `{{variables}}` and `inherit`
auth engine-side and return the execute-ready payload that `POST /execute` and
`POST /runs` accept unchanged (issue #226). Pure - no traffic, no run row -
which is what lets a client (e.g. MCP's allowlist gate) inspect the *resolved*
request before anything is sent. The execution endpoints never interpolate, so
composing here and executing the result resolves everything exactly once; a
payload that skips composition is sent byte-for-byte as supplied.

**Request** - at least one of `requestId` / `request` is required:

```json
{
  "requestId": "req_1234567890",   // Optional: compose the saved request
  "request": {                      // Optional: an inline unresolved request
    "method": "POST",
    "url": "https://{{host}}/users",
    "headers": { "X-Token": "{{token}}" },
    "body": { "mode": "json", "content": "{\"name\":\"{{name}}\"}" },
    "auth": { "mode": "inherit" },
    "preRequestScripts": [],
    "postRequestScripts": []
  },
  "collectionId": "col_1234567890", // Optional: chain scope for an inline request
  "environmentId": "env_1234567890" // Optional: environment scope
}
```

- **`requestId`** composes the stored request wholesale: URL, flattened enabled
  headers (later duplicates win), body, auth (absent auth defaults to
  `inherit`), the ordered script-part lists (collection chain root→leaf, then
  the request's own), and the stored execution options (`followRedirects` /
  `maxRedirects` / `httpVersion`, always emitted). The request's own collection
  scopes resolution; `collectionId` is only a fallback for a request without
  one. An unknown id is a definitive **404**.
- **`request`** is an inline unresolved request in the `POST /execute` body
  shape. Given *alongside* `requestId`, its fields lay over the stored ones
  before resolution - how an override like "retarget this saved request at
  another URL" works. Given alone, `collectionId` scopes the variable chain and
  the `inherit` walk. Unknown scope ids degrade to an empty scope rather than
  erroring - composition works with no collection or environment at all.

**What gets resolved:** the URL, header keys and values, body `content` and
`fields`, and every string inside the winning auth block - after `inherit` is
walked (leaf→root; an explicit `noauth` terminates the walk, `none` is stepped
over) and strictly before any OAuth 2.0 cache key is derived from the config.
Script text is **never** interpolated - a `{{...}}` in a script is user
JavaScript. Resolution semantics (precedence, unknown names, dynamic
variables, the D17 malformed-data rules) are specified in
[variable-resolution](../app/variable-resolution.md) and pinned by the shared
conformance fixture (`engine/tests/fixtures/variable-resolution-conformance.json`).

**Response:** `200` with the composed payload - the `POST /execute` body shape,
with `requestId` / `environmentId` echoed so the result can be POSTed onward
unchanged. An auth that resolves to "send nothing" is an absent `auth` field.

**Errors** use the engine's single nested shape (see the top of this page),
with specific codes:

- `404` `{"error": {"code": "request_not_found", "message": "..."}}` - unknown `requestId`.
- `400` `{"error": {"code": "invalid_compose_request", "message": "..."}}` -
  malformed JSON, neither `requestId` nor `request`, or a field of the wrong type.

### POST /execute

Execute a single HTTP request (Design Mode). Returns immediate response with test results.

> Alias: `POST /request` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

The request's `auth` (see [Authentication](#authentication)) is resolved before
the pre-request script runs, so `pm.request` reflects the real outgoing headers.
If a non-interactive OAuth 2.0 token cannot be obtained, the engine still returns
`200` but the body carries `statusCode: 0`, an `errorCode` of `AUTH_REQUIRED`
(interactive sign-in needed) or `AUTH_FAILED`, and an `authErrorCode` hint.

**Request:**
```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "type": "json",
    "content": "{\"name\":\"John\"}"
  },
  "requestId": "req_1234567890",      // Optional, links to saved request
  "environmentId": "env_1234567890",  // Optional, uses environment variables
  "preRequestScript": "",              // Optional
  "postRequestScript": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));",
  "followRedirects": true,             // Optional, default true
  "maxRedirects": 10,                  // Optional, default 10
  "verifySSL": true,                   // Optional, default true
  "httpVersion": "auto"                // Optional: "auto" | "http1.1" | "http2", default "auto"
}
```

**Script parts.** `preRequestScript` / `postRequestScript` above are the legacy
single-string form and still work. The engine also accepts `preRequestScripts`
/ `postRequestScripts`: a list of parts, each recording where it came from, so
a stored run can say which part is the collection's and which is the
request's:

```json
{
  "preRequestScripts": [
    { "origin": "collection", "id": "c1", "name": "API", "script": "const base = pm.environment.get('baseUrl');" },
    { "origin": "request", "id": "r1", "script": "pm.environment.set('traceId', base);" }
  ]
}
```

When both forms are sent, the list wins - they are never merged. Parts are
joined with a blank line and run as a single script in one shared scope (see
[scripting.md](scripting.md#script-parts)), so a variable declared in an
earlier part is visible to a later one; parts that are empty or only
whitespace are dropped.

**The pre-request script can change what is sent.** Its `pm.request` edits -
method, url, headers, body - are applied to the request before it goes out, and
because auth is resolved *before* the script runs, a script-set `Authorization`
overrides the one the engine applied. `requestHeaders` and `rawRequest` in the
response below, and the stored trace behind `GET /runs/:id`, all report the
post-script request. A value the engine cannot send (a non-string url, an
unknown method) rejects the whole write-back, leaves the request unchanged, and
is reported as `preScriptError`. See
[scripting.md](scripting.md#mutating-the-request-pre-request-scripts).

**Redirect policy.** `followRedirects` defaults to **true**, so omitting it
follows every 3xx and only the final response is returned - send
`followRedirects: false` to see the 3xx status and its `Location` header. Both
clients send these explicitly for exactly that reason (see
[api-integration](../app/api-integration.md)). `POST /runs` accepts the same
three fields with the same defaults, so a load test can be run under the policy
the request was configured with.

**Protocol.** `httpVersion` selects which HTTP version curl attempts:
`"auto"` lets ALPN negotiate (curl's own default), `"http1.1"` forces
HTTP/1.1, and `"http2"` attempts h2 over TLS and falls back to 1.1
(`CURL_HTTP_VERSION_2TLS` - against a plain `http://` URL this silently
negotiates 1.1, since h2 is not offered over cleartext). This is what was
*requested*; the response's own `httpVersion` (below) reports what was
actually negotiated, and the two can differ. The renderer always sends this
field on every execute, never eliding it even when it equals the default - the
same rule `followRedirects` follows, and for the same reason: an omitted field
lets an engine-side default win silently. MCP's saved-request paths get the
same guarantee from `POST /compose`, which always emits a stored request's
execution options; its two ad-hoc tools (`run_request` / `start_load_run`)
forward `httpVersion` only when the caller supplies it, since there is no
saved request behind an ad-hoc call for an omission to silently override (see
[mcp.md](mcp.md#request-composition)). It governs **both** Send and load test -
`POST /requests`/`PUT /requests/:id` is where a request's protocol is actually
stored (see [Requests](#requests) above); `POST /runs` (below) is simply the
run-shaped way of stating the same field, not a second store.

**Response:**
```json
{
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json"
  },
  "requestHeaders": { "accept": "*/*" },
  "rawRequest": "GET /users HTTP/1.1\n...",
  "body": { "id": 1, "name": "John" },
  "bodyRaw": "{\"id\":1,\"name\":\"John\"}",
  "bodySize": 20,
  "httpVersion": "HTTP/1.1",
  "timing": {
    "totalMs": 245.5,
    "wireMs": 245.1,
    "queueWaitMs": 0.4,
    "dnsMs": 5.2,
    "connectMs": 12.3,
    "tlsMs": 45.1,
    "firstByteMs": 180.2,
    "downloadMs": 2.7
  },
  "testResults": [
    {
      "name": "Status is 200",
      "passed": true
    }
  ],
  "consoleLogs": []
}
```

**`httpVersion` on the response** is the protocol actually **negotiated**
(`CURLINFO_HTTP_VERSION` after the transfer), e.g. `"HTTP/1.1"` or `"HTTP/2"` -
an *outcome*, not an echo of the request's own `httpVersion` field, and
deliberately a different value space (see
[requests.http_version](db-schema.md#requests) for the full distinction). It is
`""`, not omitted, when nothing was negotiated (e.g. the connection never
reached a server) - empty rather than guessing `"HTTP/1.1"` and presenting a
guess as fact. The same field is stored in a design run's `trace_data.response`
and reported back unchanged by `GET /runs/:runId` and
`GET /runs/:runId/report`.

**One timing convention.** The `timing` keys above are the same `*Ms` names the
stored trace uses (`store_result` / `load_strategy` → `results[].trace` in
`GET /runs/:runId/report`), and the design-mode writer stores all eight keys
unconditionally - so a live response and one restored from the stored trace
carry the same fields with the same names, Wire/Queue included. Traces written
by earlier releases differ two ways, and readers must tolerate both: stored
rows omitted zero-valued phases and all of `totalMs`/`wireMs`/`queueWaitMs`
(see [db-schema.md](db-schema.md)), and the live response named its keys
without the suffix (`firstByte`, `dns`, …) - consumers of the raw `/execute`
body written against that dialect must switch to the `*Ms` names.

**Variables the scripts wrote are persisted, and only those.** After the
post-request script runs, the engine writes back the three variable scopes
(the run's environment, globals, and the executed request's collection) - but
only for a scope whose variables a script actually changed. A run that sets no
variable writes nothing at all, so it does not move a collection's or
environment's `updatedAt`. Each variable round-trips whole, `createdAt`
included; see [VariableValue shape](db-schema.md#variablevalue-shape) for why
that field must survive and who may stamp it.

### POST /runs

Start a load test run (Vayu Mode).

> Alias: `POST /run` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

**Request:**
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": {},
  "body": {
    "type": "none",
    "content": ""
  },
  "mode": "constant_rps",    // "constant_rps", "constant_concurrency", "ramp_up", or "iterations"
  "concurrency": 100,        // Target in-flight requests (constant_concurrency / ramp_up target / iterations)
  "startConcurrency": 1,     // Ramp start concurrency (ramp_up mode)
  "duration": "60s",         // Duration, ms/s/m/h (constant_rps / constant_concurrency / ramp_up)
  "rampUpDuration": "10s",   // Ramp time, ms/s/m/h (ramp_up mode; start may be above target)
  "iterations": 0,           // Number of iterations (iterations mode)
  "targetRps": 1000,         // Target requests per second (constant_rps mode)
  "maxInFlight": 10000,      // Optional; see "maxInFlight" note below - constant_rps only
  "requestId": "req_1234567890",      // Optional, links to saved request
  "environmentId": "env_1234567890",  // Optional
  "tests": "",               // Optional, deferred validation script
  "followRedirects": true,   // Optional, default true - see POST /execute
  "maxRedirects": 10,        // Optional, default 10
  "httpVersion": "auto"      // Optional: "auto" | "http1.1" | "http2", default "auto" - see POST /execute
}
```

**`httpVersion` on `POST /runs`** is not a per-run override of a stored
request - it is simply how this endpoint states which protocol the run uses at
all, the same way `method` and `url` state the rest of the request. The
renderer always sends the saved request's own `httpVersion` here (there is no
second, load-test-only protocol control in the app); MCP's ad-hoc
`start_load_run` - which has no saved request behind it - is the caller that
actually depends on this field to specify a protocol in the first place. An
explicit `null` is treated exactly like an absent key. An unrecognized string
is a `400` naming the field and the valid values, the same validation
`POST /requests` uses.

**Response:**
```json
{
  "runId": "run_1234567890",
  "status": "running"
}
```

**`tests` accepts both forms**, like `preRequestScripts` / `postRequestScripts`
on `POST /execute` above: the legacy single string, or a list of parts
(`[{ "origin": "collection" | "request", "id", "name", "script" }]`) that the
engine joins itself (see [scripting.md](scripting.md#script-parts)). The list
wins when both are sent. Sending the collection chain's parts means its
assertions are now actually checked under load - previously only the
request's own `tests` string was ever sent, so a collection-level assertion
passed in design mode and was silently never validated by a load run.

**`tests` and `postRequestScript(s)` are the same field.** The post-request
script is stored as `postRequestScript`, `POST /execute` grew up calling it
`postRequestScript(s)`, and this endpoint calls it `tests`. All three names are
accepted on **both** endpoints, so a payload composed for one can start the
other kind of run unchanged - which is how a saved request's composed test
scripts reach a load run. The names are tried in a fixed order
(`postRequestScripts`, `postRequestScript`, then `tests`) and the first that
yields a non-blank script wins; they are never merged. Previously each route
knew only its own spelling and silently dropped the other.

**There is no pre-request hook on this endpoint.** `preRequestScript(s)` in a
run payload is not an error, but nothing runs it - only `POST /execute` executes
a pre-request script. A request that signs itself in one is sent unsigned under
load.

**Accepted ranges.** The numeric config is range-checked **before the run row is
created**, so a rejected request leaves no `pending` row behind. A violation is
a `400` whose `error.code` is `invalid_run_config` rather than the per-status
default, and whose message names the offending field and why the bound exists:

| Field | Accepted | Rejected because |
|-------|----------|------------------|
| `success_sample_rate` | `1`-`100000` | It is a sampling *period* (keep 1 in N), used as `counter % rate`. A `0` was a division by zero that killed the daemon mid-run. |
| `response_sample_rate` | `1`-`100000` | Same modulo, same crash. |
| `max_response_samples` | `0`-`1000000` | Each retained sample holds a full response body, and the vector is reserved up front; a negative value casts to ~1.8e19. |
| `concurrency` | `1`-`10000` | Connections are eagerly pre-allocated per worker before any traffic flows, so `-1` (a natural "unlimited" guess) allocated until malloc failed. |
| `timeout` | `1`-`86400000` ms | A transfer that never times out never completes, leaving the run stuck `running` and unstoppable. |
| `duration` | string, positive, optional unit (`ms`\|`s`\|`m`\|`h`) | A JSON *number* threw out of the run-context constructor *after* the row was written, stranding it `pending` forever behind an opaque `500`. |

An **absent** field, or an explicit `null`, is always accepted - every one of
them has a default. The ceilings are crash guards, not policy: each client caps
itself far lower (the load dialog offers `concurrency` &le; 1000; the MCP
`start_load_run` tool has a user-settable cap in Settings).

The sample rates are additionally clamped to &ge; 1 inside the metrics
collector, so the modulo cannot divide by zero even for a caller that bypasses
this route.

**Shutdown refuses new runs.** Once the daemon has begun draining its run
workers, `POST /runs` answers `503` with the message `Engine is shutting down` rather
than accepting a run nothing will ever execute. The window is small - the HTTP
server stops before the drain begins - but it is not empty, and a request
already in a handler when the drain starts must not be able to spawn a worker
past it (see `RunManager::shutdown`).

**Auth pre-flight.** When `auth.mode` is `oauth2`, the run route resolves the
token **before** creating the run and warms the cache for the workers. An
unauthorizable config is rejected up front with `409` (interactive sign-in
required) or `400`, carrying the `/oauth2` error codes, so a bad token never
surfaces as a silently-failed run.

**Concurrency model.** `constant_concurrency`, `ramp_up`, and `iterations` are
**closed-loop**: the engine holds in-flight requests at a target (`concurrency`,
or the ramp curve from `startConcurrency` to `concurrency`) - when a request
completes, another is issued. Throughput is a *result* (`concurrency ÷ latency`),
not an input. `constant_rps` is **open-loop**: it dispatches at `targetRps`
regardless of how fast responses return.

**`maxInFlight`.** A hard cap on concurrent in-flight requests. It applies
**only to `constant_rps`** (the open-loop rate mode), where it bounds how many
requests may be outstanding before the engine drops new ones; default
≈ `max(targetRps × 10, 1000)`. For the closed-loop modes the `concurrency`
target *is* the in-flight bound, so `maxInFlight` is ignored there.

**Durations.** `duration` and `rampUpDuration` take a number with an optional
unit: **`ms`, `s`, `m`, `h`**, matched as a whole suffix (`"500ms"` is half a
second, not 500 minutes). A bare number is seconds - `"60"` == `"60s"` - which
is also how the MCP duration cap reads the field. Fractions are allowed
(`"1.5s"`), case and spacing are ignored (`"30 S"`). A value the engine cannot
read - an unknown unit, a non-number, a negative - **fails the run** (status
`failed`, with the offending field named in the daemon log) rather than being
silently replaced by the 60s default.

**`constant_rps` is time-bound, and its shortfall is recorded.** The generator
accrues `targetRps × elapsed` and submits the whole requests owed each tick,
carrying the fraction - so a rate above 1000 is delivered as asked rather than
floored to a multiple of 1000. Requests that come due while in-flight is at
`maxInFlight` are **dropped at that instant**, not deferred: the run ends at its
wall-clock `duration`, and `droppedRequests` (in the run summary and per-tick
metrics) carries what the rate owed but could not issue. `sent + dropped` is
therefore what `targetRps × duration` asked for.

**Ramp semantics.** `ramp_up` interpolates linearly from `startConcurrency` to
`concurrency` over `rampUpDuration`, then holds `concurrency` for the rest of
`duration`. A `startConcurrency` **above** `concurrency` is a valid descending
ramp. If `duration` is shorter than `rampUpDuration`, the run stops partway up
(or down) the curve.

**Response bodies are capped.** A load-run request reads at most
`maxResponseBodyBytes` (Settings → Observability, default 32MB) into memory.
Every in-flight request holds its own body, so an uncapped one multiplies by
concurrency; a response past the cap **fails that request** rather than being
buffered. It is reported like any other transport failure - `statusCode: 0`
with an `errorCode` of `INTERNAL_ERROR` and a message naming
`maxResponseBodyBytes` - and the truncated prefix is kept as the body. Design
mode (`POST /execute`) is **not** capped: it sends one request at a time, and
truncating a response the user asked to see would be the wrong trade.

**Wire method and body.** A body is sent with whatever method the request
names: a `GET` carrying one stays a `GET` on the wire (Elasticsearch-style
search bodies work), where it previously went out as a `POST`. The one
combination that cannot be sent is **`HEAD` with a body** - curl's `HEAD`
support drops the body - so it is refused rather than silently changed:
`statusCode: 0`, `errorCode: INVALID_METHOD`, and a message saying so. This
holds identically for `POST /execute` and `POST /runs`.

**Failed requests still report timing.** A transfer that fails (timeout,
connection refused, capped body) carries whatever curl measured before it
failed - `wireMs`, the phase breakdown, and `bytes`/throughput counts - instead
of reporting zeros. No phase (`dnsMs`, `connectMs`, `tlsMs`, `firstByteMs`,
`downloadMs`) is ever negative: `tlsMs` is `0` for plain HTTP and for a reused
keep-alive connection rather than the negative value it used to store.

## Metrics & Statistics

### GET /runs/:runId/metrics

Paginated **historical time-series** (JSON) for a run's charts. This is the
canonical replacement for the legacy `GET /stats/:runId?format=json`; both call
the same `run_time_series_response` core so they cannot drift. The response is
**always JSON** - any `format` query param is ignored.

**Query parameters:**
- `limit` - max records per page (default 5000, invalid/&le;0 falls back to 5000, capped at 50000).
- `offset` - skip N records (default 0, negative floored to 0).

Per-tick rows carry the **windowed** latency percentiles (`latency_p50_ms` /
`latency_p95_ms` / `latency_p99_ms`, snake_case) alongside
rps/throughput/concurrency/status codes, so the history view can rebuild the
percentiles-over-time chart, the response-time-vs-concurrency scatter, and the
capacity-breakpoint / saturation stats from stored data.

**Response:**
```json
{
  "data": [
    {
      "timestamp": 1234567890,
      "elapsed_seconds": 10.5,
      "requests_completed": 1500,
      "requests_failed": 5,
      "current_rps": 150.5,
      "current_concurrency": 100,
      "send_rate": 150.0,
      "throughput": 149.5,
      "backpressure": 0,
      "error_rate": 0.33,
      "dropped_requests": 0,
      "bytes_sent": 48000,
      "bytes_received": 1920000,
      "status_codes": { "200": 1495, "404": 3, "500": 2 },
      "latency_p50_ms": 38.5,
      "latency_p95_ms": 95.1,
      "latency_p99_ms": 12.0
    }
  ],
  "pagination": { "total": 1, "limit": 5000, "offset": 0, "hasMore": false, "returned": 1 }
}
```

`requests_failed` is derived per tick as `error_rate% × requests_completed`,
rounded to the nearest request, after every row belonging to that timestamp has
been folded into the bucket. It is therefore independent of the order the rows
come back in - deriving it while reading the `error_rate` row made it depend on
the `requests_sent` row having already been seen for the same timestamp, and the
producer writes `error_rate` first, so it read a completed count of 0 and every
bucket of every run reported 0 failed requests.

A missing run returns `404` with the message `Run not found`.

**Storage (response shape unchanged).** Each `data[]` entry is one stored row of
`metric_ticks` - the engine writes the tick object once, at write time, instead
of the reader reassembling it from ~20 EAV `metrics` rows per second. Two things
follow, both improvements the shape gives for free:

- **Pagination is tick-aligned**: `limit`/`offset` count ticks, so
  `pagination.total` is the number of ticks (not rows), and a page boundary can
  no longer return a tick with half its fields zeroed.
- **`elapsed_seconds` keeps counting across pages** (it is measured from the
  run's first stored tick), and `requests_failed` carries the real error count
  the row-order-dependent legacy derivation always reported as `0`.

Runs recorded before `metric_ticks` existed are still served from their legacy
rows, with exactly the response they produced before.

### GET /stats/:runId (deprecated)

> **Prefer `GET /runs/:runId/live`** (above) for live dashboards - it replays a retained
> in-memory tick topic with no attach race. `/stats/:runId` is the legacy DB-polling path
> and is retained wholesale (its SSE mode gets no canonical rename). Its historical
> `?format=json&limit=&offset=` retrieval is a deprecated alias of `GET /runs/:runId/metrics`
> (same core); new callers should use that path.

Stream real-time metrics for a load test using Server-Sent Events (SSE).

**Response:** SSE stream with events:

```
event: stats
data: {"timestamp":1234567890,"totalRequests":1500,"totalErrors":5,"totalSuccess":1495,"errorRate":0.33,"avgLatencyMs":45.2,"currentRps":150.5,"activeConnections":100,"elapsedSeconds":10.5}

event: complete
data: {"totalRequests":6000,"totalErrors":30,"totalSuccess":5970,"errorRate":0.5,"avgLatencyMs":42.1,"finalRps":100.0,"duration":60.0}
```

**Metrics included:**
- `totalRequests`: Total requests completed
- `totalErrors`: Total errors encountered
- `totalSuccess`: Total successful requests
- `errorRate`: Error rate as percentage
- `avgLatencyMs`: Average latency in milliseconds
- `currentRps`: Current requests per second
- `activeConnections`: Active concurrent connections
- `elapsedSeconds`: Elapsed time since test start

For runs recorded since `metric_ticks`, this stream is fed from those rows; every
field above comes from the stored tick except **`avgLatencyMs`, which stays `0`** -
the per-tick object has never carried mean latency. `GET /runs/:runId/live` serves
it (from the in-memory collector) and is the endpoint to use.

### GET /runs/:runId/live

> Alias: `GET /metrics/live/:runId` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Stream live metrics for a run via Server-Sent Events, replayed from a retained
in-memory tick topic. The engine produces one wire-ready `metrics` tick per
`liveTickIntervalMs` (default 100ms) into a per-run buffer; this endpoint
replays that buffer **from offset 0** and then tails new ticks until the run
finishes, ending with a `complete` event. Because the topic is retained for
`liveRetentionMs` (default 60000ms) after completion, a client that connects
late - even after a sub-second run has already finished - still receives the
full series. There is no attach race.

**Events:**
```
event: metrics
id: 0
data: {"runId":"...","timestamp":1234567890,"elapsedSeconds":10.5,
       "totalRequests":1500,"totalSuccess":1495,"totalErrors":5,"errorRate":0.33,
       "currentRps":150.5,"sendRate":150.0,"throughput":149.5,
       "activeConnections":100,"backpressure":0,"droppedRequests":0,
       "avgLatencyMs":45.2,"avgQueueWaitMs":0.4,
       "latencyP50Ms":38.5,"latencyP95Ms":95.1,"latencyP99Ms":156.7,
       "bytesSent":48000,"bytesReceived":1920000,
       "requestsSent":1500,"requestsExpected":0,
       "status2xx":1495,"status3xx":0,"status4xx":3,"status5xx":2,
       "statusCodes":{"200":1495,"404":3,"500":2}}

event: complete
data: {"event":"complete","runId":"run_1234567890"}
```

**Field reference** (all keys emitted by `MetricsCollector::get_current_stats()`):

| Field | Meaning |
|-------|---------|
| `totalRequests` / `totalSuccess` / `totalErrors` | Completed counts |
| `errorRate` | Error percentage |
| `currentRps` | Instantaneous RPS (delta over the tick window) |
| `sendRate` | Rate requests are dispatched (open model) |
| `throughput` | Rate responses are received |
| `activeConnections` | Current in-flight requests |
| `backpressure` | Queue depth (`requestsSent − totalRequests`) |
| `droppedRequests` | Requests discarded at the `maxInFlight` cap (never sent) |
| `avgLatencyMs` | Mean **perceived** latency |
| `avgQueueWaitMs` | Mean time queued inside the generator before the wire |
| `latencyP50Ms` / `latencyP95Ms` / `latencyP99Ms` | Live **windowed** percentiles - a rolling per-tick window sampled from a phaser-based `hdr_interval_recorder`, so the chart tracks recent load instead of flattening toward the all-time distribution (the final report still uses the cumulative histogram) |
| `bytesSent` / `bytesReceived` | Cumulative wire bytes |
| `requestsSent` / `requestsExpected` | Progress for bounded modes (drives ETA) |
| `status2xx`–`status5xx` | Per-class counts |
| `statusCodes` | Full per-code distribution map |

Each `metrics` event carries an `id:` equal to its zero-based offset. The
browser's built-in `EventSource` retry automatically replays this id as
`Last-Event-ID` on its **own** intra-connection retries (no application code
needed), and the stream resumes from `Last-Event-ID + 1`.

**Replay window.** The in-memory tick topic is a bounded ring, so a long run's
memory does not grow with its duration. Its span is `liveReplayWindowMs`
(default 300000, i.e. 5 minutes) and the tick count is derived from that window
and the configured cadence - `liveReplayWindowMs / liveTickIntervalMs`, 3000
ticks at both defaults. The bound is a duration rather than a fixed count
because the cadence is itself configurable: one tick count would mean a
30-second window at `liveTickIntervalMs=10` and a 50-minute one at `1000`.
`liveReplayWindowMs = 0` means the full run (no time limit). Whatever the pair,
the ring is capped at `liveMaxRetainedTicks` (default **50,000**, ~50 MB), so a
fast cadence reaches that ceiling before a long window does. Raising it is
cheap at stock settings - the window, not the ceiling, is what sizes the ring.

Ids keep counting past an eviction, so they stay monotonic; a `Last-Event-ID`
older than the retained window resumes from the oldest retained tick rather than
replaying from 0, which means a client that was disconnected for longer than the
window sees a gap, not a duplicate flood.

The window also bounds the **replay-from-0** path below, which is the one the
bundled app actually exercises: a dashboard attaching (or re-attaching) mid-run
rebuilds its chart from the retained ring. That is why `liveReplayWindowMs` is
the *same* setting as the app's live-chart window rather than a second one to
keep aligned - the app's **Settings → Live Dashboard → Chart window** picker
reads and writes this entry (`GET`/`POST /config`), so the span the engine
retains and the span the chart displays cannot disagree. Editing it here and
editing it there are the same action.

The final `metrics` event is emitted only once the run's worker has actually
settled. On `POST /runs/:runId/stop` the engine keeps ticking while in-flight
requests are cancelled and recorded, so the last live numbers agree with the
stored report rather than freezing at the moment of the stop request.

**Application-level reconnect**: clients that close the EventSource themselves
(e.g. after observing `readyState === CLOSED`) should NOT open a new connection
and rely on `Last-Event-ID` - `EventSource` does not expose a header-setting
API, so a fresh connect would request `from=0` and replay the entire retained
topic, duplicating ticks already shown. The canonical recovery is to converge
on the stored report via `GET /runs/:runId/report` (the same path used at normal
run end). This is the pattern the bundled app uses.

**Responses:**
- `200` - SSE stream (active run, or finished run still within the retention window).
- `404` - run not found or evicted past `liveRetentionMs`; the body hints
  `Use /runs/:runId/report for the stored report`. Clients should fall back to
  the stored report in this case.

Tuning: `liveTickIntervalMs` (live tick cadence, 10–1000ms),
`liveReplayWindowMs` (retained replay span *and* the dashboard's chart window,
0–3600000ms; 0 = full run), `liveMaxRetainedTicks` (the tick ceiling for that
window on both sides, 1000–500000) and `liveRetentionMs`
(post-completion retention, 0–600000ms; 0 disables retention) are configurable
via `POST /config`.

## Runs

### GET /runs

List test runs (both design mode and load tests), newest first
(`start_time DESC` - the only order the UI uses). Rows carry a compact
`summary` rather than the full `configSnapshot`, so the polled history sidebar
stays cheap as history grows.

**Query parameters** (passing **any** of them opts into the paginated envelope):
- `limit` - page size (default 50, invalid/&le;0 falls back to 50, capped at 500).
- `offset` - rows to skip (default 0, negative floored to 0).
- `type` - `design` | `load` (an unrecognised value is ignored, not an error).
- `status` - a `RunStatus` string (`pending` | `running` | `completed` | `failed` | `stopped`; unrecognised ignored).
- `requestId` - exact match on the run's linked request.
- `q` - case-insensitive substring **over the stored `config_snapshot` text**
  (SQL `LIKE`). It searches the raw snapshot, so it may over-match JSON keys or
  structure - acceptable for a search box.

**`summary`** carries exactly these nine keys: `url`, `method`, `mode`,
`duration`, `concurrency`, `comment`, `followRedirects`, `maxRedirects`, and
`httpVersion`. The first eight are each **omitted** when absent from the
snapshot (a malformed snapshot yields an empty `summary`, never a `500`);
`httpVersion` alone is always present. A raw `POST /runs` body of
`"httpVersion": null` (erased before execution, so it behaves exactly like an
absent key - see [POST /runs](#post-runs)) lands in the stored snapshot
verbatim, and a run predating this field has no key at all; neither case
recorded a protocol, so both normalize to the literal string `"auto"` rather
than being omitted, which would misrepresent "nothing was recorded" as "we
lost it". Do not read `"auto"` on an old run as the protocol it used: a load
run stored before 0.11.0 hardcoded `CURL_HTTP_VERSION_2TLS`, and every run
before it went out as HTTP/1.1 regardless, because nghttp2 was not linked. The full snapshot stays available on
`GET /runs/:runId`.

**Response (envelope):**
```json
{
  "data": [
    {
      "id": "run_1234567890",
      "requestId": "req_1234567890",
      "environmentId": null,
      "type": "load",
      "status": "completed",
      "startTime": 1234567890,
      "endTime": 1234567891,
      "summary": {
        "url": "https://api.example.com/users",
        "method": "GET",
        "mode": "constant_rps",
        "duration": "60s",
        "concurrency": 100,
        "comment": "nightly",
        "followRedirects": true,
        "maxRedirects": 10,
        "httpVersion": "auto"
      }
    }
  ],
  "pagination": { "total": 812, "limit": 50, "offset": 0, "hasMore": true, "returned": 50 }
}
```

**Legacy no-param behavior (deprecated, removed next minor).** A request with
**no query params at all** returns today's bare array of full-`configSnapshot`
rows unchanged, so external scripts keep working:
```json
[
  {
    "id": "run_1234567890",
    "requestId": "req_1234567890",
    "environmentId": "env_1234567890",
    "type": "design",
    "status": "completed",
    "configSnapshot": "{}",
    "startTime": 1234567890,
    "endTime": 1234567891
  }
]
```
This legacy branch is a temporary alias (like those in
[Deprecated aliases](#deprecated-aliases)) and is removed at the next minor
release; new callers should always pass pagination params and read the
`{data, pagination}` envelope.

### GET /runs/:runId

> Alias: `GET /run/:runId` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Get details for a specific run.

**Response:** The run object shown in `GET /runs` (`id`, `requestId`,
`environmentId`, `type`, `status`, `configSnapshot`, `startTime`, `endTime`).

For a `design` run that has at least one stored result, the response also
carries a `result` object with that run's single exchange - the only other
place it appears is `GET /runs/:runId/report`, whose `results` array and
`metadata.configuration` are load-test concepts and are absent for a design
run.

```json
{
  "id": "run_1234567890",
  "requestId": "req_1234567890",
  "environmentId": null,
  "type": "design",
  "status": "completed",
  "configSnapshot": { "...": "the raw run payload" },
  "startTime": 1234567890,
  "endTime": 1234567891,
  "result": {
    "timestamp": 1234567891,
    "statusCode": 200,
    "statusText": "OK",
    "latencyMs": 42.1,
    "error": "optional, only when the request failed",
    "trace": { "request": { "...": "..." }, "response": { "...": "..." } }
  }
}
```

If the engine truncated a body for storage (over `maxTraceBodyBytes`), the
affected `trace.request` and/or `trace.response` object carries
`"bodyTruncated": true` and `"bodyBytes": <original length>`; its `body` then
holds only the first `maxTraceBodyBytes` of the original. Absent when the body
fit. Clients surface this as a "body truncated for storage" notice and re-send
to fetch the whole body.

### POST /runs/:runId/stop

> Alias: `POST /run/:runId/stop` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Stop a running load test. The engine signals the run, waits up to 5s for its
worker to settle, and answers with a summary of what the run actually did.

**Stop discards, it does not drain.** The queued backlog is thrown away rather
than sent, and transfers already in flight are cancelled (removed from curl and
completed as an `INTERNAL_ERROR` "Request cancelled"), so the target stops
receiving traffic immediately and the stop's latency does not belong to the
upstream. A cancelled request was submitted, so it is counted: it lands in the
run's errors, which is what keeps `requests_sent` and the recorded total equal.

A run that ends **naturally** still lets its in-flight requests finish, but only
up to its own `timeout` plus a 2s grace; anything still outstanding then is
cancelled the same way. Without that bound an upstream that never answers would
hold the run in `running` indefinitely.

**Response** (active run):
```json
{
  "status": "stopped",
  "runId": "run_1234567890",
  "summary": {
    "totalRequests": 1500,
    "errors": 5,
    "errorRate": 0.33,
    "avgLatencyMs": 38.9
  }
}
```

`avgLatencyMs` is the same average the final report and the live ticks show:
the latency sum over the requests that contributed to it (successes). It is not
divided by `totalRequests`, which would report a lower figure here than
everywhere else for the same run.

A run that is already finished answers `{"status": "<status>", "runId": ...,
"message": "Run already <status>"}`; one that is not in memory answers
`{"status": "stopped", "runId": ..., "message": "Run was not active"}`.

### GET /runs/:runId/report

> Alias: `GET /run/:runId/report` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Get the final report for a completed run. The response is a **nested** object; conditional
sections appear only when relevant (e.g. `rateControl` only for `constant_rps`, `testValidation`
only when a test script ran).

The whole-run aggregates come from the run's stored `summary` (written once when the run reaches
a terminal status - see [db-schema.md](db-schema.md#runs)), combined with the sampled `results`
rows for the timing breakdown and the `results[]` array. A run recorded before that column
existed is reconstructed from its legacy `metrics` rows exactly as before. **The response shape
is the same either way** - only where the numbers are read from changed.

**Response:**
```json
{
  "metadata": {
    "runId": "run_1234567890",
    "runType": "load",
    "status": "completed",
    "startTime": 1234567890,
    "endTime": 1234567950,
    "requestUrl": "https://api.example.com/users",
    "requestMethod": "GET",
    "configuration": {
      "mode": "constant_rps",
      "duration": "60s",
      "concurrency": 100,
      "followRedirects": true,
      "maxRedirects": 10,
      "httpVersion": "auto"
    }
  },
  "summary": {
    "totalRequests": 6000,
    "successfulRequests": 5970,
    "failedRequests": 30,
    "errorRate": 0.5,
    "totalDurationSeconds": 60.0,
    "avgRps": 100.0,
    "testDuration": 60.0,
    "sendRate": 100.0,
    "throughput": 99.5,
    "setupOverhead": 0.12,
    "peakConcurrency": 100,
    "droppedRequests": 0,
    "avgQueueWaitMs": 0.4,
    "bytesSent": 192000,
    "bytesReceived": 7680000,
    "throughputBytesPerSec": 128000
  },
  "latency": {
    "min": 12.3, "max": 1250.5, "avg": 42.1, "median": 38.5,
    "p50": 38.5, "p75": 45.2, "p90": 78.3, "p95": 95.1, "p99": 156.7, "p999": 450.2
  },
  "statusCodes": { "200": 5970, "500": 30 },
  "rateControl": { "targetRps": 100, "actualRps": 99.5, "achievement": 99.5 },
  "errors": {
    "total": 30,
    "withDetails": 30,
    "types": { "timeout": 20, "connection_failed": 10 },
    "byStatusCode": { "500": 30 }
  },
  "timingBreakdown": {
    "avgDnsMs": 5.2, "avgConnectMs": 12.3, "avgTlsMs": 45.1,
    "avgFirstByteMs": 180.2, "avgDownloadMs": 2.7
  },
  "slowRequests": { "count": 12, "thresholdMs": 1000, "percentage": 0.2 },
  "testValidation": { "samplesTested": 500, "testsPassed": 498, "testsFailed": 2, "successRate": 99.6 },
  "results": [ { "...": "sampled request/response outcomes" } ]
}
```

`latency.*` and the enriched `summary` fields (`peakConcurrency`, `droppedRequests`,
`avgQueueWaitMs`, `bytesSent/Received`, `throughputBytesPerSec`) come from the persisted
per-tick `metrics` rows. `latency_ms` in `results` (and therefore these percentiles) is
**perceived** latency.

`metadata.configuration` carries the load-test tuning knobs present in the
snapshot (`mode`, `duration`, `concurrency`, `startConcurrency`,
`rampUpDuration`, `timeout`, `comment`, `followRedirects`, `maxRedirects` -
each omitted when absent) plus `httpVersion`, which is always present with the
same `"auto"`-when-unknown normalization `GET /runs`'s `summary` uses (see
above). `rps` in the raw snapshot is renamed to `targetRps` here.

### DELETE /runs/:runId

> Alias: `DELETE /run/:runId` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Delete a run and all associated metrics/results.

**An active run is stopped first.** Deleting a run that is still executing used
to remove its rows while its worker kept writing new metrics and results against
the same id - orphan rows that no run owns, and a run that partially reappeared
as it finished. So a run that is still active is stopped exactly as
`POST /runs/:runId/stop` stops it, and the rows are removed only once its worker
has completed its final writes. Expect the call to take as long as the stop does
(up to ~5s for a large run).

If the worker has not settled within that window nothing is deleted and the call
returns **409** - a half-deleted run racing a live writer is worse than a delete
that has to be retried. The stop still stands, so a retry a moment later
succeeds. A run whose stored status is `running` but which has no worker (the
daemon restarted under it) has nobody to race and is deleted immediately.

**Response:**
```json
{
  "message": "Run deleted successfully",
  "runId": "run_1234567890"
}
```

**409 Conflict** (still stopping - nothing was deleted):
```json
{
  "error": {
    "code": "conflict",
    "message": "Run is still stopping; it was not deleted. Retry once it reports a terminal status."
  }
}
```

## Scripting

### GET /scripting/completions

Get script engine API completions for UI autocomplete.

**Response:**
```json
{
  "version": "1.0.0",
  "engine": "quickjs",
  "completions": [
    {
      "label": "pm.test",
      "kind": 1,
      "insertText": "pm.test(\"${1:test name}\", function() {\n\t${2:// assertions}\n});",
      "detail": "pm.test(name: string, fn: () => void)",
      "documentation": "Define a test with assertions..."
    }
  ]
}
```

### GET /scripting/types

The same `pm.*` surface as TypeScript declarations, for Monaco's TypeScript
worker. A completion list can only populate a dropdown; the declarations are
what give hover documentation over an existing call, signature help while
typing arguments, and go-to-definition within the surface.

The declarations are **generated from the completion table above**, not
maintained separately - a hand-written `pm.d.ts` in the app would be a second
declaration of a surface the engine owns, and the two would drift the first
time a method was added to one and not the other. The derivation works because
a completion entry already carries its type: a function's `detail` is its
signature, a field's `detail` is its type. See
`engine/src/http/routes/script_types.cpp`.

Output is deterministic - the same table always produces byte-identical text,
so a client may cache on `version`.

**Response:**
```json
{
  "version": "1.0.0",
  "engine": "quickjs",
  "libUri": "ts:vayu/pm.d.ts",
  "typeDefinitions": "interface VayuExpectTo {\n\tequal(expected: any): VayuExpectation;\n…"
}
```

| Field | Description |
|-------|-------------|
| `libUri` | Model URI the app registers the declarations under (`addExtraLib`) |
| `typeDefinitions` | The `.d.ts` source |

Two things the generated file cannot get from the table, both handled in
`script_types.cpp` and guarded by `script_types_test.cpp`:

- **Chain vocabulary.** A getter that *continues* an assertion chain (`.to.not`,
  `.and`) and one that *performs* an assertion (`.to.be.true`) are identical as
  completion entries - both are non-functions whose `detail` restates their own
  name. Only meaning separates them, so the meaning is named in the generator.
- **Unparseable parameter lists.** Two entries document an overload in prose
  TypeScript cannot parse (`upsert({ key, value }) | (name, value)`). Those fall
  back to `(...args: any[])`, keeping the member callable rather than emitting a
  file that does not compile.

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (invalid JSON, missing required fields, invalid OAuth 2.0 config) |
| 401 | OAuth 2.0 provider rejected the token request |
| 404 | Resource not found |
| 409 | OAuth 2.0 interactive authorization required (`/run` pre-flight, `/oauth2/token`) |
| 500 | Internal server error |
| 502 | Upstream network error (OAuth 2.0 token endpoint, `/import/fetch` proxy) |
| 503 | Engine is shutting down (`POST /runs` only - see below) |

## Notes

- All timestamps are Unix milliseconds (since epoch)
- Variable substitution uses `{{variableName}}` syntax
- Environment variables are resolved in order: environment → collection → global
- Load test metrics are collected every 100ms
- SSE connections timeout after 30 seconds of inactivity
