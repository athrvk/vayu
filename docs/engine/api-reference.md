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
`{"mode":"none"}` for a request `body`, `true` for `followRedirects`, `10` for
`maxRedirects`, and `false` for `isActive`.

`order` is the one default that is computed rather than constant: it means
"append after the current siblings", on both resources and on both verbs - see
[Ordering](#ordering) below.

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

### Ordering

Collections and requests both carry an `order` column that fixes their position
among their siblings - a collection among the children of its `parentId`, a
request among the requests of its `collectionId`.

**Reading.** `GET /collections` and `GET /requests` sort by `order` ascending,
then `createdAt` ascending, then `id` ascending. All three keys are load-bearing:
`order` alone is not a total order (every request created before explicit orders
existed sits at `0`), and rows are stored with `INSERT OR REPLACE` on a TEXT
primary key, which hands the row a *new* rowid on every edit - so without an
explicit tiebreak, renaming a request silently moved it among its ties. Clients
must apply the same rule if they sort locally; the app's `compareTreeOrder` is
pinned to this one by
`engine/tests/fixtures/tree-order-conformance.json`, read by both test suites.

A collection's sub-collections and its requests are **two separate blocks**, so
`order` never interleaves them - a request and a subfolder in one folder can hold
the same value. Where the two blocks sit relative to each other is the tree's
rule rather than the column's: subfolders first, which is also the order a
recursive [collection run](#the-scenario-block-collection-runs) executes in,
pinned across both consumers by
`engine/tests/fixtures/recursive-run-order-conformance.json`.

**Writing.** `order` defaults to "append after the current siblings" - one past
the highest `order` any sibling holds:

| Write | `order` |
|---|---|
| Create, `order` absent or `null` | appended |
| Create, `order` stated | as given |
| Update, `order` stated | as given |
| Update, `order` absent, no move | unchanged |
| Update, `order` absent or `null`, **and** the row changes parent (a collection's `parentId`, a request's `collectionId`) | appended in the destination |
| Update, `order` `null`, no move | appended among its current siblings |

A move that states no order therefore lands at the end of the destination rather
than at whatever slot its position in the *old* list happened to name. Ordering
*within* a list is always the caller's to state.

**Bulk import** is the one exception to the append scan: `POST /import/apply`
writes rows that cannot see each other yet, so an omitted `order` gives the
payload's items consecutive slots starting from the append point - see
[POST /import/apply](#post-importapply).

**Any writer producing several sibling rows at once owes them distinct
`order`s** - the import applier is the instance of a general rule, not a special
case. The `createdAt` leg is a millisecond stamp, so rows written inside one
tick tie on it and fall through to `id`, which compares random UUIDs: stable
across reads of the same data, but arbitrary with respect to the order the
caller meant. Single-row creates need nothing extra, because the append scan
already sees every stored sibling and hands out a fresh slot. The rule is on the
writer rather than on a finer timestamp: a microsecond stamp would still tie
under a fast enough writer, and it would make row identity depend on clock
resolution across the three platforms Vayu builds on.

**Repositioning several rows at once** is [`POST /reorder`](#post-reorder), not a
run of `PUT`s. Each `PUT` is its own write under its own lock, so a reorder
expressed as N sibling `PUT`s is last-write-wins between concurrent clients, can
be interrupted halfway (leaving two rows at one `order` and a gap where the
moved one was), and its collection cycle guard is read-then-write across two lock
scopes. The batch endpoint validates and writes under one lock scope, which
closes all three. The per-row `PUT`s remain correct for a single row - a rename,
a move that appends - and still carry those caveats when used in a loop.

### Accepted field shapes

A field that is present and not `null` must have the shape below, on both verbs.
Anything else is a `400` naming the field, e.g.
message `Invalid 'auth': must be a JSON object`.

| Field | Shape |
|---|---|
| `variables` (collection / environment / globals) | object |
| `auth` (collection / request) | object |
| `body` (request) | object - see [The request `body` union](#the-request-body-union) |
| `params` / `headers` (request) | array of `{key: string, value: string, enabled: bool}` |

Object-shaped fields are stored as JSON blobs, and every reader of one degrades
quietly when it is not an object - `variables` reads back empty, a request `body`
is dropped, and `auth` resolves to none, so a request the caller believes carries
credentials goes out bare. The write is therefore rejected rather than stored:
`{"variables": 42}` and `{"auth": "bearer"}` are `400`s, and the previously
stored value is left untouched.

### The request `body` union

`body` is a discriminated union on `mode`, and the shape of what it carries
depends on which mode it is. The same union is read on the execution endpoints
(`POST /compose`, `POST /execute`, `POST /runs`) and stored on a request row,
so a body that round-trips through storage sends the same bytes.

| `mode` | Carries | On the wire |
|---|---|---|
| `none` | nothing | no body |
| `json` / `text` | `content` (string) | `content`, verbatim |
| `graphql` | `content` (string) | the GraphQL-over-HTTP envelope (see below) |
| `jsonrpc` | `content` (string) | the JSON-RPC 2.0 call envelope (see below) |
| `xml` | `content` (string) | `content`, verbatim |
| `x-www-form-urlencoded` | `fields` | percent-encoded `key=value&…` |
| `form-data` | `fields` | `multipart/form-data`, boundary engine-generated |

`fields` is an array of `{key: string, value: string, enabled?: bool}` - the
same row shape `params` and `headers` use. `key` is required and must be a
string; `value` defaults to `""` and a non-boolean `enabled` reads as enabled.
A form mode carrying no `fields` array is a `400`, as is a `fields` on a mode
whose content is a string. Rows with `enabled: false` are stored and returned
but never sent, so switching one back on needs no re-compose; `{{variables}}`
resolve inside `key`, `value`, and a file part's `src` / `fileName` /
`contentType` during composition.

Four Content-Type rules follow from the encoding:

- `x-www-form-urlencoded` sets `Content-Type: application/x-www-form-urlencoded`
  **only when the request declares no Content-Type of its own** - an explicit
  header wins.
- `graphql` and `jsonrpc` set `Content-Type: application/json` under the same
  rule - a Content-Type the caller wrote wins.
- `xml` sets `Content-Type: application/xml`, again only when the caller
  declared none. It has no envelope and nothing is done to `content`; the header
  is the whole of what the mode adds over `text`, which is why an endpoint
  expecting `application/soap+xml` keeps the header it was given.
- `form-data` **always** sets its own Content-Type, and a caller-supplied one is
  dropped. The header has to carry the boundary of the body that was actually
  encoded, which no caller can name in advance.

#### The `graphql` envelope

A GraphQL server reads its query out of a JSON object, so a `graphql` body is
enveloped on its way to the wire rather than sent as typed. `content` may be
either shape and the engine normalizes both:

| `content` | Sent as |
|---|---|
| a JSON object with a string `query` | itself, **byte for byte** |
| anything else (a bare document, JSON that is not an envelope) | `{"query": <content>}` |

The pass-through is byte-exact deliberately: the envelope also carries
`operationName`, `variables` and whatever else a server has agreed with its
clients, and re-serializing it would reorder keys the caller never edited. The
app's request builder writes the envelope itself, so its requests take the
first row; MCP and raw callers can hand over the document alone and take the
second.

One case is neither: `content` that *looks* like a JSON object (`{` then a
quoted key) but does not parse - an envelope whose `{{token}}` went unresolved,
or a mistyped one - is passed through unchanged rather than wrapped. Wrapping a
body the engine could not read would turn a broken envelope into a valid
request carrying the wrong query. A bare GraphQL document cannot take that
shape, so nothing legitimate falls into it.

#### The `jsonrpc` envelope

A JSON-RPC 2.0 server refuses a frame that does not declare its version, so a
`jsonrpc` body is completed on its way to the wire in the same place, and by the
same rule, as the `graphql` one. `content` may be either shape:

| `content` | Sent as |
|---|---|
| a JSON object with a **string** `jsonrpc` member | itself, **byte for byte** |
| a JSON object without one | itself plus `"jsonrpc":"2.0"`, and `"id":1` if it declares no `id` |
| a JSON array (a batch call) | itself, verbatim |
| anything else (a non-object, or text that does not parse) | itself, verbatim |

The added `id` is the constant `1`, never a random or time-derived value: a
load run sends the same call thousands of times and a replay has to send the
bytes it replays, so a per-send id would make two runs of the same request
incomparable. A caller who needs their own ids writes the full frame - which is
passed through - and so does a caller sending a **notification**, the frame with
no `id` that a server must not answer. Members the caller wrote keep the order
they wrote them in, and the two the engine may add go on the end.

The member's *type* is what is checked, not its presence: `{"jsonrpc": 2.0}` is
the JSON number and the spec asks for the string, so such a frame is completed
(the version stamped over) rather than sent as the invalid request it is.

A batch array needs nothing done to it - every element carries its own envelope
- and passes through for the same reason any non-object does: there is no single
call object to complete.

The unresolved-`{{token}}` caveat is the `graphql` one, and it matters more here
because a JSON-RPC `params` is where a variable usually sits. Composition
resolves the body first (`POST /compose`), and the envelope rule then runs on
the *resolved* text; a body still holding a token at wire time does not parse,
so it is passed through as typed rather than completed into a well-formed
request carrying an unresolved template.

#### File parts (`form-data` only)

A `form-data` row with `"type": "file"` uploads a file from the machine running
the engine. It carries a path rather than bytes:

```json
{
  "mode": "form-data",
  "fields": [
    { "key": "caption", "value": "my avatar", "enabled": true },
    {
      "key": "avatar",
      "type": "file",
      "src": "/home/ada/portrait.png",
      "fileName": "profile.png",
      "contentType": "image/png",
      "enabled": true
    }
  ]
}
```

| Member | Meaning |
|---|---|
| `type` | `"text"` (default) or `"file"`. Any other value is a `400`. |
| `src` | Path the engine opens at transfer time. Required for a file part. |
| `fileName` | Name the part declares. Defaults to the basename of `src`. |
| `contentType` | Per-part Content-Type. Defaults to libcurl's guess. |

Rules, all of them refusals rather than silent omissions:

- A file part in an `x-www-form-urlencoded` body is a `400` - that media type's
  wire form is a string of pairs and has no file form.
- A `src` on a part that is not `"type": "file"` is a `400`: it names a file
  nothing would send.
- An **enabled** file part whose `src` is empty, or whose file this process
  cannot read, fails the request before it is sent - `statusCode: 0`,
  `errorCode: INTERNAL_ERROR`, and a message naming the field and the path.
  Identical on `POST /execute` and `POST /runs`. A **disabled** file part is
  neither sent nor opened.
- In a load run the file is read from disk on **every iteration** (libcurl
  streams it during the transfer), and the readability check above costs one
  open per request. A body with no file part pays neither.

MCP has no file-part surface: `run_request` / `create_request` /
`update_request` describe a body as a string, and a path on the user's machine
is not something an agent can choose for them - see
[MCP](mcp.md). The renderer authors file parts in the form-data editor, and the
Postman and Insomnia importers map them to file rows.

The older mode spellings `form` (for `x-www-form-urlencoded`) and `formdata`
(for `form-data`) are still accepted on input; responses always use the long
names.

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
      "description": "Number of background worker threads. Higher values improve throughput on multi-core systems but increase RAM usage. Default equals CPU core count.",
      "category": "general_engine",
      "default": "8",
      "min": "1",
      "max": "128",
      "requiresRestart": true,
      "advanced": false,
      "keywords": ["cores", "parallelism"],
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
      "requiresRestart": false,
      "advanced": false,
      "keywords": ["h2", "alpn"],
      "updatedAt": 1234567890
    },
    {
      "key": "dbCacheSize",
      "value": "67108864",
      "type": "integer",
      "label": "Database Cache Size",
      "description": "Memory SQLite keeps per connection for recently used database pages...",
      "category": "database_performance",
      "default": "67108864",
      "min": "1048576",
      "max": "1073741824",
      "unit": "bytes",
      "requiresRestart": true,
      "advanced": false,
      "keywords": ["ram"],
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

`requiresRestart` and `advanced` are booleans, always present:

- **`requiresRestart`** - the running engine keeps the old value until it is
  restarted; anything else takes effect on the next run, inbox or request that
  reads it. It is the only statement of that fact: labels and descriptions no
  longer spell it out, and the app renders one chip from this field (a pending
  signal in the Dock too, once such a setting has been saved). Consumers must
  read the field rather than parse the label - the old `(Requires Restart)`
  suffix drifted out of step with the mechanism and misinformed the settings
  screen and the MCP `update_config` result at the same time.
- **`advanced`** - an internal with no everyday user story (`dbBusyTimeout`, the
  three `oauth2Refresh*` watchdog knobs, `inboxLivePollIntervalMs`,
  `sseIdleTimeoutMs`). Still
  live and still settable; the app renders these collapsed under an "Advanced"
  section at the bottom of their category.

`keywords` is an array of strings, **always present** and empty for the entries
that declare none - a client never has to tell "declares none" from "this
engine does not send the field". They are extra terms the app's settings search
matches on: what a user types that this entry's key, label and description
never say ("ram" for `dbCacheSize`, "deadline" for `defaultTimeout`, "fsync"
for `dbSynchronous`). They are match terms only and are never displayed, and a
seeded keyword never repeats a word the entry already carries - search reaches
the other three fields first and ranks them higher, so a duplicate would only
push the entry above better matches. A test over the seeded catalogue enforces
both halves of that.

`unit` says what a numeric entry's value **measures** - `ms`, `sec`, `days` or
`bytes` today - and is **omitted** when the entry measures nothing, the same
shape as `min` / `max` / `options` above rather than a null. Absent means the
number is a count (worker threads, retained runs, stored steps); a suffix
reading "items" would be noise, so counts declare none. Non-numeric entries
never declare one.

The app renders it as the suffix inside the input, which is where a unit is
stated **once** - so a seeded description never spells the same unit out as an
"in milliseconds" clause, and a label never carries a `(ms)` suffix; a test
over the catalogue enforces both. `bytes` additionally selects human-readable
formatting for the value, the range hint and the default line (`104857600`
reads as `100.0 MB`), which the app used to select from a hardcoded list of
three keys - so a byte-valued entry added engine-side was formatted as a raw
number until someone edited a TypeScript array. A client that meets a unit it
does not know should show it verbatim rather than drop it.

Two entries are seeded as `enum` today. `defaultHttpVersion` is the protocol a
**newly created** request starts with (see [POST /requests](#post-requests)).
It is a write-time seed only - changing it never alters a request that already
exists, and it is never consulted at execution time. `dbSynchronous` is
SQLite's durability level, whose three values (`"0"` Off, `"1"` Normal, `"2"`
Full) are an enumeration rather than a range; it is stored as an `enum` so the
panel draws a picker instead of an integer box the description has to explain.

The Settings panel renders entries dynamically, so new keys appear without app
changes. These `observability` keys govern how much a run keeps - most of them
on disk, one in memory:

| Key                 | Default   | Range        | Effect |
|---------------------|-----------|--------------|--------|
| `maxTraceBodyBytes` | `5242880` | 1024–104857600 | Largest request/response body stored in a design run's `trace_data`. Bigger bodies are truncated with `bodyTruncated`/`bodyBytes` (see `GET /runs/:id`). |
| `maxResponseBodyBytes` | `33554432` | 1024–1073741824 | Largest response body a **load-test** transfer reads into memory. A bigger response fails that request (see `POST /runs`). Not a storage cap and unrelated to `maxTraceBodyBytes`, which truncates what a *completed* design request writes to the database. |
| `maxSampleBodyBytes` | `32768`  | 0–104857600  | Largest response body kept for a single captured **load-run** sample. Bigger bodies are stored truncated and marked. Deliberately far below `maxTraceBodyBytes`: a design run stores one exchange the user asked for, a load run stores tens nobody asked for individually. `0` keeps headers and metadata and no body. |
| `maxSampleBytes`    | `2097152` | 0–1073741824 | Total captured body bytes one load run may store. Once spent, samples keep their headers and metadata and only their bodies are dropped; the report counts them as `sampling.sampleBodiesDropped`. |
| `phaseHistograms`   | `true`    | boolean      | Record DNS/connect/TLS/first-byte/download times for **every** load-test completion into five HdrHistograms, so the report can carry `timingBreakdown.phases` percentiles instead of averages over the retained trace sample. Costs five atomic histogram writes per completion; see [benchmarks](benchmarks.md). |
| `maxRunsRetained`   | `200`     | 0–100000     | Keep at most this many most-recent runs; older runs (and their metrics/results, **including captured response bodies**) are pruned at startup and after each run finishes. `0` = unlimited. Captured data is stored verbatim, so this doubles as its expiry. |
| `runRetentionDays`  | `30`      | 0–3650       | Delete runs older than this many days. `0` = unlimited. |
| `monitorIntervalMs` | `1000`    | 250–60000    | Scrape cadence for a [`monitor` block](#the-monitor-block-server-vitals) that names no `intervalMs` of its own. Read per run, so a change applies to the next run started. The *bounds* on a block's own `intervalMs` are fixed at 250–60000 either way - they exist to stop a cadence that measures the scraper rather than the target. |
| `monitorMaxSeries`  | `8`       | 1–64         | How many metric names one run may chart from its monitored endpoint. A longer `series` list is a `400`. Raising it past 4 repeats chart colours (the categorical palette has four line-legible hues). |
| `monitorScrapeTimeoutMs` | `0`  | 0–60000      | How long one scrape may take before it counts as a gap. `0` derives it from the cadence in force for that run - three quarters of the interval. Set it explicitly for an exposition that is slow to render: one taking longer than three quarters of the interval fails *every* scrape otherwise, and the only other way out is a slower cadence, which also thins the data. A value longer than the interval a run scrapes at is shortened to it (logged once per run), because a scrape that outlives its own cadence puts the loop behind itself. |

In-progress (`running`/`pending`) runs are never pruned, and neither are runs
pinned as baselines (see
[PUT /runs/:runId/baseline](#put-runsrunidbaseline)); neither kind counts
toward `maxRunsRetained`.

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
{ "error": { "code": "invalid_config", "message": "'workers' must be at most 128 (got 9999)" } }
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
  "order": 0,               // Optional, appended after siblings if omitted - see Ordering
  "variables": {},          // Optional, collection-scoped variables
  "dataSchema": {},         // Optional, the declared data contract - see below
  "openapi": {}             // Optional, the bound spec document - see below
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
  "order": 3,               // Optional; a move with no order appends - see Ordering
  "variables": null,        // Optional, null resets to {}
  "dataSchema": null,       // Optional, null clears the declared contract
  "openapi": null           // Optional, null unbinds the spec document
}
```

A `parentId` that changes the collection's parent and states no `order` appends
the collection among its new siblings, rather than carrying a position from the
list it just left. See [Ordering](#ordering).

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

**`dataSchema` (both verbs, and `POST /import/apply`):** the data contract the
collection declares - which columns its data files carry, so `{{data.column}}`
and `pm.iterationData` can be checked before a run (issue #599).

```json
{"columns":["id","email"],"declaredAt":1700000000000,"fileName":"users.csv"}
```

`{}` means the collection declares no contract, and is what an absent field on
create and an explicit `null` on update both resolve to. A present value must be
an object (`400` otherwise, like `variables` and `auth`), and its contents are
validated: `columns` an array of unique, non-empty strings - at most 1024 of
them, each at most 256 characters - `declaredAt` a number, `fileName` a string.
Each violation is a `400` naming the field (`Invalid 'dataSchema.columns': ...`)
that writes nothing.

The schema is stored; the file's **rows are not**, anywhere, and neither is its
path - it is machine-local and stays app-side. See
[Data-driven runs](../app/data-driven-runs.md).

**`openapi` (both verbs, and `POST /import/apply`):** the OpenAPI document this
collection is bound to (issue #637).

```json
{"specId":"spec_3f2b1c9a-...","specHash":"<hex sha256>","syncedAt":1700000000000}
```

`{}` means bound to nothing, and is what an absent field on create and an
explicit `null` on update both resolve to - so **unbinding is
`{"openapi": null}`** rather than a verb of its own. A present value must be an
object (`400` otherwise, like `variables` and `dataSchema`). A *non-empty* one is
a binding and is validated further: `specId` must be a non-empty string that
resolves to a stored [spec document](#specs) (`400` naming the id otherwise),
`specHash` a string, `syncedAt` a number.

`specHash` records which *version* of the document the collection was last synced
to; a scenario run of a bound collection stamps both values into its snapshot and
report (see [GET /runs/:runId/report](#get-runsrunidreport)).

Deleting the document is refused while a collection binds it - the binding is
never cascaded away, see [DELETE /specs/:id](#delete-specsid).

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

List requests in a collection. Results are ordered by `order`, then `createdAt`,
then `id` - the same contract `GET /collections` has for collections. See
[Ordering](#ordering) for why the tiebreak is part of the contract.

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
    "stream": false,
    "updatedAt": 1234567890,
    "createdAt": 1234567890
  }
]
```

`followRedirects` / `maxRedirects` / `httpVersion` / `stream` are the request's
stored execution options. They are always present in the response: a request
saved before these columns existed reads back as the engine defaults
(`true` / `10` / `"auto"` / `false`), which is the behaviour it already had.
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
  "stream": false,
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
  "bodyType": "none",                // Optional, mirrors body.mode - see The request body union
  "auth": {},                        // Optional, authentication config
  "preRequestScript": "",            // Optional, JavaScript pre-request script
  "postRequestScript": "",           // Optional, JavaScript test script
  "order": 0,                        // Optional, appended after the collection's requests if
                                      // omitted - see Ordering
  "followRedirects": true,           // Optional, follow 3xx responses. Default true
  "maxRedirects": 10,                // Optional, hops while following, clamped to 0..100. Default 10
  "httpVersion": "auto",             // Optional: "auto" | "http1.1" | "http2". Absent/null seeds
                                      // from the "defaultHttpVersion" config entry
  "stream": false,                   // Optional, consume the response as an event stream.
                                      // Default false - see below
  "specOperation": null              // Optional, which spec operation this request is - see below
}
```

**`params` is builder display state, not the query the engine sends.** The
engine stores it and hands it back verbatim; nothing in the request-composition
path ever reads it. `url` is the wire truth, so a query parameter that must
reach the wire belongs **in `url`** - the app's Params table keeps the two in
step by rewriting `url` on every edit, and stores disabled rows in `params` only.
A raw API, MCP or import caller that puts the query only in `params` stores a
request that sends none of it (issue #590).

**`stream` is the saved half of [`POST /execute`'s `stream`](#post-execute)**
(issue #574). It records that *this endpoint* is a `text/event-stream`, which is
a property of the endpoint rather than of one send, so the app's Event stream
toggle persists here and a bulk import carries it. The engine never acts on the
stored value by itself: `POST /execute` reads the flag off the payload it is
given, and the by-id compose path deliberately does not add it, so an existing
caller that composes by id keeps getting a buffered send.

**`specOperation` names which operation of the collection's
[bound spec](#post-collections) this request is** (issue #637):

```json
{"operationId": "listPets", "method": "GET", "path": "/pets/{petId}"}
```

`method` and `path` are required inside the object and `operationId` is optional,
because an OpenAPI operation may declare none. `path` is the **templated** path
from the document, never a concrete URL - it is the identity a re-fetched spec is
diffed against - so a `path` that does not start with `/` is a `400`, as is a
missing or empty `method` / `path`, a non-object value, or a non-string
`operationId`. `null` (or absent on create) means the request declares no
operation, and both request serializers emit `specOperation: null` for it - the
key is always present, so a client never has to tell "no operation" from "not
serialized". Two requests may name the same operation.

**Response:** The created request object, carrying the engine-generated `id`.

**Errors:** `400` if the body carries an `id`
([the engine owns it](#the-engine-owns-every-id)), if a
required field is missing or `null`, if `collectionId` names a collection that
does not exist (message `Collection '<id>' does not exist`), on an unrecognized
`method`, on a
`params` / `headers` entry that is not `{key: string, value: string, enabled: bool}`,
or on an `httpVersion` that is not `"auto"` / `"http1.1"` / `"http2"` (the body
names the field and lists the valid values).

Unlike a collection's `parentId`, a request's `collectionId` **must** resolve to
a stored collection. A request under no collection is unreachable: no
per-collection `GET` lists it, and no cascade delete ever reaps it. Bulk import
is unaffected - `POST /import/apply` resolves owners from the payload's own temp
ids before any row is written.

### PUT /requests/:id

Update an existing request. **Update only** - a `404` when the id does not
exist, never a silent create. Merge-patch body, same rule as collections.

**Request:** any subset of the `POST /requests` fields, minus `id` (it is the
path). Sending `collectionId` moves the request to another collection; the id
must resolve to a stored collection (`400` otherwise), and a move that states no
`order` appends in the destination - see [Ordering](#ordering). An update that
states no `collectionId` is not checked against the request's stored one, so a
row stranded before this validation existed stays editable, and repairable by a
`PUT` that moves it somewhere real. Omitting `followRedirects` / `maxRedirects` /
`stream` / `specOperation` leaves the stored values untouched; sending `null`
resets them to `true` / `10` / `false` / "no operation". A non-boolean
`followRedirects` or `stream`, or a non-integer `maxRedirects`, is ignored rather
than rejected. `maxRedirects` is clamped to `0..100` on the way in.

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
`collectionId` / `name` / `method` / `url`, a `collectionId` naming a collection
that does not exist, an unrecognized `method`, a
malformed `params` / `headers` entry, a malformed `specOperation`, or an
`httpVersion` that is not `"auto"` / `"http1.1"` / `"http2"`.

### DELETE /requests/:id

Delete a request. Cascades to the request's
[saved examples](#request-examples) - they are owned by it, and every read of
them is by request id, so a row left behind would be unreachable.

**Response:**
```json
{
  "message": "Request deleted successfully",
  "id": "req_1234567890"
}
```

## Request examples

Saved example responses for a request: what an importer found next to it
(Postman's `item.response[]`, an OpenAPI operation's `responses`), and the
responses a mock server will serve. Nested under the request because an example
is owned by exactly one - the owner is checked before the example on every path,
so an example reached through the wrong request is a `404`, not a cross-request
write.

**Ordering is part of the contract**, not a display preference: the list is
returned by `order`, then `createdAt`, then `id`, and a mock server answers with
the first example of the matched request. A create that states no `order`
appends after the request's current examples; a bulk import numbers them by
payload position, because every row it writes shares one `createdAt` and would
otherwise come back shuffled by the id tiebreak.

**Caps.** A `body` over **1 MiB** is a `400` rather than a truncation - an
example served as if it were whole when it is not is worse than a refused write
- and a request holds at most **100** examples.

**`origin` says who wrote the row** (issue #588): `"import"` for everything an
importer or a spec sync produced, `"user"` for one a person saved from a live
response. It defaults to `"import"`, which is honest for every row written
before the column existed, and an unrecognised value is a `400` rather than a
silent fall back - the OpenAPI spec sync (#627) may replace `"import"` rows
wholesale and must never touch a `"user"` one, so an absorbed typo would cost a
user their saved example.

### GET /requests/:id/examples

**Response:** an array of example objects, oldest first:
```json
[
  {
    "id": "exa_1234567890",
    "requestId": "req_1234567890",
    "name": "200 - A user",
    "status": 200,
    "headers": [{"key": "Content-Type", "value": "application/json", "enabled": true}],
    "body": "{\"id\":1}",
    "contentType": "application/json",
    "order": 0,
    "origin": "import",
    "createdAt": 1730000000000,
    "updatedAt": 1730000000000
  }
]
```

An empty array and a missing request are different answers: `404` (message
`Request not found`) means the request does not exist, `[]` means it has no
examples yet.

### POST /requests/:id/examples

Create one example. **Create only**, and the engine owns the id - see
[Resource writes](#resource-writes-create-vs-update).

**Request:**
```json
{
  "name": "200 - A user",   // Required, no default (null is a 400)
  "status": 200,             // Optional, must be 100-599. Default 200
  "headers": [],             // Optional, array of {key, value, enabled}
  "body": "",                // Optional. Default ""
  "contentType": "",         // Optional. Default ""
  "order": 0,                // Optional, appended after the request's examples if omitted
  "origin": "import"         // Optional, "import" | "user". Default "import"
}
```

`headers` is an array of `KeyValueEntry`, the same shape a request's headers
use - not a JSON object. A stored example is re-served rather than only
displayed, so repeated names (`Set-Cookie`) and the author's ordering both have
to survive.

**Response:** the created example object.

**Errors:** `404` if the request does not exist. `400` if the body carries an
`id`, if `name` is missing or `null`, on a `status` outside `100`-`599` (rejected
rather than clamped - a stored `700` would be re-served as a status line nobody
can send), on a malformed `headers` entry, on an `origin` that is neither
`"import"` nor `"user"`, or on a `body` over the cap. `409` when the request
already holds the maximum number of examples.

### PUT /requests/:id/examples/:exampleId

Update one example. **Update only** - a `404` when the example does not exist,
and the same `404` when it exists under a different request. Merge-patch body:
absent keeps, `null` resets to the field's default (`name` has none, so `null`
is a `400`).

**Response:** the updated example object.

### DELETE /requests/:id/examples/:exampleId

**Response:**
```json
{
  "message": "Example deleted successfully",
  "id": "exa_1234567890"
}
```

## Specs

OpenAPI documents, stored once and bound to collections by
[`collections.openapi`](#post-collections) (issue #637). A spec is not owned by a
collection: several may bind the same document, and unbinding one must leave it
there for the others - so it is a top-level resource with no cascade reaching it,
and the rule that keeps that safe is the delete refusal below.

The document is stored **verbatim** and its `hash` is computed engine-side on
every write, never taken from the caller. A scenario run of a bound collection
stamps `specId` + `specHash` into its snapshot and report, and that stamp only
means anything because both sides of a later comparison were computed by the same
code on the same bytes.

There is deliberately **no `PUT /specs/:id`**: a document that changed is a
different document, and rewriting one in place would invalidate the hash every
run of every bound collection was stamped with. A re-fetch stores a new document
and moves the binding.

### POST /specs

Store one OpenAPI document. **Create only**, and the engine owns the id - see
[Resource writes](#resource-writes-create-vs-update).

**Request:**
```json
{
  "content": "{\"openapi\":\"3.1.0\", ...}",  // Required, non-empty, at most maxSpecDocumentBytes
  "sourceUrl": "https://api.example.com/openapi.json"  // Optional; null when pasted or uploaded
}
```

**Response:**
```json
{
  "id": "spec_3f2b1c9a-...",
  "content": "{\"openapi\":\"3.1.0\", ...}",
  "sourceUrl": "https://api.example.com/openapi.json",
  "fetchedAt": 1730000000000,
  "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

`sourceUrl` is `null` rather than `""` when the document did not come from a URL,
so a client can offer a re-fetch for exactly the documents that have somewhere to
re-fetch from.

**Errors:** `400` if the body carries `id`, `hash` or `fetchedAt` (all
engine-computed), if `content` is missing, `null` or empty, if `sourceUrl` is
present and not a string or `null`, or if the document is larger than the live
`maxSpecDocumentBytes` [config entry](#get-config) - default **10 MiB**, aligned
with the engine's JSON field cap. The size rejection names the byte count, the
cap and the setting, and is checked on `POST /import/apply` too, through the same
helper; the document is never stored truncated.

### GET /specs/:id

**Response:** the whole stored document, `content` included - rendering and
validating it is what every reader wants it for. `404` (message `Spec not found`)
when it does not exist.

### DELETE /specs/:id

Delete a stored document.

**Response:**
```json
{
  "message": "Spec deleted successfully",
  "id": "spec_3f2b1c9a-..."
}
```

**Errors:** `404` when it does not exist. `409` while any collection still binds
it, with a message naming the first binder (and a count of the rest) so the
caller knows what to unbind without a second round trip:

```json
{
  "error": {
    "code": "conflict",
    "message": "Spec 'spec_3f2b...' is bound by collection 'Pets API' (col_9a1f...); unbind it before deleting the document"
  }
}
```

The refusal is deliberate rather than a cascade to unbound: the caller asked to
delete a document, not to edit collections it never mentioned. Unbind with
`PUT /collections/:id` and `{"openapi": null}`, then delete.

## Reorder

### POST /reorder

Reposition collections and requests in one atomic batch - the write path behind a
drag-and-drop reorder or a cross-folder move. One drop is one call, one lock
scope and one transaction: the batch validates, stages and commits under a single
acquisition of the engine's database lock, so nothing partial survives a
rejection and no concurrent write - a create computing its append slot, a
conflicting batch, a cascade delete - can land between what this batch checked
and what it wrote.

**Request:**
```json
{
  "normalize": [
    {"type": "request", "collectionId": "col_1234567890"}
  ],
  "moves": [
    {"type": "request",    "id": "req_1", "order": 0, "collectionId": "col_2"},
    {"type": "collection", "id": "col_3", "order": 1, "parentId": null}
  ]
}
```

Both arrays are optional (absent or `null` means none); an empty batch is a
`200` that writes nothing.

**`moves`** - each entry names one row and the position it takes:

| Field | Rule |
|---|---|
| `type` | `"collection"` or `"request"`; anything else is a `400` |
| `id` | Non-empty string naming a **stored** row of that type |
| `order` | Required, a non-negative integer. Not a float, not negative - this endpoint writes dense positions, and either would be a silently truncated or unreachable slot |
| `parentId` (collection) | Absent keeps the current parent; `null` moves to the root; a string moves under that collection, which must exist |
| `collectionId` (request) | Absent keeps the current owner; a string moves to that collection, which must exist |

A row may appear in `moves` at most once - two positions for one row is a `400`
naming it, not a last-writer-wins accident of iteration order.

**`normalize`** - each entry names a scope whose children are renumbered dense
`0..n-1` in the [pinned display order](#ordering) **before** any move applies. A
collection scope states `parentId` (`null` for the root collections) and a
request scope states `collectionId`; the named collection must exist, and for a
collection scope `parentId` must be *stated* rather than omitted, so a renumber
can never land on a scope the caller did not mean.

Normalization exists for the first drop into a collection whose rows predate
explicit orders: every row sits at `0`, so its displayed position lives only in
the tiebreak and there are no slots to shift into. Materializing that order in
the same batch is what keeps the other siblings from appearing to jump. It is
idempotent - a scope already dense writes nothing at all.

Where a row is named by both lists, the move wins.

**Validation is complete before the first write.** Entry shapes, the existence of
every named row and owner, and the acyclicity of the **post-move** collection
graph are all checked first; a failure is a `400` naming the offending row with
nothing written. The cycle check reading the post-move shape is what makes two
reparents that each look legal alone (`A` under `B` and `B` under `A`) a
deterministic rejection rather than a race - unlike `PUT /collections/:id`, which
validates and writes under different locks.

That rejection is deterministic **because the check and the commit share one lock
scope**: two such batches arriving concurrently are serialized whole, and the
second revalidates against the first's committed graph rather than against the
shape both of them read. The rows are written as updates, never inserts, so a
batch whose row was deleted after it staged fails with a `409` naming the row and
writes nothing at all - it never re-creates the deleted row.

**Response:** the rows as written, in the same serialized shape a list entry
carries - not an acknowledgement. A client that drew the drop optimistically
settles its caches on these, so a normalization the engine performed is visible
without waiting for a refetch.

```json
{
  "collections": [],
  "requests": [
    {"id": "req_1", "collectionId": "col_2", "order": 0, "name": "Get users", "...": "..."}
  ]
}
```

**Errors:** `400` for any malformed entry, a row or owner that does not exist, a
duplicate move, a cycle, or a batch over 10000 entries. `409` if a staged row is
gone by the time the batch commits. In every case nothing at all was written.
Body that is not JSON or not an object is also a `400`.

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

Persist an entire parsed import - collections, their requests, environments, and
the OpenAPI documents they bind - in **one atomic call**. Items reference each other by opaque **temp ids** the
client invents; the engine generates every real id via `generate_id` and returns
the translation in `idMap`.

This is what replaced ~500 sequential `POST /collections` + `POST /requests`
calls for a 500-request import, and with it the only reason those endpoints ever
accepted a client-supplied `id` - which they no longer do (see
[The engine owns every id](#the-engine-owns-every-id)).

**Request:**
```json
{
  "specs": [
    { "tempId": "s1", "content": "{\"openapi\":\"3.1.0\", ...}",
      "sourceUrl": "https://api.example.com/openapi.json" }
  ],
  "collections": [
    { "tempId": "c1", "parentTempId": null, "name": "My API", "order": 0,
      "variables": {}, "auth": {"mode":"none"},
      "openapi": {"specTempId": "s1"},
      "preRequestScript": "", "postRequestScript": "" },
    { "tempId": "c2", "parentTempId": "c1", "name": "Users", "order": 0 }
  ],
  "requests": [
    { "tempId": "r1", "collectionTempId": "c2", "name": "List users",
      "method": "GET", "url": "https://api.example.com/users",
      "params": [], "headers": [], "body": {"mode":"none"}, "bodyType": "none",
      "auth": {"mode":"inherit"}, "order": 0,
      "examples": [
        { "name": "200 - A user", "status": 200, "headers": [], "body": "{}",
          "contentType": "application/json" }
      ] }
  ],
  "environments": [
    { "tempId": "e1", "name": "Prod", "variables": {} }
  ]
}
```

- All four sections are optional; absent or `null` means "none of that kind"
  (the [null-vs-absent rule](#the-null-vs-absent-rule)). An empty payload is a
  `200` with an empty `idMap`.
- Every item needs a non-empty string `tempId`, **unique across all four
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
  siblings are stored yet). For requests it defaults to `0` on this path only:
  `POST /requests` appends by scanning the collection's stored rows, which a bulk
  write cannot do for a collection it is creating in the same call, so a client
  that cares about request order must state it here. The app's importer does -
  and deliberately omits `order` on its **root** collections, so an import into a
  non-empty workspace lands after the roots already there instead of colliding
  with their `0, 1, 2...`.
- A request may carry **`examples`**, an array of
  [saved example responses](#request-examples). They are nested rather than a
  fourth section because nothing references them: they need no `tempId`, get
  engine-generated ids, and so **do not appear in `idMap`**. Each entry takes the
  fields `POST /requests/:id/examples` accepts, through the same field applier,
  and an entry that fails validation is a per-item `400` naming the *request's*
  `tempId`. `origin` is among those fields and an importer leaves it at its
  `"import"` default, which is what these rows are. An entry with no `order` takes its payload position, so the stored
  order is the order the source file listed the responses in.
- A **`specs`** item carries `content` (required, non-empty) and an optional
  `sourceUrl`; its `hash` and `fetchedAt` are engine-computed and a per-item
  `400` if sent, and the size cap is the same live `maxSpecDocumentBytes` that
  [`POST /specs`](#post-specs) enforces, through the same helper. Spec rows are
  written **before** the collections that bind them, in the same transaction.
- A collection binds a spec through **`openapi.specTempId`** (a spec in this
  payload, resolved through the temp-id map exactly as `collectionTempId` is) or
  **`openapi.specId`** (one already stored). Sending both is a per-item `400`,
  and so is either one that resolves to nothing. The resolved value is stored as
  `openapi.specId`; `specTempId` is never persisted.
- Up to **10,000 items** per call (collections + requests + environments + specs
  + nested examples - they are rows this call allocates and writes, so they
  count).

**Response:** `200`
```json
{ "idMap": { "c1": "col_<uuid>", "c2": "col_<uuid>", "r1": "req_<uuid>", "e1": "env_<uuid>", "s1": "spec_<uuid>" } }
```

Every `tempId` sent appears in `idMap`. Nested examples do not - they carry no
`tempId` to map.

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
  present but not an array (same for `requests` / `environments` / `specs`).
- `400` `Invalid collection at index 2: 'tempId' must be a non-empty string`.
- `400` `Invalid collection at index 0: 'id' is not accepted - the engine assigns ids; reference items by 'tempId'`.
- `400` `Duplicate tempId 'c1'`, with `item: "c1"`.
- `400` `Unknown parentTempId 'c9'`, with `item: "c2"`, and the same for
  `collectionTempId` - including a `collectionTempId` that names an environment
  rather than a collection.
- `400` `Unknown openapi.specTempId 's9'`, with `item: "c1"`, and
  `400` `Spec 'spec_...' does not exist` for an `openapi.specId` that resolves to
  no stored document.
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

## Cookies

The engine keeps a cookie jar for design-mode requests (`POST /execute` and the
`pm.sendRequest` calls inside it), so a session set by one request is sent on
the next. **One jar per environment**, plus one for requests sent with no
environment selected; in memory only, for the life of the engine process, and
never written to disk. Load runs neither read nor write it.

### GET /cookies

Every jar that holds anything, one entry per scope.

**Response:**
```json
{
  "scopes": [
    {
      "environmentId": "env_staging",
      "cookies": [
        {
          "name": "session",
          "value": "abc123",
          "domain": ".staging.example.com",
          "path": "/",
          "secure": true,
          "httpOnly": true,
          "expires": 1767225600
        }
      ]
    }
  ]
}
```

`environmentId` is `null` for the no-environment jar - null rather than `""` so
a client cannot mistake it for an id. `expires` is unix seconds, or `0` for a
session cookie (one that lives until the engine exits). A scope with no cookies
left is not reported.

### DELETE /cookies

Clear one jar, or all of them.

**Query parameters:**

| Parameter | Meaning |
|-----------|---------|
| *(none)* | Clear every jar |
| `environmentId=<id>` | Clear that environment's jar |
| `environmentId=` | Clear the no-environment jar |

The three cases are the [null-vs-absent rule](#the-null-vs-absent-rule) in a
query string: an empty value is a real scope - the one no id can name - and not
a mistake.

**Response:**
```json
{
  "cleared": 3
}
```

`cleared` counts the cookies dropped; clearing a scope that holds nothing is a
`200` with `0`, not an error.

## Webhook Inbox

An **inbox** is a second HTTP listener the engine opens on request. It accepts
any method on any path, records what arrived, and answers a canned response -
nothing else. That is what makes testing the *receiving* side of a webhook a
local operation: point the sender at the inbox URL instead of a cloud tunnel,
and the payload never leaves the machine.

**Lifetime is the engine process.** An inbox is not a stored resource: there is
no create/update split ([POST creates, PUT updates](#resource-writes-create-vs-update)
applies to collections, requests and environments), ids are not restorable
across restarts, and `POST /inbox/start` is a verb path for that reason. Stopping
an inbox frees its listener but keeps the record - and therefore its captures -
readable until the engine exits; `DELETE /inbox/:inboxId` is what removes both.

**Binding is a trust decision.** The default is `127.0.0.1`. Any other address
is refused unless the caller also sends `"confirmNonLoopback": true`, and the
inbox reports `loopback: false` from then on so a client can badge it. See
[architecture.md](architecture.md#listeners) for why only the inbox listener may
bind wide and the management API never may.

**Bounds.** Three are settings (`GET`/`POST /config`, category *Observability &
Data*), read once when an inbox starts - so a change applies to the next inbox
started, and a running listener keeps what it was started with:

| Setting | Default | Range | What it bounds |
|---------|---------|-------|----------------|
| `inboxMaxBodyBytes` | 65536 | 256 - 8388608 | Stored body per capture. Past it the body is kept as a prefix with `bodyTruncated: true`; `bodyBytes` is always the size as received |
| `inboxMaxCaptures` | 500 | 1 - 10000 | Captures retained per inbox, oldest evicted first. Also the ceiling on one `limit` of the capture list |
| `inboxLivePollIntervalMs` | 250 | 25 - 5000 | How often a watched inbox checks for new captures - the delay between a webhook landing and its event |

Two are **not** settings, deliberately. A request over **8 MiB** is refused at
the transport with a `413` and recorded nowhere: that bounds what an
unauthenticated remote caller can make the engine buffer, which is not the local
user's preference to spend. The canned response's **`delayMs` is capped at
30000**: it holds a listener thread for its whole duration and a stop waits on
that join, so it bounds how long a stop can be made to take.

### POST /inbox/start

Start a listener. Every field is optional - an empty body starts a loopback
inbox on a free port that answers `200` with no body.

**Request:**
```json
{
  "port": 0,
  "bind": "127.0.0.1",
  "confirmNonLoopback": false,
  "response": {
    "status": 200,
    "body": "",
    "headers": {},
    "delayMs": 0
  }
}
```

| Field | Meaning |
|-------|---------|
| `port` | `0` (default) picks a free port |
| `bind` | Default `127.0.0.1`; anything outside 127.0.0.0/8 and `::1` needs `confirmNonLoopback`. Loopback is decided by parsing the *address*, so a hostname that merely starts `127.` (or `localhost.example.com`) is not loopback and needs the confirmation |
| `response.status` | 100-599 |
| `response.headers` | String values only; a `Content-Type` here is used verbatim |
| `response.delayMs` | 0-30000, applied before every reply |

An out-of-range value is a `400` naming the field rather than a fallback to the
default: a listener quietly answering something other than what it was asked to
is invisible on both sides of the wire. A bind that fails is a `409` with code
`inbox_bind_failed`; a non-loopback bind without confirmation is a `400` with
code `inbox_non_loopback_bind`.

A `port` another engine listener is already running on - an inbox or a mock
issuer - is refused with that same `409`, naming the holder ("`inbox inbox_2f1c`
is already listening there"). The engine checks that itself rather than letting
the bind report it: listeners are bound with `SO_REUSEPORT`, so on Linux a
second bind on the same address and port *succeeds* and the kernel then splits
arriving connections between the two listeners, each capturing an effectively
random half. A port held by a process outside the engine is still reported by
the bind, with the "in use or unavailable" wording; `port: 0` is never refused
this way, since the kernel does not hand out a port it is already using.

**Response:**
```json
{
  "inboxId": "inbox_2f1c...",
  "url": "http://127.0.0.1:41235/",
  "bind": "127.0.0.1",
  "port": 41235,
  "running": true,
  "loopback": true,
  "captureCount": 0,
  "response": { "status": 200, "body": "", "headers": {}, "delayMs": 0 }
}
```

`captureCount` is how many captures the inbox is holding right now - what a
`DELETE /inbox/:inboxId` would destroy with it. Every route that returns an
inbox fills it, so a client can word a confirmation without a second round trip.

### GET /inbox

Every inbox this process has started, running or stopped: `{"data": [ ... ]}`,
each entry the object above.

### PUT /inbox/:inboxId

Update the canned response, live - the next caller receives the new one, with no
restart and no captures lost. Merge-patch: an absent field keeps what the inbox
is serving. The body may be the response object itself or `{"response": {...}}`,
so a client can send back what `start` handed it. `404` for an unknown id.

### POST /inbox/:inboxId/stop

Stop the listener. Returns the inbox with `running: false`. Captures survive;
`404` for an unknown id. A stop is not a delete - `DELETE /inbox/:inboxId` is.

### DELETE /inbox/:inboxId

Stop the listener, drop the record, and delete its captures with it:
`{"inboxId": "...", "capturesDeleted": 12}`. `404` for an unknown id.

**A running inbox is stopped rather than refused** - one call, because the
caller's intent is that the inbox be gone. That is safe rather than racy
because the teardown joins every in-flight handler before returning, so nothing
can still be capturing when the rows are cleared. The order is stop, then
clear, then drop the record: a database failure therefore leaves the inbox in
place - stopped, and deletable again - rather than orphaning captures no inbox
could list.

The captures dying *with* the record is the point, and is why `stop` keeps them:
they go by explicit user intent here, instead of the record living to the end of
the process to protect them. **There is deliberately no restart route**: delete
and start a new inbox. A restart would have to decide what happens to the
existing captures, and this way the user decides.

### GET /inbox/:inboxId/requests

The captures, **newest first**, in the standard `{data, pagination}` envelope.

**Query parameters:** `limit` (default 50, capped at 500), `offset` (default 0).

```json
{
  "data": [
    {
      "id": 12,
      "inboxId": "inbox_2f1c...",
      "receivedAt": 1767225600000,
      "method": "POST",
      "path": "/hooks/order",
      "query": "attempt=2",
      "headers": { "Content-Type": "application/json" },
      "body": "{\"id\":7}",
      "bodyBytes": 8,
      "bodyTruncated": false,
      "remoteAddr": "127.0.0.1"
    }
  ],
  "pagination": { "total": 1, "limit": 50, "offset": 0, "hasMore": false, "returned": 1 }
}
```

`id` is the capture's storage id and also its SSE event id (see below).
`headers` joins a repeated name with `, `. `query` is the raw query string
without the `?`.

### DELETE /inbox/:inboxId/requests

Clear the captures, keeping the listener: `{"inboxId": "...", "cleared": 12}`.

### GET /inbox/:inboxId/live

Server-Sent Events, one event per capture, each carrying the same object as the
list above and an SSE `id:` equal to the capture's `id`. A reconnect that sends
`Last-Event-ID` resumes after that capture, so nothing is missed across a drop.
The stream ends when the inbox is stopped.

**`?lastEventId=<id>` is the same resume point as a query parameter**, for a
client that reconnects by hand: browser `EventSource` sets `Last-Event-ID` only
on its *own* retry and exposes no way to set a header on a fresh connection. The
header wins when both are given, being the more recent of the two. A value that
is not a non-negative capture id is refused with `400` and code
`invalid_last_event_id` rather than resumed from the start, which would replay
every retained capture as though it had just arrived.

**One stream per inbox.** A second concurrent watcher is refused with `409` and
code `inbox_live_in_use`: each SSE handler occupies a cpp-httplib pool thread
for its whole life, so N watchers on one inbox is N parked threads.

**A claim whose holder stopped writing is taken over, not refused.** A stream
learns its socket died only when its next write fails, up to one
`inboxLivePollIntervalMs` later, so a client reconnecting inside that window used
to meet a `409` it could not recover from. A holder that has not written
successfully for two poll intervals (at least 100ms) is not writing, and its slot
goes to the newcomer; the evicted stream ends on its next write. Every live
stream writes at least a keep-alive each interval, so a genuinely live watcher is
never evicted and a second concurrent one is still refused.

## Mock Server

A **mock server** is a listener that answers a collection's [saved
examples](#request-examples) on the paths its requests describe. It is what
examples are *for*: import a spec, and the responses it documented become a
running upstream you can build a frontend against, or point a Vayu load run at,
without a cloud plan or a second machine.

**Lifetime is the engine process**, exactly as for an inbox and an issuer - a
verb path starts it, ids are not restorable across restarts, and stopping one
**drops its record**. There is no stopped state to read: a mock holds nothing
that outlives its listener, unlike an inbox and its captures.

**Load-testing against a mock is a supported workflow**, and it is the one this
listener exists for as much as frontend development: a mock is a
known-latency, zero-cost upstream on the same machine, so a run against it
measures the *generator* rather than someone else's service, and costs nobody a
bill. Start the mock, then point a run at one of its paths:

```bash
curl -s localhost:9876/mock/start -d '{"collectionId":"col_abc123","latencyMs":5}'
# -> {"mockId":"mock_5f2a","url":"http://127.0.0.1:43117", ...}

curl -s localhost:9876/runs -d '{
  "mode":"constant_rps","targetRps":500,"duration":"30s",
  "url":"http://127.0.0.1:43117/pets","method":"GET"
}'
```

`latencyMs` is what makes the baseline realistic rather than degenerate, and
`errorRatePct` is how a run's error handling and [threshold
verdict](#post-runs) get exercised without breaking a real service.

**Loopback only.** There is no `bind` field. Unlike an inbox - which serves
capture-and-echo and nothing else, so a LAN-visible one is defensible - a mock
re-serves stored response bodies verbatim, and a recorded response can carry
whatever the real one did. See [architecture.md](architecture.md#listeners).

**The route table is a start-time snapshot.** It is built once, from the
collection and every collection under it (an OpenAPI import files its requests
in a folder per tag, so the subtree is the only useful unit), and a running mock
does not reload edits: stop it and start it again. An example saved from the
app's response viewer (issue #588) is an edit like any other - it is appended
after the request's existing examples, so a restart keeps answering with the
same first one, and the new row is only reachable once the mock is restarted.

**How a request is matched.**

- The stored URL is reduced to a path: scheme and host - or the `{{baseUrl}}`
  variable standing in for them - the query and the fragment are all dropped.
- All three template spellings are one wildcard segment: `{{petId}}` (Vayu and
  Postman), `{petId}` (OpenAPI) and `:petId` (Postman's other form). A wildcard
  matches exactly one non-empty segment. The normalization is pinned to the
  importers' own by `engine/tests/fixtures/path-template-conformance.json`,
  which both suites read - the app writes these URLs and the mock reads them
  back.
- **Specificity wins, not registration order**: `/pets/mine` answers
  `GET /pets/mine` even when `/pets/{{petId}}` was stored first.
- A trailing slash and a repeated `/` are the same route.

**What a miss says.** The message is most of the debugging value, so the three
outcomes are distinct rather than one blanket 404:

| Case | Status | `code` | Message names |
|------|--------|--------|---------------|
| No request has that path | 404 | `mock_no_route` | The method and path, and how many routes are served |
| The path matches, the method does not | 404 | `mock_method_mismatch` | The matching path template and the methods it *is* served for |
| A route matched but its request has no saved example | 501 | `mock_no_example` | The request's name, and that an example must be saved or imported |

**Bounds** (rails, not settings): at most **8** mock servers at once (a listener
thread each), at most **2000** routes in one table, and `latencyMs` capped at
**30000** - it holds a listener thread for its whole duration and a stop waits
on that join.

### POST /mock/start

**Request:**
```json
{
  "collectionId": "col_abc123",
  "port": 0,
  "latencyMs": 0,
  "errorRatePct": 0
}
```

`collectionId` is required. `port` 0 (the default) binds a free one.
`latencyMs` (0 - 30000) delays every answer; `errorRatePct` (0 - 100) replaces
that share of answers with a synthesized `500` carrying `mock_injected_error`.
Every out-of-range value is a `400` rather than a clamp.

**Response:**
```json
{
  "mockId": "mock_5f2a",
  "collectionId": "col_abc123",
  "collectionName": "Pet Store",
  "url": "http://127.0.0.1:43117",
  "port": 43117,
  "latencyMs": 0,
  "errorRatePct": 0,
  "routeCount": 12,
  "routesWithoutExample": 3,
  "createdAt": 1735689600000
}
```

`url` has **no trailing slash** - it is a base to concatenate a path onto.
`routesWithoutExample` is the number that explains an otherwise empty-looking
mock, which is why it is reported rather than left to be discovered one `501` at
a time.

**Errors:** `404` for a collection that does not exist; `400`
`mock_no_requests` when the collection and its subtree hold none (a listener
that 404s everything is never what the caller meant); `400`
`mock_too_many_routes` past the table bound; `409` `mock_limit_reached` at the
server budget; `409` `mock_bind_failed` when the requested port is taken,
naming the holder when this engine is the one holding it.

### GET /mock

`{"data": [...]}` - every running mock, in the shape above.

### GET /mock/:mockId/routes

The table the mock is serving. This is how "the mock 404s that path" gets
diagnosed without sending a request per guess.

```json
{
  "data": [
    {
      "requestId": "req_1",
      "requestName": "Get pet",
      "method": "GET",
      "path": "/pets/{{petId}}",
      "hasExample": true,
      "status": 200
    }
  ]
}
```

`status` is `0` when `hasExample` is false - there is no example whose status it
could be. `404` for an unknown mock.

### POST /mock/:mockId/stop

Stops the listener and drops the record: `{"mockId": "...", "stopped": true}`,
or `404`. In-flight answers - including one inside its configured `latencyMs` -
are joined before this returns.

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

### Local mock issuer

A built-in OAuth 2.0 issuer for developing and testing auth flows **offline** -
no real identity provider, so no 2FA prompts, provider rate limits or
"suspicious login" mail in the dev loop. Each issuer is an independent
`127.0.0.1` listener serving `/token` and `/authorize`; point any OAuth 2.0
config's `accessTokenUrl` at the `tokenUrl` it returns.

It is **not an IdP**. JWKS/RS256, OIDC discovery documents, token introspection,
consent screens and multi-tenant realms are deliberate non-goals.

| Method / Path | Purpose |
|---------------|---------|
| `POST /mock-issuer/start` | Start one → `{issuerId, issuerUrl, tokenUrl, authorizeUrl, signingKey}` |
| `GET /mock-issuer` | List the running issuers |
| `PUT /mock-issuer/:id` | Update `failureMode` / `slowMs` / `expiresInSeconds` live |
| `POST /mock-issuer/:id/stop` | Stop one → `{stopped: true}` (`404` if unknown) |

**Start body** (every field optional):

```json
{
  "port": 0,
  "expiresInSeconds": 3600,
  "claims": { "sub": "alice", "roles": ["admin"] },
  "clients": [{ "clientId": "cid", "clientSecret": "s3cret" }],
  "failureMode": "none",
  "slowMs": 2000,
  "issueRefreshTokens": true
}
```

`port: 0` (the default) binds an ephemeral port; an explicit `port` another
engine listener already holds is a `500` with code `mock_issuer_bind_failed`
naming that listener, for the [same `SO_REUSEPORT`
reason](#webhook-inbox) the inbox refuses one. `clients` empty accepts **any**
client id; with clients configured, an id must be one of them and one carrying a
secret must present it (Basic header or body - both RFC 6749 §2.3.1 placements).
A field present with the wrong type or an out-of-range value is a `400`
(`mock_issuer_invalid_config`) rather than a silent fallback to the default - a
mock issuer running with an expiry other than the one asked for would defeat the
purpose. At most 8 issuers run at once (`429 mock_issuer_limit_reached`).

**The issuer's own endpoints:**

- `POST /token` - `client_credentials`, `password`, `authorization_code` and
  `refresh_token` grants, `application/x-www-form-urlencoded` as RFC 6749 §3.2
  requires. Answers `{access_token, token_type: "Bearer", expires_in,
  refresh_token?, scope?}`. Authorization codes are single-use and expire after
  5 minutes; a refresh grant **rotates** its token (the presented one is spent).
- `GET /authorize` - auto-approves and `302`s straight back to `redirect_uri`
  with `code` and `state`, so the interactive flow completes with zero human
  steps. PKCE is verified when a `code_challenge` is present;
  `code_challenge_method` must then be `S256` (`plain` is refused rather than
  quietly accepted). An unknown client or a missing `redirect_uri` answers in
  place rather than redirecting (RFC 6749 §4.1.2.1).

The access token is an **HS256 JWT** signed with the per-issuer `signingKey` the
start call returned - hand that key to the service under test as its shared
secret and it can verify the mock's tokens. The payload is the configured
`claims` plus `iss`, `iat`, `exp` and `jti` (these four always win, since they
describe the token being issued), with `sub`, `client_id` and `scope` filled in
only when the claims did not set them.

`failureMode` is what makes retry and error handling testable, and can be
flipped on a **running** issuer with the `PUT`:

| Mode | `/token` answers |
|------|------------------|
| `none` | Normally |
| `slow` | Normally, after `slowMs` |
| `server_error` | `500 {"error": "temporarily_unavailable"}` |
| `invalid_client` | `401 {"error": "invalid_client"}` |

Issuers bind `127.0.0.1` only - never configurable, because they mint bearer
tokens and the engine has no route auth. State is in-memory: a restart forgets
every issuer, and stopping one drops its codes and refresh tokens with it.

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
  the request's own), the stored execution options (`followRedirects` /
  `maxRedirects` / `httpVersion`, always emitted) and its `requestName` (the
  script sandbox reads it as `pm.info.requestName`; omitted when the row's name
  is empty). The request's own collection scopes resolution; `collectionId` is
  only a fallback for a request without one. An unknown id is a definitive
  **404**.
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
    "mode": "json",
    "content": "{\"name\":\"John\"}"
  },
  "requestId": "req_1234567890",      // Optional, links to saved request
  "requestName": "Create user",       // Optional, read by scripts as pm.info.requestName
  "environmentId": "env_1234567890",  // Optional, uses environment variables
  "preRequestScript": "",              // Optional
  "postRequestScript": "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));",
  "allowScriptRequests": false,        // Optional, default false - see below
  "followRedirects": true,             // Optional, default true
  "maxRedirects": 10,                  // Optional, default 10
  "verifySSL": true,                   // Optional, default true
  "httpVersion": "auto",               // Optional: "auto" | "http1.1" | "http2", default "auto"
  "transient": false,                  // Optional, default false - see below
  "stream": false,                     // Optional, default false - see below
  "maxStreamDurationMs": 600000,       // Optional, streaming only - see below
  "maxStreamEvents": 100000,           // Optional, streaming only - see below
  "data": { "id": "7" }                // Optional, one data row - see below
}
```

**`stream` consumes a `text/event-stream` response live** (issue #573) instead
of buffering it. It changes the *execution model*, so it is declared rather than
detected: the engine creates the run row, hands the transfer to a managed
consumer worker, and answers **`202`** at once with the run and the URL its
events arrive on. Nothing about a non-streaming send changes.

```json
{
  "runId": "run_1234567890",
  "eventsUrl": "/runs/run_1234567890/events",
  "status": "running"
}
```

The worker parses SSE frames into a bounded in-memory ring that
[`GET /runs/:runId/events`](#get-runsrunidevents) relays, and writes a bounded
`events` node into the run's stored trace when the stream ends, so History
restores the timeline.

**Every stream ends, and the run says why.** Five terminations, never "the
timeout happened to fire":

| Reason | What happened |
|--------|---------------|
| `completed` | The server closed the stream |
| `stopped` | [`POST /runs/:runId/stop`](#post-runsrunidstop) |
| `maxStreamEvents` | The event cap was reached |
| `maxStreamDurationMs` | The duration cap elapsed |
| `idleTimeout` | Nothing arrived for `sseIdleTimeoutMs` |

The whole-transfer `timeout` is deliberately **not** applied to a stream - it
would kill a healthy one mid-flight. The only deadline is the idle one, and the
two caps above are what bound a stream that talks forever. `maxStreamDurationMs`
(1000–86400000) and `maxStreamEvents` (1–10000000) override the configured
defaults per request; sending either **without** `"stream": true` is a **400**,
since a cap that quietly did not apply is worse than no cap.

Refused with a **400** rather than silently reinterpreted:

- a non-boolean `stream` (`'stream' must be a boolean`);
- `"stream": true` with `"transient": true` - a stream **is** its run row: the
  row is what `eventsUrl` names, what carries the status, and what a stop
  finds, and a transient execution creates none;
- `stream` on `POST /runs` (`errorCode: "invalid_run_config"`) - a load run's
  completion accounting has no place for a response that never ends.

**Scripts run on a streaming request** (issue #575), and were refused until they
did. The pre-request script runs before the transfer starts, exactly as on a
buffered send, so its `pm.request` edits reach the wire. The post-request script
runs **once, after the stream has terminated**, and reads the bounded stored
list as `pm.response.events` with `pm.response.totalEvents` and
`pm.response.eventsTruncated` beside it - the sandbox is synchronous with no
event loop, so a live per-event callback is not a feature that was skipped but
one the runtime cannot have. See
[Scripting](scripting.md#pmresponseevents---a-streamed-runs-events).

Because the route has already answered `202`, a streaming run's script output
has nowhere to be *returned*: it is stored on the run's trace under `scripts`,
with the same four keys the buffered response body uses (`testResults`,
`consoleLogs`, `preScriptError`, `postScriptError`). One engine builder fills
both, so a live pane and a restored one cannot disagree. A run whose scripts
said nothing stores no node at all.

Tuning: `sseMaxRetainedEvents`, `sseMaxEventBytes`, `sseMaxStoredEvents`,
`sseMaxStreamDurationMs`, `sseMaxStreamEvents` and `sseIdleTimeoutMs` (see
[GET /config](#get-config)).

**`transient` runs the request without recording it** (issue #382). The
execution is otherwise identical - same composition, the cookie jar named by
`environmentId`, the same scripts, the same response body - but the engine
creates **no run row**: nothing appears in `GET /runs`, no result trace is
written, and the count-based retention prune does not run, so no existing run
is evicted. Because the trace is where the post-auth request headers would have
landed, a transient execution is also the only way to send with resolved
credentials and leave none of them on disk.

Absent and `null` both mean `false`; a present non-boolean is a **400**
(`'transient' must be a boolean`) rather than a silent `false`, because a
caller that asked for privacy must not be quietly refused it. The flag is
**not valid on `POST /runs`** - a load or scenario run *is* the row it creates
(the run id is the endpoint's return value), so sending it there is a **400**
with `errorCode: "invalid_run_config"`.

The one caller today is the app's GraphQL schema introspection
(`lib/graphql/introspect.ts`), a background fetch the user never made. MCP's
`run_request` deliberately does **not** set it: an agent's runs belong in
History like anyone else's, and the tool builds its payload from named
arguments, so an agent cannot supply the flag either.

**`data` binds one row to this send** (issue #601). It is the single-send half
of a run's `scenario.data`: every `{{data.column}}` in the URL, the header names
and values, the body and both halves of every form field is substituted against
it, and both scripts read it as `pm.iterationData` with `pm.info.iteration` `0`
and `pm.info.iterationCount` `1` - the send *is* row 0 of 1. Without the field
nothing changes: `{{data.*}}` goes out written as it stands and
`pm.iterationData` is `undefined`.

An **object** of name/value pairs, never the array a run sends - one row. The
row is bounded by `maxScenarioDataBytes` (the same setting a run's whole set is
measured against) and composes freely with `transient` and `stream`: a streaming
send binds the row before the transfer opens, so the URL and headers it opens
with are the bound ones.

Refused with a **400**, before any run row exists and with nothing sent:

| What | Message |
|------|---------|
| `data` is not an object | `'data' must be an object of name/value pairs (got array). A single send binds one row; a set of rows is a collection run.` |
| over the byte cap | `'data' is N bytes, over the limit of M (raise the 'maxScenarioDataBytes' setting to allow more)` |
| a token names a column the row lacks | the binder's own sentence, naming the token, the row and the row's columns |
| a `null` cell, a header collision, an unwritable XML placement | the binder's own sentence - identical to a run's, see [Scenario runs](#scenario-runs) |
| `auth` carries a `{{data.*}}` token | `Auth credentials carry {{data.user}}, and a single send cannot bind them: ...` |

That last one is the one asymmetry with a collection run, and it is a refusal
rather than a silent wrong send. Auth is applied when the request is built -
basic credentials are already collapsed into one base64 `Authorization` value -
so a credential token would go out as base64 of the literal token text. A run
resolves its plan once and can afford to keep the credentials typed and bind
them per iteration (issue #591); a single send has no plan to hang that off, so
it names the token and points at the alternatives (move it into the URL, a
header or the body, or run the collection with a data file).

**`requestName` is script identity, not an HTTP field** - it never reaches the
wire. The scripts read it as `pm.info.requestName` (with `requestId` as
`pm.info.requestId`); a client sends it because Send executes editor state,
which may be unsaved and therefore have a name no stored row carries. Absent,
the engine falls back to the name of the row named by `requestId`, so linking
an id is enough. An empty string is treated as absent - a script reads
`undefined` rather than `""` - and a non-string is a **400**
(`'requestName' must be a string`). See
[scripting.md](scripting.md#script-identity-pminfo).

**`allowScriptRequests` lets this payload's scripts use `pm.sendRequest`.**
Absent, `null` or non-boolean all mean `false`, and that default is a security
control rather than a convenience (issue #302): Vayu's MCP target allowlist is
checked in the MCP server, before it calls this endpoint, so a request issued
from inside a script never passes that gate. Denying unless a caller asks means
a client that forgets gets a script that cannot send rather than unchecked
egress. The app's Send and load runs send `true`; the MCP server never does.
`POST /runs` reads the same field for its deferred `tests` validation, so one
script behaves the same on both. See
[scripting.md](scripting.md#sending-a-request-from-a-script-pmsendrequest).

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
  "httpVersionDowngraded": true,
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
  "consoleLogs": [
    { "source": "pre", "level": "log", "message": "token refreshed" },
    { "source": "test", "level": "error", "message": "unexpected shape" }
  ]
}
```

**`headers` is keyed by the lower-cased header name, and a name the response
sent more than once holds every value folded with `", "`** - the RFC 7230 §3.2.2
equivalence for comma-list headers. So two `Set-Cookie` lines read back as one
`"session=abc; Path=/, csrf=xyz; Path=/"` entry rather than the last one alone.
A client splitting a folded `Set-Cookie` must split on a comma followed by
`name=`, since an `Expires=` value contains a comma of its own. The same holds
for the response headers stored on a design run's `trace_data.response` and on
captured load-run samples, which come off the same parse.

**`rawRequest` is the header block libcurl actually sent**, captured from the
transfer's last outbound header frame and followed by the request body. So it
carries what libcurl added on its own - the `Cookie` line the
[cookie jar](architecture.md#cookie-jar) matched, `Accept`, `Content-Length`,
and an h2 request rendered in HTTP/1 form - none of which appear in
`requestHeaders`.

**`requestHeaders` is the sent record**: the composed headers as the transfer
issued them. It carries the two the engine derives at send time - the
body-implied `Content-Type` and the default `User-Agent` - and drops a
`form-data` `Content-Type`, which libcurl writes itself with the boundary. It
does not carry libcurl's own additions or the jar's `Cookie` line; those are
`rawRequest`'s alone. A test script's `pm.request.headers` reads this same set
(see [scripting.md](scripting.md#request-object-pmrequest)), so an assertion
about what went out and the response pane's Headers tab cannot disagree.

Values in `rawRequest` are not redacted:
this field exists to say exactly what went out. On a followed redirect it is the
final hop, matching the response beside it. A transfer that failed before
sending anything (DNS failure, connection refused) has no frame to read, and
falls back to a request synthesized from what was composed.

**The stored trace keeps the same string**, as `trace_data.request.rawRequest`
on the design run this execute created (and on each step row of a scenario run)
- so reopening a run shows the raw request the live view showed, cookies
included, rather than one rebuilt from `headers` that never had them. Its body
half is capped at `maxTraceBodyBytes` like `body` is, and the key is absent both
on a step that sent nothing and on rows written before the field existed; see
[db-schema](db-schema.md#results). The redaction posture is the live field's,
for the reason [Security](architecture.md#security) records: a trace is the
record of what was sent.

**`consoleLogs` entries carry their own source and level.** `source` is which of
the request's two scripts wrote the line (`"pre"` for the pre-request script,
`"test"` for the post-request one) and `level` is the `console.*` method that was
called - `"log"`, `"info"`, `"warn"` or `"error"`. Releases before this one sent
a flat `string[]` with the source encoded as a `"[pre] "` text prefix and no
level at all, which was indistinguishable from a script logging that string
itself; a client that may talk to an older engine should read a bare string as
`{"source": "test", "level": "log"}`, or `"pre"` when the prefix is present. The
field is omitted entirely when neither script logged anything. See
[scripting.md](scripting.md#console-output).

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

**`httpVersionDowngraded`** is `true` when the request explicitly asked for
`"http2"` and the connection negotiated something older - the one thing the two
`httpVersion` fields cannot say on their own, since neither knows about the
other. It is always present (never omitted), so a client can tell "not
downgraded" from "an engine too old to say". Only an explicit `http2` counts:
`"auto"` promises nothing and `"http1.1"` got what it asked for, so neither can
be downgraded. A transfer that negotiated nothing at all (`httpVersion` `""`)
is `false` - that is a transport failure, and `errorCode` already reports it.

**A plaintext `http://` URL always reports `true` for an explicit `"http2"`.**
`CURL_HTTP_VERSION_2TLS` offers h2 over TLS only, so a cleartext request never
attempts it - the fallback noted above under the request's `httpVersion` is
exactly the case this field is for, and it is honest rather than a false
positive: h2 was asked for and HTTP/1.1 was used. A local dev server on
`http://` with the protocol set to HTTP/2 will show the warning on every
request; either switch the request to `auto`, or serve over TLS.

This exists because the failure it names is invisible otherwise: a `200`, a
latency and a body look identical whether or not the protocol you asked for was
granted. Windows shipped from v0.11.0 to v0.14.0 with HTTP/2 unreachable and
every request silently on HTTP/1.1 ([#215](https://github.com/athrvk/vayu/issues/215));
nothing in the API said so. The same field is stored on a design run's
`trace_data.response`, and load runs carry the whole-run count as
`summary.httpVersionDowngraded` in
[`GET /runs/:runId/report`](#get-runsrunidreport).

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
    "mode": "none",
    "content": ""
  },
  "mode": "constant_rps",    // "constant_rps", "constant_concurrency", "ramp_up", "iterations", or "capacity"
  "concurrency": 100,        // Target in-flight requests (constant_concurrency / ramp_up target / iterations); the ceiling for capacity
  "startConcurrency": 1,     // Ramp start concurrency (ramp_up); first level searched (capacity)
  "duration": "60s",         // Duration, ms/s/m/h (constant_rps / constant_concurrency / ramp_up); the deadline for capacity
  "rampUpDuration": "10s",   // Ramp time, ms/s/m/h (ramp_up mode; start may be above target)
  "sloMs": 200,              // p99 budget the search looks for the edge of (capacity mode)
  "stepDuration": "5s",      // How long each level is held before it is judged (capacity mode)
  "iterations": 0,           // Number of iterations (iterations mode)
  "targetRps": 1000,         // Target requests per second (constant_rps mode)
  "maxInFlight": 10000,      // Optional; see "maxInFlight" note below - constant_rps only
  "requestId": "req_1234567890",      // Optional, links to saved request
  "requestName": "Create user",       // Optional, read by the tests script as pm.info.requestName
  "environmentId": "env_1234567890",  // Optional
  "tests": "",               // Optional, deferred validation script
  "thresholds": {},          // Optional pass/fail budgets - see below
  "monitor": {},             // Optional server-vitals scrape - see below
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

#### The `thresholds` block (pass/fail budgets)

A run may declare budgets it must meet. The engine evaluates them once, when the
run reaches a terminal status, and the report comes back with a
[`thresholdValidation`](#get-runsrunidreport) section carrying one check per
budget and a verdict. Without the block a run is measured and not judged, and
its report has no such section at all.

```jsonc
{
  "thresholds": {
    "latencyP50Ms": 20,        // ceiling, ms; > 0 and <= 86400000
    "latencyP95Ms": 40,        // ceiling, ms
    "latencyP99Ms": 50,        // ceiling, ms
    "maxErrorRatePct": 0.1,    // ceiling, percent of the run's requests; 0-100
    "minThroughputRps": 10000  // floor, completed requests per second; > 0
  }
}
```

Every key is optional and at least one must be present. An unknown key, a
non-numeric or out-of-range value, or an object that declares nothing is a `400`
`invalid_run_config` naming the field - and, like every other run-config
rejection, it happens before the run row is created, so a rejected request
leaves no trace. A `null` value reads as absent, the same rule the flat numeric
fields follow.

`maxErrorRatePct` is measured against every response outside 2xx/3xx **plus** the
transport failures that never got one - the same figure `summary.errorRate`
reports. This is deliberately wider than the script-level `pm.test` view: a run
of nothing but HTTP 500s has a transport error rate of zero.

The verdict is the run's, not the process's: a run **stopped early** is judged on
what it measured up to that point, and its status stays `completed` / `stopped`
whatever the verdict says. A failing budget is reported, never a failed run.

#### The `monitor` block (server vitals)

A run may name a metrics endpoint on the target, which the engine scrapes for
the life of the run on **its own thread**. The samples are stored per run and
served by [`GET /runs/:runId/monitor`](#get-runsrunidmonitor), streamed live as
`monitor` frames on [`GET /runs/:runId/live`](#get-runsrunidlive), and summarised
in the report's `monitor` section. Without the block nothing is scraped and none
of those three carry anything.

```jsonc
{
  "monitor": {
    "url": "http://localhost:9100/metrics",  // required; http(s), loopback and private allowed
    "intervalMs": 1000,                      // optional, defaults to `monitorIntervalMs`; 250-60000
    "format": "prometheus",                  // optional, default "prometheus"; or "json"
    "series": [                              // required; 1 to `monitorMaxSeries` names
      "node_cpu_seconds_total",
      "process_resident_memory_bytes"
    ]
  }
}
```

`format` decides how the body is read:

- **`prometheus`** - the text exposition format. Comment and blank lines are
  skipped, a trailing exposition timestamp is ignored, and a value that is not a
  finite number (`NaN`, `+Inf`) is dropped. **Samples sharing a name across
  label sets are summed**, so `node_cpu_seconds_total{cpu="0"}` and
  `{cpu="1"}` chart as one series.
- **`json`** - a flat object of numbers, where `series` lists the keys to read.
  A key that is absent or non-numeric is skipped.

A name the body does not carry is **absent** from that sample rather than zero,
and a scrape that reads nothing at all - a transport failure, an unreadable
body, or a body carrying none of the requested names - stores no row and is
counted as a gap in the report's `monitor.failures`. A failing scrape never
fails the run; after five consecutive failures the engine logs once and backs
off to twice the configured interval until one succeeds.

Three of the limits are settings rather than constants: `intervalMs` defaults to
**`monitorIntervalMs`** when the block omits it, the `series` ceiling is
**`monitorMaxSeries`**, and how long a single scrape may take is
**`monitorScrapeTimeoutMs`** (see [GET /config](#get-config)). All three are read
per run, so a change applies to the next run started - no restart. The interval
*bounds* are fixed, because a cadence below 250ms measures the scraper rather
than the target and one above a minute records nothing on a short run.

The scrape budget has no field on the block: it is about the endpoint being
scraped, which is the same one run after run, so it lives with the other engine
settings. Left at its default of `0` it tracks the cadence at three quarters of
it - raise it when a heavyweight `/metrics` renders too slowly for that, and the
cadence stays where you set it.

Loopback and private addresses are deliberately allowed: this is a local tool
scraping the user's own infrastructure. An unusable block (no `url`, a
non-http(s) scheme, no `series`, more than `monitorMaxSeries`, an out-of-range
`intervalMs`, an unknown `format`) is a `400` `invalid_run_config` naming the
field, before the run row is created.

#### The `scenario` block (collection runs)

A run may instead state its work as an **ordered collection** - the collection
runner's sequence primitive. The block replaces the single request, so a payload
carrying it needs no top-level `method` / `url`, and states its iteration count
inside the block rather than through `mode` / `duration` / `iterations`:

```jsonc
{
  "scenario": {
    "source": "collection",         // required; the only accepted value today
    "collectionId": "col_123",      // required
    "recursive": false,             // optional, default false - descend into sub-collections
    "iterations": 1,                // optional; defaults to the data row count, else 1
    "data": [ { "user": "a" } ]     // optional inline rows; see maxScenarioDataRows
  },
  "environmentId": "env_123"        // optional, and what {{variables}} resolve against
}
```

The collection is resolved into an ordered, fully composed plan **once, before
anything is sent**, in the order the sidebar displays top to bottom: direct
requests by `requests.order` and - with `recursive` - descendant collections by
`collections.order`, depth-first, each sub-collection's whole subtree running
**before** its parent's own requests, and each list under the tiebreak in
[Ordering](#ordering). Subfolders ahead of own requests is the tree's rule, not
the column's: a folder's sub-collections and its requests are separately ordered
blocks, so the two `order` values are free to collide, and the run follows the
render (issue #431). Each step is
composed through the same path `POST /compose` uses, so a step's request and
joined scripts are byte-identical to what a Send of that request would run. A
collection edited mid-run therefore cannot change the sequence underneath
itself, and no execution path re-reads the database for request data.

**A valid block answers `202 {runId}`** and creates a run with
`type: "scenario"` - unless a load `mode` sits beside it, which makes it a
[scenario load run](#scenario-load-runs) with `type: "load"` instead. The
lifecycle is a load run's either way -
the run is registered, streams over
[`GET /runs/:runId/live`](#get-runsrunidlive), stops through
[`POST /runs/:runId/stop`](#post-runsrunidstop) and reports through
[`GET /runs/:runId/report`](#get-runsrunidreport) - and only the executor
differs. See [Scenario runs](#scenario-runs) below for what it does while it
runs and what it leaves behind.

**Every rejection is a `400`** with `error.code: "invalid_scenario"`, raised
before any run row exists - an empty or oversized sequence is never silently run
as a smaller one:

| Input | Rejected because |
|-------|------------------|
| `source` absent, or anything but `"collection"` | The discriminator exists for a future stored scenario; an unknown value must not fall through to the collection path. |
| `collectionId` absent, not a string, or empty | There is nothing to resolve. The id is echoed back when it names no collection. |
| The collection (with `recursive` applied) has no requests | An empty sequence is a mistake, not a zero-step run. |
| A step's composition fails | The message names the step index, request name and id. |
| More steps than `maxScenarioSteps` | The whole plan is held in memory for the run's life; the message carries the count and the cap. |
| `recursive` present and not a boolean | |
| `iterations` present and not a whole number in `1`-`2147483647` | It is read as a count, so `0`, a fraction and a string are each a run nobody asked for. |
| `data` present and empty | A data set that binds nothing is a mistake - omit the field to run without one. |
| `data` not an array, or a row that is not an object | |
| More `data` rows than `maxScenarioDataRows` | The message carries the count and the cap. |
| A `data` array larger than `maxScenarioDataBytes` | The row count cannot catch a few very large rows, and the transport's own body cap would drop the connection instead of explaining itself. |
| A step carrying a `{{data.*}}` token in a run sent without `data` | Nothing would bind it, so the literal token would be sent. The message names the step and the token. The step's credential fields are scanned as well as its request. |
| A step with a `{{data.*}}` token in its `oauth2` config | The token is acquired once, when the plan is resolved, so no iteration exists for a row to reach it. Refused with or without a data set. |

A cycle in the `collections.parent_id` tree terminates the recursive walk rather
than hanging it, exactly as the cascade delete in `DELETE /collections/:id` does.

**Five settings bound a scenario** (all in the `general_engine` category, see
[GET /config](#get-config)):

| Key                   | Default | Range      | Effect |
|-----------------------|---------|------------|--------|
| `maxScenarioSteps`    | `200`   | 1-10000    | Largest plan one run may resolve to. The sequence is composed up front and held in memory, and a load-mode scenario allocates a latency histogram per step, so this bounds memory rather than expressing a preference. |
| `maxScenarioDataRows` | `1000`  | 1-1000000  | Largest inline `data` array. The app parses the CSV/TSV/JSON/JSONL file and sends the rows - the engine never reads a file from disk - so this bounds the payload that decision costs. |
| `maxScenarioDataBytes` | `16777216` | 1024-104857600 | Largest inline `data` array measured in bytes of JSON. The row bound alone does not bound the payload, since one row may hold a megabyte in a single cell. |

| `maxScenarioStoredSteps` | `5000` | 0-1000000 | Per-step `results` rows one run stores; `0` stores every step. Steps that did not pass are kept first, successes fill the rest, and what was thinned is reported in the run summary. |
| `maxStepsPerIteration` | `0` | 0-1000000 | How many steps one iteration may execute before it is cut off. `pm.execution.setNextRequest` can send an iteration backwards, so a cycle would otherwise run forever. `0` derives the bound from the plan - ten times its step count, never below 100 - so a straight-through iteration can never trip it. |

The two data bounds are also enforced by the app *before* the run, against the
file it is about to parse, so a set this endpoint would refuse is named while
the file can still be changed. The **file format** those rows come from - which
extensions are read, the header row's rules, quoting, encoding, and what a CSV
cell's type becomes - is the app's contract and is documented once, in
[Data-Driven Runs](../app/data-driven-runs.md). This endpoint only ever receives
rows.

#### Scenario runs

A scenario run executes every step of the plan, in order, once per iteration.
Each step is the `POST /execute` exchange - pre-request script, send through the
environment's cookie jar, test script - so a step behaves exactly as a Send of
the same request does, and the two cannot drift apart.

**What carries between steps.**

- **Variables.** The environment, globals and collection scopes are loaded once
  at run start, mutated in memory by every step's scripts, and written back
  **once, when the run ends** (through the same diff that keeps a Send from
  rewriting a scope no script touched). The collection scope is the collection
  being run.
- **Cookies.** The environment's jar, unchanged - so a step that logs in leaves
  a session the next step sends.

> **`{{variables}}` are resolved before the first send, not per step.** The plan
> is composed once, so a value a script sets mid-run does **not** appear in a
> later step's URL, headers or body. It reaches later steps through the script
> API - `pm.environment.get(...)` in a pre-request script, which may then edit
> `pm.request`. This is the price of resolving once, and resolving once is what
> keeps a collection edited mid-run from changing the sequence underneath it.
>
> The one exception is the reserved `{{data.*}}` namespace below, which
> composition deliberately leaves alone so the runner can bind it per iteration.

**Scripts** additionally read `pm.info.iteration` (0-based) and
`pm.info.iterationCount`. No other caller sets them - see
[scripting.md](scripting.md#script-identity-pminfo).

**A run with `data` binds one row per iteration.** Row `i % rows` binds to
iteration `i`, and the run's scripts read it as `pm.iterationData` -
`get(name)` and `toObject()`, read-only, and `undefined` for a run sent without
`data`. With `iterations` absent the row count *is* the iteration count; with
both given the explicit count wins and the index wraps. The rows reach the run's
worker and nowhere else: they are not persisted, and the snapshot records
`dataRowCount` only. The full contract is in
[scripting.md](scripting.md#data-rows-pmiterationdata).

**`{{data.column}}` puts the row into the request itself.** `pm.iterationData`
is read *after* a step's request was built, so it cannot change where the
request goes; the `data.*` namespace can. A step whose URL, header or body
carries `{{data.email}}` has it substituted with that iteration's row, per
iteration, immediately before the send.

The namespace is **reserved and disjoint from the variable tiers** - not a
fourth, higher tier. `{{data.id}}` and `{{id}}` are different names, so a data
set can neither shadow nor be shadowed by a global, collection or environment
variable, and adding a data file to an existing collection cannot change what
its other tokens resolve to. Composition (`POST /compose`, and the plan
resolution that shares it) leaves a `data.*` token written exactly as it stands
for that reason; `{{data.}}` with no column after it names nothing and follows
the ordinary unknown-name rule instead.

**Where a token participates.** Exhaustively: the **URL** (path and query
string alike, so a token in a stored request's params reaches it once they are
joined into the URL), every **header name** and **header value**, the **raw
body**, **both halves of every form field** (`x-www-form-urlencoded` and
`form-data`), and the **credential fields** of the request's auth - the bearer
**token**, basic auth's **username** and **password**, and an api key's **name**
and **value**. Script text is never interpolated at all (a script reads its row
through `pm.iterationData`).

The pass runs over the **composed** text, not the text as it was authored, so a
token that arrived as a *variable's value* binds like any other: a variable
`endpoint` whose value is `/u/{{data.id}}` leaves `{{data.id}}` in the URL after
composition (resolution is one pass and never rescans a substituted value), and
the data pass then binds it. That is usable, and it is also why the
no-data refusal below says "or from the variable value it was written into" -
the token it names may not appear anywhere in the request as you wrote it.

**Only scenario runs bind at all.** `POST /execute` and a non-scenario
`POST /runs` have no rows and perform no data pass, so a `{{data.*}}` token in
either reaches the wire as the literal text `{{data.id}}` - no substitution, and
no warning, since composition leaves the reserved namespace written as it stands
by design. The refusal below exists for scenario runs only. A raw API or MCP
caller putting `{{data.*}}` into a single request is asking for the literal
braces and gets them.

> **Credentials bind before they are encoded.** A credentials file behind basic
> auth is the canonical data-driven run, so a step whose credentials carry a
> `{{data.*}}` keeps them unresolved in the plan and applies its auth *per
> iteration* instead: the row is bound first, and only then does the username
> and password become one base64 `Authorization`, or an api key become a
> percent-encoded query parameter. Every other step still resolves its auth once,
> when the plan is composed.
>
> **OAuth 2.0 is the exception, and it is refused rather than ignored.** Its
> token is acquired once, when the run is planned, so no iteration exists for a
> row to reach - a `{{data.*}}` anywhere in an `oauth2` config is a `400` at
> `POST /runs` naming the token, with or without a data set.

Which columns a collection *expects* is a separate, declared thing - see
`dataSchema` under [Collections](#collections) and
[Data-driven runs](../app/data-driven-runs.md). Declaring it changes no binding
rule; it is what lets the refusal above name the columns, and what the app
checks a picked file against before the run.

**What a cell renders as.** The CSV/TSV path produces only strings, so the first
row is the ordinary case; a JSON or JSONL file may carry any type:

| Cell | Substituted text |
|------|------------------|
| String | The string, byte for byte - no quoting round trip |
| Number | As JSON writes it: `7`, `-1.5` |
| Boolean | `true` / `false` |
| Object / array | Compact JSON: `{"a":1}`, `[1,2]` |
| `null` | Nothing - the bind **errors** instead, see below |

**Placement is typed, and that is the point.** In a JSON body, a token written
*inside* a string literal produces a string and a token written *outside* one
produces the value's own JSON type:

```json
{ "id": "{{data.id}}", "n": {{data.n}}, "flag": {{data.flag}} }
```

sends `"id":"42"`, `"n":2`, `"flag":true` for a JSON file's `{"id":"42","n":2,"flag":true}`.
Write `"n":"{{data.n}}"` instead and the number arrives quoted; that is the
knob, not a bug.

**A value cannot break the document it lands in.** For a body whose text is a
JSON document - `json`, `jsonrpc`, and a `graphql` body written as the
`{"query": ...}` envelope - a token inside a string literal binds **escaped**,
so a cell carrying `"`, `\` or a newline arrives as its own text inside valid
JSON rather than ending the string early. A token outside a string literal is
not escaped, which is what keeps typed placement working. Nowhere else is
anything escaped: a URL, a header, a form field and a `text` body take the
rendered value byte for byte, and a bare (un-enveloped) GraphQL document is
escaped once, later, when the engine wraps it.

An `xml` body has quoting rules of its own rather than JSON's, so it gets its
own encoding - decided per token from where in the document that token sits,
because XML has no single escape set the way a JSON string literal does:

| Position | Encoding |
|----------|----------|
| Element text | `&`, `<`, `>` escaped as entities |
| Attribute value | the above, plus the quote delimiting *that* attribute (`"` or `'`, whichever the author wrote) |
| `<![CDATA[…]]>` | verbatim - a `]]>` in the value is written `]]]]><![CDATA[>`, which reopens the section instead of ending it |
| A tag or attribute name (`<{{data.tag}}>`) | verbatim - no escape is legal in a name |
| Inside `<!--…-->` or `<?…?>` | **none - the bind is refused**, naming the token |

The last row is a refusal rather than an encoding because every candidate is
wrong there: a comment is not sent as content at all, a processing instruction
is markup addressed to the parser, and a value carrying `-->` or `?>` would end
the construct and send a document the author did not write. It errors the step
like a missing column does, for every row alike.

The **mode** decides this, not the content: a `text` body holding XML still
takes the cell byte for byte.

A token naming a column the bound row does not carry **errors the step before
anything is sent**, with a message naming the token, the row index and the
columns the row does have. Substituting an empty string would send a request
quietly pointing somewhere else, which is the failure this namespace exists to
remove.

**Two headers that bind to one name** error the same way. `X-{{data.h}}`
resolving to `authorization` beside a literal `Authorization`, or two templated
names resolving alike, would leave the request carrying one of the two - so the
row is refused instead, naming the header as it is written, the name it
produced and the row. Note this is deliberately *not* composition's duplicate
rule, which is last-wins: a duplicate there is two headers the author typed and
can see, while this one exists only for the rows that produce it.

A cell that is present but **`null`** errors the same way, naming the token and
the row. It is the same failure one type down - the token says the value comes
from the file and the file says there is none - and writing `""` for it would
send `{"n": }` for a typed placement or a quietly blank field for a quoted one.
A column that is legitimately optional belongs in a script, through
`pm.iterationData` (see
[scripting.md](scripting.md#data-rows-pmiterationdata)), where `null` is a value
a branch can read.

A run sent **without a `data` set at all** whose plan still carries a `data.*`
token is refused outright, before any run row exists: nothing would bind the
token, so every iteration would send the literal text `{{data.id}}`. The `400`
names the step and the token, and - when the collection
[declares a data contract](#collections) - the columns it declares, so the
message says which file to run with rather than only that one is missing:

```
step 1 (request 'Fetch user', id 'req_a') carries {{data.id}}, but this run has
no 'scenario.data' set. ... (declared columns: id, email)
```

Starting such a collection as a quick smoke check
means running it with a data file - a one-row set is enough - because the run
this refuses would not have exercised the endpoint either.

**Each step execution writes one `results` row** carrying the design-mode trace
plus `iteration`, `stepIndex`, `stepName`, `requestId` and `outcome`, and -
for a run with `data` - `dataRowIndex`, the row that iteration bound. Bodies are
capped by `maxTraceBodyBytes`; the row count is capped by
`maxScenarioStoredSteps` as described above.

**Outcomes** are `passed`, `failed`, `skipped` and `errored`:

| Outcome | Meaning | Effect on the iteration |
|---------|---------|-------------------------|
| `passed` | The request completed and every assertion held. | Continues. |
| `failed` | A `pm.test` assertion did not hold. | Continues - the request itself completed. |
| `errored` | The step did not complete: a transport failure, a timeout, or a script that threw. | **Ends the iteration.** The next iteration still runs. |
| `skipped` | A pre-request script called `pm.execution.skipRequest()`, so nothing was sent. The row carries the request and **no response**. | Continues with the next step. |

A run whose steps failed still reaches `completed`: the outcome of the work is
in the steps, and only the runner itself failing makes the run `failed`. A stop
is honoured **between steps**, so a `stopped` run does not finish the iteration
it was in.

**A step's scripts can redirect the sequence.** `pm.execution.setNextRequest(name)`
runs a named request next instead of the one that follows, `setNextRequest(null)`
ends the iteration, and `pm.execution.skipRequest()` (pre-request scripts only)
sends nothing and marks the step `skipped`. A target that names no step in the
run, or one that two steps share, fails the step by name rather than guessing,
and `maxStepsPerIteration` above is what stops a cycle. The full contract,
including everywhere the two methods throw, is in
[scripting.md](scripting.md#flow-control-pmexecution).

**The stored snapshot carries a step manifest, never the composed plan.**
`runs.config_snapshot` holds the block as validated - with `data` replaced by
its row count - plus `{index, requestId, name, method, url}` per step, where
`url` is the **stored, uncomposed** one. The composed plan carries resolved
`Authorization` headers and, for an `apikey` auth with `in: "query"`, a live key
in the URL; it lives in memory for the run's life and nowhere else.

#### Scenario load runs

Adding a load **`mode`** beside the `scenario` block runs the same plan as a
load test: `concurrency` virtual users, each walking the sequence on its own,
closed-loop on the event loop. The absence of `mode` is what still means a
design-mode collection run, so a payload written before this existed keeps its
meaning exactly.

```json
{ "mode": "constant_concurrency", "concurrency": 50, "duration": "60s",
  "scenario": { "source": "collection", "collectionId": "col_1" } }
```

| Field | Meaning here |
|-------|--------------|
| `concurrency` | **The number of virtual users** - what k6 and JMeter mean by it. Each holds its own position in the plan and its own cookies. |
| `duration` | Wall-clock length, for `constant_concurrency` and `ramp_up`. Virtual users keep starting iterations until it is up. |
| `iterations` (top level) | `mode: "iterations"` only: total passes over the plan across all virtual users. Distinct from `scenario.iterations`, which the design-mode runner reads. |
| `startConcurrency` / `rampUpDuration` | `ramp_up` only, as for a single-request run. |

**Rejected with a `400` (`error.code: "invalid_run_config"`)**, before any run
row exists:

| Input | Rejected because |
|-------|------------------|
| `mode: "constant_rps"` with a `scenario` | An open-loop arrival rate over a multi-step sequence is an arrival-rate executor, which Vayu does not implement. Refused rather than silently run closed-loop. |
| `mode: "capacity"` with a `scenario` | The search judges one windowed p99 and a sequence has one per step, so which of them the knee is measured against is a question the mode does not answer. |
| `rps` / `targetRps` above zero, on any mode | It is what selects the open-loop path regardless of the declared mode. |
| An unknown `mode` | |

`maxInFlight` is **moot** and is ignored with a warning: in-flight requests are
bounded by the virtual-user count by construction, so `concurrency` is the only
knob.

**What differs from a design-mode collection run:**

- The run's `type` is **`load`**, not `scenario`. It publishes `metrics` ticks
  over `GET /runs/:runId/live` (not `step` events) and reports RPS and
  percentiles like any load run.
- **Cookies are per virtual user**, empty at the start of each iteration, and
  the environment jar is untouched. One session shared between 1,000 virtual
  users is not the thing being measured.
- **Scripts do not run inline. They stay deferred, keyed per step.** After the
  run drains, each step's own post-request script is replayed against the
  responses that step produced, and the tallies appear on that step's entry in
  the breakdown as `tests` (see `scenario.steps` below). A step that carries no
  script, or whose script never got a sampled response, carries no `tests`
  object at all rather than a row of zeros. A pre-request script runs nowhere.
  `pm.execution` still throws - a script that has already run against a recorded
  response cannot redirect a sequence that already happened. Flow control is
  design-mode only.

  Sampling is keyed per step for the same reason: the run's
  `max_response_samples` budget is split evenly across the steps that carry a
  script (floored at one apiece), so the last step of a forty-step plan is
  sampled instead of being crowded out by the first. The whole-run
  `testValidation` section still reports the aggregate - it says *something*
  failed, and the per-step `tests` say where.
- **Data rows are claimed from one shared cursor**, one per virtual-user
  iteration, wrapping when they run out - so two virtual users never *start*
  with the same row while unclaimed rows remain, which is what a credentials
  file is for. Once every row has been claimed the cursor wraps and rows are
  reused, concurrently: a 10-row file under 50 virtual users, or any
  duration-mode run past the row count, has several users on one row at a time.
  Size the file to the concurrency if the rows must stay exclusive. Every step
  of an iteration binds that iteration's row. `scenario.iterations` still has no
  meaning here: the run repeats until its duration is up, and the row count does
  not bound it.

  A `{{data.column}}` naming a column its bound row does not carry **fails that
  step**: nothing is sent, the step's `errors` count in the breakdown moves, and
  the run's error list carries an entry with `error_type: "data_binding_failed"`
  naming the token, the row and the row's columns. It is never substituted with
  an empty string. A `null` cell and two headers binding to one name fail the
  same step the same way.

  Every retained result carries **`dataRowIndex`** on its `trace`, which is how
  a failure is attributed to a row when no per-step `results` rows exist. Absent
  for a run sent without `data`.
- **An errored step ends its iteration** and its virtual user starts the next
  one. It is never stranded.
- **No per-step `results` rows are stored** - one row per step per iteration per
  virtual user is what a load run exists not to keep. The report's
  `scenario.steps` breakdown is the per-step record instead:

```json
"scenario": {
  "iterations": 480, "iterationsCompleted": 474, "iterationsAbandoned": 6,
  "stepsExecuted": 1422, "errored": 6, "virtualUsers": 50,
  "steps": [
    { "index": 0, "name": "Log in", "requestId": "req_a", "method": "POST",
      "executed": 480, "errors": 0,
      "latency": { "min": 1.2, "p50": 4.0, "p95": 9.1, "p99": 12.4, "max": 30.2 },
      "tests": { "sampled": 20, "passed": 20, "failed": 0 } }
  ]
}
```

One histogram is allocated per plan step at run start, which is the other thing
`maxScenarioSteps` bounds.

`tests` is the step's deferred validation, and is **absent** for a step that
asserted nothing or whose script drew no sample - "no assertions" and "no
failures" are different answers.

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
| `max_success_results` | `0`-`1000000` | Each retained record holds a serialised timing breakdown, and the store is reserved up front. `0` means unlimited. |
| `max_slow_results` | `0`-`1000000` | Same store, same reserve, separate budget. `0` means unlimited. |
| `slow_threshold_ms` | `0`-`86400000` ms | `0` disables outlier capture; a negative threshold would mark **every** completion an outlier and fill the slow store with the whole run. |
| `max_sample_body_bytes` | `0`-`104857600` | A captured body is copied on the completion callback, so the cap bounds hot-path work. `0` keeps headers and metadata and no body. Defaults to the `maxSampleBodyBytes` setting. |
| `max_sample_bytes` | `0`-`1073741824` | The whole-run capture budget; every byte under it is held in memory until the run flushes. Defaults to the `maxSampleBytes` setting. |
| `max_exemplar_results` | `0`-`100000` | Each retained exemplar holds a captured exchange. `0` means unlimited. |
| `phase_histograms` | boolean | Per-run override for the `phaseHistograms` setting. `false` skips the bank entirely, and the run's report carries no `timingBreakdown.phases`. |
| `save_timing_breakdown` | boolean | Read as a bool inside the run-context constructor, which threw on a string *after* the row was written - the same stranded-`pending` failure `duration` had. |
| `capture_response_bodies` | boolean | Same read, same constructor, same failure. |
| `concurrency` | `1`-`10000` | Connections are eagerly pre-allocated per worker before any traffic flows, so `-1` (a natural "unlimited" guess) allocated until malloc failed. |
| `startConcurrency` | `1`-`10000` | The ramp is seeded with this many in-flight requests before the first duration check, and it is read as a `size_t`, so a negative start is ~1.8e19 of them. |
| `maxInFlight` | `1`-`1000000` | It is a pending-request ceiling read as a `size_t`, so `-1` or `0` removes the backpressure the field exists to provide instead of tightening it, and an open-loop run against a slow target then accumulates in-flight requests for its whole duration. The ceiling is **not** the `concurrency` guard: that one bounds an eager per-worker connection pre-allocation, while this bounds a counter that pre-allocates nothing, and the engine's own default - `max(targetRps × 10, 1000)` - reaches 500,000 at the load dialog's 50k RPS maximum, so a lower bound would refuse ceilings the engine picks for itself. |
| `timeout` | `1`-`86400000` ms | A transfer that never times out never completes, leaving the run stuck `running` and unstoppable. |
| `duration` | string, positive, optional unit (`ms`\|`s`\|`m`\|`h`) | A JSON *number* threw out of the run-context constructor *after* the row was written, stranding it `pending` forever behind an opaque `500`. |
| `stepDuration` | string, positive, optional unit (`ms`\|`s`\|`m`\|`h`) | `capacity` only, and read by the same parser `duration` is - so it is gated by the same rule rather than by a second copy of it. |
| `sloMs` | `1`-`60000` ms | `capacity` only. A non-positive budget has no edge to find, and one past a minute is longer than the transfers any realistic run measures. Matches the app's own clamp on the SLO setting. |

An **absent** field, or an explicit `null`, is always accepted - every one of
them has a default. The ceilings are crash guards, not policy: each client caps
itself far lower (the load dialog offers `concurrency` &le; 1000; the MCP
`start_load_run` tool has a user-settable cap in Settings).

One field is rejected by **presence**, not by range: **`transient`**. It is
`POST /execute`'s no-run-row flag (issue #382) and has no meaning here, because
a load or scenario run *is* the row it creates - the run id is what this
endpoint returns, and the live stream, the report and the scenario step store
are all keyed by it. Ignoring the flag would leave a caller believing the run
left nothing behind while it wrote the largest trace the store holds, so a
present `transient` (`true` **or** `false`) is a `400` with `error.code`
`invalid_run_config`. An explicit `null` is absent, as everywhere else here.

The sample rates are additionally clamped to &ge; 1 inside the metrics
collector, so the modulo cannot divide by zero even for a caller that bypasses
this route.

**What a run stores, and for how long.** A completed request is recorded in the
aggregate counters always; whether its *detail* survives is decided by three
independent budgets:

| Budget | Filled by | Bounded by |
|--------|-----------|------------|
| Sampled timing traces | 1 in `success_sample_rate` completions, only while `save_timing_breakdown` is on | `max_success_results` |
| Slow-request traces | any completion at or past `slow_threshold_ms`, **regardless** of `save_timing_breakdown` | `max_slow_results` |
| Response samples (post-run test scripts) | 1 in `response_sample_rate` completions | `max_response_samples` |
| Per-status exemplars (captured responses) | the first three completions of each distinct status code **that no other budget already stored** | `max_exemplar_results` |

None of these budgets bound the report's `timingBreakdown.phases`: the per-phase
histograms are fed by every completion and hold counts rather than records, so
the phase distribution is the whole population no matter how hard the stores
above thin. That is what they are for - the `avg*` fields beside them *are*
computed over the sampled subset.

Two properties are worth relying on. An outlier **never consumes a sampling
slot**: a run whose target degrades does not silently stop sampling ordinary
traffic because everything became slow. And each store is a **reservoir** - past
its bound a later record displaces a uniformly chosen incumbent instead of being
refused - so what a long run retains describes the whole run rather than its
first few seconds, and `sampling` in
[the report](#get-runsrunidreport) says how many records that thinning cost.

The exemplar budget is the one exception to the reservoir rule, and deliberately
so: an exemplar that gets displaced is not an exemplar, so past its bound a
later candidate is refused and counted rather than evicting an incumbent.

It is also the **last** budget consulted, not the first. A completion that is
already an outlier stays charged to the slow budget and a sampled one stays
charged to the sampling budget - claiming an exemplar never moves a record out
of the store that wanted it, because the first few completions of a status code
are often exactly where a run's outliers are. What the exemplar claim decides is
whether the response **body** is captured, which is independent of which budget
pays: a completion that is both sampled and a claimed exemplar is stored in the
sampling budget *and* keeps its body.

**Response capture.** `capture_response_bodies` (boolean, default `true`) decides
whether the retained samples carry their response headers and body. On by default
is only defensible because capture is failure-and-outlier-shaped rather than
uniform - errors, slow outliers and the per-status exemplars, never the 1-in-N
slice - so a healthy run captures a handful of exchanges. Set it to `false` and
the collector is byte-for-byte what it was before capture existed: no gate is
consulted, no exemplar is claimed, nothing is copied, and no rows are written.
What is captured is read back with
[GET /runs/:runId/samples](#get-runsrunidsamples) and described in
[`result_bodies`](db-schema.md#result_bodies).

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
≈ `max(targetRps × 10, 1000)`, accepted range `1`-`1000000`. That range holds
the default formula across the whole advertised RPS span (50k RPS → 500,000),
which is why it is not the `concurrency` guard - a ceiling of 10,000 would
reject explicitly what the engine already does implicitly. For the closed-loop
modes the `concurrency` target *is* the in-flight bound, so `maxInFlight` is
ignored there.

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

**Capacity semantics.** `capacity` is the one mode whose target is not a
function of elapsed time. It holds `startConcurrency` for `stepDuration`, judges
that window's windowed p99 and throughput, and then steps up by 25% (at least
+1) while the level stayed inside `sloMs`. It stops - and names the reason in
the report - when p99 exceeds `sloMs` across **two consecutive** windows
(`slo_exceeded`; one breaching window re-measures the same level rather than
ending the search), when two step-ups buy under 5% more throughput
(`plateau`), when `concurrency` is reached (`cap_reached`), when `duration`
runs out (`deadline`), or when the operator stops the run (`stopped`).

An **omitted `duration`** on a capacity run defaults to **5 minutes**, not the
60 seconds every other mode falls back to: this mode walks a level every
`stepDuration`, so a minute is a dozen levels and a search that almost always
ends `deadline` rather than finding anything. Any client enforcing its own
duration ceiling has to account for that per-mode default rather than assuming
one number - the MCP tool's cap does.

The search steers by the published metric tick - the same numbers `GET
/runs/:id/live` streams - rather than sampling the collector itself, so the
controller and the dashboard cannot disagree about a level. Windows in which
nothing completed are not judged: their percentiles are the empty-window zeros
and reading those as "answered instantly" would climb straight past the limit.
`capacity` is rejected on a **scenario** run with a `400`: the search judges one
windowed p99 and a sequence has one per step.

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

`requests_failed` is the producer's own error count, written into the tick at
write time. It is not derived at read time from `error_rate` and
`requests_completed` any more - that derivation depended on the order the EAV
rows came back in, and reported 0 failed requests for every bucket of every run.

A missing run returns `404` with the message `Run not found`.

**Storage.** Each `data[]` entry is one stored row of `metric_ticks` - the
engine writes the tick object once, at write time. Two things follow:

- **Pagination is tick-aligned**: `limit`/`offset` count ticks, so
  `pagination.total` is the number of ticks (not rows), and a page boundary can
  no longer return a tick with half its fields zeroed.
- **`elapsed_seconds` keeps counting across pages**, since it is measured from
  the run's first stored tick.

A run with no ticks returns `200` with an empty `data` array - only a run that
does not exist is a `404`.

### GET /runs/:runId/monitor

Paginated **server vitals** scraped during the run - the samples the
[`monitor` block](#the-monitor-block-server-vitals) collected. Same
`{data, pagination}` envelope and the same `limit` / `offset` rules as
`GET /runs/:runId/metrics`, so one pagination reader covers both.

Its own endpoint rather than extra keys on the tick objects: that key set is the
`/metrics` contract, and these samples land on the user's scrape cadence rather
than the tick cadence, so they do not line up row for row.

**Response:**
```json
{
  "data": [
    {
      "timestamp": 1234567890,
      "series": { "node_cpu_seconds_total": 3.75, "process_resident_memory_bytes": 1048576 }
    }
  ],
  "pagination": { "total": 1, "limit": 5000, "offset": 0, "hasMore": false, "returned": 1 }
}
```

`timestamp` is wall-clock Unix ms - when the engine scraped, not an elapsed
offset - because a tick's `elapsed_seconds` is measured from the run's first
*persisted* tick while the scrape starts with the run; joining the two series
onto one timeline is what the wall clock is for. A series the target did not
report in that scrape is **absent** from its `series` object rather than zero.

A run that configured no monitor returns `200` with an empty `data` array; only
a run that does not exist is a `404`. Samples are deleted with the run, like
every other child row.

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

This stream is fed from the run's `metric_ticks` rows; every field above comes
from the stored tick except **`avgLatencyMs`, which stays `0`** -
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

**A scenario run streams `step` events instead of `metrics` ticks.** One per
step execution, on the same ring and the same monotonic `id:` numbering, so
`Last-Event-ID` resume works identically and a client that reconnects mid-run
replays the steps it missed:

```
event: step
id: 3
data: {"iteration":1,"stepIndex":0,"name":"Log in","outcome":"passed",
       "statusCode":200,"latencyMs":42.7,"dataRowIndex":1}

event: complete
data: {"event":"complete","runId":"run_1234567890"}
```

`outcome` is one of `passed`, `failed`, `skipped`, `errored` - see
[Scenario runs](#scenario-runs). `dataRowIndex` is present only for a run with
`data`, on the same terms as on the stored row, so a step reads the same live
and after a reload. A scenario run publishes no `metrics` ticks:
its work is sequential, so per-tick aggregates would be a rate of one request at
a time rather than anything about the sequence.

**A run with a [`monitor` block](#the-monitor-block-server-vitals) also streams
`monitor` events**, one per successful scrape, interleaved with its `metrics`
ticks on the same ring and the same monotonic `id:` numbering - so
`Last-Event-ID` resume replays both kinds in the order they happened:

```
event: monitor
id: 12
data: {"timestamp":1234567890,
       "series":{"node_cpu_seconds_total":3.75,"process_resident_memory_bytes":1048576}}
```

The payload is byte-identical to one `data[]` entry of
[`GET /runs/:runId/monitor`](#get-runsrunidmonitor), so the live overlay and the
history overlay are drawn from the same rows. A scrape that read nothing emits
no frame.

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

### GET /runs/:runId/events

Relay a streaming run's events via Server-Sent Events (issue #573). Started by
`POST /execute` with `"stream": true`, which returns this URL as `eventsUrl`.

The endpoint replays the run's retained events, then tails until the stream
terminates, and closes with a `complete` event naming the termination reason.
Like the live-metrics topic, the ring is retained for `liveRetentionMs` after
the stream ends, so a client that connects late - even after a short stream has
already finished - still receives the whole series.

**Events:**
```
event: open
id: 0
data: {"statusCode":200,"statusText":"OK","headers":{"content-type":"text/event-stream"}}

event: message
id: 1
data: {"event":"token","data":"Hello","sourceId":"42","receivedAt":1234567890}

event: complete
data: {"runId":"run_1234567890","reason":"completed","totalEvents":128}
```

- `open` is published once, as soon as the response's header block arrives, so
  even a late consumer learns what the stream connected to.
- `message` carries one upstream event: its `event` name (`message` when the
  origin sent none), its `data` (multiple `data:` lines joined with `\n`), the
  origin's own `id:` as **`sourceId`**, and `receivedAt`. An event larger than
  `sseMaxEventBytes` is stored as a prefix and says so in band, with
  `dataTruncated: true` and `dataBytes` (the size as sent) - never silently cut.
- `complete`'s `reason` is one of `completed`, `stopped`, `maxStreamEvents`,
  `maxStreamDurationMs`, `idleTimeout`, `error`; see
  [POST /execute](#post-execute).

**`sourceId` is not the resume point.** `id:` on the wire is this relay's own
frame offset, which is what `?lastEventId=` / `Last-Event-ID` takes; `sourceId`
is what the *origin* would want back. Conflating them would make one of the two
resumes silently wrong.

**Resume** picks up at the frame *after* the one named, so a dropped consumer
re-renders nothing. The header wins over the query parameter when both are
present (`EventSource` cannot set a header on a fresh connection, so a client
owning its retry uses the parameter). Unlike the inbox's capture ids, frame ids
start at **0**, so `lastEventId=0` means "I saw frame 0" rather than "from the
start"; absence is what means the start. A present-but-unreadable value is a
**400** (`invalid_last_event_id`) rather than a silent replay from 0. A resume
point older than the retained window is fast-forwarded to the oldest retained
frame rather than looping on ids that will never come back.

**One consumer at a time.** Each stream parks a cpp-httplib pool thread for its
whole life, so a second concurrent watcher is a `409`
(`run_events_in_use`) - but a claim whose holder has stopped writing for two
keep-alive intervals is taken over instead of refused, since `EventSource`
treats a 409 as fatal and a reconnect racing the previous socket's death would
otherwise kill the stream for good.

**Responses:**
- `200` - SSE stream (live stream, or finished one still within the retention
  window).
- `400` - unreadable `lastEventId` / `Last-Event-ID`.
- `409` - already being streamed.
- `404` - no stream for this run, or it expired past `liveRetentionMs`; the body
  hints `GET /runs/:runId/report`, whose trace carries the stored `events` node.

## Runs

### GET /runs

List test runs (design mode, load tests and collection runs), newest first
(`start_time DESC` - the only order the UI uses). Rows carry a compact
`summary` rather than the full `configSnapshot`, so the polled history sidebar
stays cheap as history grows.

**Query parameters** (passing **any** of them opts into the paginated envelope):
- `limit` - page size (default 50, invalid/&le;0 falls back to 50, capped at 500).
- `offset` - rows to skip (default 0, negative floored to 0).
- `type` - `design` | `load` | `scenario` (an unrecognised value is ignored, not an error).
- `status` - a `RunStatus` string (`pending` | `running` | `completed` | `failed` | `stopped`; unrecognised ignored).
- `requestId` - exact match on the run's linked request.
- `collectionId` - exact match on a **collection run's** stored
  `scenario.collectionId`, read out of the snapshot as JSON. This is the
  deliberate opposite of `q` below: it matches the field, never the text around
  it, so a design run whose URL happens to contain the id does not come back.
  Only a collection run records the path, so `type: "design"` and `type: "load"`
  runs can never match; an id nothing has run is an empty page, not an error. A
  collection's most recent run is `?collectionId=<id>&limit=1`, since the list
  is already `start_time DESC`.
- `q` - case-insensitive substring **over the stored `config_snapshot` text**
  (SQL `LIKE`). It searches the raw snapshot, so it may over-match JSON keys or
  structure - acceptable for a search box.
- `baseline` - `true` lists only runs pinned as baselines, `false` only unpinned
  ones (any other value is ignored, like an unrecognised `type`). Leaving it out
  lists both, so omit it rather than passing `false` to mean "either". A
  request's current baseline is `?baseline=true&requestId=<id>&limit=1`, since
  the list is already `start_time DESC` - the lookup both the history view's
  vs-baseline strip and the MCP `compare_runs` tool make.

Every parameter composes with every other; each one left out is a wildcard.

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

A **collection run** (`type: "scenario"`) carries none of the first eight: its
work is a sequence, so there is no single `url`, `method` or `mode` to report.
Its row instead carries a tenth key, `scenario`, present on scenario runs only:

```json
"scenario": {
  "collectionId": "col_1234567890",
  "iterations": 3,
  "recursive": true,
  "stepCount": 12
}
```

`stepCount` is the length of the snapshot's step manifest, not the manifest
itself - a row that shipped every step's name, method and URL would undo the
reason `summary` exists. The manifest stays on `GET /runs/:runId`. Each of the
four keys is omitted when the stored snapshot has no such key.

**`baseline`** is on every row, `true` only for a run pinned through
[PUT /runs/:runId/baseline](#put-runsrunidbaseline). It is also on
`GET /runs/:runId`, so a client that opened a run directly can draw the pin
without listing.

**`resultSummary`** is what a **design run's** row says about the exchange:
`statusCode` and `latencyMs`, and nothing else. A design run is one request and
one response, so its outcome fits on the row and a page of them costs one extra
query; a load or collection run's results are many and unbounded, so its row
carries no `resultSummary` at all and its result rows are never read to build
one - the same split [GET /runs/:runId](#get-runsrunid) draws when it attaches
`result`. The two numbers rather than that whole `result`: it carries the
exchange's `trace`, request and response bodies included, which is a per-row
cost a list cannot take. A design run with no stored result - still running, or
one whose result write failed - **omits the key** rather than reporting
`statusCode: 0`, which is the wire's own way of saying the request never reached
a server.

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
      "baseline": true,
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
    },
    {
      "id": "run_1234567891",
      "requestId": "req_1234567890",
      "environmentId": null,
      "type": "design",
      "status": "completed",
      "startTime": 1234567892,
      "endTime": 1234567893,
      "baseline": false,
      "summary": { "url": "https://api.example.com/users", "method": "GET", "httpVersion": "auto" },
      "resultSummary": { "statusCode": 200, "latencyMs": 34.2 }
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
`environmentId`, `type`, `status`, `configSnapshot`, `startTime`, `endTime`,
`baseline`).

For a `design` run that has at least one stored result, the response also
carries a `result` object with that run's single exchange - the only other
place it appears is `GET /runs/:runId/report`, whose `results` array and
`metadata.configuration` are load-test concepts and are absent for a design
run. **`result` is design-only by construction**: it serves the first stored row
on the assumption that there is exactly one, and a `scenario` run has one per
step - its steps are read from the report's `results` array instead.

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

**A streaming design run** (`POST /execute` with `"stream": true`) is stopped
here too: the endpoint asks its consumer worker to end the transfer, waits up to
the same 5s, and answers `{"runId": ..., "status": "stopped", "message":
"Stream stopped", "totalEvents": N}`. The worker owns the terminal write, so the
run reaches `stopped` with its trace and its true event count together; the
stream's `complete` event carries `"reason": "stopped"`. A stream that had
already terminated keeps the reason it recorded rather than being rewritten as a
user stop.

### GET /runs/:runId/report

> Alias: `GET /run/:runId/report` (deprecated - see [Deprecated aliases](#deprecated-aliases)).

Get the final report for a completed run. The response is a **nested** object; conditional
sections appear only when relevant (e.g. `rateControl` only for `constant_rps`, `testValidation`
only when a test script ran, `thresholdValidation` only when the run declared
[budgets](#the-thresholds-block-passfail-budgets), `capacity` only for a
`capacity` run, `auth` only when the run's OAuth 2.0 credential could be
refreshed mid-run).

The whole-run aggregates come from the run's stored `summary` (written once when the run reaches
a terminal status - see [db-schema.md](db-schema.md#runs)), combined with the sampled `results`
rows for the timing breakdown and the `results[]` array. A run with no summary never reached a
terminal status - the engine died mid-run - and its report is built from those sampled `results`
alone rather than erroring. **The response shape is the same either way.**

**`metadata.openapi`** appears only for a run whose collection was
[bound to a spec](#post-collections) when the run was planned (issue #637). It is
echoed from the run's snapshot rather than re-read from the collection: a report
has to say what the run was measured against, and the binding is free to have
moved since. An unbound run carries **no `openapi` key at all** - absent rather
than an empty object, so "not measured against a spec" has one spelling.

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
    },
    "openapi": {
      "specId": "spec_3f2b1c9a-...",
      "specHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
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
    "throughputBytesPerSec": 128000,
    "httpVersionDowngraded": 0
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
    "avgFirstByteMs": 180.2, "avgDownloadMs": 2.7,
    "phases": {
      "dns":       { "p50": 0.1, "p95": 0.2, "p99": 1.4,  "max": 12.0, "count": 6000 },
      "connect":   { "p50": 0.3, "p95": 0.9, "p99": 8.2,  "max": 40.1, "count": 6000 },
      "tls":       { "p50": 0.0, "p95": 0.0, "p99": 22.0, "max": 61.0, "count": 6000 },
      "firstByte": { "p50": 2.9, "p95": 4.0, "p99": 6.1,  "max": 30.0, "count": 6000 },
      "download":  { "p50": 0.1, "p95": 0.3, "p99": 0.9,  "max": 4.2,  "count": 6000 }
    }
  },
  "slowRequests": { "count": 12, "thresholdMs": 1000, "percentage": 0.2 },
  "sampling": {
    "errorsDropped": 0, "successTracesDropped": 29000,
    "slowTracesDropped": 0, "responseSamplesDropped": 998000,
    "exemplarsDropped": 0, "sampleBodiesDropped": 12,
    "responseBodiesCaptured": 23
  },
  "monitor": {
    "samples": 60, "failures": 0,
    "series": {
      "node_cpu_seconds_total": { "min": 1.2, "max": 3.9, "avg": 2.6, "count": 60 }
    }
  },
  "testValidation": { "samplesTested": 500, "testsPassed": 498, "testsFailed": 2, "successRate": 99.6 },
  "thresholdValidation": {
    "checks": [ { "metric": "latencyP99Ms", "limit": 50, "actual": 47.2, "passed": true } ],
    "passed": 1, "failed": 0, "verdict": "passed"
  },
  "auth": { "refreshes": [ { "atSeconds": 3620.4 } ], "refreshFailures": 0 },
  "results": [ { "id": 41, "...": "sampled request/response outcomes" } ]
}
```

**`timingBreakdown` holds two independently-present halves.** The `avg*` fields
are means over the run's *retained trace sample* - the 1-in-`success_sample_rate`
completions stored while `save_timing_breakdown` is on, plus any slow-request
outliers - so they are absent for a run that stored no traces. `phases` comes
from five HdrHistograms fed by **every** successful completion, so it is present
for exactly such a run, and absent only when `phaseHistograms` was off, nothing
succeeded, or the run predates the bank. Read each half by its own key: the
object's presence proves neither, and the two are drawn from different
populations, so a `phases.tls.p50` is not comparable to an `avgTlsMs`.

`phases` is what answers "was the latency the server or the connection path".
A `tls.p50` of 0 beside a large `tls.p99` is a run re-handshaking under load -
most requests reused a connection, a minority did not - which the average over
both flattens into a number that looks merely mediocre. `count` is the number of
completions behind each distribution and is identical across the five.

**A capacity run adds a `capacity` section** and no other mode carries one:

```json
"capacity": {
  "sloMs": 200,
  "stopReason": "slo_exceeded",
  "maxHealthyConcurrency": 48, "maxHealthyRps": 23400, "p99AtMaxHealthyMs": 41.2,
  "kneeConcurrency": 64, "kneeP99Ms": 312.0,
  "levels": [ { "concurrency": 1, "rps": 980, "p99Ms": 1.4 } ]
}
```

`stopReason` is one of `slo_exceeded`, `plateau`, `cap_reached`, `deadline` or
`stopped` - see [Capacity semantics](#post-runs). The two optional halves are
**omitted rather than zeroed**, and the distinction carries information:

- `maxHealthy*` is absent when the very first level already breached the budget.
  The search found no sustainable capacity, which is not the same claim as a
  capacity of zero.
- `knee*` is absent unless `stopReason` is `slo_exceeded`. A run that ended at
  its ceiling, its deadline, or on a plateau inside the budget never watched the
  target give out, so it has no knee to report.

`levels[]` is one entry per level *judged*, in order - bounded by construction
(a search holds tens of levels, not thousands). A level that breached once and
was re-measured appears twice, at the same concurrency; the level still being
measured when the run ended does not appear at all, because it was never judged.

**`auth`** appears only for a run whose OAuth 2.0 credential could be renewed
while it ran - a header-placed, expiring token with `autoRefreshToken` on (see
[db-schema.md](db-schema.md#oauth_tokens) for the full eligibility list). Each
entry in `refreshes` is when a renewal landed, in seconds from the run's start.
`refreshFailures` plus a `lastError` string is the other half of the answer: the
run kept sending the credential it had, so 401s in `statusCodes` from that point
on are explained here rather than by the target. The section is **absent** for a
run that could never refresh, which is not the same claim as a run that watched
and never needed to (that one reports an empty `refreshes` array).

**A scenario run adds a `scenario` section** and no other run type carries one:

```json
"scenario": {
  "iterations": 3, "iterationsCompleted": 3, "stepsExecuted": 6,
  "passed": 4, "failed": 1, "skipped": 0, "errored": 1,
  "stepsStored": 6, "stepsDropped": 0
}
```

`stepsStored` versus `stepsExecuted` is the honest reading of `results[]`: a run
that filled `maxScenarioStoredSteps` reports fewer rows than it ran, with every
non-passing step among the ones kept. `summary.totalRequests` is the number of
step executions, not the number of rows that survived.

`latency.*` and the enriched `summary` fields (`peakConcurrency`, `droppedRequests`,
`avgQueueWaitMs`, `bytesSent/Received`, `throughputBytesPerSec`) come from the persisted
per-tick `metrics` rows. `latency_ms` in `results` (and therefore these percentiles) is
**perceived** latency.

`summary.httpVersionDowngraded` is the count of this run's transfers that asked
for HTTP/2 and negotiated something older - see
[`httpVersionDowngraded` on a response](#post-execute). It is the only figure in
`summary` that describes the report's *validity* rather than its performance:
non-zero means the latency and throughput beside it were measured over a
protocol other than the one `metadata.configuration.httpVersion` names.

**`0` is "none recorded", not "none happened".** An engine from 0.15.0 always
emits the key - including for a run whose stored summary predates the count, and
for one reported from its sampled results because that summary was malformed or
never written, neither of which can produce a figure. The key is absent only
from an engine older than 0.15.0. That is deliberately a weaker guarantee than
the per-response `httpVersionDowngraded`, which is exact for the exchange it
describes.

`sampling` says how much each bounded store thinned away: all zeros means the
`results[]` array and the tested responses are the complete set, and a non-zero
count means they are a **uniform sample of the whole run** (reservoir retention)
rather than a truncated prefix of it. The section is absent on a run recorded
before it was reported, which is not the same claim as "nothing was dropped".

Three of its keys are about captured responses rather than retention:
`responseBodiesCaptured` is how many exchanges the run stored (see
[GET /runs/:runId/samples](#get-runsrunidsamples)), and is also the run's own
marker that it holds response data **stored verbatim** - non-zero is what the
Samples tab warns on. `sampleBodiesDropped` counts samples whose headers were
kept but whose body was dropped once the run's `maxSampleBytes` budget was
spent. `exemplarsDropped` counts per-status exemplars refused because
`max_exemplar_results` was full, which only a target answering with more
distinct status codes than that limit can reach. All three are absent on runs
recorded before 0.15.0.

`monitor` is present only for a run that declared a
[`monitor` block](#the-monitor-block-server-vitals) - absent is "this run
scraped nothing", never "the target reported zeros". `samples` counts successful
scrapes and `failures` counts the ones that read nothing, so a section with
`samples: 0` and a non-zero `failures` says the endpoint was unreachable for the
whole run rather than that the run was not monitored. A series that never
produced a reading is absent from `series` for the same reason. The per-sample
readings are served separately by
[`GET /runs/:runId/monitor`](#get-runsrunidmonitor).

`results[].id` is the `results` row id, and the join key against
`GET /runs/:runId/samples`. It is absent on reports served by an engine older
than 0.15.0.

`metadata.configuration` carries the load-test tuning knobs present in the
snapshot (`mode`, `duration`, `concurrency`, `startConcurrency`,
`rampUpDuration`, `timeout`, `comment`, `followRedirects`, `maxRedirects` -
each omitted when absent) plus `httpVersion`, which is always present with the
same `"auto"`-when-unknown normalization `GET /runs`'s `summary` uses (see
above). `rps` in the raw snapshot is renamed to `targetRps` here.

### GET /runs/:runId/samples

Get the response headers and body a load run captured for its retained samples.
Paginated; **no deprecated alias** - the endpoint is new in 0.15.0, so there is
no pre-consolidation spelling for it to keep working.

Deliberately **not** part of `GET /runs/:runId/report`. That path loads every
`results` row for the run and JSON-parses each `trace_data` to accumulate
aggregates that never look at a body, and the dashboard polls it; at 1000
samples carrying 32 KiB bodies, folding them in would turn every poll into ~32 MB
read from SQLite and parsed. So the bodies live in their own tables and are
fetched here, per page, only when a reader actually expands a sample.

**Query params:**

| Param    | Default | Notes                                     |
|----------|---------|-------------------------------------------|
| `limit`  | `50`    | Capped at 500; a non-numeric value falls back to the default |
| `offset` | `0`     | Floored at 0                              |

**What a run captures** - and does not - is described under
[`result_bodies`](db-schema.md#result_bodies): every error, the slow outliers,
and the first three of each distinct status code, within `maxSampleBodyBytes`
per body and `maxSampleBytes` for the run. A uniformly sampled success carries
no body by design.

**Response:**
```json
{
  "data": [
    {
      "resultId": 41,
      "response": {
        "headers": { "content-type": "application/json", "server": "nginx" },
        "body": "{\"error\":\"upstream timeout\"}",
        "bodyBytes": 28,
        "contentType": "application/json"
      }
    },
    {
      "resultId": 42,
      "response": {
        "headers": { "content-type": "image/png" },
        "bodyBytes": 20480,
        "contentType": "image/png",
        "binary": true
      }
    }
  ],
  "pagination": { "total": 23, "limit": 50, "offset": 0, "hasMore": false, "returned": 23 }
}
```

`resultId` is the `results` row this exchange belongs to - join it against
`results[].id` on the report rather than re-deriving an order.

The `response` node always carries `headers` and `bodyBytes` (the size **as
received**, before any truncation). The rest is conditional, and each key means
something the bytes alone cannot say:

| Key             | When present | Meaning                                                                 |
|-----------------|--------------|-------------------------------------------------------------------------|
| `body`          | Not binary   | The stored bytes. `""` when the response had none, or when the body was dropped |
| `bodyTruncated` | `true` only  | `body` is a prefix; the response was larger than `maxSampleBodyBytes`. Same convention design-mode traces use |
| `bodyDropped`   | `true` only  | The run's `maxSampleBytes` budget was spent before this sample: headers kept, body not. **Distinct from an empty response body** |
| `binary`        | `true` only  | Stored as a descriptor - `bodyBytes` and `contentType`, no bytes. See [`result_bodies`](db-schema.md#result_bodies) for why a binary body is never stored as text |
| `contentType`   | Non-empty    | The response's `Content-Type`                                           |

**Captured data is stored verbatim** - no redaction, consistently with
design-mode traces, which already store request headers as sent. A response
`Set-Cookie` is captured along with everything else. It is deleted with the run,
so `maxRunsRetained` is its expiry.

A run that captured nothing is an empty page, not an error; an unknown run id is
a **404** in the shared error shape.

**Response (404):**
```json
{ "error": { "code": 404, "message": "Run not found" } }
```

### PUT /runs/:runId/baseline

Pin (or unpin) a run as a **baseline** - the known-good run later runs of the
same request are compared against. `PUT` rather than `POST` per the
[create vs update](#resource-writes-create-vs-update) split: the run already
exists, and this updates it. There is no deprecated alias; the endpoint is new.

Two things follow from a pin, and both are the point of it:

- **Retention never expires it.** `prune_runs` skips a baseline under both the
  count cap and the age cap, and a pinned run does not count toward
  `maxRunsRetained` either - a pin the cap could expire is not a pin, and pins
  crowding the cap would evict the recent history the cap exists to keep.
- **Clients can find it**: `GET /runs?baseline=true&requestId=<id>&limit=1`.

Several runs may be pinned at once (one per request is the expected use). The
engine records the pin and holds no opinion about which baseline applies to
which run - that selection is the client's, so a pin never unpins anything else.

**Request body** - `baseline` is required and must be a boolean:
```json
{ "baseline": true }
```

**Response `200`:** the updated run row, in the same shape
[GET /runs](#get-runs) lists (including `summary`), so a client can patch its
cached row instead of re-listing.

**`400`** when the body is not JSON, has no `baseline`, or `baseline` is not a
boolean - including `null`. Unlike the merge-patch resource updates, an
unusable value here is refused rather than ignored: this body has exactly one
field, so ignoring it would answer `200` to a request that changed nothing.

```json
{ "error": { "code": "bad_request", "message": "Invalid 'baseline': must be a boolean" } }
```

**`404`** when no run has that id.

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

The file also declares the host globals the sandbox **lacks** (`setTimeout`,
`fetch`, `require`, `URL`, …) as `never`, with the reason as documentation. That
is not padding: the app must suppress "Cannot find name" wholesale, because a
collection-level script part is joined to the request's before the engine runs
it, so a name declared there is undeclared as far as the editor's model can see.
Declaring the absent globals keeps the real mistake caught ("not callable")
while that suppression is in force. A test executes `typeof <name>` in the real
script engine for every entry, so the list cannot drift from the runtime.

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

#### The declarations are compiled, not just grepped

`script_types_test.cpp` asserts on substrings of the generated text - every
listed member appears, the chain returns the chain, an optional field keeps its
type. That cannot catch the class of defect where a declaration contains every
right name and still does not type-check, and four of those shipped (#463):
`pm.cookies.jar()` emitted twice with the `object` overload winning, every jar
method's signature emptied by the `()` inside its own label, `pm.info.eventName`
read as prose and typed `void`, and two `pm.expect` chains shorter than the
documentation beside them.

So the durable guard compiles the **54 `pm.*` code blocks** in
[`scripting.md`](scripting.md) and
[`pm-api-compatibility.md`](../app/pm-api-compatibility.md) against the real
declarations and requires zero errors, with the app's own compiler options and
its two suppressed codes. The documentation and the declarations then hold each
other up: an example the editor would squiggle fails the suite, and so does a
declaration that stops describing what the docs recommend.

It needs a TypeScript compiler, which ctest does not have, and the generator
needs the engine, which vitest cannot run. The two halves meet at one checked-in
artifact - the same shape as `variable-resolution-conformance.json`:

| Where | What |
|-------|------|
| `engine/tests/fixtures/script-typedefs.d.ts` | The generated declarations, checked in |
| `ScriptTypesTest.TheCheckedInDeclarationsMatchTheGenerator` | Pins that file to the generator byte-for-byte, so the copy cannot drift |
| `app/src/hooks/script-typedefs.docs-compile.test.ts` | Compiles the docs' blocks against it |

A change to the surface therefore shows up as a diff in the declarations the
editor will serve. Regenerate deliberately:

```bash
VAYU_UPDATE_SCRIPT_TYPEDEFS=1 ctest --preset linux-dev -R ScriptTypes
```

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
