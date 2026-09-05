---
description: >-
  The SQLite schema Vayu stores locally - every table, its columns, and the JSON shapes kept inside them.
---

# Engine Database Schema

Vayu uses SQLite via `sqlite_orm`. The schema is defined in `engine/src/db/database.cpp` and the
struct definitions live in `engine/include/vayu/types.hpp`. `sync_schema()` adds new columns
automatically on startup - no migration scripts are needed for additive changes.

> **Breaking changes**: because Vayu is pre-release, destructive schema changes (column removal,
> type changes) wipe the database rather than migrating it. The `PRAGMA user_version` is
> not currently managed; wipe is done by deleting the `.db` file.

---

## Startup validation, backup and recovery

`Database::Database` (`engine/src/db/database.cpp`) opens the database and runs
`sync_schema()` before anything else uses it, and what it does next depends on
whether that succeeded:

| Outcome | What happens to the files | What is recorded |
|---------|---------------------------|------------------|
| Opens cleanly | The whole file set is copied to `<db>.bak` (sidecars included), so the backup is only ever taken from a database that validated | Nothing |
| Fails, `<db>.bak` passes the same validation | The corrupt file set is quarantined and the backup copied back over it | `restored_from_backup` |
| Fails, `<db>.bak` fails the same validation | The backup is left untouched as evidence, the corrupt file set is quarantined, and a fresh empty database is created | `backup_also_corrupt` |
| Fails, there is no backup | The corrupt file set is quarantined and a fresh empty database is created | `started_fresh_quarantined` |
| Fails, and the quarantine rename fails too | `<db>`, `<db>-wal` and `<db>-shm` are **deleted** so the daemon can still start | `deleted_corrupt` |

Starting fresh is deliberate - the alternative is a daemon that fails to start
on every launch forever - but it is total: collections, requests, environments,
saved examples, spec documents and run history are all gone, and the app comes
up looking like a fresh install.

> **`<db>.bak` is not a user backup.** It is rewritten on every clean start, so
> it exists to give a corrupt file something to restore *from*, not to let
> anyone go back to last week - and the row above where it is the only copy
> left is the one that ends in an empty workspace. The snapshot a user owns is
> `POST /workspace/backup` / `vayu-cli backup`, described in
> [architecture.md](architecture.md#workspace-backups).

### The quarantine (issue #984)

A database that fails validation is **moved, not deleted**: `<db>` becomes
`<db>.corrupt-<epoch-ms>` with its `-wal` and `-shm` sidecars renamed alongside.
SQLite's own tooling can usually pull most rows back out of a damaged file, and
only while the file exists:

```
sqlite3 /path/to/vayu.db.corrupt-1755870000000 .recover > salvage.sql
```

Two rules bound it:

- **At most two sets are kept.** These are full-size copies written unattended
  into the user's data directory; the newest two survive each recovery and older
  ones are pruned. Two, not one, because the set before the current one is what
  says this has happened before.
- **The backup is validated before it is trusted.** It gets the same open plus
  `sync_schema()` probe the main file gets - which also migrates a backup taken
  by an older build before it is committed to. A backup that fails is left
  exactly where it is rather than written over the original, which is what
  `backup_also_corrupt` records.

One implementation detail worth knowing before changing the order of that code:
the validation probe cannot be the first thing to touch the file. SQLite
**deletes the `-wal` and `-shm`** when it opens a file whose header is not a
database's, and a `-wal` holds committed transactions the main file does not, so
the sidecars would be gone before the quarantine could move them. The
constructor reads the 16-byte SQLite header itself first and only opens a file
that could plausibly be a database.

### The recovery marker (issue #922)

The record of that cannot live in the database, because the database is the
thing that just went away, so it is a small JSON file beside it, `<db>.recovery`,
written by `engine/src/db/recovery.cpp`:

```json
{
  "outcome": "started_fresh_quarantined",
  "at": 1755870000000,
  "quarantinedPath": "/home/someone/.local/share/vayu/vayu.db.corrupt-1755870000000"
}
```

`at` is epoch milliseconds, as every other engine timestamp is.
`quarantinedPath` is present only when a set was moved aside - absent for
`deleted_corrupt` and for any marker written before #984 - so a reader tests for
it rather than deriving it from `outcome`. Two rules the readers depend on:

- **A clean start writes no marker.** The file's presence alone is what
  distinguishes a wiped database from a genuine first run, which produces an
  empty database too. There is deliberately no `ok` outcome.
- **A marker is never cleared by the engine.** The engine can be restarted, or
  crash, before any client has polled it; clearing it on the next clean start
  would lose exactly the case the file exists for. Showing a notice about it
  once is the *reader's* job - the app remembers the `at` it has acknowledged
  (`app/src/stores/recovery-notice-store.ts`).

`Database` reads the marker once at construction and exposes it as
`Database::recovery()`, so the polled `GET /health` costs no file access. That
endpoint reports it as a `recovery` node, absent on a clean start - see
[api-reference.md](api-reference.md#get-health) - and the app renders it as a
dismissible banner naming the database path and, when there is one, the
quarantined file and the `.recover` command that reads it.

### Reclaiming freed pages

Deleting rows - a prune, a trash purge, the `metrics` drop - moves their pages to SQLite's
freelist, where the engine reuses them and the filesystem never sees them again, so a workspace
that once held weeks of heavy runs keeps that high-water mark forever. `Database::init()` ends
with a guarded `VACUUM` that gives them back (issue #990).

Guarded, because a `VACUUM` rewrites the whole database: it runs only when **both** thresholds are
crossed - at least **25%** of the file's pages are free **and** they hold at least **10 MiB**
(`VACUUM_MIN_FREELIST_PERCENT` / `VACUUM_MIN_RECLAIMABLE_BYTES`, compile-time, deliberately not
configurable). The fraction alone would rewrite a nearly-empty workspace on every start; the byte
floor alone would rewrite four gigabytes to win back eleven megabytes. Neither threshold crossed
means the pass reads three PRAGMAs and returns.

Three things worth knowing about where it sits:

- **Last in `init()`**, after the run prune and the trash purge, so it sees the pages every sweep
  freed rather than only the first one's.
- **On a connection of its own**, like `POST /workspace/backup`'s `VACUUM INTO` - sqlite_orm
  exposes no way to run these statements on the connection it holds. Nothing contends for it:
  `init` runs before the HTTP listener starts, and the lock file has already refused a second
  engine.
- **The `VACUUM` is followed by a `wal_checkpoint(TRUNCATE)`.** Under WAL the rewritten image
  lands in the `-wal` file and the database is not resized until a checkpoint copies it back, so
  without it the pass would free every page it set out to and leave the file exactly as large as
  it found it.

The outcome is logged at info level (`Reclaimed N KB of freed database pages`), because the cost
is paid on the startup path - `db.init()` returns before `/health` answers, and the app's readiness
poll budgets 45 seconds against it before handing the engine to the renderer's own health poll. A
rewrite slow enough to matter is one this line explains.
Best-effort like the sweeps before it: a failure is a warning, never a daemon that will not start.
`auto_vacuum` was rejected as the alternative - switching an existing database's mode requires a
full `VACUUM` anyway, and it changes page bookkeeping for every write thereafter.

---

## Tables

**ID format, and who owns it.** Every row ID in the database is generated by the
engine, with `vayu::utils::generate_id("col_")` (see `engine/src/utils/id.cpp`) -
`<prefix>_` + a random UUIDv4 (lowercase `8-4-4-4-12` hex, e.g.
`col_3f2b1c9a-...`). No client can supply one: `POST /collections`, `/requests`
and `/environments` reject a body carrying `id` with a `400`, and
`POST /import/apply` rejects a per-item `id` the same way, taking opaque
`tempId`s and returning the map of the real IDs it generated (issues #96, #97).
So the format is a property of the data rather than a convention clients are
trusted to follow. The engine formerly built IDs from a millisecond timestamp, so
two rows created in the same millisecond collided and - because persistence
upserts (`storage.replace()`) - silently merged; the random UUID removes that.
`globals.id` is the one exception: a fixed literal `"globals"`.

### `collections`

Stores folder/group hierarchy for requests.

| Column               | Type    | Notes                                        |
|----------------------|---------|----------------------------------------------|
| `id`                 | TEXT PK | `col_` + UUID                                |
| `parent_id`          | TEXT    | NULL for root collections                    |
| `name`               | TEXT    |                                              |
| `description`        | TEXT    | Default `""`                                 |
| `variables`          | TEXT    | JSON: `Record<string, VariableValue>`        |
| `auth`               | TEXT    | JSON: `RequestAuth` (never `inherit`)        |
| `pre_request_script` | TEXT    | Default `""`                                 |
| `post_request_script`| TEXT    | Default `""`                                 |
| `data_schema`        | TEXT    | JSON: the declared data contract; default `"{}"` |
| `openapi`            | TEXT    | JSON: the bound spec document; default `"{}"` |
| `order`              | INTEGER | Sort order within parent; default 0          |
| `created_at`         | INTEGER | Unix ms                                      |
| `updated_at`         | INTEGER | Unix ms                                      |
| `deleted_at`         | INTEGER | Unix ms; NULL while the collection is live (issue #988) |

**data_schema** - which columns this collection's data files are expected to
carry, so `{{data.column}}` and `pm.iterationData` can be checked before a run
(issue #599):

```json
{"columns":["id","email"],"declaredAt":1700000000000,"fileName":"users.csv"}
```

`{}` - the default, and what an explicit `null` on `PUT` resets to - means the
collection declares no contract. `columns` must be an array of unique, non-empty
strings (at most 1024 of them, each at most 256 characters); `declaredAt` is
epoch ms and `fileName` is a display label, both optional. Validation lives in
`apply_collection_fields`, so `POST`, `PUT` and `POST /import/apply` all enforce
it. NOT NULL with a `default_value`, which is what lets `sync_schema`
`ALTER TABLE ADD COLUMN` it onto an existing collections table - pre-existing
rows backfill to `{}` (the same migration shape as `config_entries.keywords`).

The **schema** is stored; the **rows** never are. A data file's contents are
user data of unknown sensitivity and are persisted nowhere - not here, not in a
run snapshot (which records `dataRowCount` only). The file's path is likewise
not stored engine-side: it is true of one machine, so the app keeps it in a
local store. See [Data-driven runs](../app/data-driven-runs.md).

**openapi** - the OpenAPI document this collection is bound to (issue #637):

```json
{"specId":"spec_3f2b1c9a-...","specHash":"<hex sha256>","syncedAt":1700000000000}
```

`{}` - the default, and what an explicit `null` on `PUT` resets to - means the
collection is bound to nothing, so unbinding needs no verb of its own. A
non-empty object is a binding and must carry a `specId` that resolves to a row in
[`spec_documents`](#spec_documents); `specHash` records which *version* of the
document the collection was last synced to, and `syncedAt` when. Shape validation
lives in `apply_collection_fields` so all three write paths enforce it, and the
resolvability check sits in the route cores beside `reject_missing_collection` -
`POST /import/apply` binds specs it is about to write in the same transaction.

**The version half is the engine's** (issue #709). A client sends the `specId`;
whichever write path receives it fills in `specHash` from the document that id
names and `syncedAt` from the moment of the write - the same division
`spec_documents.hash` itself draws. Only the halves the caller left out are
filled, so a binding that deliberately records an older version keeps it and a
run still reports `hash_mismatch` for it. This matters because both contract
readers - coverage and response-schema validation - require the binding's hash
to equal the stored document's before they engage: until #709 the import path
stored `{specId}` alone, and every run of an imported collection therefore
reported no contract at all. `Database::stamp_hashless_spec_bindings()` repairs
the rows written before that rule, on every startup, stamping the document's
`fetched_at` (when the import that made the binding stored it, not the moment of
the restart) and skipping any binding whose document is gone.

The **edge** is stored here; the **document** is not. Several collections may
bind the same spec, so nothing here owns it: no cascade reaches `spec_documents`,
and `DELETE /specs/:id` is refused while any collection names the row. NOT NULL
with a `default_value`, the same migration shape as `data_schema` above.

**auth** is a JSON discriminated union: `{"mode":"none"}` | `{"mode":"bearer","token":"..."}` |
`{"mode":"basic","username":"...","password":"..."}` | `{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}` |
`{"mode":"oauth2","config":{…}}` (see [`requests.auth`](#requests) and [`oauth_tokens`](#oauth_tokens)).
Collections are always auth sources - they never store `{"mode":"inherit"}`. They may store
`{"mode":"noauth"}`, the inheritance terminator meaning "descendants inherit no credentials"
(distinct from `none`, which means nothing is set at that level); `POST /compose` resolves both
during the inherit walk (`request_composer.cpp`), so neither reaches the engine's `parse_auth` -
which would treat them as no auth anyway.

**Cascade delete**: deleting a collection performs BFS to collect all descendant IDs, then
deletes all their requests before deleting the collections deepest-first, wrapped in a single
transaction so a crash mid-cascade cannot leave a half-deleted subtree. See
`Database::delete_collection()`.

`parent_id` forms a tree, but SQLite enforces no such constraint, so the BFS carries a visited
set and is **cycle-safe**: a self-parent (`parent_id == id`) or an `A -> B -> A` loop terminates
instead of growing the work list forever under the global DB mutex (which would hang every
endpoint, including `/health`). `POST /collections` rejects the writes that would create such a
cycle (see [api-reference.md](api-reference.md) - POST /collections), so cycles only arise from
data written before that validation existed; the visited set is what lets deletion recover from it.

---

### `requests`

Stores individual HTTP request definitions.

| Column                | Type    | Notes                                                |
|-----------------------|---------|------------------------------------------------------|
| `id`                  | TEXT PK | `req_` + UUID                                        |
| `collection_id`       | TEXT    | FK → `collections.id` (not enforced by SQLite FK)   |
| `name`                | TEXT    |                                                      |
| `description`         | TEXT    | Default `""`                                         |
| `method`              | TEXT    | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / etc.  |
| `url`                 | TEXT    |                                                      |
| `params`              | TEXT    | JSON array of `KeyValueEntry[]`                      |
| `headers`             | TEXT    | JSON array of `KeyValueEntry[]`                      |
| `body`                | TEXT    | JSON discriminated union (see below)                 |
| `body_type`           | TEXT    | Denormalized mirror of `body.mode`; kept for queries |
| `auth`                | TEXT    | JSON discriminated union (see below)                 |
| `pre_request_script`  | TEXT    | Default `""`                                         |
| `post_request_script` | TEXT    | Default `""`                                         |
| `order`               | INTEGER | Sort order within collection; default 0              |
| `follow_redirects`    | INTEGER | Boolean; default 1 (follow)                          |
| `max_redirects`       | INTEGER | Hops allowed while following; default 10             |
| `http_version`        | TEXT    | `'auto'` \| `'http1.1'` \| `'http2'`; default `'auto'` |
| `verify_ssl`          | INTEGER | Boolean; verify the TLS certificate; default 1       |
| `stream`              | INTEGER | Boolean; consume the response as SSE; default 0      |
| `spec_operation`      | TEXT    | JSON: which spec operation this is; NULL when none   |
| `created_at`          | INTEGER | Unix ms                                              |
| `updated_at`          | INTEGER | Unix ms                                              |
| `deleted_at`          | INTEGER | Unix ms; NULL while the request is live (issue #988) |

**params / headers** - stored as a JSON array of objects:
```json
[{"key":"Content-Type","value":"application/json","enabled":true,"description":""}]
```
Disabled rows (`"enabled":false`) are preserved in storage and filtered at HTTP-execution time only.
Duplicate keys are allowed.

**body** - discriminated union:
```json
{"mode":"none"}
{"mode":"json"|"text"|"graphql"|"jsonrpc"|"xml","content":"..."}
{"mode":"form-data"|"x-www-form-urlencoded","fields":[{"key":"...","value":"...","enabled":true}]}
```

**auth** - discriminated union (same shape as collection auth, plus `inherit`):
```json
{"mode":"none"}
{"mode":"inherit"}                                        // resolved at execution time
{"mode":"bearer","token":"..."}
{"mode":"basic","username":"...","password":"..."}
{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}
{"mode":"oauth2","config":{ /* OAuth2Config */ }}
```

The `oauth2` `config` holds the grant type, endpoints, client id/secret,
placement options, etc. Secret fields (`clientSecret`, `password`) are stored
**in plaintext** here, same as bearer/basic credentials - the v1 posture. The
resolved access tokens live separately in [`oauth_tokens`](#oauth_tokens).

**follow_redirects / max_redirects / http_version / stream** - the request's
execution options, surfaced in the request builder's **Settings** tab and
serialized as `followRedirects` / `maxRedirects` / `httpVersion` / `stream`. The
first three mirror the executable `vayu::Request` fields of the same name, so the
saved options are what `POST /execute` and `POST /runs` apply - `http_version`
governs both Send and load test alike; there is no separate per-run protocol
control.

**`stream` has no `vayu::Request` mirror**, deliberately (issue #574). It is not
a transfer option the executor applies but a choice of *which delivery path*
runs, read off the `POST /execute` payload by `read_stream_flag`; the column is
where the app's Event stream toggle persists so the choice survives a tab switch
and a bulk import carries it. `payload_from_stored` does not add it to a by-id
composition, so a client that pipes `POST /compose` into `POST /execute` - MCP's
`run_collection_smoke`, among others - still gets a buffered send rather than a
`202` it never asked to parse. **That stays true now that MCP can stream**
(issue #575): `run_request` sets `stream` from its own argument on every call
rather than inheriting it from a row, and the app's Code panel reads the flag off
the request row rather than out of the composed payload, for the same reason.

All four columns are `NOT NULL` with a `DEFAULT`, which is what lets
`sync_schema()` add them to an existing, non-empty `requests` table - a
`NOT NULL` column with no default cannot be added by `ALTER TABLE ADD COLUMN`.
Rows written before the columns existed backfill to `1` / `10` / `'auto'` / `0`,
i.e. the behaviour they already had (a row predating `http_version` could only
ever have run HTTP/1.1, since nghttp2 was not yet linked). `max_redirects` is
clamped to `0..100` on write.

**spec_operation** - which operation of the collection's bound
[`openapi`](#collections) document this request *is* (issue #637):

```json
{"operationId":"listPets","method":"GET","path":"/pets/{petId}"}
```

`method` and `path` are required and `operationId` is optional, because an
OpenAPI operation may declare none. `path` is the **templated** path from the
document, never a concrete URL - it is the identity a re-fetched spec is diffed
against and the key coverage counts by, and a substituted URL would match nothing
in the document it came from, so a `path` that does not start with `/` is a
`400`. Two requests may name the same operation.

Nullable rather than `NOT NULL` with a `"{}"` default, unlike the four columns
above: a request that answers to no operation declares nothing, and `NULL` is
that - `{}` would be a second spelling of the same absence for every reader to
handle. A nullable column is `ALTER TABLE ADD COLUMN`-friendly without a default.
Both request serializers emit it as `specOperation`, `null` when the column is,
and `apply_request_fields` applies it, so `POST`, `PUT` and `POST /import/apply`
all carry it.

**http_version** stores `Request::http_version` (the *requested* protocol, an
enum member spelled as text) - a different value and a different value space
from `Response::http_version`, the *negotiated* protocol string
(`"HTTP/1.1"` / `"HTTP/2"` / `""`) that lands in a design run's `trace_data`
(see [`results`](#results)) and the live `/execute` response. Conflating the
two would show a user a protocol they asked for but were not actually granted.
On create or on an explicit `null` reset, this column seeds from the
`defaultHttpVersion` [`config_entries`](#config_entries) row (`'auto'` unless
changed) - a write-time default only, never consulted at execution. Changing
the global afterward does not alter a request already saved.

---

### `request_examples`

Stores saved example responses for a request (issue #481) - what an importer
found next to it (Postman's `item.response[]`, an OpenAPI operation's
`responses`) and, once the mock server lands, what that server answers with.

| Column         | Type    | Notes                                             |
|----------------|---------|---------------------------------------------------|
| `id`           | TEXT PK | `exa_` + UUID                                     |
| `request_id`   | TEXT    | FK → `requests.id` (not enforced by SQLite FK)   |
| `name`         | TEXT    | Required on write; no default                     |
| `status`       | INTEGER | HTTP status, `100`-`599`; default 200             |
| `headers`      | TEXT    | JSON array of `KeyValueEntry[]`                   |
| `body`         | TEXT    | Response body, verbatim; capped (see below)       |
| `content_type` | TEXT    | Denormalized from `headers`; `""` when unstated   |
| `order`        | INTEGER | Sort order within the request; default 0          |
| `origin`       | TEXT    | `import` \| `user`; NOT NULL, default `import`     |
| `body_truncated` | INTEGER | `body` stops short of the captured response; NOT NULL, default `0` |
| `suppressed`   | INTEGER | A tombstone: an imported example the user deleted; NOT NULL, default `0` |
| `spec_example_key` | TEXT | The `examples` map key this was imported from; NULL when there is none |
| `created_at`   | INTEGER | Unix ms                                           |
| `updated_at`   | INTEGER | Unix ms                                           |

**headers** is the same `KeyValueEntry[]` shape a request's headers use, not the
JSON object [`result_bodies`](#result_bodies) and [`inbox_requests`](#inbox_requests)
store. A stored example is re-served rather than only displayed, so repeated
names (`Set-Cookie`) and the author's ordering both have to survive - an object
keeps neither.

**order** is what makes "the first example" a stable answer. A bulk import
writes every example of one request in the same millisecond, so `created_at`
ties for all of them and an id tiebreak would return the author's list
shuffled; `GET /requests/:id/examples` orders by `order`, then `created_at`,
then `id`. A create that states no `order` appends after the request's current
examples, exactly as a new request appends within its collection.

**origin** records who wrote the row (issue #588). It carries `default_value`
rather than being a fresh table's column, so `sync_schema` ALTERs it onto an
existing `request_examples` and every pre-existing row backfills to `import` -
which is what all of them are, since import was the only writer until the app
could save a live response as an example. It exists because the OpenAPI spec
sync replaces the examples a document produced and must leave the ones a person
saved alone, and nothing else about a row says which it is - `POST /specs/sync`
(issue #655) is the reader: applying a change to a request deletes that
request's `import` rows and writes the document's in their place. The rows are
the engine's own since issue #869 - the payload says only *whether* to refresh a
request's imported examples, and what is written is what the document being
stored documents - so a sync cannot manufacture a row it would then refuse to
replace, nor one for a response no document describes. The write paths validate it against those two
values and `400` on anything else; no read path in the app displays it.

**body_truncated** (issue #659) records that `body` is only the first slice of
the response it was captured from - the trace's `maxTraceBodyBytes` cap. Added
the same ALTER-friendly way as `origin`: NOT NULL with a `default_value`, so
`sync_schema()` adds it and every pre-existing row backfills to false, which is
what they all are (an importer copies a whole documented body; only the app's
save-as-example ever had a partial one). It is stored rather than inferred
because a short body is a legitimate body - nothing about the row says otherwise
- and a mock server serves the bytes verbatim, so an undisclosed partial example
is answered as though it were complete. The Examples panel is the reader,
painting a "Partial body" chip; before the column, the fact lived only in the
example's *name*, which the save dialog invites the user to edit.

**suppressed** (issue #722) marks a row as a tombstone: an `origin="import"`
example the user deleted. Added the same ALTER-friendly way as the two columns
above, and `false` is right for every pre-existing row - before it, a delete
removed the row. It exists because deleting an imported example otherwise
recorded nothing, while the sync refresh above rewrites every imported row of a
request it applies *any* change to, so the next rename-only sync re-created what
the user had removed. The row is kept so the refresh can skip that response
**status** (the identity a document's example keeps across a reworded
description, which its `name` does not), and `body`, `headers` and
`content_type` are cleared when the flag goes on, since nothing serves a
tombstone. `get_request_example`, `get_request_examples` and
`count_request_examples` all filter suppressed rows out - so the list route, a
mock server and an export behave exactly as though the delete had removed it -
and `get_suppressed_request_examples` is the one read that sees them, for the
one caller that must. A `user` row is still deleted outright: nothing re-creates
a saved response, so there is no intent to keep.

**spec_example_key** (issue #1457) records which entry of a 3.x response's
named `examples` map the import took this example's payload from - the *first*
one, unwrapped, since `firstNamedExample` never read past it. Nullable rather
than NOT NULL with a default, on the `requests.spec_operation` precedent: a row
that predates the column, or one taken from a single `example` or sampled off a
schema, names no entry, and NULL is the only spelling of that - there is
nothing to backfill it from. It exists because a value comparison alone cannot
tell an edited example from a new one: once its body has changed, it no longer
equals the entry it came from, so exporting it back would add it beside that
entry rather than replace it. The bound export reads the key to find its way
back to the same entry when the document still declares it, and falls back to
adding a new one when it does not. Not a display field: no app surface reads it.

**Cascade.** Examples are owned by their request: `DELETE /requests/:id` removes
them in the same transaction, and the `delete_collection` cascade removes each
descendant request's examples before the requests themselves. Every read here is
by `request_id` or by example id, so a row left behind would be unreachable
rather than merely stale. A tombstone is a row like any other and goes with the
same cascades.

**Caps.** A body over `request_example::MAX_BODY_BYTES` (1 MiB) is a `400`, never
a truncation - a half-body served as if whole is worse than a refused write - and
a request holds at most `MAX_PER_REQUEST` (100) examples. Both constants live in
`engine/include/vayu/core/constants.hpp`.

---

### `spec_documents`

Stores OpenAPI documents, bound to collections by
[`collections.openapi`](#collections) (issue #637).

| Column       | Type    | Notes                                              |
|--------------|---------|----------------------------------------------------|
| `id`         | TEXT PK | `spec_` + UUID                                     |
| `content`    | TEXT    | The document, verbatim; capped (see below)         |
| `source_url` | TEXT    | Where it was fetched from; NULL when pasted/uploaded |
| `fetched_at` | INTEGER | Unix ms                                            |
| `hash`       | TEXT    | Hex `sha256(content)`, computed engine-side        |
| `operations` | TEXT    | JSON array: the declared-operation index, `""` = none |
| `response_schemas` | TEXT | JSON object: the response schema index, `""` = none |

**content** is stored as text rather than a parsed model, because every feature
stacked behind this needs the *document*: the Spec tab renders it, sync
re-fetches and diffs against it, response validation resolves `$ref`s through it,
and export writes a new one beside it. A parse here would be re-done by each of
them anyway and would lose whatever the author wrote that the parser did not
model.

**hash** is the content+hash pair [`body_blobs`](#body_blobs) uses, and is
**never taken from the caller** - `POST /specs` and `POST /import/apply` both
compute it through `spec_content_hash`, and a body carrying `hash` or `fetchedAt`
is a `400`. A scenario run of a bound collection stamps `specId` + `specHash`
into its [`runs.config_snapshot`](#runs) under `scenario.openapi`, and that stamp
only means anything because both sides of a later comparison were computed by the
same code on the same bytes.

**Ownership, and why there is no cascade.** A spec is bound *by* collections
rather than owned by one: several may bind the same row, and unbinding one must
leave it there for the others. So no cascade deletes a document -
`DELETE /specs/:id` is refused with a `409` naming the binder while any
collection still names it. There is likewise no `PUT /specs/:id`: a document that
changed is a different document, and rewriting one in place would invalidate the
hash every run of every bound collection was stamped with.

**Lifetime, and the sweep that enforces it** (issue #718). Having no owner left
these rows with no way to die: every `POST /specs/sync` mints a new document and
moves the binding off the old one, unbinding leaves it, re-binding mints another,
and deleting a bound collection takes its requests and not the document - while
`DELETE /specs/:id` needs an id and there is no list route to get an unreachable
one from. Weekly syncs of a 12 MB document therefore stranded ~600 MB a year that
nothing could read or reclaim. The rule now, and the only one:

> A document lives while a collection binds it, **or** while a retained run names
> it in [`runs.config_snapshot`](#runs) under `scenario.openapi.specId`.

`Database::sweep_orphaned_spec_documents()` applies it and returns how many rows
went. Run-referenced documents live as long as the runs do, deliberately: a
scenario run stamps the `specId` it was planned against and its report describes
that contract, so the source has to outlive the binding by exactly the retention
window - which is why the sweep is the tail of `prune_runs_configured()`, the
pass that *releases* those references, and thereby runs on startup and at the end
of every run. It also runs after `spec_sync_apply` (the accretion source) and
after `delete_collection` (the last binder going away). Two rules keep it honest:
a document written within `SPEC_DOCUMENT_SWEEP_GRACE_MS` (10 min) is always
spared, because binding stores the document *before* the `PUT /collections/:id`
that names it and a document in that window is a bind in flight, not an orphan;
and the pass never throws or reads `content`, so no caller can fail over
housekeeping and no 10 MiB blob is loaded to decide its fate.

**Cap.** A document over the live `maxSpecDocumentBytes`
[`config_entries`](#config_entries) value (default 10 MiB, aligned with
`json::MAX_FIELD_SIZE`) is a `400` naming the size and the cap, on both write
paths - never a truncation, and never cpp-httplib's own body cap dropping the
connection without explaining itself.

**operations** is what the document *declares* - a JSON array of
`{operationId?, method, path, responses[]}` in document order - read by
[contract coverage](../app/openapi.md#contract-coverage) (issue #629).
**Derived, never supplied** (issue #853): the engine reads `content` as it stores
it (`core/openapi_document.cpp`, JSON first and YAML second) and writes this
column from that parse, the way it computes `hash` rather than taking one; a
write carrying an `operations` field is a `400`. One reader answers what a
document declares, which is what keeps this column agreeing with the
`spec_operation` stamped on each request. NOT NULL with a `default_value`, the
same migration shape `request_examples.origin` uses, so `sync_schema()` ALTERs it
onto an existing table and every pre-existing row backfills to `""`.

`""` means *no index*, which is not the same as a document declaring nothing: a
run of a collection bound to such a document reports no coverage block at all,
and `GET /specs/:id` reads the column back as `null` rather than `[]` so the two
stay distinguishable. A row can hold `""` because it predates the column, or
because the document declares no operation at all - a stored file that is not a
contract. Capped at 2000 rows on the write, which is refused with the count rather
than silently truncated.

**response_schemas** is what the document declares each response *looks like*
(issue #628) - a JSON object of `{refRoots?, operations: [{operationId?, method,
path, responses: [{status, contentType, schema}]}]}`, read when a response comes
back with a body to check. **Derived, never supplied** (issue #860), off the
*same* read as `operations`: a write carrying a `responseSchemas` field is a
`400`, and one read for both is what keeps them agreeing about which operation
declares which status.

A column of its own rather than a field on `operations` because the two are read
at different moments: the operation index is parsed when a run's plan resolves
and held for the run's whole life, while schemas are touched only per response -
and they are orders of magnitude larger.

`refRoots` holds the document's `components.schemas` / `definitions` /
`x-vayu-bundled` subtrees **once**, and each schema keeps its `$ref`s as written;
validation merges the two into one root document. Inlining instead would copy a
shared `Error` schema into every operation naming it, and a recursive schema - a
tree node whose child is itself - has no finite expansion at all. Schemas are
translated out of OpenAPI's dialect as they are derived (3.0's `nullable`, its
draft-04 boolean `exclusiveMinimum`, and the OpenAPI-only keywords that constrain
no body): the column holds JSON Schema and nothing else, because that is what the
validator reads.

`""` means *no index* on the same terms as `operations`: a response of such a
document reports `checked: false` with the reason `no_index`, never a body that
passed, and `GET /specs/:id` reads it back as `null`. The serialized index is
held to the same `maxSpecDocumentBytes` cap as the document, refused on the write
with the count and the cap rather than truncated.

The table itself was new when it landed, so `sync_schema()` created it outright;
`operations` and `response_schemas` are its migrated columns.

---

### `environments`

Stores named variable sets.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | `env_` + UUID                         |
| `name`       | TEXT    |                                       |
| `description`| TEXT    | Default `""`                          |
| `variables`  | TEXT    | JSON: `Record<string, VariableValue>` |
| `is_active`  | INTEGER | Boolean; 0 or 1. At most one row is 1 - see below |
| `created_at` | INTEGER | Unix ms                               |
| `updated_at` | INTEGER | Unix ms                               |

**`is_active` marks the environment clients resolve against by default, and at
most one row carries it.** The invariant is enforced in the DB layer, not the
routes: every write path that can store an active environment calls
`Database::deactivate_other_environments_locked` first, inside the same
transaction, so activating one environment deactivates the previous one
atomically - no reader can observe two actives, and none can observe an
intermediate zero. Three paths reach this table (`POST /environments`, `PUT
/environments/:id`, and `POST /import/apply`); putting the rule in the handlers
would mean repeating it in each, which is how this column previously ended up
honoured on create but not on update.

Writing `isActive: true` **is** the switch - there is no separate endpoint and
no companion request to clear the old one. Clearing entirely is spelled as
writing `isActive: false` to the environment that holds the flag, since there is
no "no environment" row to write `true` to.

Selecting is still a client action: the engine never *applies* an active
environment to a request, which must always name its own `environmentId`. What
changed is where the choice lives. Storing it here rather than in client-local
state is what makes it survive a restart and a reinstall, and what lets two
clients on the same database agree - the app mirrors it into
`session-store.ts` for synchronous reads and reconciles on launch
(`useActiveEnvironmentRestore`), treating the engine's value as the truth.

---

### `client_certificates`

The registry that maps a host to the client certificate Vayu presents to it
(issue #707). Read into the transport policy at the point of use - once per run
on the load and collection paths - and applied by the shared applier every
outbound transfer goes through. See
[api-reference.md](api-reference.md#client-certificates) for the routes and the
matching rule.

| Column       | Type    | Notes                                                     |
|--------------|---------|-----------------------------------------------------------|
| `id`         | TEXT PK | `cert_` + UUID                                            |
| `host`       | TEXT    | Hostname, lower-cased, no scheme/port/path, or `*.example.com` for every subdomain of it (issue #803). IPv6 without brackets |
| `port`       | INTEGER | NULL = answers for the host on every port                 |
| `cert_path`  | TEXT    | Path to the certificate file                              |
| `key_path`   | TEXT    | Path to the private key file; `""` for a `p12` entry, which carries its own |
| `cert_format`| TEXT    | `pem` or `p12` (issue #833). NOT NULL, default `pem` - what a row written before this column existed is |
| `passphrase` | TEXT    | The key's passphrase, `""` when it has none. **Plaintext** - see below |
| `created_at` | INTEGER | Unix ms                                                   |
| `updated_at` | INTEGER | Unix ms                                                   |

**The private key never enters this database.** `cert_path` and `key_path` are
paths, and the engine opens the files at send time - the strongest storage
decision available without a keystore, and the reason a registry entry survives
being copied between machines only if the files do.

**`cert_format` is stored rather than sniffed per send.** The applier runs on
every handle of every load run, so reading the file each time would pay for the
same answer thousands of times - and a format nothing recorded is one the
Settings card cannot print back for the user to correct. It is written once, at
the moment the entry is registered, from the body or from the file's own first
bytes; `client_cert_rejection` refuses a row whose bytes contradict it.

**The passphrase is stored in plaintext, and that is disclosed rather than
hidden.** It is the same treatment every other credential in this file already
gets - request auth, and `oauth_tokens.access_token` / `refresh_token` - and
libsodium, though linked, encrypts nothing here. OS-keychain storage is
explicitly out of scope for the transport epic (#704, decision 6); it would be
its own change, touching every stored credential rather than this one column.
The wire is narrower than the file: reads never echo the passphrase, answering
`hasPassphrase` instead.

`port` is nullable rather than a sentinel because "every port" is the *absence*
of a port, the same distinction `result_bodies.stream_events` draws. At most one
row may claim a given `host` + `port` pair - the routes answer `409` on the
second, and a wildcard pattern is a `host` like any other, so the rule covers it
unchanged. Several rows may still *match* one transfer once patterns overlap
(#803), and they are ranked rather than tie-broken: closest host, then port. A
tie would need the same host and port twice, which is the pair the `409`
forbids.

---

### `globals`

Singleton table; always has exactly one row with `id = "globals"`.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | Always `"globals"`                    |
| `variables`  | TEXT    | JSON: `Record<string, VariableValue>` |
| `updated_at` | INTEGER | Unix ms                               |

---

### `runs`

Stores design-mode and load-test run records. Defined in `database.cpp` (`make_table("runs", …)`);
struct is `db::Run` in `engine/include/vayu/types.hpp`.

| Column            | Type    | Notes                                                       |
|-------------------|---------|-------------------------------------------------------------|
| `id`              | TEXT PK | `run_` + UUID                                               |
| `request_id`      | TEXT    | FK → `requests.id` (optional; set in design mode)           |
| `environment_id`  | TEXT    | FK → `environments.id` (optional)                           |
| `type`            | TEXT    | `"design"`, `"load"` or `"scenario"` (a collection run)      |
| `status`          | TEXT    | `"pending"` / `"running"` / `"completed"` / `"failed"` / `"stopped"` |
| `config_snapshot` | TEXT    | JSON snapshot of the request/env at run time                |
| `start_time`      | INTEGER | Unix ms                                                     |
| `end_time`        | INTEGER | Unix ms; `0` = no end recorded (readers guard on `> 0`)      |
| `summary`         | TEXT    | JSON: whole-run results, written once at terminal status (`""` = not written) |
| `baseline`        | INTEGER | `1` when the run is pinned as a baseline. NOT NULL DEFAULT `0`               |

**`end_time`** is stamped on every terminal status write (`update_run_status`), and refined
mid-run by `update_run_end_time` when a load run finishes generating. Both inserts also *seed*
it to `start_time` up front (`seed_run_times`, `http/routes/execution.cpp`), because a run
killed by a daemon crash never reaches a terminal status: `reconcile_orphaned_runs` marks it
failed and leaves `end_time` as recorded, so an unseeded row would report a duration spanning
however long the daemon was down. `db::Run::end_time` defaults to `0` as the backstop for a
future insert site that forgets to seed - `0` is the "no end recorded" sentinel, and readers
(`GET /runs/:runId/report`, the app's dashboard) guard on `> 0`.

**`baseline`** is the pin set by
[`PUT /runs/:runId/baseline`](api-reference.md#put-runsrunidbaseline): the
known-good run later runs of the same request are compared against. Several rows
may carry it at once - the engine records the pin and leaves the choice of which
baseline applies to a given run to the client. NOT NULL with a `default_value`,
which is what lets `sync_schema` `ALTER TABLE ADD COLUMN` it onto an existing
`runs` table (the same pattern as `summary` and `requests.follow_redirects`);
rows written before the column read as unpinned. **Retention reads it** - see
below.

**`summary`** holds the aggregates `GET /runs/:runId/report` used to rebuild by scanning every
metric row of the run: totals, the cumulative latency percentiles, the status-code distribution,
bytes, and the script-validation tallies. It is written once - by `run_manager.cpp` when the run
reaches `completed`/`stopped`, and best-effort (minus `setup_overhead`, with a wall-clock
`test_duration`) when it fails. `""` means the engine died before the run reached a terminal
status, and the report then stands on the run's sampled `results` alone. NOT NULL with a `""`
default, so `sync_schema()` can
`ALTER TABLE ADD COLUMN` it onto an existing table (same pattern as `requests.follow_redirects`).

```json
{
  "total_requests": 100, "rps": 50.0, "send_rate": 51.0, "throughput": 49.5,
  "test_duration": 2.0, "setup_overhead": 0.25,
  "peak_concurrency": 8, "dropped_requests": 2, "queue_wait_avg": 1.5,
  "bytes_sent": 1024, "bytes_received": 8192,
  "status_codes": { "200": 90, "500": 7, "0": 3 },
  "latency": { "min": 1.0, "max": 90.0, "avg": 12.5, "p50": 10.0, "p75": 15.0,
               "p90": 20.0, "p95": 25.0, "p99": 30.0, "p999": 35.0 },
  "phases": {
    "dns":       { "p50": 0.1, "p95": 0.2, "p99": 1.4,  "max": 12.0, "count": 100 },
    "connect":   { "p50": 0.3, "p95": 0.9, "p99": 8.2,  "max": 40.1, "count": 100 },
    "tls":       { "p50": 0.0, "p95": 0.0, "p99": 22.0, "max": 61.0, "count": 100 },
    "firstByte": { "p50": 2.9, "p95": 4.0, "p99": 6.1,  "max": 30.0, "count": 100 },
    "download":  { "p50": 0.1, "p95": 0.3, "p99": 0.9,  "max": 4.2,  "count": 100 }
  },
  "tests": { "sampled": 10, "passed": 9, "failed": 1 },
  "thresholds": {
    "checks": [ { "metric": "latencyP99Ms", "limit": 50, "actual": 30.0, "passed": true } ],
    "passed": 1, "failed": 0
  },
  "schemaValidation": {
    "sampled": 40, "checked": 36, "valid": 30, "failed": 6, "unevaluated": 0,
    "uncheckedReasons": { "body_not_json": 4 },
    "failures": [ { "step": "get pet", "status": 200, "path": "/id", "message": "..." } ],
    "failuresTotal": 6
  }
}
```

`phases` carries the whole-run distribution of each network phase, drained from the collector's
five per-phase HdrHistograms - which every successful completion feeds, unlike the sampled
`results` rows the report's `timingBreakdown` averages come from. Keyed by wire name (`firstByte`,
not `ttfb`), and the only section here written in camelCase, because the report passes it through
verbatim rather than translating it. **Omitted** when the run recorded no distribution - the
`phaseHistograms` setting (or the run's own `phase_histograms`) off, or nothing successful
completed - which keeps the report's `timingBreakdown.phases` absent rather than showing five
zeroed rows; a zeroed TLS row would claim the handshake was free, which is a different statement
from "this run did not measure it". A zero *inside* a present section is meaningful and kept: a
run over reused connections genuinely has a TLS p50 of 0.

`tests` is **omitted** when deferred script validation did not run, which is what keeps the
report's `testValidation` section absent rather than reporting zero tests. `schemaValidation`
follows the same rule (issue #682): omitted when the deferred pass over the run's sampled
responses walked nothing, so an unbound collection's report carries no block rather than one
saying its contract held. Written in camelCase because the report passes it through verbatim,
the `phases` rule. Its `sampled` count is stored rather than derived because it is the
denominator that says these tallies describe the run's bounded reservoir and not the run -
unlike `coverage` beside it, which is exact. `thresholds` follows
the same rule and for the same reason: absent when the run declared no
[budgets](api-reference.md#the-thresholds-block-passfail-budgets), so the report's
`thresholdValidation` section is left out rather than claiming a run passed nothing. Its `metric`
keys are the wire names the payload declared, carried through unchanged; the report derives
`verdict` from `failed` rather than storing it, so the two cannot contradict. The writer is
`vayu::core::build_run_summary_payload` and the reader is `apply_run_summary`
(`http/routes/runs.cpp`); `runs_route_test.cpp` round-trips the pair, so the key names cannot
drift apart silently.

Do not confuse this **results** summary with the `summary` key on a `GET /runs` list row - that
one is a derived view of `config_snapshot` (url/method/mode/duration/concurrency/comment) and is
never stored. It is built once per run id and held in a bounded in-memory cache
for as long as the process lives (issue #1150), which is sound only because
`config_snapshot` is write-once: `create_run` sets it, and every later write to a
run row - status, end time, summary, baseline, the startup reconcile - is a
read-modify-write that puts the same string back. **A change that edits a stored
snapshot in place breaks that**, and would have to invalidate the cache in
`engine/include/vayu/http/run_summary_cache.hpp`.

**A scenario run's `summary`** is a different shape, written by
`vayu::core::build_scenario_summary_payload` (`core/scenario_runner.cpp`): the
three keys `apply_run_summary` reads plus everything sequence-shaped under
`scenario`, which the report serves as its own section.

```json
{
  "total_requests": 6, "test_duration": 1.8, "rps": 3.3,
  "scenario": {
    "iterations": 3, "iterations_completed": 3, "steps_executed": 6,
    "passed": 4, "failed": 1, "skipped": 0, "errored": 1,
    "steps_stored": 6, "steps_dropped": 0
  }
}
```

`total_requests` is the number of **step executions**, and it is here precisely
because the report would otherwise count the rows that survived
`maxScenarioStoredSteps` and call that the run's size. `steps_dropped` is what
that cap thinned - always successes, never a failure.

**`config_snapshot` redaction** - the snapshot is the raw run payload, which can
carry auth credentials. Before persistence, its top-level `auth` object is
reduced to just `{"mode": "..."}` (via `sanitize_config_snapshot` in
`utils/json.cpp`) - an allowlist, so no current or future auth field
(`clientSecret`, `password`, tokens) leaks into a stored run.

**`config_snapshot` for a scenario run** - a run started from a `scenario` block
(see [POST /runs](api-reference.md#post-runs)) stores a **step manifest**, never
the resolved plan. The manifest *replaces* the block as sent, rather than
sitting beside it (`scenario_snapshot`, `http/routes/execution.cpp`).

```json
{
  "source": "collection", "collectionId": "col_123", "recursive": false,
  "iterations": 3, "dataRowCount": 2,
  "steps": [
    { "index": 0, "requestId": "req_1", "name": "Log in",
      "url": "https://{{host}}/login", "method": "POST" }
  ]
}
```

`url` is the **stored, uncomposed** one. The resolved plan is credential-grade -
it carries resolved `Authorization` headers, and an `apikey` auth with
`in: "query"` puts a live key in the composed URL - so persisting it would route
around the `auth` allowlist above rather than respect it. The plan lives in
memory for the run's life and nowhere else. Inline `data` rows are not
snapshotted either: they are user data of unknown sensitivity, and the manifest
records only their count. The writer is `vayu::core::build_scenario_manifest`
(`core/scenario_plan.cpp`).

**Retention** - runs are append-only in normal use (every design-mode click adds a `runs` row,
every load run its `metric_ticks`/`results`), so `Database::prune_runs(max_runs, max_age_days)` trims
the history. A run is a victim when it falls **beyond the `maxRunsRetained` most-recent runs**
(ordered by `start_time`) **or** its `start_time` is older than **`runRetentionDays`** days;
either knob is disabled by `0`. Runs still `running`/`pending` are never pruned and never count
toward the cap, and neither are runs whose `baseline` is set: a pin that retention can expire is
not a pin, and pins counting toward the cap would let a handful of them evict the recent history
the cap exists to keep. Deletion goes through the `delete_run` cascade (runs + their `metric_ticks` +
their `monitor_samples` + their `results`), batched inside transactions that release the DB mutex between batches so a large
backlog cannot stall `/health`, SSE, or the runs poll. The cascade itself lives in one function
(`remove_run_cascade_locked`), which both `delete_run` and `prune_runs` call, so a new child table
is wired into both at once. `prune_runs_configured()` reads the two
knobs (config, `data_retention`, defaults 200 / 30) and runs at **startup** (`Database::init`) and
after a run reaches a **terminal** status (design mode's `store_result`, and the load-run
completion/failure paths in `run_manager.cpp`). What a prune frees is disk the file keeps until
[Reclaiming freed pages](#reclaiming-freed-pages) gives it back.

---

### `oauth_tokens`

Cached OAuth 2.0 access/refresh tokens, keyed by config identity. Written by the
token client (`engine/src/http/oauth_client.cpp`); struct is `db::OAuthToken`.
Auto-created by `sync_schema()`.

| Column          | Type    | Notes                                                             |
|-----------------|---------|-------------------------------------------------------------------|
| `cache_key`     | TEXT PK | `accessTokenUrl \x1f clientId \x1f credentialsId \x1f username?` - byte-identical to the app's `computeOAuth2CacheKey` (omits scope/audience/resource) |
| `access_token`  | TEXT    | Bearer token (plaintext at rest)                                  |
| `token_type`    | TEXT    | Defaults to `"Bearer"` when the provider omits it                 |
| `refresh_token` | TEXT    | `""` when none                                                    |
| `scope`         | TEXT    | Granted scope, if returned                                        |
| `expires_in`    | INTEGER | Seconds; `0` = non-expiring                                       |
| `created_at`    | INTEGER | Unix ms                                                           |
| `raw_response`  | TEXT    | Provider JSON (truncated to 4 KB); debugging only, never logged   |

Expiry is `now > created_at + expires_in*1000 − 45s` (skew). On refresh the
`refresh_token` rotates when the provider issues a new one; a rejected refresh
token clears the row and falls back to a fresh grant.

A load run **does** refresh mid-run: a run whose auth resolves to a
header-placed, expiring oauth2 token gets a watchdog thread that re-acquires
`oauth2RefreshLeadMs` (default 60s) before expiry, writes the new row here and
republishes the header onto every later transfer. That lead, the floor between
two renewals (`oauth2RefreshMinIntervalMs`), the retry backoff after a refused
renewal (`oauth2RefreshRetryMs` doubling to `oauth2RefreshRetryMaxMs`) and how
often the watchdog wakes to notice the run ended (`oauth2RefreshPollIntervalMs`,
which bounds how long a finished run waits to join it) are all settings under
**Services**, read once when a run arms its watchdog, so a change
applies to the next run started. It stays out of the way
for the shapes it cannot renew - `tokenPlacement: "query"` (the credential is in the
URL every transfer copies), `autoRefreshToken: false`, an `authorization_code`
grant with no refresh token, a non-expiring token, and a scenario load run
(whose steps each resolved their own auth at plan time). Each refresh, and any
failure, is reported in the run's `auth` section; a failed refresh never fails
the run. See `plan_auth_refresh` (`engine/src/http/auth_resolver.cpp`) and
`run_auth_refresh` (`engine/src/core/auth_refresh.cpp`).

Tokens are plaintext at rest (v1 posture); the row is cleared via
`DELETE /oauth2/token`.

---

### `metric_ticks`

The time series for a load test: **one wide row per persisted tick** (~1/s), written by the
metrics producer thread. Struct is `db::MetricTick`. Auto-created by `sync_schema()`.

| Column      | Type       | Notes                                          |
|-------------|------------|------------------------------------------------|
| `id`        | INTEGER PK | Autoincrement                                  |
| `run_id`    | TEXT       | FK → `runs.id`                                 |
| `timestamp` | INTEGER    | Unix ms - the tick's single wall-clock sample  |
| `payload`   | TEXT       | JSON: the complete tick object (below)         |

`payload` **is** one `data[]` entry of `GET /runs/:runId/metrics` - the app's snake_case
`LoadTestMetrics` shape, built once at write time by
`vayu::core::build_metric_tick_payload` instead of being reassembled per request:

```json
{
  "timestamp": 1730000001000, "elapsed_seconds": 1.0,
  "requests_completed": 120, "requests_failed": 2,
  "current_rps": 118.4, "current_concurrency": 10, "send_rate": 120.0,
  "throughput": 118.4, "backpressure": 3, "error_rate": 1.66,
  "dropped_requests": 0, "bytes_sent": 4096, "bytes_received": 65536,
  "status_codes": { "200": 118, "0": 2 },
  "latency_p50_ms": 8.1, "latency_p95_ms": 20.4, "latency_p99_ms": 31.9
}
```

Two consequences of the row being the tick:

- **Pagination is tick-aligned.** `GET /runs/:runId/metrics` pages rows, and a row is a whole
  tick, so a page boundary can no longer hand back a half-populated bucket (which row-paginating
  the retired EAV `metrics` table did every ~277 ticks).
- **`elapsed_seconds` is measured from the run's first persisted tick**, at write time, so it
  keeps counting across page boundaries instead of restarting at 0 on each page.

Latency percentiles in a tick are the **windowed** (rolling) values sampled from the
`hdr_interval_recorder` for that interval - the whole-run cumulative ones live in
[`runs.summary`](#runs), never here.

---

### `monitor_samples`

The **server vitals** a run scraped from a target endpoint it was configured to
watch (`monitor` on `POST /runs`): one row per successful scrape, written by the
run's own scrape thread. Struct is `db::MonitorSample`. Auto-created by
`sync_schema()`.

| Column      | Type       | Notes                                          |
|-------------|------------|------------------------------------------------|
| `id`        | INTEGER PK | Autoincrement                                  |
| `run_id`    | TEXT       | FK → `runs.id`                                 |
| `timestamp` | INTEGER    | Unix ms - when the engine scraped              |
| `payload`   | TEXT       | JSON: the sample object (below)                |

`payload` **is** one `data[]` entry of `GET /runs/:runId/monitor`, and the
`data:` of a live `monitor` SSE frame - one shape for both, built by
`vayu::core::build_monitor_sample_payload`:

```json
{
  "timestamp": 1730000001000,
  "series": { "node_cpu_seconds_total": 3.75, "process_resident_memory_bytes": 1048576 }
}
```

**Its own table rather than wider `metric_ticks` rows.** That payload's key set
is the `GET /runs/:runId/metrics` contract, pinned by `stats_route_test.cpp`;
and a scrape lands on the user's own cadence (250-60000ms), which does not line
up row for row with the 1/s tick. A scrape that read nothing writes no row at
all - a stored sample with no readings would draw a line through a hole in the
data - so gaps are counted in the run summary's `monitor.failures` instead.

Deleted with the run by the same cascade (`remove_run_cascade_locked`).

---

**The EAV `metrics` table this replaced is gone.** It stored one row per
(`run_id`, `name`, `timestamp`) sample, ~20 rows per second of a run, and was kept read-only
after the switch so runs recorded by an older engine still rendered. Retention deletes those
runs within `runRetentionDays`, so the read path outlived its data; it was removed in issue #177,
along with the `MetricName` enum and `db::Metric`. `sync_schema()` only syncs the tables the
storage still declares - it never drops one that was removed from it - so `Database::init()`
issues an explicit `DROP TABLE IF EXISTS metrics`, and an upgraded database sheds the table and
its rows on first start. The freed pages return to SQLite's freelist for reuse; the file itself
shrinks only when the guarded reclamation at the end of `Database::init()` decides they are worth
a rewrite - see [Reclaiming freed pages](#reclaiming-freed-pages).

---

### `results`

Individual request outcomes - all errors plus sampled successes (sampling is configurable in
`MetricsCollector`). Struct is `db::Result`.

| Column        | Type       | Notes                                                        |
|---------------|------------|--------------------------------------------------------------|
| `id`          | INTEGER PK | Autoincrement                                                |
| `run_id`      | TEXT       | FK → `runs.id`                                               |
| `timestamp`   | INTEGER    | Unix ms                                                      |
| `status_code` | INTEGER    | HTTP status, or **0 for transport errors** (so totals reconcile) |
| `status_text` | TEXT       | Wire reason phrase or canonical IANA text                    |
| `latency_ms`  | REAL       | **Perceived** latency (`completion − submitted_at`), not wire time |
| `error`       | TEXT       | Error message for failures; empty on success                 |
| `trace_data`  | TEXT       | JSON (headers/body/timing breakdown) - design mode + errors + slow samples |

A load run's captured response headers and bodies are **not** here - they live in
[`result_bodies`](#result_bodies) / [`body_blobs`](#body_blobs). That split is load-bearing:
`Database::get_results` loads every row for a run with no limit and
`calculate_detailed_report` JSON-parses each `trace_data` on every report fetch, which the
dashboard polls. At ~200 bytes per trace that is free; with bodies inline it would be megabytes
read and parsed per poll, to compute aggregates that never look at a body.

`trace_data` timing keys are all in ms and carry the `Ms` suffix: `totalMs`, `wireMs`,
`queueWaitMs`, `dnsMs`, `connectMs`, `tlsMs`, `firstByteMs`, `downloadMs`. `totalMs` is perceived
latency; `wireMs` is libcurl's `CURLINFO_TOTAL_TIME`; `queueWaitMs = totalMs − wireMs` is time
spent queued inside the generator.

**The writers store different subsets, at different nesting**, so read the one you need rather
than assuming all eight are there and flat:

| Writer | What lands in `trace_data` |
|--------|----------------------------|
| Load run, success sample (`load_strategy.cpp`) | timing only, flat, all eight keys. Written for a completion the 1-in-`success_sample_rate` sampler selects (only while `save_timing_breakdown` is on), **or** one that crossed `slow_threshold_ms` (which also adds `isSlow` / `thresholdMs`, and is stored whether or not the breakdown toggle is on). The two have separate retention budgets - `max_success_results` and `max_slow_results` - and an outlier never consumes a sampling slot. A **scenario** load run started with `scenario.data` adds **`dataRowIndex`**, the row that iteration bound - the only per-result record of it, since a scenario load run stores no per-step rows. |
| Load run, error (`load_strategy.cpp`) | an error envelope (`error_type`, `message`, `request_number`) with the eight keys **nested under `timing`**, present whenever `totalMs > 0`, plus **`dataRowIndex`** for a scenario load run given `scenario.data`. A `data_binding_failed` error is written for a request that was never sent at all - a `{{data.column}}` naming a column its row does not carry - so it has no timing. |
| Design mode (`store_result` in `execution.cpp`) | all eight keys flat, unconditionally - the same set the live `/execute` response carries, so a restored response shows exactly what the live one did (a skipped phase is stored as `0`). Written on **every** single request, alongside a nested `request` object plus either `response` (success) or `error_type` / `error_message` (failure). The `response` node carries `headers`, `body`, `httpVersion` - the negotiated protocol, `""` when nothing was negotiated, same convention as the live `/execute` response (see [POST /execute](api-reference.md#post-execute)) - and `httpVersionDowngraded`, true when the request asked for HTTP/2 and got something older; a row written before either field existed simply has no such key, so `restore-response.ts` must default both. Rows written by older engines omitted zero-valued phases and all of `totalMs`/`wireMs`/`queueWaitMs`, so readers must default missing keys (perceived total also lives in the `latency_ms` column). |

| Scenario run, one row per step execution (`core/scenario_runner.cpp`) | the design-mode writer's trace exactly - it *is* `build_result_trace` - plus five keys naming the step: `iteration` (0-based), `stepIndex`, `stepName`, `requestId` and `outcome` (`passed` / `failed` / `skipped` / `errored`), and a sixth, **`dataRowIndex`**, present only for a run given `scenario.data` - the row that iteration bound, which is the only record of *which* row a wrapped pass re-used. The rows themselves are never stored; the snapshot keeps `dataRowCount` alone. A `skipped` row - a pre-request script called `pm.execution.skipRequest()` - carries the `request` node and **no `response`**, because nothing was sent; `restore-response.ts` already answers `null` for that shape rather than building a hollow 0-byte response. Bodies are capped the same way. The row count is bounded by **`maxScenarioStoredSteps`** (config, `data_retention`, default 5000; `0` = unlimited), biased so that every step that did not pass is kept and successes fill the remainder - what was thinned is reported in `runs.summary`, never silently. |

A **streaming** design run (`POST /execute` with `"stream": true`, issue #573)
adds one node the others never carry: **`events`**, holding `items` (the first
`sseMaxStoredEvents` events, each with `event` / `data` / optional `sourceId` /
`receivedAt`, and `dataTruncated` + `dataBytes` on one that hit the per-event
cap), `totalEvents` (every event received, whatever was stored), `eventsTruncated`
(true when the two differ) and `endReason`. `cap_trace_bodies` walks the
request/response *body* nodes and does not reach this one, so its cap is applied
when the node is built rather than when the trace is stored - which is why
`eventsTruncated` is computed from the true total rather than derived from
whatever the cap happened to be.

The `request` node also carries **`rawRequest`** - the message the transfer actually put on the
wire, the same string the live [`POST /execute`](api-reference.md#post-execute) response returns
(issue #348). It is what a restored raw-request view reads, because it is the only copy that
carries what libcurl added on our own behalf: the [cookie jar](architecture.md#cookie-jar)'s
`Cookie` line, `Accept`, the real `Content-Length`. Values in it are **not redacted**, matching
the live field's contract - it lands in the same node that already stores the resolved
`Authorization` header among `request.headers` (see [Security](architecture.md#security) for why
this column and `runs.config_snapshot` answer differently). The key is **absent** on a step that
sent nothing (a `pm.execution.skipRequest()`) and on every row written before #348, so a reader
falls back to rebuilding the view from `method`/`url`/`headers`/`body` -
`restore-response.ts`'s `sentSide` is that reader.

The `request` node carries a second header map, **`sentHeaders`** - the record of what the
transfer issued, the same map the live [`POST /execute`](api-reference.md#post-execute) response
returns as `requestHeaders` (issue #664). It is `headers` minus the entries the transfer
suppresses (a `form-data` `Content-Type`, which libcurl writes itself with the boundary) and the
value-less ones libcurl drops, plus what the engine derives at send time: the body-implied
`Content-Type` and the [default headers](api-reference.md#default-request-headers) this send
added - the `User-Agent`, a negotiated `Accept-Encoding`, a correlation id where one is switched
on. None of those is written into the request row itself (issue #1229): they are applied per send,
so a stored request cannot carry a stale one. Both maps are stored because both are read, and they
answer different questions - `sentHeaders` is what the response pane's sent-headers disclosure
means, while `headers` is the request as *composed*, which is what a pre-request script saw and
what `design-run-seed.ts` reseeds a request tab from. Values are **not redacted**, same contract
as `rawRequest` beside it. The key is **absent** on a step that sent nothing and on every row
written before #664, so a reader falls back to `headers`. The load-run writers store no sent
record at all - the load driver passes `nullptr` for it, to keep an allocation off the hot path -
so a sampled capture's replay reads the composed map either way.

The design-mode `request.body` and `response.body` are **capped at `maxTraceBodyBytes`**
(config, `data_retention`, default 5 MiB) before storage, so downloading one 50 MB response does
not live in SQLite forever. `request.rawRequest` ends with that same body and is capped to the
same limit, **body half only** - its header block is never cut, being the reason the field is
stored at all. When a body is cut, its node gains two keys:

| Key on `request` / `response` | Type | Meaning |
|-------------------------------|------|---------|
| `bodyTruncated`               | bool | Present and `true` only when the stored `body` is a prefix, not the whole body |
| `bodyBytes`                   | int  | The **original** body length in bytes (the stored `body` is the first `maxTraceBodyBytes` of it) |

The cut is on a raw byte boundary (the body is an opaque string), so a split UTF-8 sequence is
possible; `store_result` dumps the trace with `error_handler_t::replace`, turning a stray
continuation byte into U+FFFD rather than throwing. The cap is applied by
`vayu::json::cap_trace_bodies` (`utils/json.cpp`) to the trace `build_result_trace`
(`http/request_exchange.cpp`) produces. It applies to the design-mode writer and
to the scenario runner, which shares that trace builder - the load-run writers
store timing/error envelopes, not bodies.

That design-mode subset is what rebuilds the request builder's response pane (Timing tab included)
after a restart - see `app/src/modules/request-builder/utils/restore-response.ts`, which surfaces
`bodyTruncated`/`bodyBytes` as a "body truncated for storage" notice.

A design run has exactly one `results` row. `GET /runs/:runId` serves it (as `result`)
alongside the run itself, in addition to `GET /runs/:runId/report`'s `results` array - the
same row, read by two routes for two different callers.

---

### `result_bodies`

The response captured for one sampled **load-run** result, one-to-one with a `results` row.
Struct is `db::ResultBody`. Read only by [`GET /runs/:runId/samples`](api-reference.md#get-runsrunidsamples);
nothing on the report path touches it.

| Column         | Type       | Notes                                                              |
|----------------|------------|--------------------------------------------------------------------|
| `result_id`    | INTEGER PK | The `results.id` this exchange belongs to (not autoincrement)      |
| `run_id`       | TEXT       | FK → `runs.id`; what the run cascade and the endpoint filter on    |
| `headers`      | TEXT       | JSON object of the response headers, as received                   |
| `blob_id`      | INTEGER    | FK → `body_blobs.id`, or **0** when no body was stored             |
| `body_bytes`   | INTEGER    | Size of the body **as received**, before any truncation            |
| `truncated`    | INTEGER    | 1 when the stored bytes are a prefix (`maxSampleBodyBytes`)        |
| `binary`       | INTEGER    | 1 when the body was stored as a descriptor rather than as text     |
| `content_type` | TEXT       | The response's `Content-Type`, `""` when it sent none              |
| `stream_events` | INTEGER   | Events the transfer delivered when it was a **stream**; NULL otherwise, and NULL on every row written before 0.17.2 |

**Which completions get a row.** Not a uniform sample - a uniform slice of a 30M-request run is
a thousand identical 200s. Three buckets, all decided before anything is copied:

| Bucket | Bound |
|--------|-------|
| Every error | `maxStoredErrors` (the error store's own cap) |
| Slow outliers | `max_slow_results`, the existing slow-request reservoir |
| The first `EXEMPLARS_PER_STATUS` (3) of each distinct status code | `max_exemplar_results` (64), and unlike its neighbours **not** a reservoir - an exemplar that gets displaced is not an exemplar |

The buckets overlap, and the overlap resolves toward the *other* store: an
outlier that is also one of its status code's first three stays charged to the
slow budget, and a sampled completion stays charged to the sampling budget. The
exemplar store holds only what no other budget wanted. Claiming an exemplar is
what decides that a **body** is captured, separately from which budget pays - so
a completion that is both sampled and an exemplar is stored as a sample and
still keeps its body.

**`stream_events` is a count, not a list.** The stored body of a streaming
sample already *is* the `text/event-stream` bytes, so
[`GET /runs/:runId/samples`](api-reference.md#get-runsrunidsamples) parses the
events back out of it with the same `SseParser` the live path feeds rather than
storing a second copy that could disagree with the first. What a reader cannot
recover from those bytes is how many events the transfer actually delivered -
the body may be a prefix - so that one number is stored beside them. NULL means
"this was not a stream", which is why the column is nullable rather than
defaulted to 0.

A uniformly sampled success (`success_sample_rate`) is deliberately body-less.

**Budgets.** `maxSampleBodyBytes` (config, `data_retention`, default 32 KiB) caps a single body;
`maxSampleBytes` (default 2 MiB) is the whole-run budget. Once the run budget is spent, samples
keep their headers and metadata and lose only their bodies - the row then has `blob_id = 0` with
`body_bytes > 0`, and `runs.summary`'s `sampling.sample_bodies_dropped` counts them, so the UI
can say the set is incomplete rather than presenting a biased subset as the whole story. Both
defaults are far below design mode's `maxTraceBodyBytes` (5 MiB): a design run stores one
exchange the user asked for, a load run stores tens nobody asked for individually.

**Binary bodies.** Since issue #1229 the engine negotiates compression by default and libcurl
decodes what it negotiated, so a gzip response is stored decoded - but a request carrying its own
`Accept-Encoding`, or a run with `loadNegotiateCompression` off against a server that compresses
anyway, still yields compressed bytes; images and protobuf arrive that way regardless.
Those are stored as a descriptor (`binary = 1`, `blob_id = 0`, with `body_bytes` and
`content_type`), never as text - `error_handler_t::replace` would keep `dump()` from throwing and
hand the reader a mojibake that reads like a real response. The rule is
`vayu::core::looks_binary` (`core/sample_capture.cpp`): a content type that is not text-shaped,
or a bounded prefix that is not valid UTF-8 / contains a NUL.

**No redaction.** Captured data is stored verbatim, consistently with design-mode traces, which
already store request headers as sent. A response `Set-Cookie` is captured along with everything
else. The mitigation is the run's own marker - `sampling.response_bodies_captured` in
`runs.summary` - which the Samples tab reads to warn, plus the run cascade below, which makes
`maxRunsRetained` the expiry for anything credential-shaped a capture picked up.

**Per-run request.** There is deliberately no per-sample request copy: a load run's request is
constant across iterations and already lives in `runs.config_snapshot`, and the event-loop path
never populates `Response::request_headers` at all (only the synchronous `client.cpp` does).

---

### `body_blobs`

One row per **distinct** captured body within a run - the dedup table. Struct is `db::BodyBlob`.

| Column    | Type       | Notes                                                            |
|-----------|------------|------------------------------------------------------------------|
| `id`      | INTEGER PK | Autoincrement; `result_bodies.blob_id` points here               |
| `run_id`  | TEXT       | FK → `runs.id`; scopes dedup to one run                          |
| `hash`    | TEXT       | Lowercase hex SHA-256 of `content` (`vayu::core::body_digest`)   |
| `content` | TEXT       | The stored bytes, already truncated to `maxSampleBodyBytes`      |

Load-test responses are overwhelmingly identical, so 1000 samples of one 2 KiB body store 2 KiB,
not 2 MB. The digest is taken over the **stored** (already truncated) bytes: two bodies that
differ only past the truncation point are byte-identical as stored, and storing them twice would
be storing the same row twice.

Dedup is scoped per run rather than globally so that deleting a run deletes its blobs with no
cross-run refcount to maintain. Both tables are removed by `remove_run_cascade_locked` - bodies
before the results they hang off, so a delete interrupted between the two leaves results without
bodies rather than body rows pointing at nothing.

Both tables are new in 0.15.0. `sync_schema()` creates new tables outright, so there is no
migration: an existing database picks them up on the next startup and older runs simply have no
rows in them.

---

### `inbox_requests`

What a [webhook inbox](api-reference.md#webhook-inbox) listener captured. Struct is
`db::InboxRequest`.

| Column           | Type       | Notes                                                            |
|------------------|------------|------------------------------------------------------------------|
| `id`             | INTEGER PK | Autoincrement; also the SSE event id on `GET /inbox/:id/live`     |
| `inbox_id`       | TEXT       | The inbox that recorded it - **not** an FK; inboxes are in memory |
| `received_at`    | INTEGER    | Unix ms                                                          |
| `method`         | TEXT       | Any verb cpp-httplib routes (GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS) |
| `path`           | TEXT       | Decoded path, no query                                            |
| `query`          | TEXT       | Raw query string, without the `?`                                 |
| `headers`        | TEXT       | JSON object; a repeated name is joined with `, `                  |
| `body`           | TEXT       | Stored bytes, truncated to the `inboxMaxBodyBytes` setting (default 64 KiB) |
| `body_bytes`     | INTEGER    | Size **as received**, which exceeds `length(body)` when truncated |
| `body_truncated` | INTEGER    | 1 when `body` is a prefix                                         |
| `remote_addr`    | TEXT       | Peer address the request arrived from                             |

**Bounded as it is written.** `add_inbox_request` inserts and trims in one transaction, keeping the
newest `inboxMaxCaptures` rows per inbox (default 500, settable 1-10000) and deleting the oldest by
`id` - insertion order, which for an append-only table is arrival order and, unlike `received_at`,
cannot tie. A capture the caller was told had landed can therefore never be missing its insert, nor
an untrimmed table its bound. The retention and body limits are resolved by `read_inbox_limits`
once, when the inbox starts, so every row belonging to one inbox was truncated and retained by the
same rule - see [api-reference.md](api-reference.md#webhook-inbox) for the settings.

**Cleared at startup.** An inbox lives only as long as the engine process that opened it, so after
a restart every row here belongs to an inbox nothing can list. `Database::init` calls
`clear_inbox_requests_all` for the same reason it reconciles orphaned runs: the previous process's
leftovers are dealt with before anything can read them. Rows are stored at all - rather than kept
on the heap - so a long-lived listener's capture list is paged off disk instead of growing a
running daemon's memory.

New in 0.16.0. `sync_schema()` creates new tables outright, so there is no migration.

---

### `config_entries`

Engine configuration registry - each tunable setting with UI metadata. Read by `GET /config`,
written by `POST /config`. Struct is `db::ConfigEntry`.

| Column          | Type    | Notes                                                  |
|-----------------|---------|--------------------------------------------------------|
| `key`           | TEXT PK | e.g. `workers`, `dbCacheSize`, `liveTickIntervalMs` |
| `value`         | TEXT    | Current value (parsed per `type`)                      |
| `type`          | TEXT    | `"integer"` / `"string"` / `"boolean"` / `"number"` / `"enum"` |
| `label`         | TEXT    | Display label                                          |
| `description`   | TEXT    | Help text                                              |
| `category`      | TEXT    | Which sidebar row it renders under; one of `general_engine`, `network_performance`, `services`, `observability`, `data_retention`, `limits`, `scripting_sandbox` |
| `default_value` | TEXT    | Default as string                                      |
| `min_value`     | TEXT    | Optional minimum (numbers)                             |
| `max_value`     | TEXT    | Optional maximum (numbers)                             |
| `options`       | TEXT    | JSON array of `{value, label}`; `"enum"` entries only  |
| `updated_at`    | INTEGER | Unix ms                                                |
| `requires_restart` | INTEGER | Boolean; the running engine keeps the old value until restarted |
| `advanced`      | INTEGER | Boolean; an internal, rendered collapsed under "Advanced" |
| `keywords`      | TEXT    | JSON array of extra search terms; `"[]"` when the entry declares none |
| `unit`          | TEXT    | What a numeric value measures (`ms`, `sec`, `days`, `bytes`); NULL for a count |

**category** is a closed set, and it is the app that closes it: the renderer
draws one sidebar row per category it declares
(`app/src/modules/settings/engine-categories.ts`) and drops an entry whose
category it does not know, so a value outside the list above is a setting with
no screen. `seed_default_config` is the only writer, and two guards pin the two
lists against each other from opposite sides:
`ConfigRouteTest.EverySeededEntrySitsInADeclaredCategory` reads the seeded rows
against a set copied into the C++ test, and `engine-categories.test.ts` reads
`database.cpp` itself against the renderer's registry - so a category added to
the seed and to the C++ set but forgotten in the app still fails. Reseeding rewrites an existing row's metadata while keeping
its value, which is how a retired category (`database_performance`, folded into
`general_engine` in #586) carries an upgraded database across with nothing to
migrate by hand.

**requires_restart / advanced / keywords** are NOT NULL with a `default_value`
(false, false and `"[]"`), so
`sync_schema` adds them to an existing table with `ALTER TABLE ADD COLUMN`
rather than a copy-and-recreate. They are metadata, not user data: every startup
re-seeds each row's metadata (values are preserved), so the backfill only holds
between the ALTER and that upsert. `requires_restart` replaced a
`"(Requires Restart)"` suffix in `label` that the app and the MCP tool surface
both parsed out of the prose - one stale label misinformed both at once, and a
test now asserts no label carries the substring.

**keywords** is JSON-in-TEXT like `options`, but never null: an entry with no
terms stores `"[]"`, so `GET /config` always sends an array and no client
branches on absent-vs-empty. It holds what a user types that the entry's key,
label and description never say ("ram" for `dbCacheSize`), which is why a
seeded keyword may not repeat a word those three fields already carry - the
search matches them first and ranks them above keywords, so a duplicate only
lifts the entry over better matches. `config_route_test.cpp` scans the seeded
catalogue for both rules.

**unit** is nullable, like `min_value` / `max_value`: an entry that measures
nothing declares none, and NULL is that - a nullable column is ALTER-friendly
without a `default_value`. It is what lets the app put the unit on the input
where a unit belongs, and `"bytes"` additionally selects the human-readable
size formatting. The app used to decide that last part from a hardcoded list of
three keys, which is the "one branch defines, another re-derives" shape: an
entry seeded here was invisible to it until someone edited a TypeScript array,
and two of the three keys had already been retired out from under it.
`config_route_test.cpp` guards that every key ending `Ms` / `Bytes` / `Days`
declares the matching unit, that no non-numeric entry declares one, and that no
description restates a unit the input already carries.

**options** is nullable and populated only for `type: "enum"` entries. It is
JSON-in-TEXT, the same convention as every other structured column in this
schema (`variables`, `auth`, `config_snapshot`, ...), never a delimited string.
Labels travel with values so the Settings UI never holds its own
value-to-label map that could drift from the engine's. `min_value` / `max_value`
were considered and rejected as a place to carry the option list - they are
engine-side validation only and unread by the app, whereas `options` is part of
the client contract: the renderer cannot draw the dropdown without it.

Three entries are seeded as `enum` today (`upsert_config` in `database.cpp`).
Two of them derive their `options` from the C++ enumeration that gives the
values meaning, rather than from a literal list, so the picker cannot offer a
value the engine rejects or omit one it accepts.

**`defaultHttpVersion`** derives from the same `HttpVersion` enumeration that
validates `requests.http_version` - see [`requests`](#requests) above:
```json
[
  {"value": "auto", "label": "Auto"},
  {"value": "http1.1", "label": "HTTP/1.x"},
  {"value": "http2", "label": "HTTP/2"}
]
```
Its `value` is this instance's current global, read fresh (not cached) on
every request create; changing it applies to the next request created, never
retroactively.

**`proxyMode`** derives from `all_proxy_modes()`
(`engine/include/vayu/http/transport_policy.hpp`), the same enumeration
`resolve_transport_policy` parses the stored value back into:
```json
[
  {"value": "environment", "label": "From environment"},
  {"value": "system", "label": "From system"},
  {"value": "manual", "label": "Manual"},
  {"value": "off", "label": "None"}
]
```
It sits beside three plain `string` entries, `proxyUrl`, `proxySystemUrl` and
`proxyBypass`, and the four are read together as one policy at the point of use
- see [Proxy settings](api-reference.md#proxy-settings) for the values, the
cross-field rule `POST /config` enforces over `proxyMode` + `proxyUrl`, and why
`proxyUrl` holds credentials in plaintext exactly as `oauth_tokens` does.
`proxySystemUrl` is the one config row the **app** writes rather than the user:
the Electron main process resolves the operating system's proxy through
Chromium and stores the answer there for `system` mode to read. It is a visible
row rather than a hidden channel, because a proxy a user cannot see is the
failure this whole area exists to end.

**`customCaCertificates`** is the one `text` entry - a multi-line string, which
is a rendering distinction rather than a value-space one: the app draws a
textarea for it because what it holds is pasted PEM whose line breaks are the
format. The certificates themselves are public, so nothing here is a
credential; the engine materializes them as `ca-bundle.pem` beside this
database (see [TLS trust settings](api-reference.md#tls-trust-settings)), which
is derived state a delete only costs a rewrite.

**`dbSynchronous`** is the exception: SQLite's durability levels (`"0"` Off,
`"1"` Normal, `"2"` Full) are its enumeration rather than ours, so that one
list is literal.

---

## Indexes

Declared alongside the tables in `make_storage()` (`engine/src/db/database.cpp`). `sqlite_orm`
requires index arguments to precede the table arguments. `sync_schema()` creates them on startup
for fresh **and** pre-existing databases, so adding an index is additive and needs no migration.

| Index                        | Column                  | Query paths that rely on it                                                                                                                       |
|------------------------------|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `idx_metric_ticks_run_id`    | `metric_ticks.run_id`   | `get_metric_ticks_paginated` / `count_metric_ticks` (every `GET /runs/:id/metrics`), `get_metric_ticks_since` (the legacy SSE poll), and the `remove_all` in the run cascade |
| `idx_monitor_samples_run_id` | `monitor_samples.run_id`| `get_monitor_samples_paginated` / `count_monitor_samples` (every `GET /runs/:id/monitor`) and the `remove_all` in the run cascade                  |
| `idx_results_run_id`         | `results.run_id`        | `get_results` and the `remove_all` in `delete_run`                                                                                                |
| `idx_result_bodies_run_id`   | `result_bodies.run_id`  | `get_result_bodies_paginated` / `count_result_bodies` (every `GET /runs/:id/samples`) and the `remove_all` in the run cascade                     |
| `idx_body_blobs_run_id`      | `body_blobs.run_id`     | The `remove_all` in the run cascade                                                                                                               |
| `idx_requests_collection_id` | `requests.collection_id`| `get_requests_in_collection` (every sidebar load) and cascade delete                                                                              |
| `idx_collections_parent_id`  | `collections.parent_id` | The cascade-delete BFS in `Database::delete_collection`, which does one lookup per node in the subtree                                            |
| `idx_runs_start_time`        | `runs.start_time`       | `get_all_runs` and `get_runs_paginated`, which sort `start_time DESC` on every `GET /runs`                                                        |
| `idx_inbox_requests_inbox_id`| `inbox_requests.inbox_id`| Every inbox read - the capture page, the live poll, the per-insert retention trim and `DELETE /inbox/:id/requests`                |
| `idx_runs_request_id`        | `runs.request_id`       | `GET /runs?requestId=` and `useLastDesignRunQuery`'s single-run lookup (`get_runs_paginated` with a `request_id` filter)                          |
| `idx_request_examples_request_id` | `request_examples.request_id` | Every example read - `GET /requests/:id/examples`, the create path's append scan, and the `remove_all` in both the request and collection cascades |

`metric_ticks` and `results` are the unbounded-growth tables - a load run writes one tick row per
second (the retired EAV `metrics` table cost roughly 20 rows for the same second) - so without `run_id`
indexes a lookup slows down with every run ever recorded, not just the current one. `collections.parent_id` is a nullable column; `sqlite_orm` indexes it
without special handling.

Guarded by `DatabaseTest.CreatesIndexesOnFreshDatabase` and
`DatabaseTest.RecreatesIndexesOnExistingDatabase` in `engine/tests/db_test.cpp`, which read
`sqlite_master` directly rather than trusting what `sqlite_orm` reports about itself.

---

## VariableValue shape

Used in `collections.variables`, `environments.variables`, and `globals.variables`:

```json
{
  "value": "https://api.example.com",
  "enabled": true,
  "secret": false,
  "type": "string",
  "createdAt": 1784967810149
}
```

`secret` is a UI masking hint only - values are not encrypted at rest. `type` is a UI/script
conversion hint, one of `"string"` (default), `"number"`, `"boolean"`, `"json"` - it controls
how scripts read the variable via `pm.*.get(...)`.

`createdAt` (ms epoch) is the app's row-ordering key: the variables editor lists a scope
oldest-first. It is **optional** - a row written before the field existed, or stripped by an
engine older than the fix for issue #135, simply has none, and the app sorts an absent value as
older than everything. Neither side may backfill it on an existing variable: stamping a legacy
row at save time is what made it leapfrog the row the user had just added. Only the two places
that genuinely create a variable stamp it - the app when the user types a new row, and the
engine's `pm.*.set()` when a script introduces a key that did not exist.

The engine round-trips the whole shape through `vayu::json::parse_variables` /
`serialize_variables` (`engine/src/utils/json.cpp`) when `POST /execute` persists script-set
variables. **A field added here must be added to both**, or a design run erases it from disk;
`engine/tests/script_variables_test.cpp` pins the round trip field by field. `POST /execute`
also skips the write entirely for a scope no script changed, so sending a request no longer
touches a collection's / environment's `updated_at`.
