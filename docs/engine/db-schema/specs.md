---
description: >-
  The tables that hold a collection's API specification and the operations a user declined to import from it.
---

# Spec documents

## `spec_documents`

Stores OpenAPI documents, bound to collections by [`collections.openapi`](collections-and-requests.md#collections) (issue #637).

| Column       | Type    | Notes                                              |
|--------------|---------|----------------------------------------------------|
| `id`         | TEXT PK | `spec_` + UUID                                     |
| `content`    | TEXT    | The document, verbatim; capped (see below)         |
| `source_url` | TEXT    | Where it was fetched from; NULL when pasted/uploaded |
| `fetched_at` | INTEGER | Unix ms                                            |
| `hash`       | TEXT    | Hex `sha256(content)`, computed engine-side        |
| `operations` | TEXT    | JSON array: the declared-operation index, `""` = none |
| `response_schemas` | TEXT | JSON object: the response schema index, `""` = none |

**content** is stored as text rather than a parsed model, because every feature stacked behind this needs the *document*: the Spec tab renders it, sync re-fetches and diffs against it, response validation resolves `$ref`s through it, and export writes a new one beside it.
A parse here would be re-done by each of them anyway and would lose whatever the author wrote that the parser did not model.

**hash** is the content+hash pair [`body_blobs`](run-artifacts.md#body_blobs) uses, and is **never taken from the caller** - `POST /specs` and `POST /import/apply` both compute it through `spec_content_hash`, and a body carrying `hash` or `fetchedAt` is a `400`.
A scenario run of a bound collection stamps `specId` + `specHash` into its [`runs.config_snapshot`](runs.md#runs) under `scenario.openapi`, and that stamp only means anything because both sides of a later comparison were computed by the same code on the same bytes.

**Ownership, and why there is no cascade.**
A spec is bound *by* collections rather than owned by one: several may bind the same row, and unbinding one must leave it there for the others.
So no cascade deletes a document - `DELETE /specs/:id` is refused with a `409` naming the binder while any collection still names it.
There is likewise no `PUT /specs/:id`: a document that changed is a different document, and rewriting one in place would invalidate the hash every run of every bound collection was stamped with.

**Lifetime, and the sweep that enforces it** (issue #718).
Having no owner left these rows with no way to die: every `POST /specs/sync` mints a new document and moves the binding off the old one, unbinding leaves it, re-binding mints another, and deleting a bound collection takes its requests and not the document - while `DELETE /specs/:id` needs an id and there is no list route to get an unreachable one from.
Weekly syncs of a 12 MB document therefore stranded ~600 MB a year that nothing could read or reclaim.
The rule now, and the only one:

> A document lives while a collection binds it, **or** while a retained run names
> it in [`runs.config_snapshot`](runs.md#runs) under `scenario.openapi.specId`.

`Database::sweep_orphaned_spec_documents()` applies it and returns how many rows went.
Run-referenced documents live as long as the runs do, deliberately:
a scenario run stamps the `specId` it was planned against and its report describes that contract, so the source has to outlive the binding by exactly the retention window - which is why the sweep is the tail of `prune_runs_configured()`, the pass that *releases* those references, and thereby runs on startup and at the end of every run.
It also runs after `spec_sync_apply` (the accretion source) and after `delete_collection` (the last binder going away).
Two rules keep it honest: a document written within `SPEC_DOCUMENT_SWEEP_GRACE_MS` (10 min) is always spared, because binding stores the document *before* the write that names it (`POST /specs/bind`, `POST /collections`) and a document in that window is a bind in flight, not an orphan;
and the pass never throws or reads `content`, so no caller can fail over housekeeping and no 10 MiB blob is loaded to decide its fate.

**Cap.**
A document over the live `maxSpecDocumentBytes` [`config_entries`](config.md#config_entries) value (default 10 MiB, aligned with `json::MAX_FIELD_SIZE`) is a `400` naming the size and the cap, on both write paths - never a truncation, and never the engine's general body cap refusing the whole request without naming the document ([Request bodies](../api-reference/index.md#request-bodies)).

**operations** is what the document *declares* - a JSON array of `{operationId?, method, path, responses[]}` in document order - read by [contract coverage](../../app/openapi.md#contract-coverage) (issue #629).
**Derived, never supplied** (issue #853): the engine reads `content` as it stores it (`core/openapi_document.cpp`, JSON first and YAML second) and writes this column from that parse, the way it computes `hash` rather than taking one; a write carrying an `operations` field is a `400`.
One reader answers what a document declares, which is what keeps this column agreeing with the `spec_operation` stamped on each request.
NOT NULL with a `default_value`, the same migration shape `request_examples.origin` uses, so `sync_schema()` ALTERs it onto an existing table and every pre-existing row backfills to `""`.

`""` means *no index*, which is not the same as a document declaring nothing: a run of a collection bound to such a document reports no coverage block at all, and `GET /specs/:id` reads the column back as `null` rather than `[]` so the two stay distinguishable.
A row can hold `""` because it predates the column, or because the document declares no operation at all - a stored file that is not a contract.
Capped at 2000 rows on the write, which is refused with the count rather than silently truncated.

**response_schemas** is what the document declares each response *looks like* (issue #628) - a JSON object of `{refRoots?, operations: [{operationId?, method, path, responses: [{status, contentType, schema?}]}]}`, read when a response comes back with a body to check.
Every status an operation declares is listed (#3028); one with no schema to check against is a status-only row (`contentType: ""`, no `schema`), so the check and coverage agree on the statuses and a `default` or `4XX` never judges a body under a status the document names itself.
An `x-` extension key under `responses` is not a status and is listed in neither index (#3084).
**Derived, never supplied** (issue #860), off the *same* read as `operations`: a write carrying a `responseSchemas` field is a `400`, and one read for both is what keeps them agreeing about which operation declares which status.

A column of its own rather than a field on `operations` because the two are read at different moments: the operation index is parsed when a run's plan resolves and held for the run's whole life, while schemas are touched only per response - and they are orders of magnitude larger.

`refRoots` holds the document's `components.schemas` / `definitions` / `x-vayu-bundled` subtrees **once**, and each schema keeps its `$ref`s as written; validation merges the two into one root document.
Inlining instead would copy a shared `Error` schema into every operation naming it, and a recursive schema - a tree node whose child is itself - has no finite expansion at all.
Schemas are translated out of OpenAPI's dialect as they are derived (3.0's `nullable`, a union with `null` on the `type` or, beside `allOf` / `anyOf` / `oneOf` / `$ref` / `not` / `enum` with no `type`, `anyOf: [<schema>, {"type":"null"}]`; its draft-04 boolean `exclusiveMinimum`, and the OpenAPI-only keywords that constrain no body):
the column holds JSON Schema and nothing else, because that is what the validator reads.

`""` means *no index* on the same terms as `operations`: a response of such a document reports `checked: false` with the reason `no_index`, never a body that passed, and `GET /specs/:id` reads it back as `null`.
The serialized index is held to the same `maxSpecDocumentBytes` cap as the document, refused on the write with the count and the cap rather than truncated.

The table itself was new when it landed, so `sync_schema()` created it outright; `operations` and `response_schemas` are its migrated columns.

---

## `spec_declined_operations`

The operations a person declined by deleting the request for them (schema version 10, #3031), or by moving it out of the contract (#3446), so that a sync of the document does not re-create them.
[`POST /specs/diff`](../api-reference/specs.md#post-specsdiff) lists such an operation under `declined` instead of `added`, and a `policy: "safe"` sync never creates it.

| Column          | Type       | Notes                                                       |
|-----------------|------------|-------------------------------------------------------------|
| `id`            | INTEGER PK | Autoincrement; never leaves the engine                      |
| `collection_id` | TEXT       | The bound collection the decision was made under            |
| `operation_id`  | TEXT       | The operation's `operationId`, `""` when it declares none   |
| `method`        | TEXT       | The identity's method, as `requests.spec_operation` records it |
| `path`          | TEXT       | The identity's path template                                |
| `request_id`    | TEXT       | The request whose delete, or move out of the contract, wrote the row |

`UNIQUE (collection_id, method, path, operation_id)`: one row per operation under one binding, and a second request's delete for the same operation takes the row over (`request_id` moves to it).
`operation_id` is `""` rather than NULL for that reason - SQLite treats two NULLs as distinct, so a NULL would let one endpoint hold two rows.
The constraint's own index serves every read, which is by `collection_id`.

**A row of its own rather than a flag on the request**, because the decision has to outlive the request row: a purge removes it.
Who writes and forgets a row, each in the transaction of the write named:

- **Written** by a person's delete: `DELETE /requests/:id` of a request whose `spec_operation` names a whole identity (method and path), and `DELETE /collections/:id` for each such request its own delete stamps.
  The collection is the nearest ancestor that binds a document (`core::nearest_spec_binding`, resolved by the route and passed in, so `Database` reads no binding itself).
  Deleting the bound collection itself writes nothing.
  A sync's own (hard) deletes write nothing.
- **Written** too by a person's move out of the contract (#3446):
  a `PUT /requests/:id` with a `collectionId`, a `POST /reorder` batch (every stamped request under a moved collection included), or a `PUT /collections/:id` with a `parentId` (every stamped request in the moved subtree, #3470),
  that leaves a stamped request where the nearest binding is not the same contract (`declined_by_move` in `routes.hpp`: another document, none, or the same document bound by a collection outside the source's contract walk).
  The collection is the source's nearest binding, read before the move, and the same write clears the request's `spec_operation` (`Database::save_request` / `apply_reorder`, or `rebind_collection` when the same `PUT` also unbinds, given the decision by the route).
- **Forgotten** when the request comes back from the trash (by `request_id`, alone or with its collection's cohort) while it still records an operation (`forget_declined_by_locked`'s guard): a request a move unstamped claims nothing back, so its move's row stands;
  when a `POST /specs/sync` creates a request for the same operation (`core::declines_taken_back`, the diff's own identity rule run against the document being stored);
  when `PUT /collections/:id` unbinds the collection (after the rows a move in the same body wrote, so one written under the collection itself goes too), or `POST /specs/bind` binds it to a document with another `specHash`; and when the bound collection itself is purged.
- **Kept** when the deleted request is purged, by hand or by `trashRetentionDays`: emptying the trash is not changing one's mind.

The identity is read the way the diff reads a request's (`core::parse_spec_identity`), and the diff follows a row into a re-fetched document by the rule it follows a request with (`operationId` first, method and path shape second), so a declined operation the document renamed is still the declined one.
A live request claiming the operation outranks the row.
