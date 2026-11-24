---
description: >-
  How a create or an update of a saved record behaves on every resource: ids, If-Match, the null-vs-absent rule, ordering, paged lists, accepted field shapes and auth modes.
---

# Resource writes: create vs update

Collections, requests and environments follow one write contract.
`/globals` is a singleton and stays POST-only, so it is exempt from the **verb split** below - but not from the null-vs-absent rule, which it follows with every write treated as a create (see [POST /globals](environments.md#post-globals)).

| Verb | Path | Meaning | Wrong-target status |
|------|------|---------|---------------------|
| `POST` | `/<resource>` | **Create only.** | `400` when the body carries an `id` |
| `PUT` | `/<resource>/:id` | **Update only** (merge-patch). | `404` when the `id` does not exist |

`PUT` is used loosely as a merge-patch rather than a whole-record replace: an omitted field keeps its stored value.
We deliberately did not add a separate `PATCH` verb - merge-patch is what the update path has always done, and every client call site expects it.
The `:id` in the path is the record's identity; the body carries the changed fields only.

**An update is atomic against a concurrent one.**
The read the merge is computed from, the merge itself and the write are one acquisition of the database lock, so two clients patching one record at the same moment - the app's autosave and an MCP agent, say - each merge onto what the other committed rather than onto the row as both of them found it.
The alternative is not a conflict but a silent loss: the merge carries every field the body did not name, so the loser's fields come back written with the values the winner read a moment earlier, and neither request fails.
A client that computes its body from an earlier read (a read-merge-write across two round trips) closes its own window with [`If-Match`](#conditional-updates-with-if-match).

## Conditional updates with If-Match

The four whole-record `PUT`s - [collections](collections.md#put-collectionsid), [requests](requests.md#put-requestsid), [environments](environments.md#put-environmentsid) and [examples](examples.md#put-requestsidexamplesexampleid) -
take an optional `If-Match` header (issue [#2433](https://github.com/athrvk/vayu/issues/2433)), and so does the globals singleton's whole-blob save, [`POST /globals`](environments.md#post-globals) ([#2988](https://github.com/athrvk/vayu/issues/2988)).
A row's version is its `updatedAt`, and its entity tag is the weak `W/"<updatedAt>"`.

- Every `200` from those writes, and from [`GET /requests/:id`](requests.md#get-requestsid) and [`GET /globals`](environments.md#get-globals), carries the row's `ETag`.
  The list reads (`GET /collections`, `GET /environments`, `GET /requests/:id/examples`) carry no per-row header; a client builds the tag from the row's `updatedAt`, which is the same value.
- `If-Match: W/"<updatedAt>"` makes the write conditional: it lands only while the stored row is at that version.
  The check runs inside the same lock acquisition as the read and the merge, after the `404`, so the row it judges is the row the write replaces.
- A mismatch is `412` with code `precondition_failed`, and nothing is written.
  The stored `updatedAt` rides inside the error, so the caller can re-read, merge again and retry under the new tag:

  ```json
  {"error": {"code": "precondition_failed", "message": "The record changed after it was read; read it again and re-apply the change", "updatedAt": 1792359304908}}
  ```

- `If-Match: *` holds for any stored row (a missing one is still `404`).
  A comma-separated list holds when any member names the version, and repeated `If-Match` lines are read as one list.
  The comparison is weak: `W/` is ignored on both sides, where RFC 9110 asks for the strong comparison, which no weak tag passes.
  Every tag the engine issues is weak because a row's answer carries members its `updatedAt` does not version (a request's derived file trust).
- A value that is not `*` or entity tags (a bare `1792359304908`, an empty value) is `400` `invalid_if_match`, before the row is looked up.
- No `If-Match` is the unconditional write it always was.
  The app sends none: its autosave patches only the fields that changed (#1436), so its writes merge rather than collide.

An update through these routes always moves `updatedAt` forward, even within one millisecond, so two of them never share a tag.
Other writers of these rows (a reorder, a spec sync, a run persisting script variables, an import's globals) stamp the current time.
Activating an environment clears `isActive` on the one it replaces without restamping that row, so an environment's tag does not cover `isActive`.

Globals has no `404`: an engine that never saved any answers the empty set at `updatedAt: 0`, and `W/"0"` is that version's tag.
A first conditional save names it, and once anything is written it is stale like any other.

## The engine owns every id

A create must **not** carry an `id`.
The engine generates one via `generate_id`, giving the `<prefix>_<uuidv4>` form, and a body containing the field is a `400`:

```json
{"error": {"code": "bad_request", "message": "id is assigned by the engine; omit it (bulk import: POST /import/apply)"}}
```

Presence alone is rejected, `null` included - `id` is not a settable field with a default, so the [null-vs-absent rule](#the-null-vs-absent-rule) below does not reach it, and accepting `{"id": null}` would leave a caller believing the field is honoured.
The field existed for the import orchestrator, which pre-assigned ids so it could wire `parentId` / `collectionId` across a whole tree before anything was persisted; import sends one [`POST /import/apply`](import.md#post-importapply) instead, referencing items by opaque `tempId` and reading the real ids back from `idMap` (issues #96, #97).

On `PUT`, the path is the identity.
A body `id` matching it is accepted and ignored; one that disagrees - including `null` - is a `400` (message `Body 'id' must match the id in the path ('col_1') or be omitted`), because the payload otherwise names two different records and guessing between them is how a `PUT` to one id rewrites another.
This is checked before the record is looked up, so a malformed body answers `400` whether or not the target exists.

Since no create can select an id, the pre-existing "id already exists" `409` - whose body names the update path, e.g. message `Collection 'col_1' already exists; use PUT /collections/:id to update` - is now reachable only on a `generate_id` collision, which 122 bits of entropy put out of reach.
It stays as a guard: on that draw the alternative is overwriting a live record.

## The null-vs-absent rule

One rule, identical for every field of all three resources:

| | Field absent | Field explicitly `null` |
|---|---|---|
| **Create (`POST`)** | use the default | use the default |
| **Update (`PUT`)** | keep the current value | reset to the default |

The defaults are `{}` for `variables`, the resource's own default for `auth` (`{"mode":"none"}` for a collection, `{"mode":"inherit"}` for a request), `[]` for `params` / `headers`, `""` for `description` and the two script fields,
`{"mode":"none"}` for a request `body`, `true` for `followRedirects`, `10` for `maxRedirects`, `null` for a request's `timeout` (the `defaultTimeout` setting, read at each send), and `false` for `isActive`.

`order` is the one default that is computed rather than constant: it means "append after the current siblings", on both resources and on both verbs - see [Ordering](#ordering) below.

A request's `httpVersion` is the one field whose default is not fixed: absent or `null` seeds it from the live `defaultHttpVersion` config entry (`"auto"` unless changed), read fresh on every write rather than cached - see [POST /requests](requests.md#post-requests).
Unlike every other field above, an unrecognized `httpVersion` value is rejected with a `400` rather than silently coerced, because a typo'd protocol silently running as HTTP/1.1 is the worst available outcome.

A field that has **no** default cannot be reset, so `null` is a `400` on either verb rather than a silently discarded write.
Those fields are a collection's `name`, an environment's `name`, and a request's `collectionId`, `name`, `method` and `url`.
Each is also required on create.

## A storage failure is not a 400

A create or update whose request was fine but whose database write failed does not answer `400` (issue #2423), because a `4xx` tells the caller to change the request and the app does not retry one.
It is told apart by SQLite's own result code, and the body never quotes SQLite's text (the engine log does):

| Cause | Status | `code` | The caller should |
|-------|--------|--------|-------------------|
| The disk holding the data is full (`SQLITE_FULL`) | `507` | `insufficient_storage` | free space, then repeat the call |
| The database stayed locked past the busy timeout (`SQLITE_BUSY`, `SQLITE_LOCKED`) | `503` with `Retry-After: 1` | `unavailable` | repeat the call |
| Any other SQLite failure (I/O error, read-only file, corruption) | `500` | `internal_error` | read the engine log |

An exception that is not SQLite's (a body that is not JSON, a field that fails validation) stays a `400`.
Every handler of a resource write answers through `send_exception` in `routes.hpp`; `SendExceptionGuard` fails the build on one that goes back to a bare `400`.

## A stored JSON field has a write-time cap

One rule, identical for every resource (issue #1485):
a request's `params` / `headers` / `body` / `auth`, a collection's `variables` / `auth` / `dataSchema` / `openapi` / `specFile` / `dataFile`, and an environment's `variables` are each refused with a `413` when the serialized value is over the engine's field cap (10 MiB, `json::MAX_FIELD_SIZE` in `engine/include/vayu/core/constants.hpp`) -
naming the field, its size and the cap, and leaving the stored row untouched.
`POST /import/apply` enforces it too, through the same `apply_*_field` helpers every other write goes through.

A row written before this cap existed can still be oversized.
`GET /<resource>/:id` always answers with the field whole, however large it is - this did not change.
Only a **request's** list route, `GET /requests?collectionId=`, behaves differently: it has always substituted the field's documented default for a column too large to serve efficiently across a whole page, and now names which fields it substituted for that row in a `truncatedFields` array (e.g. `["body"]`), omitted when nothing was.
Neither `GET /collections` nor `GET /environments` substitutes or carries this field - see [GET /requests](requests.md#get-requests).

## Ordering

Collections and requests both carry an `order` column that fixes their position among their siblings.
The siblings of a row are **every child of its parent, of both kinds** (#2535): a collection's sub-collections and its requests share one `order` space, so a request can sit between two folders.

**Reading.**
`GET /collections` and `GET /requests` each sort by `order` ascending, then `createdAt` ascending, then `id` ascending.
All three keys are load-bearing: `order` alone is not a total order (every request created before explicit orders existed sits at `0`), and rows are stored with `INSERT OR REPLACE` on a TEXT primary key, which hands the row a *new* rowid on every edit - so without an explicit tiebreak, renaming a request silently moved it among its ties.

A client that lists a parent's children merges the two lists by `order`, and on an `order` tie ranks the **sub-collection before the request**, ahead of `createdAt` and `id`: the sibling order is `(order, kind, createdAt, id)`, which within one kind is the three-key rule above unchanged.
The engine's copy is `engine/include/vayu/db/sibling_order.hpp`; the app's `compareTreeOrder` is pinned to it by `engine/tests/fixtures/tree-order-conformance.json`, read by both test suites.
A recursive [collection run](load-runs.md#the-scenario-block-collection-runs) walks the same merged list depth-first, a request where it sits and a sub-collection's whole subtree where the sub-collection sits, pinned across both consumers by `engine/tests/fixtures/recursive-run-order-conformance.json`; a mock server's route table and `POST /specs/export` list a subtree in that order too.

A workspace from before schema version 7 numbered the two kinds apart, each from `0`, and showed every sub-collection above every request.
The version-7 migration moves each collection's requests past its highest sub-collection `order`, so that display survives (`docs/engine/db-schema.md`, Schema versions); rows still tied at the legacy `0` keep it through the tie rule.

**Writing.**
`order` defaults to "append after the current siblings" - one past the highest `order` any sibling of either kind holds:

| Write | `order` |
|---|---|
| Create, `order` absent or `null` | appended |
| Create, `order` stated | as given, if an integer from `0` to `2147483647`; otherwise a `400` |
| Update, `order` stated | as given, if an integer from `0` to `2147483647`; otherwise a `400` |
| Update, `order` absent, no move | unchanged |
| Update, `order` absent or `null`, **and** the row changes parent (a collection's `parentId`, a request's `collectionId`) | appended in the destination |
| Update, `order` `null`, no move | appended among its current siblings |

A move that states no order therefore lands at the end of the destination rather than at whatever slot its position in the *old* list happened to name, after its folders and its requests alike.
Ordering *within* a list is always the caller's to state, and a stated `order` may put a request between two sub-collections.

**A stored `order` is an integer from `0` to `2147483647`** (#3451), so a negative, truncated or wrapped slot cannot be written.
A stated `order` outside that range or that is not a JSON integer (`"3"`, `2.5`, `-1`, `2147483648`) is a `400` naming the field on every route that writes one (`POST`/`PUT /collections`, `POST`/`PUT /requests`,
[`POST /reorder`](collections.md#post-reorder), `POST /import/apply`, `POST /specs/sync`), for example `Invalid 'order': must be an integer from 0 to 2147483647 (got 2.5)`, and nothing is written.
An append under a parent where a sibling already holds `2147483647` has no slot left, so it is a `400` naming `order` too (`Cannot append: a sibling already holds 'order' 2147483647 ...`) rather than a row that wraps to the top; state an `order`, or renumber the parent with `POST /reorder`'s `normalize`, which frees the end again.
An import document's own stated order (`x-vayu-request.order`, an `x-vayu-collection.folders` entry's `order`) outside the range counts as unstated, so the row takes the position an unordered one would.

**Bulk import** is the one exception to the append scan: `POST /import/apply` writes rows that cannot see each other yet, so an omitted `order` gives the payload's items consecutive slots per parent starting from the append point, one run across both kinds - the parent's sub-collections first, in payload order, then its requests - see [POST /import/apply](import.md#post-importapply).
`POST /specs/sync` numbers the folders and requests it creates the same way.

**Any writer producing several sibling rows at once owes them distinct `order`s** - the import applier is the instance of a general rule, not a special case.
The `createdAt` leg is a millisecond stamp, so rows written inside one tick tie on it and fall through to `id`, which compares random UUIDs: stable across reads of the same data, but arbitrary with respect to the order the caller meant.
Single-row creates need nothing extra, because the append scan already sees every stored sibling and hands out a fresh slot.
The rule is on the writer rather than on a finer timestamp: a microsecond stamp would still tie under a fast enough writer, and it would make row identity depend on clock resolution across the three platforms Vayu builds on.

**Repositioning several rows at once** is [`POST /reorder`](collections.md#post-reorder), not a run of `PUT`s.
Each `PUT` is one row under its own lock, so a reorder expressed as N sibling `PUT`s can be interrupted halfway, leaving two rows at one `order` and a gap where the moved one was, and a concurrent client's move lands between any two of them.
The batch endpoint validates and writes the whole set under one lock scope, which closes both.
What is *not* a difference any more is the cycle guard: since a `PUT` holds its own read to its own write, its guard and its write are one scope too, so two conflicting reparents sent as single `PUT`s are serialized and the second is refused against the first's committed graph - it is refused after that first move is already stored, which is the part only a batch avoids.
The per-row `PUT`s remain correct for a single row - a rename, a move that appends - and still carry those caveats when used in a loop.

## Paged lists

[`GET /collections`](collections.md#get-collections), [`GET /requests`](requests.md#get-requests), [`GET /trash`](trash.md#get-trash) and [`GET /cookies`](cookies-and-certificates.md#get-cookies) answer every row they hold by default.
Three optional query parameters ask for one page of them instead, and a page cuts the route's own documented order (the three-key rule above for collections and requests, newest first for the trash, scope then jar line for cookies), so consecutive pages neither skip nor repeat a row while nothing is written between them (#2443):

- `q` - case-insensitive substring of the row's `name` (for a cookie, its `name` or its `domain`).
  The fold is ASCII only: `A`-`Z` match `a`-`z`, and any other letter matches only as typed, so `É` does not find `é`.
  Empty matches every row.
  Rows the route never lists (a request or collection in the trash, a cookie cleared from its jar) never match.
- `limit` - page size, an integer from `1` to `500`; default `50`.
  `0`, a value over `500` or anything that is not a whole unsigned integer (`5abc`, `-1`, `+5`, empty) is a `400` with code `invalid_limit`, never a clamp.
- `offset` - matching rows to skip, a non-negative integer; default `0`.
  Anything else is a `400` with code `invalid_offset`.
  An offset past the end is an empty page, not an error.

**Naming any of the three** (`?q=` alone counts) switches the answer to the envelope [`GET /runs`](runs.md#get-runs) uses:

```json
{
  "data": [ ... ],
  "pagination": { "total": 812, "limit": 50, "offset": 0, "returned": 50, "hasMore": true }
}
```

`data` holds the rows the route's own answer would have carried, cut to the page; `total` counts the rows matching `q` before the page was cut, read from the same fetch as the page; `hasMore` is `offset + returned < total`.
**Naming none of them** answers exactly what the route answered before paging existed, byte for byte: a bare array for `GET /collections` and `GET /requests`, `{items, total}` for `GET /trash`, `{scopes}` for `GET /cookies`.
Filtering and slicing run in memory over the route's ordinary fetch, so a page saves the transfer and the client's parse, not the engine's read.

## Accepted field shapes

A field that is present and not `null` must have the shape below, on both verbs.
Anything else is a `400` naming the field, e.g. message `Invalid 'auth': must be a JSON object`.

| Field | Shape |
|---|---|
| `variables` (collection / environment / globals) | object |
| `auth` (collection / request) | object |
| `body` (request) | object - see [The request `body` union](request-body.md#the-request-body-union) |
| `params` / `headers` (request) | array of `{key: string, value: string, enabled: bool}` |
| `order` (collection / request) | integer from `0` to `2147483647` - see [Ordering](#ordering) |
| `parentId` (collection) | string: a collection id, or `null` or `""` for the root |
| every other plain string field (`name`, `description`, `url`, `bodyType`, an example's `body` and `contentType`, a certificate's `host` and `passphrase`, ...) | string; the `400` is `Invalid '<field>': must be a string (got <type>)` |

Object-shaped fields are stored as JSON blobs, and every reader of one degrades quietly when it is not an object - `variables` reads back empty, a request `body` is dropped, and `auth` resolves to none, so a request the caller believes carries credentials goes out bare.
The write is therefore rejected rather than stored: `{"variables": 42}` and `{"auth": "bearer"}` are `400`s, and the previously stored value is left untouched.

**`parentId: ""` is the root, the same as `null`** (#3451).
It is stored as `null` on `POST`/`PUT /collections` (a folder `POST /specs/sync` creates with `""` or `null` lands under the synced collection), and [`POST /reorder`](collections.md#post-reorder) reads it as `null` in a move and in a `normalize` scope, so the tree has one spelling of the root: a collection created with `""` is appended among the roots and lists with them.
A value that is neither a string nor `null` (`5`, `true`, an object, an array) is a `400` such as `Invalid 'parentId': must be a collection id or null (got number)`.
Rows an older engine stored with `""` are rewritten to `null` at startup ([the empty-parent pass](../db-schema.md#the-empty-parent-pass-issue-3451)), so a delete and restore of one comes back where it was instead of re-parented to the root.

**A `variables` key must be one a `{{ name }}` token can reach (#3251).**
A token is looked up with the spaces, tabs, CR and LF around its text cut, so a stored key that is empty, whitespace-only, or differs from its trim can never be referenced.
The same `400` refuses it, naming the key: `Invalid 'variables': key ' x ' has leading or trailing whitespace`, or `... key '' is empty or whitespace-only`.
It applies to `POST`/`PUT /collections`, `POST`/`PUT /environments` and `POST /globals`, and the stored value is left untouched.
Whitespace *inside* a key and dots are fine (`my var`, `a.b`).
Variables a script writes are not checked.
An import does not hit this: it trims the names it reads, see [`POST /import/parse`](import.md#post-importparse).

## Blank names

A collection's or environment's `name` that is empty or only spaces, tabs, CR and LF is a `400` on `POST`/`PUT /collections` and `POST`/`PUT /environments` (#3253): `Invalid 'name': is empty or whitespace-only`.
The row is not written.
A `PUT` that does not state `name` keeps the stored one, so a row that is already blank stays editable.
A name with content is stored as written, surrounding spaces included.
`POST /import/apply` and `POST /specs/sync` are not held to this: they carry names an importer wrote, and a blank one imports as it always did.
The MCP `create_` and `update_` tools for both resources refuse the same name as an input error before calling the engine.

## Collection auth

A collection's `auth` is never `{"mode":"inherit"}` (#3445).
A collection, a folder included, is a link of the chain a request inherits through, so its own `inherit` would mean nothing the walk could use: the composer steps past it, while a client reading the row would show the parent's credential as the collection's.
`POST`/`PUT /collections` answer `400` (`Invalid 'auth': a collection cannot inherit auth ...`) when the body states an `auth` object whose `mode` is `inherit`, and write nothing.
A body without `auth` is not judged (a `PUT` keeps the stored value), and `"auth": null` resets to `{"mode":"none"}`, which is how a collection stops being an auth source.
`POST /import/apply` and `POST /specs/sync` are not held to this, as with [blank names](#blank-names).
A row that already stores `inherit` from before this rule is read as no auth of its own: `POST /compose` resolves a request beneath it to the nearest ancestor's credential, and a `PUT` of other fields still succeeds.
The MCP `create_` and `update_` collection tools refuse `inherit` as an input error before calling the engine.

## Auth modes

A stored `auth` object's `mode` is one of `none`, `noauth`, `inherit`, `bearer`, `basic`, `apikey`, `oauth2`, `digest`, `aws`, `ntlm`, `hawk`, `oauth1`, `edgegrid` and `jwt`, spelled exactly so (#3464).
The last seven are stored and never executed: a send names the mode in `authNotice` and goes out without a credential.
Modes match by exact lowercase string, so `Bearer`, `" inherit"` or a non-string `mode` would be stored and then read as a concrete credential that stops the inherit walk and is sent as none.
`POST`/`PUT /collections` and `POST`/`PUT /requests` therefore answer `400` (`Invalid 'auth.mode': must be a string, one of: ...`) when the body states an `auth` object whose `mode` is missing, not a string, or outside that set, and write nothing.
`inherit` stays valid for a request and is refused for a collection ([#3445](#collection-auth)).
`"auth": null` and an absent `auth` are not judged, and an `auth` that is not an object is the [shape](#accepted-field-shapes) `400`.
`POST /import/apply` and `POST /specs/sync` are not held to this, as with [blank names](#blank-names): an importer's unrecognised mode is stored as written, so one odd block cannot fail an atomic import.
The MCP `create_` and `update_` tools for both resources refuse an unknown mode as an input error before calling the engine.

An OAuth 2.0 `auth.config.privateKey` (the `jwt_bearer` grant's signing key) is stored only as one `{{variable}}` reference naming a secret variable that holds the PEM, never as the key (#3632).
The same four writes answer `400` (`Invalid 'auth.config.privateKey': must be one {{variable}} reference ...`) for any other value, a string with text around the reference or a second reference included, and write nothing; the message never quotes the value.
Absent, `null` and `""` pass (a key file in `privateKeyFile`, or no key yet).
`POST /import/apply` and `POST /specs/sync` are not held to it, as above.
`POST /compose` leaves the reference written in every mode, so no composed payload carries the key;
it is resolved only where a token is acquired: after the pre-request script on a Send and a sequential collection run, once at the start of a load run from the run's own scopes (a reference none answers is the run's `400`, `invalid_run_config` or `invalid_scenario`, naming it), and by [`POST /oauth2/token`](authentication.md#post-oauth2token) from the scopes it names.

## Behavior change (pre-1.0)

**A create carrying an `id` is now a `400`** on all three resources.
External scripts that minted their own ids must drop the field and read the engine's id out of the response, or use [`POST /import/apply`](import.md#post-importapply) for a whole tree.
A `PUT` whose body `id` disagrees with the path id is a `400` for the same reason (it used to be silently ignored, so the write landed on the path id).

`POST /<resource>` used to be a silent upsert on all three resources, so a client could send an update as a POST.
That no longer works; external scripts that relied on POST-as-update must switch to `PUT /<resource>/:id`.
Two bugs went with the old behavior and are fixed here:

- A stale or typo'd `id` silently **created** a second record instead of failing, and an `id` collision silently **merged** two records into one.
- `POST /environments` had no null guard, so `{"variables": null}` stored the literal four-character text `null` - JSON that parses but is not an object, so every reader saw an environment with no variables and no error.
  It now resets to `{}` like every other resource.
- `environments.isActive` was honored only on create; it now follows the rule on both verbs.
