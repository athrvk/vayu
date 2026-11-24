---
description: >-
  The collection routes - list, create, update, delete - and the reorder route that moves collections and requests among their siblings.
---

# Collections and reorder

## Collections

Collections are folders that organize requests in a hierarchy.

### GET /collections

List all collections, ordered by `order`, then `createdAt`, then `id` (see [Ordering](resource-writes.md#ordering)); nothing in the trash.

**Query Parameters:**
- `q`, `limit`, `offset` (optional): one page of the collections whose `name` holds `q`, in the `{data, pagination}` envelope - see [Paged lists](resource-writes.md#paged-lists).
  A bad `limit` or `offset` is a `400` (`invalid_limit`, `invalid_offset`).

**Response** (none of the three):
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

Create a collection.
**Create only** - see [Resource writes](resource-writes.md#resource-writes-create-vs-update) for the shared contract and the null-vs-absent rule.

**Request:**
```json
{
  "name": "My API",        // Required, no default (null is a 400)
  "parentId": null,         // Optional, null or "" for root (stored as null); a trashed collection is a 409
  "order": 0,               // Optional, 0..2147483647; appended after siblings if omitted - see Ordering
  "variables": {},          // Optional, collection-scoped variables
  "auth": {"mode": "none"}, // Optional, default none; never mode "inherit" - see Collection auth
  "dataSchema": {},         // Optional, the declared data contract - see below
  "openapi": {},            // Optional, the bound spec document - see below
  "specFile": {},           // Optional, the bound spec file - see below
  "dataFile": {}            // Optional, the bound data file - see below
}
```

**Response:** The created collection object, carrying the engine-generated `id`.

**Errors:** `400` if the body carries an `id` ([the engine owns it](resource-writes.md#the-engine-owns-every-id)), if `name` is missing or `null`, if `name` is empty or whitespace-only ([#3253](resource-writes.md#blank-names)), if a `variables` key is blank or padded ([#3251](resource-writes.md#accepted-field-shapes)),
if `auth` states mode `inherit` ([#3445](resource-writes.md#collection-auth)) or a mode outside the [known set](resource-writes.md#auth-modes), if an `openapi` binding names no stored spec (below),
if `parentId` is neither a string nor `null` ([Accepted field shapes](resource-writes.md#accepted-field-shapes)), if `order` is not an integer from `0` to `2147483647` or an append finds no slot left ([Ordering](resource-writes.md#ordering)), or on a cycle (below);
`409` if `parentId` names a collection in the [trash](trash.md#trash) (below); `413` naming the field, its size and the cap, when a serialized `variables` / `auth` / `dataSchema` / `openapi` / `specFile` / `dataFile` is over the engine's [field cap](resource-writes.md#a-stored-json-field-has-a-write-time-cap), or a file binding's `path` or `fileName` is over its own (below).

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

### PUT /collections/:id

Update an existing collection.
**Update only** - a `404` when the id does not exist, never a silent create.
The body is a merge-patch: an omitted field keeps its value, an explicit `null` resets it to the default.

**Request:**
```json
{
  "name": "Renamed",       // Optional; null is a 400 (no default)
  "parentId": null,         // Optional, null or "" moves it to the root; a trashed collection is a 409
  "order": 3,               // Optional, 0..2147483647; a move with no order appends - see Ordering
  "variables": null,        // Optional, null resets to {}
  "auth": null,             // Optional, null resets to {"mode":"none"}; never mode "inherit" - see Collection auth
  "dataSchema": null,       // Optional, null clears the declared contract
  "openapi": null,          // Optional, null or {} unbinds the spec document; nothing else
  "specFile": null,         // Optional, null unbinds the spec file
  "dataFile": null          // Optional, null unbinds the data file
}
```

A `parentId` that changes the collection's parent and states no `order` appends the collection among its new siblings, rather than carrying a position from the list it just left.
See [Ordering](resource-writes.md#ordering).

A `parentId` that takes the collection out of the spec contract that answers for the requests beneath it is removing them from that contract (#3470),
the rule [`PUT /requests/:id`](requests.md#put-requestsid) applies to one request, with the same meaning of out:
every request in the subtree that records an operation (`specOperation`) and whose nearest binding after the move names another document, none, or the same document from a collection outside the source's contract has its stamp cleared,
and the operation is recorded as declined under the binding it left, in the same transaction as the collection's own row, so the source's [`POST /specs/diff`](specs.md#post-specsdiff) lists it under `declined` rather than `added`.
The binding after is read against the tree the `PUT` writes, so an `openapi: null` in the same body counts: a bound collection unbound and moved out at once clears its requests' stamps, and the decline that records under it is forgotten with the binding's other records (below).
A move within one contract keeps every stamp, and so does moving the bound collection itself.
The response is the collection; the cleared requests are read back with [`GET /requests/:id`](requests.md#get-requestsid) or arrive on the [change feed](changes.md#get-changes).
This is the decline [`POST /reorder`](#post-reorder) records for a moved folder.

**Headers:** `If-Match` (optional), see [Conditional updates](resource-writes.md#conditional-updates-with-if-match).

**Response:** The updated collection object, with its `ETag`.

**Errors:** `404` if the collection does not exist; `412` if `If-Match` no longer names the stored row;
`400` on a `null` or empty or whitespace-only `name` ([#3253](resource-writes.md#blank-names)), a malformed `If-Match`, a blank or padded `variables` key ([#3251](resource-writes.md#accepted-field-shapes)), an `auth` that states mode `inherit` ([#3445](resource-writes.md#collection-auth)) or a mode outside the [known set](resource-writes.md#auth-modes),
an `openapi` that is neither `null` nor `{}` (binding is [`POST /specs/bind`](specs.md#post-specsbind), issue #3348, below), a `parentId` that is neither a string nor `null` ([Accepted field shapes](resource-writes.md#accepted-field-shapes)), an `order` that is not an integer from `0` to `2147483647` or an append with no slot left ([Ordering](resource-writes.md#ordering)) or on a cycle (below);
`409` if `parentId` names a collection in the [trash](trash.md#trash) (below); `413` naming the field, its size and the cap, when a serialized `variables` / `auth` / `dataSchema` / `openapi` / `specFile` / `dataFile` is over the engine's [field cap](resource-writes.md#a-stored-json-field-has-a-write-time-cap), or a file binding's `path` or `fileName` is over its own (below).

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

**Cycle validation (both verbs):** `parentId` is validated to keep the collection tree acyclic, since a cycle would make the cascade delete below loop forever.
Both cases return `400`:

- `parentId` equal to the collection's own `id` - message `A collection cannot be its own parent`.
- `parentId` pointing at one of the collection's own descendants (a reparent that would form a cycle) - message `Cannot move a collection into its own descendant`.

Parent *existence* is intentionally not checked: the import orchestrator creates collections in bulk, so requiring the parent to exist first would couple to import ordering.
Only self-parent and descendant cycles are rejected.

**A parent in the trash (both verbs) is a `409`**, message `Collection '<id>' is in the trash - restore it first` (issue #1883).
That is different from a parent the store has never seen: a trashed parent would leave the collection live but invisible under it, and a purge of the parent would then re-parent it to the root.
Only a `parentId` the body states is checked, so a `PUT` that does not move the collection is never refused by its stored parent.

**`dataSchema` (both verbs, and `POST /import/apply`):** the data contract the collection declares - which columns its data files carry, so `{{data.column}}` and `pm.iterationData` can be checked before a run (issue #599).

```json
{"columns":["id","email"],"declaredAt":1700000000000,"fileName":"users.csv"}
```

`{}` means the collection declares no contract, and is what an absent field on create and an explicit `null` on update both resolve to.
A present value must be an object (`400` otherwise, like `variables` and `auth`), and its contents are validated: `columns` an array of unique, non-empty strings - at most 1024 of them, each at most 256 characters - `declaredAt` a number, `fileName` a string.
Each violation is a `400` naming the field (`Invalid 'dataSchema.columns': ...`) that writes nothing.

The schema is stored; the file's **rows are not**, anywhere.
Where the file is lives in `dataFile`, below.
See [Data-driven runs](../../app/data-driven-runs.md).

**`openapi` (`POST /collections`, `POST /import/apply`, and unbinding on `PUT`):** the OpenAPI document this collection is bound to (issue #637).

```json
{"specId":"spec_3f2b1c9a-...","specHash":"<hex sha256>","syncedAt":1700000000000}
```

`{}` means bound to nothing, and is what an absent field on create and an explicit `null` on update both resolve to.
A present value must be an object (`400` otherwise, like `variables` and `dataSchema`).
A *non-empty* one is a binding and is validated further: `specId` must be a non-empty string that resolves to a stored [spec document](specs.md#specs) (`400` naming the id otherwise).

**`PUT /collections/:id` only unbinds** (issue #3348): `{"openapi": null}` and `{"openapi": {}}` both store `{}`, and any other value is a `400` that names [`POST /specs/bind`](specs.md#post-specsbind), after the `404` and `412` checks.
Binding or rebinding an existing collection restamps every request beneath it both ways, which only that route does, in one transaction.
Unbinding forgets the operations deletes declined under the old document (issue #3031; see [`DELETE /requests/:id`](requests.md#delete-requestsid)).

`specHash` records which *version* of the document the collection was last synced to; a scenario run of a bound collection stamps both values into its snapshot and report (see [GET /runs/:runId/report](runs.md#get-runsrunidreport)).

**Send the `specId`; the engine writes the rest** (issues #709, #3348): a create stamps `specHash` from the document the id names and `syncedAt` from the moment of the write, so a binding cannot be stored without the version that contract coverage and response-schema validation compare against.
A `specHash` or `syncedAt` the body sends is dropped, never stored: the version is the document's, not the caller's claim about it.
A collection's recorded version can still fall behind its document's (a binding an older engine wrote); a run of it reports `hash_mismatch`, and a `PUT` that says nothing about `openapi` leaves it as it is.

Deleting the document is refused while a collection binds it - the binding is never cascaded away, see [DELETE /specs/:id](specs.md#delete-specsid).

**`specFile` and `dataFile` (both verbs; refused by `POST /import/apply`):** the files this collection's Spec and Data tabs are bound to (issue #2765), stored so a [workspace backup](health-config.md#post-workspacebackup) carries them.

```json
{"path":"/home/me/specs/pets.yaml","fileName":"pets.yaml"}
{"path":"/home/me/data/users.csv","fileName":"users.csv","hash":"<hex sha256>","castNumbers":true}
```

`{}` means no file, and is what an absent field on create and an explicit `null` on update both resolve to, so unbinding is `{"specFile": null}`.
A present value must be an object (`400` otherwise).
A *non-empty* one must carry `path` and `fileName` as non-empty strings and no member beyond its own: `specFile` holds those two, `dataFile` adds an optional `hash` (64 lowercase hex characters, the SHA-256 of the file's bytes, the digest a run records as `dataFileHash`) and an optional boolean `castNumbers`.
Each violation is a `400` naming the field or member that writes nothing; a `path` over 96 KiB or a `fileName` over 1 KiB is a `413` naming the member, its size and the cap.
The path's form is not checked: it is the location on the machine that picked the file, so a Windows path is stored on Linux as written.
A stored path grants nothing - a request body may send a file only under the [file trust rule](file-access.md#allowed-folders-file-roots) - and the engine never opens either file.
Neither field appears in `POST /export/postman` or `POST /specs/export`.
A `POST /import/apply` collection item carrying either is a `400` with `error.item`, because an import describes a document from elsewhere; `null` passes.

### DELETE /collections/:id

Delete a collection and all its requests (cascading delete).
**The delete is soft** (issue #988): the collection and every descendant are stamped `deleted_at` in a single transaction rather than removed, which is why every read surface stops returning them while [`GET /trash`](trash.md#get-trash) still can.
The walk terminates even if the stored `parent_id` tree contains a cycle (see [db-schema/index.md](../db-schema/index.md) - collections).

Restore it with [`POST /trash/:id/restore`](trash.md#post-trashidrestore); destroy it for good with [`DELETE /trash/:id`](trash.md#delete-trashid), which is also what the startup sweep does once `trashRetentionDays` has passed.

**Beneath a bound collection, the delete declines operations** (issue #3031), as [`DELETE /requests/:id`](requests.md#delete-requestsid) does for one request: each request it stamps that records an operation is recorded under the nearest bound ancestor, in the same transaction.
Deleting a tag folder is the user declining everything in it.
Deleting the bound collection itself records nothing - that is the whole contract going, not a choice about any operation of it - and a purge of a bound collection takes its records with it.

**The delete stops every running [mock](mock-server.md#mock-server) of what it trashed** (issue #3449): a mock of the collection itself or of any folder under it, whichever client sent the delete, before the response is sent, so it is gone from [`GET /mock`](mock-server.md#get-mock) by then.
A mock of a collection outside the subtree keeps running.
Restoring the collection does not start its mock again; `POST /mock/start` does.

**Response:**
```json
{
  "message": "Collection deleted successfully",
  "id": "col_1234567890"
}
```

## Reorder

### POST /reorder

Reposition collections and requests in one atomic batch - the write path behind a drag-and-drop reorder or a cross-folder move.
One drop is one call, one lock scope and one transaction: the batch validates, stages and commits under a single acquisition of the engine's database lock, so nothing partial survives a rejection and no concurrent write - a create computing its append slot, a conflicting batch, a cascade delete - can land between what this batch checked and what it wrote.

**Request:**
```json
{
  "normalize": [
    {"parentId": "col_1234567890"}
  ],
  "moves": [
    {"type": "request",    "id": "req_1", "order": 0, "collectionId": "col_2"},
    {"type": "collection", "id": "col_3", "order": 1, "parentId": null}
  ]
}
```

Both arrays are optional (absent or `null` means none); an empty batch is a `200` that writes nothing.

**`moves`** - each entry names one row and the position it takes:

| Field | Rule |
|---|---|
| `type` | `"collection"` or `"request"`; anything else is a `400` |
| `id` | Non-empty string naming a **stored** row of that type |
| `order` | Required, an integer from `0` to `2147483647`. Not a float, not negative, not past the column - this endpoint writes dense positions, and each would be a silently truncated, unreachable or wrapped slot. Anything else is a `400`, e.g. `Invalid move at index 0: 'order' must be an integer from 0 to 2147483647 (got 2147483648)` |
| `parentId` (collection) | Absent keeps the current parent; `null` or `""` moves to the root; any other string moves under that collection, which must exist; anything else is a `400` naming `parentId` |
| `collectionId` (request) | Absent keeps the current owner; a string moves to that collection, which must exist |

A row may appear in `moves` at most once - two positions for one row is a `400` naming it, not a last-writer-wins accident of iteration order.

**`normalize`** - each entry names a **parent**, and its children are renumbered dense `0..n-1` in the [sibling order](resource-writes.md#ordering) **before** any move applies.
The children are the parent's sub-collections and its requests as one list (#2535), so a tie across the two kinds comes out as distinct numbers with the sub-collection first.
An entry is `{"parentId": <collection id>}`, or `{"parentId": null}` (`""` reads the same) for the root collections (the roots hold collections only).
The named collection must exist, and `parentId` must be *stated* rather than omitted, so a renumber can never land on a scope the caller did not mean.
The per-kind shapes engines before #2535 took, `{"type": "collection", "parentId": ...}` and `{"type": "request", "collectionId": ...}`, are a `400` naming the shape above: renumbering one kind alone would leave it tied with the other kind's slots.

Normalization exists for the first drop into a collection whose rows predate explicit orders: every row sits at `0`, so its displayed position lives only in the tiebreak and there are no slots to shift into.
Materializing that order in the same batch is what keeps the other siblings from appearing to jump; a parent with every row at `0` comes out with its sub-collections at `0..m-1` and its requests after them, the order the tie rule already showed.
It is idempotent
- a scope already dense writes nothing at all.

Where a row is named by both lists, the move wins.

**A move out of a spec contract declines the operation** (#3446), the rule [`PUT /requests/:id`](requests.md#put-requestsid) applies to one request, with the same meaning of out.
A request that records an operation (`specOperation`) and that the batch leaves outside its contract comes back with `specOperation: null`, and the operation is recorded as declined under the binding it left, in the batch's transaction.
A moved collection does this for every stamped request beneath it, as a `parentId` sent to [`PUT /collections/:id`](#put-collectionsid) does (#3470).
The binding after and the contract are read against the tree the batch writes, so a request moved into a folder the same batch moves away is judged by where the folder lands.
A move within one contract keeps the stamp, and so does moving the bound collection itself.
Each request this clears is in the response, a request whose position did not change included.

**Validation is complete before the first write.**
Entry shapes, the existence of every named row and owner, and the acyclicity of the **post-move** collection graph are all checked first; a failure is a `400` naming the offending row with nothing written.
The cycle check reading the post-move shape is what makes two reparents that each look legal alone (`A` under `B` and `B` under `A`) a deterministic rejection rather than a race.
The same pair sent as two `PUT /collections/:id` calls is caught as well - each update holds its read to its write - but one at a time, so the first reparent is already committed when the second is refused; the batch refuses both and writes nothing.

That rejection is deterministic **because the check and the commit share one lock scope**: two such batches arriving concurrently are serialized whole, and the second revalidates against the first's committed graph rather than against the shape both of them read.
The rows are written as updates, never inserts, so a batch whose row was deleted after it staged fails with a `409` naming the row and writes nothing at all - it never re-creates the deleted row.

**Response:** the rows as written, in the same serialized shape a list entry carries - not an acknowledgement.
A client that drew the drop optimistically settles its caches on these, so a normalization the engine performed is visible without waiting for a refetch.

```json
{
  "collections": [],
  "requests": [
    {"id": "req_1", "collectionId": "col_2", "order": 0, "name": "Get users", "...": "..."}
  ]
}
```

**Errors:** `400` for any malformed entry (a per-kind `normalize` entry included), a row or owner that does not exist, a duplicate move, a cycle, or a batch over 10000 entries.
`409` if a staged row is gone by the time the batch commits.
In every case nothing at all was written.
Body that is not JSON or not an object is also a `400`.
