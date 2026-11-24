---
description: >-
  The API service's methods for saved data: request examples, the create-versus-update rule, collections, requests, the trash and reordering.
---

# API methods: collections, requests and examples

## Request examples

```typescript
apiService.listRequestExamples(requestId): Promise<RequestExample[]>
apiService.createRequestExample(requestId, example): Promise<RequestExample>
apiService.deleteRequestExample(requestId, exampleId): Promise<void>
```

Saved example responses stored against a request (issue #481) - what an import found next to it, and what a mock server will serve.
**Not read-only any more** (issue #588): the response viewer's *Save as example* keeps the response on screen as one, with its body as received (`bodyRaw`, not the indented pane copy), and the Examples tab removes one.
`PUT` still has no caller and so no endpoint constant - the panel is a viewer, and editing a stored example is its own change.
The three consumers are in `queries/request-examples.ts` (`useRequestExamplesQuery`, `useCreateRequestExampleMutation`, `useDeleteRequestExampleMutation`); both writes settle by invalidating the one list key rather than splicing a row in, since the engine decides the id, the `order` an append lands on and the stored shape of the row.
The delete also invalidates `trash.all` (#2971): the engine moves a saved example to the Trash and keeps an imported one as a spec-sync tombstone, and the mutation cannot tell which, so an open Trash view refetches either way.
A saved example's delete raises the shared `Moved "<name>" to the Trash` toast with an Undo (`hooks/useTrashUndo.ts`); an imported one raises none, since there is nothing in the Trash to restore.

A saved example is written with **`origin: "user"`**, and an imported one keeps the engine's `"import"` default.
Its first reader is the OpenAPI spec sync (#627), which may replace the examples a document produced and must never touch one a person saved - and since #722 the panel reads it too: `RequestExample` claims the field, an imported row carries an **Imported** chip, and the delete dialog says what can still bring that kind of row back (the Trash for a saved one, a re-import for an imported one).
The asymmetry the field encodes is a fact about the list, so leaving it invisible made which rows the next sync would replace unpredictable.
The rest of the payload is the importers' own mapping, `contentType` included (the response's Content-Type header verbatim, `""` when it stated none), so an app-saved example and an imported one are served identically.
No `order` is ever sent: the engine appends, which is what keeps a restarted mock answering with the same first example.

A response from a live send also carries **`sentRequest`**, the request as the builder held it at Send (`{{vars}}` unresolved, the stored request-column shapes from `sentRequestOf` in `utils/execute-mapping.ts`; issue #1763).
`RequestBuilderProvider` attaches it - to the `/execute` result on the buffered path, and on a stream to the stored run's response at stream end, only when that run is the one the snapshot was taken for.
The save sends it as the create-only **`savedFrom`**: `{ request, statusText, responseTimeMs, receivedAt }`, the server's own reason phrase, the response time and when the response came in (epoch ms, from `receivedAt`, or the stored run's `restoredFrom.at` on a stream's reloaded copy - the time a cookie's `Max-Age` counts from) beside it.
The engine builds the Postman saved-response shape from it once and stores it for the export.
A response restored from a stored run has no snapshot, so its save omits `savedFrom` and the export regenerates that example.

No transformer, unlike a request row: an example carries no timestamp the app renders and no column that predates a schema change, so the wire shape *is* the domain shape - minus the `order` and timestamps the `RequestExample` type deliberately does not claim, since the list arrives already ordered and no surface displays either.
The stored order is the contract, not a suggestion: a mock server answers with the first example of a matched request, so the panel renders the list as received rather than re-sorting it.

Imported examples take a different route entirely: they ride **nested on their request item** in `POST /import/apply` (`ImportApplyRequestItem.examples`), not through this endpoint, so the whole tree still lands in one engine transaction.

## Create vs update

For collections, requests and environments the engine splits the write verbs: `POST /<resource>` creates and never updates; `PUT /<resource>/:id` updates and answers an unknown `id` with `404`.
They are not interchangeable, so `apiService` keeps one method per verb:

- `createX(data)` posts the object to the collection path **with `id` stripped** (`withoutId` in `api.ts`).
  The engine assigns every id and answers a create carrying one with a `400`, and the `Create*Request` types declare `id?: never` - but TypeScript only excess-property-checks object literals, so a call site that spreads a whole record (a duplicate flow, a restored tab) would slip one through.
  The strip is what actually holds.
  (Import is no exception: it sends one `applyImport` call and assigns no ids of its own to wire a tree together, see below.)
- `updateX(data)` takes `data.id`, puts it in the **path**, and sends the rest of the object as a merge-patch body - an omitted field keeps its stored value, an explicit `null` resets it to the default.
  The `id` is not repeated in the body; a body `id` disagreeing with the path is a `400`.

The full contract, including the null-vs-absent table and which fields have no default, is in [engine/api-reference/index.md](../../engine/api-reference/index.md) under "Resource writes".
`src/services/api.write-verbs.test.ts` pins the method and path of every one of these calls - a regression here is invisible at every other layer, because the payload shape does not change.

## Collections

```typescript
apiService.listCollections(): Promise<Collection[]>
apiService.createCollection(data): Promise<Collection>   // POST /collections
apiService.updateCollection(data): Promise<Collection>   // PUT  /collections/:id
apiService.deleteCollection(id): Promise<void>
```

A collection carries **`dataSchema`** - the data contract it declares (issue #599): `{columns?: string[], declaredAt?: number, fileName?: string}`, where `{}` means it declares none.
`CollectionTransformer` normalizes it field by field rather than casting, because a row can come from an engine that predates the column and every reader treats `columns` as a string array; use `hasDataContract(schema)` instead of hand-rolling the check, since a cleared contract is `{}` and not `undefined`.

On `updateCollection` the field is `CollectionDataSchema | null`, like `parentId`: the engine reads absent as "keep the declared contract" and an explicit `null` as "reset to none", so the Data tab's **Clear** and its picker's **Remove** (the two writers of it) are only expressible as a null that survives to the wire.
The rows behind the schema are never sent by these calls at all - they ride only the `POST /runs` payload, and are persisted by neither side.

A collection also carries **`openapi`** - the spec document it is bound to (issue #637): `{specId?, specHash?, syncedAt?}`, where `{}` means bound to nothing.
It is normalized field by field for the same reason `dataSchema` is, and `hasSpecBinding(binding)` is the check to use - a collection that was bound and then unbound holds `{}`.
On `updateCollection` the field is `CollectionOpenApiBinding | null`, and the Spec tab's **Unbind** is that null.

## Requests

```typescript
apiService.listRequestSummaries(params?): Promise<RequestSummary[]>  // GET /requests?fields=summary
apiService.listRequests(params?): Promise<Request[]>     // GET /requests, whole rows
apiService.getRequest(id): Promise<Request>
apiService.createRequest(data): Promise<Request>         // POST /requests
apiService.updateRequest(data): Promise<Request>         // PUT  /requests/:id
apiService.deleteRequest(id): Promise<void>
```

The two list calls answer the same rows in the same order; `params` is `{ collectionId? }` on both.
**`listRequestSummaries`** is the tree's (#2546): each row is a `RequestSummary` (`id`, `collectionId`, `name`, `method`, `url`, `order`, `createdAt`, `specOperation`), read by `RequestTransformer.toSummary`, and it is the only list call the launch makes.
**`listRequests`** is the whole row, `RequestTransformer.toFrontend` (built on `toSummary`, so a column the two share reads the same way in both); only the column audit asks for it (`useFullCollectionRequests`).
A reader that needs one request's body, headers or scripts reads `getRequest`, which never substitutes a default for an over-cap column the way a full list row can.

A request carries **`specOperation`** - which operation of the bound spec it is (issue #637): `{operationId?, method, path}`, where `path` is the document's **templated** path and not the URL the request sends.
The engine serializes `null` for a request that names none, and `RequestTransformer` turns that into an absent key; on `updateRequest` the field is `SpecOperation | null`, so stamping and clearing an identity are the same verb.

A request also carries **`methodSource`** - which app setting last wrote `method`, still unclaimed by the user (issue #1505): `MethodSource` (`"graphql"`, the GraphQL body mode's auto-`POST`) or absent.
Same null-vs-absent rule as `specOperation`: the engine serializes `null` for no marker, `RequestTransformer` turns that into an absent key and drops a value it does not recognize, and `updateRequest`'s field is `MethodSource | null`, so leaving GraphQL - or picking a method by hand - clears the marker the same way.

A request carries **`timeout`** - its own timeout in milliseconds, `1`-`86400000` (issue #2937) - or `null` when it states none and sends with the `defaultTimeout` setting read at each send.
The engine always serializes it, and `RequestTransformer` keeps `null` as `null` rather than filling in a default (a non-number reads as `null` too).
On `updateRequest` the field is `number | null`: absent keeps the stored value and `null` resets it, so the builder's `buildUpdatePayload` writes a cleared field as an explicit `null`.
The engine refuses a number outside the range with a 400 naming `timeout`, so the Settings tab clamps what is typed.

**The builder seeds its Params rows from the stored `params` and the URL's query together** (issue #3491, `initialRequest` in `modules/request-builder/index.tsx`).
A request stored with its query only in `url` (written before the engine derived the rows from a URL-only write, issue #3551, or by a write that stated `params: []`) opens with those pairs as rows, through `mergeParamsFromUrl` - the rule a URL-bar edit already uses, so stored disabled rows and rows with a value and no key stay, and a stored row keeps its id and description.
Without it the table opened empty and its first edit rebuilt `url` from the rows alone, deleting the query.
The seed is not an edit: the draft's saved baseline is seeded from the same rows, so the request is not marked unsaved, and nothing is written back until the user changes something.

## Trash

```typescript
apiService.listTrash(): Promise<ListTrashResponse>              // GET    /trash
apiService.restoreTrashEntry(id): Promise<RestoreTrashResponse> // POST   /trash/:id/restore
apiService.purgeTrashEntry(id): Promise<PurgeTrashResponse>     // DELETE /trash/:id
```

What `deleteCollection`, `deleteRequest`, `deleteEnvironment` (#2970), `deleteRequestExample` for a saved example (#2971) and `deleteClientCertificate` (#2973) now do is a soft delete (issue #988): the engine stamps the row instead of removing it, and these three read that stamp back.
No transformer on any of the three - a trash entry is the engine's own summary of a deleted row (a name, a stamp and its counts), not a stored record the app reshapes, so the wire shape is the only shape.

`listTrash` returns **roots only** - the row a user actually asked to delete, never a descendant the same cascade took with it.
A deleted collection's whole subtree is represented by that one root entry, with `collections` / `requests` counting what that delete took along (the cohort a restore puts back) and `purgeCollections` / `purgeRequests` counting everything a purge would destroy under it, an earlier delete's rows included (#3449).
The row and the purge prompts read the purge totals; the cohort counts are a floor there.
`kind` is `"collection"`, `"request"`, `"environment"`, `"example"` or `"clientCertificate"`; an environment entry is always a root, counts `0` for both, and alone carries `variables`, how many variables it holds.
An example entry counts `0` for both too; the engine's `parentId` on it is the owning request, which `TrashEntry` does not claim: it carries the owner's name as `parentName` instead (#3449), sent on request and example entries only, which the row shows as "from <name>" so two same-named entries tell apart.
A client-certificate entry is a root with both counts `0` and a `null` `parentId`; its `name` is its target, `host` or `host:port`.

`restoreTrashEntry` puts one deleted root back, with everything the same delete took, and answers with the entry plus `restored: true` and `reparentedToRoot` - true when the collection's parent is gone or itself in the trash, so the engine clears its parent and returns it as a tree root instead.
It rejects with a `404` for an id the trash does not hold (a live row, or one already purged) and a `409` for a request whose collection is itself deleted or gone - a request has no root to land on the way a collection does, so the engine's message names the request, its collection and the Trash root to restore first (the collection, or the ancestor whose delete took it), by name and id -
and the same `409` for an example whose request is in the trash (naming the example, the request and the root to restore) or gone, or already holds the most examples a request may (100), and for a client certificate while a live entry holds the same host and port (the message names that entry);
surface `ApiError.message` rather than inventing wording for it.
Both the Trash view's Restore and the toast's Undo do.
A restored environment comes back with every variable but inactive: the delete cleared its active flag and the restore does not set it again.
A restored example reappears in its request's Examples list because the restore invalidates `requests.all`, under which the examples key sits; a restored client certificate reappears in Settings because the restore invalidates `clientCertificates.all`.

`purgeTrashEntry` is the hard purge the soft delete deferred - it destroys the row for good, with its whole subtree, and there is no undo.
For a client certificate that is the registry entry and its stored passphrase; the certificate and key files it names are never touched.
It answers with the entry plus `purged: true`, or a `404` if the trash does not hold that id.

The full contract - request/response bodies, the restore's cohort and re-parent rules, and the startup retention sweep - is in [engine/api-reference/trash.md](../../engine/api-reference/trash.md#trash) under Trash.

## Reorder

```typescript
apiService.reorder(data: ReorderRequest): Promise<ReorderResponse>  // POST /reorder
```

The write path behind a drop.
One call repositions any number of collections and requests, and the engine applies the whole batch in one transaction - so a drop that displaces N siblings is one round trip, not N `updateRequest` calls that can half-land and race a concurrent create into the middle of their range.

The payload carries `moves` (each row's `type`, its new `order`, plus `parentId` / `collectionId` when it changes owner) and `normalize`, one `{ parentId }` per parent to renumber dense `0..n-1` in sibling order first (`null` for the top level), for a parent whose rows predate explicit orders.
A parent's sub-collections and requests are one list in one `order` space (#2535), so one entry covers both kinds and a single drop can move a request between two folders; the per-kind `{ type, parentId | collectionId }` entries earlier engines took are a `400`.
`modules/collections/reorder-math.ts` computes both arrays from the merged sibling list the tree is already showing; the full contract is in [engine/api-reference/collections.md](../../engine/api-reference/collections.md#post-reorder) under `POST /reorder`.

Unlike the other writes, the response is **read**: it is the rows as written, and `useReorderMutation` settles its caches on them so a normalization the engine performed shows up without waiting for the refetch.
