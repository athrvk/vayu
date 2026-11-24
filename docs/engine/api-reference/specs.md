---
description: >-
  The API-spec routes: store, read and delete a spec; match, describe, diff, bind, export and sync it against a collection.
---

# Specs

OpenAPI documents, stored once and bound to collections by [`collections.openapi`](collections.md#post-collections) (issue #637).
A spec is not owned by a collection: several may bind the same document, and unbinding one must leave it there for the others - so it is a top-level resource with no cascade reaching it, and the rule that keeps that safe is the delete refusal below.
What it is *not* is immortal: see the reclamation rule further down.

The document is stored **verbatim** and its `hash` is computed engine-side on every write, never taken from the caller.
A scenario run of a bound collection stamps `specId` + `specHash` into its snapshot and report, and that stamp only means anything because both sides of a later comparison were computed by the same code on the same bytes.

There is deliberately **no `PUT /specs/:id`**: a document that changed is a different document, and rewriting one in place would invalidate the hash every run of every bound collection was stamped with.
A re-fetch stores a new document and moves the binding.

**A document nothing can reach is reclaimed** (issue #718).
Having no owner is what let these rows accumulate with no way to die - every sync mints one and moves the binding off the last, and `DELETE /specs/:id` needs an id no route hands out for an unbound document.
So the engine sweeps on one rule:

> A document lives while a collection binds it, **or** while a retained run names
> it in its snapshot under `scenario.openapi.specId`.

Run-referenced documents live exactly as long as the runs do, so a report's coverage never describes a contract whose source is gone.
The sweep runs as part of ordinary housekeeping - at startup, after each run's retention pass, after a `POST /specs/sync`, and after a `DELETE /collections/:id` - and **spares any document written in the last 10 minutes**, because storing a document is the first of the three writes that bind one and a caller may not have sent the `PUT /collections/:id` yet.
A client that stores a document it does not intend to bind should therefore expect it to go: `GET /specs/:id` will answer `404` once it is unreachable by that rule.
Nothing here changes what `DELETE /specs/:id` refuses, and no cascade was added - a bound document is untouched.

## POST /specs

Store one OpenAPI document.
**Create only**, and the engine owns the id - see [Resource writes](resource-writes.md#resource-writes-create-vs-update).

**Request:**
```json
{
  "content": "{\"openapi\":\"3.1.0\", ...}",  // Required, non-empty, at most maxSpecDocumentBytes
  "sourceUrl": "https://api.example.com/openapi.json"   // Optional; null when pasted or uploaded
}
```

**Response:**
```json
{
  "id": "spec_3f2b1c9a-...",
  "content": "{\"openapi\":\"3.1.0\", ...}",
  "sourceUrl": "https://api.example.com/openapi.json",
  "fetchedAt": 1730000000000,
  "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "operations": [
    {"operationId": "listPets", "method": "GET", "path": "/pets", "responses": ["200", "default"]}
  ]
}
```

**`operations` is derived by the engine, never sent** (issue #853).
It is a fact about the bytes being stored, like `hash`, so the engine reads them: `content` is parsed as JSON and then, failing that, as YAML, and the operation index comes off that parse.
Sending an `operations` field is a `400`.

Each row carries a `method` and the **templated** `path` as the document keys it, an `operationId` when the document declares one, and `responses` - the status patterns the document declares (`"200"`, `"4XX"`, `"default"`), verbatim and in document order.
A document declaring more than **2000** operations is refused with the count and the cap, because a run holds the index in memory for its life.

What the reader does with a document, stated because the answers are visible in the index:

- **Document order is kept**, for `paths` and for each operation's `responses`.
- **Both formats**: `openapi: 3.x` and `swagger: 2.0` (quoted or not).
  Anything else declares nothing - a stored file that is not a contract stores fine and reports no coverage.
- A **path item that is a `$ref`** is followed one hop, in-document; one that resolves to nothing drops that path rather than failing the write.
- The seven methods Vayu executes are indexed, `trace` is not.
- A **repeated `operationId`** is kept on its first declaration only (issue #715); the later operation is indexed by method and path alone.
- **Anchors, aliases and merge keys (`<<`)** are expanded as js-yaml expands them; an alias naming no anchor, a duplicate mapping key, and a document that expands to far more nodes than its own size are each a `400` naming the problem.

A document that declares no operation stores "no index", which is not the same as an empty contract: `GET /specs/:id` reads it back as `null` rather than `[]`, and a run of a collection bound to it reports **no coverage block at all**.
`POST /import/apply`'s spec section and `POST /specs/sync` derive both indexes through the same helper, so a document cannot acquire or lose one depending on which route stored it.

**`responseSchemas`** is the second index the engine derives from the same read (issues #628 and #860) - what the document declares each response *looks like*.
Like `operations`, it is not a field of the body; sending one is a `400`:

```json
{
  "refRoots": {"components": {"schemas": {"Pet": {"type": "object"}}}},
  "operations": [
    {
      "operationId": "getPet",
      "method": "GET",
      "path": "/pets/{petId}",
      "responses": [
        {"status": "200", "contentType": "application/json",
         "schema": {"$ref": "#/components/schemas/Pet"}}
      ]
    }
  ]
}
```

**A response schema that refers to itself without describing any value is a `400`** (#3018): `Response schema of GET /pets (200) refers to itself without describing any value (#/components/schemas/A -> #/components/schemas/A)`.
The loop runs only through `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else` or `dependencies`, so it never reaches a value and cannot be validated.
A recursive schema that steps into a property or an item (a tree node) is fine.

Schemas are **JSON Schema**, not OpenAPI's dialect:
the engine translates `nullable` into a union with `null`, draft-04's boolean `exclusiveMinimum` into draft-07's numeric one, and drops the OpenAPI-only keywords that constrain no body (`discriminator`, `xml`, `externalDocs`, `example`) - a `nullable` passed through untouched would report a null the document permits as a type failure, which is a *wrong* verdict rather than a missing one.
Each schema keeps its `$ref`s and `refRoots` carries the subtrees they point into once (`components.schemas`, `definitions`, `x-vayu-bundled`), so a shared schema is stored once and a recursive one is a pointer rather than an infinite expansion.
A **response that is itself a `$ref`** is read through, one hop, in either dialect (`#/components/responses/x` in 3.x, `#/responses/X` in 2.0) - the shape GitHub's spec uses for nearly every response.
`status` is the pattern verbatim (`"200"`, `"4XX"`, `"default"`), `contentType` is a media type (3.x keeps every one the response declares; 2.0 pairs each response with the operation's `produces`, falling back to the document's, then to `application/json`), and a `schema` may be `true` or `false` as well as an object.
The serialized index is held to the same `maxSpecDocumentBytes` cap as the document, and one over it is a `400` naming the count and the cap.
A status that declares no schema is a status-only row (`{"status": "204", "contentType": ""}`, no `schema`), so a response under it reports `checked: false` instead of being judged by `default`.
An `x-` extension key under `responses` is not a status and is indexed in neither list (#3084).
A document where no operation declares a status stores "no index", read back as `null`, and every response of it reports `checked: false` with the reason `no_index`.

Both indexes come off **one** read of the document, which is what makes them agree: a status the schema index carries is a status the operation index lists for the same operation, and the identity in each is the same identity - the repeated-`operationId` rule included.

`sourceUrl` is `null` rather than `""` when the document did not come from a URL, so a client can offer a re-fetch for exactly the documents that have somewhere to re-fetch from.

**Errors:** `400` if the body carries `id`, `hash`, `fetchedAt`, `operations` or `responseSchemas` (all engine-computed), if `content` is missing, `null` or empty, if `sourceUrl` is present and not a string or `null`, or if the document is larger than the live `maxSpecDocumentBytes` [config entry](health-config.md#get-config) - default **10 MiB**, aligned with the engine's JSON field cap.
The size rejection names the byte count, the cap and the setting, and is checked on `POST /import/apply` too, through the same helper; the document is never stored truncated.
**A `content` the engine cannot read as JSON or YAML is a `400`** naming the line - storing it would leave a row that coverage, a sync and an export can each do nothing with, and none of those is a good place to find out.

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

## GET /specs/:id

**Response:** the whole stored document, `content` included - rendering and validating it is what every reader wants it for.
`404` (message `Spec not found`) when it does not exist.

Read it for the *text*: an export, a re-fetch comparison, a `$ref` resolution.
A client that only needs to describe the document should read the metadata route below instead - `content` here is up to `maxSpecDocumentBytes` (12 MB for Stripe's published spec), and it is sent in full on every read.

## GET /specs/:id/meta

Everything about a stored document except the document (issue #712).

**Response:**
```json
{
  "id": "spec_3f2b1c9a-...",
  "sourceUrl": "https://api.example.com/openapi.json",
  "fetchedAt": 1730000000000,
  "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "contentBytes": 12058329
}
```

Every field carries the same value `GET /specs/:id` would give it - the two are one row seen two ways - and `404` is the same body, so a client that falls back from one to the other does not need two shapes of "not found".

**`content`, `operations` and `responseSchemas` are absent, not empty.**
All three are the fields that make a document big (both indexes are extracted from it and grow with it), and an empty one would be indistinguishable from a document that genuinely has none - the distinction `operations: null` exists to draw.
A reader that needs any of them reads the full route.

`contentBytes` is the document's size as the engine counts it - the same measure `maxSpecDocumentBytes` refuses a write by, so a size reported here and the limit it was stored under are in one unit.

This route exists because binding metadata lives on the *document*: the app's Spec tab paints a source and a fetch date, and getting them used to cost a transfer of the whole spec on every first open of the tab.

## DELETE /specs/:id

Delete a stored document.

**Response:**
```json
{
  "message": "Spec deleted successfully",
  "id": "spec_3f2b1c9a-..."
}
```

**Errors:** `404` when it does not exist.
`409` while any collection still binds it, a collection in the Trash included, with a message naming the first binder (and a count of the rest) so the caller knows what to unbind without a second round trip:

```json
{
  "error": {
    "code": "conflict",
    "message": "Spec 'spec_3f2b...' is bound by collection 'Pets API' (col_9a1f...); unbind it before deleting the document"
  }
}
```

A binder in the Trash is named as such (#3446), because restoring it brings its binding back and a document deleted under it would come back named by a collection whose document is gone:

```json
{
  "error": {
    "code": "conflict",
    "message": "Spec 'spec_3f2b...' is bound by collection 'Pets API' (col_9a1f...), which is in the Trash; restore it and unbind it, or purge it, before deleting the document"
  }
}
```

The refusal is deliberate rather than a cascade to unbound: the caller asked to delete a document, not to edit collections it never mentioned.
Unbind with `PUT /collections/:id` and `{"openapi": null}`, then delete.
Purging a trashed binder runs the orphan sweep, which reclaims the document itself once nothing else binds it.

## POST /specs/match

Pair the requests in a collection's subtree with the operations a document declares - what binding a collection that already exists needs, and what an import does not (an import *creates* the requests, so it stamps each one's identity as it builds it).

**Reads only.**
Nothing is stored, stamped or created, so a caller may ask about a document it has not decided to bind - which is exactly what the app's Spec tab does, showing the counts before the user commits.
The write is [`POST /specs/bind`](#post-specsbind), which matches again over the same walk and the same rule rather than being handed this answer: between a preview and a commit a request may have moved, so what the two share is the rule, not a result carried between them.

**Request:**
```json
{
  "collectionId": "col_9a1f...",
  "operations": [
    { "operationId": "listPets", "method": "GET", "path": "/pets" },
    { "method": "GET", "path": "/pets/{petId}" }
  ],
  "basePaths": ["/v1"]
}
```

`operations` are the same identity rows the engine derives into a document's `operations` index, validated by the same rule - so a set the store would refuse cannot be matched against here first.
They are sent here (unlike on `POST /specs`, which reads them off the document) because this route matches against a document that has not been stored yet, which is the point of a bind preview.
**Get them from [`POST /specs/describe`](#post-specsdescribe)** rather than by reading the document yourself (issue #869): that route is the same reader `POST /specs/bind` derives its stamps from, so a preview and the write it previews cannot pair the requests differently.
`responses` may ride along and is ignored.
`basePaths` is optional: the path parts of the document's server URLs, which `POST /specs/describe` answers beside the operations (issue #3030).
A non-array, or an entry that is not a string, is a `400`; an entry that does not start with `/`, or is the root, names nothing to strip and is ignored.

The requests are **not** sent.
The engine gathers the subtree of `collectionId` itself, because an OpenAPI import binds the root and files every request under one sub-collection per tag: a caller sending "the collection's requests" would be matching against a set that excludes almost all of them.
The walk **stops at a sub-collection bound to a different document** (issue #3034), taking its descendants with it: a folder that is another contract's own keeps its requests out of this pairing, exactly as `POST /specs/bind` keeps them out of its stamping.
A sub-collection bound to the same document stays in, and an unbound `collectionId` stops at every bound sub-collection.

**Response:**
```json
{
  "matched": [
    {
      "requestId": "req_4c8e...",
      "operation": { "operationId": "listPets", "method": "GET", "path": "/pets" }
    }
  ],
  "unmatchedRequests": ["req_7b21..."],
  "unmatchedOperations": [{ "method": "GET", "path": "/pets/{petId}" }]
}
```

`operationId` is **absent** rather than `""` for an operation that declares none, the same way a stored `spec_operation` omits it.

**How it matches.**
Both sides are reduced to a path shape: the origin dropped (`{{baseUrl}}`, `https://api.example.com` and a schemeless host alike), the query and fragment dropped, and every placeholder - Vayu's `{{petId}}`, a request's Postman-style `:petId` path variable (issue #1764) and the document's `{petId}` - flattened to `{}`.
Flattening the name too is deliberate: a document that renames its path parameter describes the same endpoint, and a match that turned on the parameter's spelling would report a rename as removed and added.
A second pass then offers each remaining request to the templates it could be an instance of, because a hand-built collection writes the id in (`/pets/42`) - a literal path in the document wins first, which is OpenAPI's own precedence.
A segment mixing literal text with a placeholder (`{id}.json`, `{name}:cancel`, `meta-{ver}`, issue #3085) is filled the same way: the text around the placeholders must appear in order and each placeholder takes at least one character, never a `/`.
A third pass reads `basePaths` (issue #3030): a request written as a literal URL carries the server's base path (`https://h/v1/pets`) where the document writes `/pets`, so whatever the first two passes left open is compared again, both ways, with each base path taken off the front of the request's path.
A base path is taken off whole segments only (`/v1` is not a prefix of `/v10/pets`), a templated one (`/{version}`) stands for any one segment (a segment mixing text with a placeholder, `/api-{version}`, fills as above), and a request that is exactly the base path is the root operation `/`.
The first two passes win, so a document declaring `/v1/pets` in full claims that request before any base path is stripped.
**Ambiguity is refused in both directions**, in every pass: two requests reducing to one shape, or one request that could be two operations - under two base paths included - leaves all of them unmatched.
A wrong identity is worse than none, because `POST /specs/sync` applies changes *by* it.

**Errors:** `400` for a missing or empty `collectionId`, a missing `operations`, an operation row the store would refuse, or a `basePaths` that is not an array of strings.
`404` when the collection does not exist - not an empty match, since "this document matches none of your requests" and "you named a collection that is not there" are different answers.

## POST /specs/describe

Say what a document *is*, without storing it: the dialect that claimed it, what it calls itself, every operation it declares and the base paths its servers name.
The read behind a bind preview - the app's Spec tab paints its card from this and hands the identities straight to [`POST /specs/match`](#post-specsmatch).

**Reads only.**
Nothing is stored, which is why the document rides in the body: a caller asks about a file the user has not decided to bind, and a route that stored one to describe it would leave a row behind for every file merely looked at.
Describing a document that *is* stored is [`GET /specs/:id/meta`](#get-specsidmeta).

**Request:**
```json
{
  "content": "{\"openapi\":\"3.1.0\", ...}"   // Required, non-empty, at most maxSpecDocumentBytes
}
```

**Response:**
```json
{
  "format": "OpenAPI 3.1",
  "title": "Pets API",
  "operations": [
    { "operationId": "listPets", "method": "GET", "path": "/pets" },
    { "method": "GET", "path": "/pets/{petId}" }
  ],
  "basePaths": ["/v1"]
}
```

`format` is `"OpenAPI 3.1"` (an `openapi` starting `3.1`), `"OpenAPI 3.0"` (any other `3.`) or `"OpenAPI 2.0 (Swagger)"`.
`title` is the document's `info.title` and `""` when it states none - never a substitute name, because the caller asked what the document calls itself.
`operations` are in document order, in the shape a request's `spec_operation` records, `operationId` **absent** rather than `""` for an operation that declares none - the same rows `POST /specs/match` takes.

`basePaths` (issue #3030) is always present, `[]` when the document states none, and is what `POST /specs/match` takes beside the operations.
For 3.x it is the path of **every** `servers[].url`, not only the `servers[0]` an import turns into `{{baseUrl}}`, because a collection may have been written against any of them: each `{name}` with a `variables` default is substituted first (the importer's rule), then the path after the authority is taken (`https://{host}/v1` -> `/v1`), or the whole URL when it is already a path.
A server with no path, or one relative to the document (`v1`), names none.
For 2.0 it is `basePath`.
Trailing slashes are dropped, and the root and repeats are left out.

This is the reader every spec write uses (issue #853), which is the point of the route: the identities answered here are the identities [`POST /specs/bind`](#post-specsbind) will derive from the same bytes.
Before issue #869 the app read the picked document itself, so a document the two sides read differently previewed one pairing and committed another.

**Errors:** `400` for a missing or empty `content`, bytes over `maxSpecDocumentBytes` (the same cap a store applies, so a preview cannot succeed where the bind will fail), bytes that cannot be read as JSON or YAML, a document declaring more than 2000 operations, and a readable file that is **not** an OpenAPI document -
the last named as what is missing rather than answered as a contract declaring nothing.

## POST /specs/diff

What a re-fetched document would change about the collection bound to it - the read half of a sync (issue #654's comparison, moved engine-side by #854).
The app's **Sync** section is this call; an agent asking "has this contract drifted, and where" is the same one.

**Reads only.**
No document is stored, no binding moved, no request stamped, so a caller may ask about a document it has not decided to apply.
Applying is [`POST /specs/sync`](#post-specssync), which re-reads everything rather than being handed this answer - the same split `POST /specs/match` and `POST /specs/bind` follow.

**Request:**
```json
{
  "collectionId": "col_9a1f...",
  "spec": { "content": "{\"openapi\": \"3.0.0\", ...}" }
}
```

Neither the requests nor the **bound** document are sent.
The engine walks the subtree of `collectionId` itself (an import files its requests under one sub-collection per tag, and the walk stops at a sub-collection bound to a different document, issue #3034) and reads the bound document from the collection's own binding:
the three-way rule below is only worth anything if the "previous" side is the bytes actually stored, and a caller that could supply them could turn its own edits into the document's - by accident, with a stale copy.

**Response:**
```json
{
  "identical": false,
  "added": [
    {
      "operation": { "operationId": "listOwners", "method": "GET", "path": "/owners" },
      "folder": "owners",
      "safe": true,
      "draft": {
        "name": "List owners",
        "description": "",
        "method": "GET",
        "url": "{{baseUrl}}/owners",
        "params": [],
        "headers": [],
        "body": { "mode": "none" },
        "examples": []
      }
    }
  ],
  "declined": [
    {
      "operation": { "operationId": "getPet", "method": "GET", "path": "/pets/{petId}" },
      "folder": "pets",
      "safe": false,
      "draft": { "name": "Get a pet", "...": "as in added" }
    }
  ],
  "removed": [
    {
      "requestId": "req_7b21...",
      "name": "Delete a pet",
      "operation": { "operationId": "deletePet", "method": "DELETE", "path": "/pets/{petId}" },
      "safe": false
    }
  ],
  "changed": [
    {
      "requestId": "req_4c8e...",
      "name": "List pets",
      "boundOperation": { "operationId": "listPets", "method": "GET", "path": "/pets" },
      "operation": { "operationId": "listPets", "method": "GET", "path": "/pets" },
      "matchedBy": "operationId",
      "renamed": false,
      "previousUnknown": false,
      "safe": true,
      "safeFields": ["name"],
      "fields": [
        {
          "field": "name",
          "current": "List pets",
          "next": "List all the pets",
          "userTouched": false
        }
      ],
      "draft": { "name": "List all the pets", "...": "as above" }
    }
  ],
  "unchanged": 12,
  "unmapped": 1
}
```

`identical` is decided on the **stored bytes** - the ones `spec_documents.hash` is over - rather than on a hash the caller computed, and is the "up to date" answer.
The buckets are still reported when it is `true`, empty.

`draft` is the request an import of the new document would build: the values behind every `next` (which is truncated for display), plus the operation's documented responses as `examples`, so a `POST /specs/sync` payload is built by choosing which of these fields to send rather than by re-reading the document.
The `examples` here are reported rather than returned to the engine: since issue #869 a sync says *whether* to refresh a request's imported examples and the rows come off the document it stores, so this is what an apply would write, shown.
`unmapped` counts requests carrying no operation at all - not part of the comparison, but stated, because a sync that silently ignores half a collection is one nobody can read.

**`declined` is an operation nobody claims because a person deleted its request** (issue #3031).
Its entries are shaped like `added` ones, because ticking one is the same create, and an operation is in one bucket or the other, never both.
The record a delete left (see [`DELETE /requests/:id`](requests.md#delete-requestsid)) is followed into the new document by the rule a request's own identity is, below, so an operation the document renamed is still the declined one.
A live request claiming the operation - one restored from the trash, or created again by hand - outranks the record, and the operation is in neither bucket.

**`safe` is what an apply with no ticks would do to that entry** (issue #871), and `safeFields` is which of a changed request's fields it would write - empty for a pure rename, which is a real selection rather than an absence.
It is `core::safe_spec_apply`: **every operation the document adds, every field it moved that nobody here had edited, no deletions, nothing a person declined, and a request whose bound document could not be read left alone whole.**
Reported rather than left to the caller because the rules are the ones whose silent failure costs somebody their work, and because the same function decides what [`POST /specs/sync`](#post-specssync)'s `policy` applies - so the app's pre-ticked boxes and a caller that ticks nothing are one answer rather than two that agree today.
`safe` on a removal and on a declined operation is always `false` and is carried anyway, so that a reader marking the bucket reads the rule instead of writing it.

**How it compares.**
An operation is followed by its `operationId` first and by method + path shape second (the same flattening `POST /specs/match` binds with), so a path moved under a stable id and an id moved under a stable path both stay one operation, while both moving at once is disclosed as a removal plus an addition rather than guessed at.
An id **two requests claim** identifies neither and is skipped; an id whose entry contradicts the endpoint the request records loses to an exact match on that endpoint.
`renamed` says the identity itself moved, so an apply records the new one.

**`userTouched` is three-way**: the field is flagged when what the request holds is neither what the new document produces nor what the **bound** one did - the only evidence that a person put it there, and the flag an apply may not overwrite silently.
`previousUnknown` says the bound document does not declare this operation, so no such claim can be made about it at all, and every `userTouched` on that request is `false`.
A query typed into the URL is a Params change too: the write that stored the URL derived the query rows from it (see [`POST /requests`](requests.md#post-requests), issue #3551), so `params` is flagged beside `url`.

**Response examples are deliberately not compared.**
The rule that governs them (`origin="import"` is replaced, `origin="user"` survives) only means anything at apply time, so they ride on `draft` rather than appearing as a difference nothing acts on.

**Errors:** `400` for a missing or empty `collectionId`, a missing or empty `spec.content`, a document larger than `maxSpecDocumentBytes`, a document that will not read as JSON or YAML (the message names where it broke), or a collection that binds nothing - there is nothing to compare against, and binding is [`POST /specs/bind`](#post-specsbind).
`404` when the collection does not exist.
`409` when its binding names a document the store no longer holds, which is a broken binding rather than a bad request.

## POST /specs/bind

Bind a collection to an OpenAPI document, in **one transaction**: the document is stored, the collection's binding moves to it, and every request in the collection's subtree is stamped with the operation it matched or has its stamp cleared.
Nothing is created or deleted - that is what a sync is for.
It is the one way to bind or rebind an existing collection: `PUT /collections/:id` with any `openapi` but `null` or `{}` is a `400` naming this route (issue #3348).

**The caller sends a document, never a pairing.**
The engine reads the bytes it is about to store, derives the `operations` index from them, and matches the subtree with `core::match_operations` - the same rule `POST /specs/match` previews with, over the same subtree walk, under the base paths the same read of the document names (the `basePaths` `POST /specs/describe` answers, issue #3030).
A pairing worked out by the caller would be a second opinion about what the document declares, and an agent over MCP has bytes and no OpenAPI reader at all.

**Request:**
```json
{
  "collectionId": "col_9a1f...",
  "spec": {
    "content": "openapi: 3.0.0\n...",
    "sourceUrl": "https://api.example.com/openapi.yaml"
  }
}
```

`spec.content` is the document verbatim, JSON or YAML, capped by `maxSpecDocumentBytes`.
`sourceUrl` is optional and `null` or absent means the document did not come from a URL.
`id`, `hash`, `fetchedAt`, `operations` and `responseSchemas` are engine-computed and a `400` if sent, the same rule `POST /specs` applies.

**Response:**
```json
{
  "specId": "spec_2b74...",
  "specHash": "8f3c...",
  "syncedAt": 1755000100000,
  "stamped": 12,
  "cleared": 2,
  "unmatchedRequests": ["req_7b21..."],
  "unmatchedOperations": [{ "method": "GET", "path": "/pets/{petId}" }]
}
```

`unmatchedRequests` and `unmatchedOperations` carry the same shapes `POST /specs/match` answers with, so a caller reads one shape for the preview and the commit.

**Stamping goes both ways** (issue #718).
After a bind, a request's `spec_operation` is the operation it matched in the bound document, or nothing: `cleared` counts the requests whose identity was removed because this document does not account for it.
That half is not a list the caller states - it is the other side of the same walk - because a bind that wrote only the matches left every non-matcher carrying identity from the previous document, and coverage resolves a stamp by `operationId` first, so such a stamp claims whichever operation of the new document shares the id rather than going unread.

**Nothing outside the subtree is touched**, the rule `POST /specs/sync` follows: a request under another collection keeps its own stamp even when it would have matched.
That includes a sub-collection bound to a *different* document and everything beneath it (issue #3034): its requests carry that document's operation identity, so neither a match nor a clear is applied to them.
A sub-collection bound to the same document is in the subtree.

**A bind to other bytes forgets the declined operations** (issue #3031).
The operations deletes declined under the collection (see [`DELETE /requests/:id`](requests.md#delete-requestsid)) were decisions about the document it was bound to, so a bind whose document hashes differently from the bound one forgets them in the same transaction; a bind to the same bytes keeps them.

**Errors:** `400` for a malformed body, an engine-owned field, a document over the cap, or one that cannot be read as JSON or YAML - and in that last case nothing is written, so the collection stays bound to whatever it was bound to.
`404` when the collection does not exist.
`409` when a row moved under the write.

Unbinding is not here: it is `PUT /collections/:id` with `"openapi": null` (or `{}`), which writes one row, leaves every stamp in place - so unbind-then-rebind of the same document is lossless - and has no document to read.
It does forget the declined operations, in the same transaction, as a bind to other bytes does.

## POST /specs/export

A collection back out as an OpenAPI document - its own bound document updated, or a skeleton describing its requests when it binds none.
Which of the two runs is a fact about the collection rather than a parameter; *how much* a bound export writes is the caller's choice (`mode`, below).

**Reads only.**
Nothing is stored and the collection is left exactly as it is; a POST because the answer is a document rather than a resource, and because the body carries the format.

**Request:**
```json
{
  "collectionId": "col_9a1f...",   // Required
  "format": "json",                // Optional - "json" (default) or "yaml"
  "mode": "contract"               // Optional - "contract" (default) or "full"
}
```

Neither the requests nor the document are sent.
The engine reads the whole subtree of `collectionId` (an OpenAPI import binds the root and files every request under one sub-collection per tag), each request's stored examples, and the bound document itself - **stopping at any collection bound to a *different* document**.
That boundary is not a filter: the refused collection takes its own descendants with it, because its requests carry another document's operation stamps and `operationId`s are names generators hand out in every document (`listUsers`, `GET /users`), so letting them through would have them claim these operations and rewrite them.
A descendant bound to the *same* document is part of the export, because its requests describe the very operations being patched.

**Response:**
```json
{
  "text": "{\n  \"openapi\": \"3.0.3\",\n ...",
  "fileName": "petstore.openapi.json",
  "notes": {
    "direction": "document",        // or "skeleton"
    "dialect": "OpenAPI 3.0.3",
    "requestsExported": 12,
    "requestsWithoutOperation": 1,
    "operationsNotInDocument": 0,
    "operationsRemoved": 2,
    "requestsWithoutPath": 0,
    "duplicateOperations": 0,
    "examplesWritten": 4,
    "examplesWithoutMediaType": 1,
    "examplesTruncated": 0,
    "examplesAlreadyDeclared": 3,
    "examplesSampledAtImport": 2,
    "sharedParametersLeft": 1,
    "referencedResponsesLeft": 1,
    "bodiesNotWritten": 2,
    "rowsNotDeclared": 1,
    "operationsEdited": 0,
    "vocabularyNotWritten": false,
    "secretsOmitted": 2,
    "requestsOnlyInExtension": 0,
    "operationsAdded": 0,
    "boundMode": "contract"         // "" for a skeleton
  }
}
```

Every count is present, zeros included: "0 requests with no operation" is how a bound export states that it carried everything, and a body that omitted its zeros would read as complete whether or not it was.

**`mode` - what a bound export may write.**
`contract`, the default, treats the stored document as the API's contract and writes only what the next three paragraphs describe.
`full` writes everything the collection holds, into the document's own dialect (Swagger 2.0 included):
each request's name (as `summary`, only where it differs from the name an import would read) and description, a parameter for every Params or Headers row the operation does not declare (a query stated only in the URL included, since the write derives its rows, issue #3551; 2.0's `type` and `x-example` in a 2.0 document),
the body as the media type's `example` (2.0: an `in: body` or `formData` parameter, added only where the operation declares none),
the auth wherever the operation does not already state it (a scheme the document declares with the same credential is reused, otherwise one is added), saved examples (2.0: the response's `examples` map),
a new operation for every request the document never declared (`operationsAdded`; a new operation in 3.0 or 2.0 with no saved example gets a `default` response, which those dialects require), the collection's name, description, base URL and auth at the root, and the `x-vayu-*` extensions below.
It still never rebuilds: schemas, `$ref`s and every member Vayu does not model stay as they were, and a request nobody edited writes nothing new into the standard members - an unedited export in `full` differs from the stored document only by its `x-vayu-*` keys.
A skeleton ignores `mode`.
Anything else is a `400`.

**A request's `:name` path variable is an OpenAPI path parameter** (issue #1764): wherever a URL becomes a path, a whole `:name` segment is written `{name}`, as a whole `{{name}}` segment is, and its path row's value is the parameter's `example`.
A path row is never declared `in: query`, and `x-vayu-request.params` keeps each row's `in` (and a Postman `type`), so a re-import gives the path row back.
A segment with a suffix (`:name.json`) is left as written, as `{{name}}.json` is.

**A bound export patches the stored bytes, never rebuilds them.**
Operations no request claims are removed (and a path left with no operations goes with them), a declared parameter whose request row carries a value gets it as `example` (a declared `in: path` parameter reads the request's path row of that name, issue #1764; a credential row's value is not written, see "Secrets never leave"), and stored examples become response examples -
one as `example`, several as a named `examples` map.
Everything else - `info`, `tags`, vendor extensions, `security`, components nothing references - is carried through by simply not being visited, and the dialect is left as it was.

**It adds, and never removes what the document declares** (#1442).
A media object already answering with an `examples` map keeps every entry it had and gains one; a single `example` is replaced by the one value that would replace it, and moves into the map under the key `example` when a second example has to go somewhere.
A response that is a `$ref` is left bare and counted as `referencedResponsesLeft`: a Reference Object admits no siblings in 3.0, so a `content` written beside it is ignored by conformant readers and rejects the document at a validator, and the component it names is shared with every operation that references it.
An example whose value the document already declares is counted as `examplesAlreadyDeclared` and written nowhere, and an **imported** example (`origin: import`) for a media object that declares no example at all was sampled off that response's schema at import, so it is counted as `examplesSampledAtImport` rather than written back as though the API had stated it;
where the document declares no such response either, the status is not documented from it at all, because putting back a response the contract dropped is not this export's to do.
Values are compared as values, so an example whose members are stored in another order than the document writes them is the same example.
An export of a spec-origin collection nobody edited is therefore the document it was bound to, structurally unchanged.

**In `contract` mode, the edits it does not write are counted, not silent.**
It writes parameters and examples: a request body is `bodiesNotWritten`, a Params or Headers row the operation declares no parameter for is `rowsNotDeclared` (`Authorization` and `Content-Type` excepted - OpenAPI states them as `security` and as the body's media type), and a request whose method or path no longer matches the operation it is stamped as is `operationsEdited` -
its values still land, in the operation the document declares.
A concrete path that fills the operation's template (`/users/1` for `/users/{id}`) still matches, by the rule the matcher stamped it with, and is not counted; neither is one under a server base path the document declares (`/v1/users/1` with `servers: [{url: /v1}]`, or a 2.0 `basePath`).
A parameter the operation declares by `$ref`, or one the Path Item declares for every method under it, is declared: its name is read through the reference, so a row that has a home is never counted as one the document has no place for, and `sharedParametersLeft` is what says its *value* was not written.

A **Swagger 2.0** document is the one partial case of `contract` mode, reported as `vocabularyNotWritten`: operations nothing claims are still removed, but nothing is written *into* an operation.
`full` writes 2.0's own vocabulary.

**A skeleton invents nothing.**
`{{variable}}` tokens are written as they stand in paths (resolving them would export one machine's environment as though the contract named it);
a `{{baseUrl}}` server gets a real default when the collection's own `baseUrl` variable has a value - written as the single-brace `{baseUrl}` OpenAPI's Server Variable syntax expects, with that value as its `default` - and the bare double-brace token otherwise, since an undeclared single-brace variable is invalid OpenAPI.
A path segment that is exactly one token becomes the OpenAPI `{petId}` it came from, every Params and Headers row (a query written only in the URL has its rows, issue #3551) is declared without a `required` it was never given but carries its toggle explicitly as `x-vayu-enabled` (neither a value nor its absence says whether a row is on),
and a body or response is described only where there is a stored example to read a shape off -
carrying a `description` that says the shape is derived.
A JSON body holding a `{{variable}}` token is not valid JSON on its own, so it is written as the text it is and read back the same way, byte for byte, rather than re-quoted into a JSON string.

**It carries what OpenAPI can name, for the modes it has names for** (#1441).
A folder becomes a `tag` named by its full path (`Users/Admin`), described by the folder's own description and declared once at the document root and on every operation under it.
Auth becomes `components.securitySchemes` plus a `security` requirement -
basic and bearer as `http`, an API key as `apiKey`,
OAuth 2 as `oauth2` with the flow the request uses (`authorization_code` as `authorizationCode`, `password`, and every other grant as `clientCredentials`, `jwt_bearer` included: OpenAPI has no RFC 7523 flow, so the flow names the token endpoint and the real config travels in `x-vayu-request.auth`, Swagger 2.0's `application` is the same fallback) -
at the document root for the collection's own auth and on the operation only where a request's differs from it.
An `inherit` request is resolved the way `POST /compose` resolves it, through its folders (the nearest one with a credential, `noauth` ending the walk), so a request under a folder with its own auth states that folder's scheme; an explicit no-auth request is `security: []`, one left to inherit gets no override, and a mode with no OpenAPI name (`digest`, `aws`, `ntlm`) gets no `security` at all.
A body is written as the example another tool can send:
JSON and JSON-RPC as JSON, GraphQL as the `{query, variables}` envelope a GraphQL-over-HTTP server receives, XML and text as the text they are, a form as its fields (file parts `format: binary`) with the enabled text values as the example, a binary body as one file's bytes (`type: string, format: binary`, no example) -
filed under the media type an enabled `Content-Type` row names (`application/vnd.api+json`) rather than the mode's generic one;
a binary body with no such row is filed under its file's own `contentType`, else `application/octet-stream`.
What the standard members cannot state exactly travels in `x-vayu-request` and `x-vayu-collection` (below), so every one of these reads back as it was.

**`x-vayu-request` and `x-vayu-collection` carry the rest of the collection** (`core/vayu_extensions.hpp`).
A skeleton writes them always, a `full` bound export too; `contract` mode writes neither.
On an operation, `x-vayu-request` holds the request as the UI does:
`name`, `method`, `url` (verbatim, `{{...}}` and all), `order`, the `folder` path it is filed under, every Params and Headers row as typed (`Authorization` and `Content-Type` rows, toggles, duplicates and all), the body in its own mode, the auth exactly as set (`inherit` included),
the non-default `settings` (`followRedirects`, `maxRedirects`, `timeout`, `httpVersion`, `verifySSL`, `stream`, and beside `stream` its `streamTextPath` and `streamFirstContentMarker`),
every saved example with its headers and its `origin` (`"user"` or `"import"`, #2430; one that is neither is an unreadable example, and a document with none, as an older Vayu wrote, imports as `"import"`), and the mock mode with the index of a `fixed` target.
At the root, `x-vayu-collection` holds the collection's `variables` (`baseUrl` included), `auth` and `dataSchema`, every folder (`path`, `order`, `description`, `variables`, `auth`, `elements`, empty folders included; `order` shares its parent's space with the requests' `x-vayu-request.order`, #2535, so a request between two folders imports there), and the `requests` no operation can hold -
a URL with no path, or a second request on a method and path another already claimed - counted as `requestsOnlyInExtension` (and under `requestsWithoutPath` / `duplicateOperations`, which say why).
Another tool ignores both keys; Vayu's importer reads them back (see [`POST /import/parse`](import.md#post-importparse)).

**Secrets never leave.**
This export has no `includeSecrets`: every token, password, API-key value, client secret, AWS key and variable marked secret, at every level either key writes, is written as `""` and counted as `secretsOmitted` - except a value that is one `{{variable}}` reference and nothing else, which names where the secret lives without being one.
The auth modes kept as a `config` bag (AWS, digest, NTLM, Hawk, OAuth 1.0, EdgeGrid, JWT, OAuth 2.0's own config) are blanked by an allowlist of the members known to describe the auth, so a member no list has heard of (Insomnia's IAM `secretAccessKey`) leaves blank too.
The `jwt_bearer` grant's `subject`, `assertionAudience`, `assertionLifetimeSeconds`, `signingAlgorithm`, `keyId` and `fallbackExpiresIn` are on that list; its `privateKey`, which is only ever one `{{variable}}` reference, stays as that reference (a key written any other way is blanked and counted), and its `privateKeyFile`, a path on one machine, is not on it and leaves blank, counted.
A config discovered from an MCP server keeps its `discoverUrl` and its `discoveredFields` list whole (#3766), so a re-import still knows which server it came from.
OAuth 2.0's extra request parameter lists (`tokenParams`, `authorizationParams`, `refreshParams`) and the `jwt_bearer` grant's `assertionClaims` are redacted per row:
a row's `key`, `enabled` and `sendAs` stay, and its value is blanked when the key names a credential (`client_secret`, `client_assertion`, `password`, `Authorization`, `X-Api-Key`, the other names below), so an `audience` row leaves intact, as a claim named `tenant` does;
a row with no non-empty string `key`, and any member of a row beside those four, is blanked whole.
A credential outside an auth block is blanked by name wherever it is written:

- a header row whose name is sensitive (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token`, the other names the logger redacts) or is the header the API-key auth in force names - the request's own, or the one its folders resolve to when it inherits - in `x-vayu-request.headers` and in the parameter that mirrors the row;
- a query parameter by the narrower name set of the Params table (the same names less the generic `code` and `key`, plus `secret`, `signature`, `x-amz-signature` and the like, plus an API-key auth's own parameter), in `x-vayu-request.params`, in the parameter's `example` (a `:name` path row included) and in `x-vayu-request.url`'s query and fragment;
- the password of a URL's `user:pass@` (the user name stays), in `x-vayu-request.url`, in a skeleton's `servers`, and in a `baseUrl` variable (collection or folder) and the server-variable default made from it;
- the response headers of a saved example in `x-vayu-request.examples`, by the header names (a `Set-Cookie` row, in full).
  A response's headers are never a standard member, so nothing else carries them.

The row and its key stay, the value is `""`, and a parameter whose value was withheld is still declared with no `example` - a bound document's own example for it is neither replaced by the credential nor erased.
A value is kept only when it is exactly one `{{variable}}` reference: `Bearer {{token}}` is blanked, because the text around a reference can hold a literal secret.
A **body** is never judged: a stored example's body, a request body and a script are written as stored, apart from the file-part rule below.

`secretsOmitted` counts each withheld value once wherever it is written: a header row and the parameter that mirrors it, a URL's query and the Params rows, and a server and the URL it was read from are one credential.
A `contract` export, which writes no `x-vayu-request`, counts a withheld row at the declared parameter whose example it would have filled; a credential row no operation declares was never going to be written, so it is not counted (`rowsNotDeclared` still counts it).

A form's file part, and a binary body's `file`, keep their name, declared file name and content type, never the local path they were read from (`src`).
A path a hand-edited `x-vayu-request` does carry is read back as written, and sent only once picked or under an allowed folder; an `unresolved` it states is dropped.

**`x-vayu-elements`** carries a request's or the collection's whole `elements` array verbatim, the same vendor-extension convention `x-vayu-enabled` already established - never a standard OpenAPI field, so writing it is never "rewriting the user's contract".
A skeleton export writes it on every operation and at the document root whenever the corresponding `elements` array is non-empty; a bound export writes it on an operation the document already declares - in `contract` mode only into a 3.x document (nothing is written into a Swagger 2.0 document's operations at all), in `full` mode into either, and at the root.
The importer reads it back verbatim, validated against the live element registry - a document hand-edited into an invalid array is not applied and is counted under `elements_invalid` in `meta.skipped` (see [`POST /import/parse`](import.md#post-importparse)) rather than reaching the stored request.
Not read on the sync/diff path (`POST /specs/diff` / `POST /specs/sync`): `DraftRequest`, what that path compares a stored request against, deliberately excludes scripts and auth so a re-sync never silently overwrites what a user edited locally, and an element can carry a script.

**`x-vayu-mock`** carries a request's `mockResponseMode` (issue #1649) the same way `x-vayu-elements` carries its `elements` - written only when the mode is not `"first"`, the default every unconfigured request already has, so an operation with no mock opinion gains no key at all.
`{"mode": "random"}` needs no target; `{"mode": "fixed", "example": "<key>"}` names the `examples` map key (or the doubled key a name collision suffixed, `add_named_examples`'s usual rule) the chosen example was written under, resolved by value rather than assumed -
a target this export could not itself write (a truncated body, no recorded media type, a response the document does not declare) is the same "nothing to name" case as the mode staying `"first"`, and gets no key either.
Gated like `x-vayu-elements`: `contract` mode writes nothing into a Swagger 2.0 document's operations.
The importer reads it back next to `x-vayu-elements`, matching `example` against the imported example that carries the same OpenAPI `examples` map key (the engine-side-only `specExampleKey` provenance field, issue #1457) and setting `mockResponseMode` / `mockExampleId` on the imported request;
a key the document no longer has an example for degrades the way `elements_invalid` does - counted as `mock_example_missing` in `meta.skipped` and left on `pick_example`'s own `"first"` default rather than naming a target that is not there.
Not read on the sync/diff path, for the same reason `x-vayu-elements` is not.

**Errors:** `400` for a missing or empty `collectionId`, a `format` other than `json`/`yaml`, or a `mode` other than `contract`/`full`.
`404` when the collection does not exist.
`409` when the collection's binding names a document that is not stored, or when the stored bytes will not read as an OpenAPI object - the export refuses rather than falling back to a skeleton, which would silently replace the document the caller believes they are updating with one that drops everything Vayu does not model.

## POST /specs/sync

Apply a re-fetched document to the collection bound to it, in **one transaction**: the document is stored, the binding moves to it, and the requests the caller selected are created, updated and deleted together.
Half of that landing would leave a collection bound to a document its requests do not reflect, which is the state the binding exists to make impossible - so it is refused structurally rather than reported afterwards.

Deliberately not part of `POST /import/apply`: that route only ever creates, which is what lets it own every id and validate a payload with nothing stored behind it.
A sync updates and deletes rows that already exist.

**Request:**
```json
{
  "collectionId": "col_9a1f...",                       // Required; must be bound to a spec
  "spec": {
    "content": "{\"openapi\":\"3.1.0\", ...}",           // Required, non-empty, at most maxSpecDocumentBytes
    "sourceUrl": "https://api.example.com/openapi.json"  // Optional; null for a file or a paste
  },                                                   // Both indexes are derived - see POST /specs
  "policy": "safe",                                    // Optional - apply the safe ticks and state no rows.
                                                       // Mutually exclusive with the four sections below.
  "collections": [                                     // Optional - tag folders to create
    {"tempId": "t_col", "name": "pets", "parentId": "col_9a1f..."}
  ],
  "create": [                                          // Optional - operations the document added, or declined ones ticked
    {"tempId": "t_req", "collectionTempId": "t_col", "name": "Get a pet",
     "method": "GET", "url": "https://api.example.com/pets/{{petId}}",
     "specOperation": {"operationId": "getPet", "method": "GET", "path": "/pets/{petId}"}}
  ],
  "update": [                                          // Optional - merge-patch by id
    {"id": "req_1234...", "name": "List pets", "specOperation": {...}, "examples": true}
  ],
  "delete": ["req_5678..."]                            // Optional - request ids
}
```

**Response:**
```json
{
  "idMap": {"t_col": "col_bb21...", "t_req": "req_cc34..."},
  "specId": "spec_dd45...",
  "specHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "syncedAt": 1730000000000,
  "created": 1, "updated": 1, "deleted": 1,
  "skipped": {"requests": 2, "fields": 3, "deletions": 1, "declined": 1}  // Only for a `policy` call - see below
}
```

**`policy` is the alternative to stating rows** (issue #871).
`"safe"` - the only one - is `core::safe_spec_apply`,
the same answer [`POST /specs/diff`](#post-specsdiff) reports per entry as `safe` / `safeFields`: **every operation the document adds, every field it moved that nobody here had edited, no deletions, none of the operations a person declined by deleting their request (issue #3031), and a request whose bound document could not be read left alone whole.**
The engine works out the rows, mints the tag folders an added operation needs (matching an existing direct child by name, creating one at most once per call), and writes them through everything below - the same validation, the same id minting, the same transaction.
It exists because those rules used to live in the renderer alone, which put applying a drift out of reach of every caller that is not the Spec tab: `electron/` may not import `src/`, so an MCP `sync_spec` would have needed a *copy* of the one judgement whose silent failure destroys a person's work.

Sending `policy` together with `collections`, `create`, `update` or `delete` is a `400`: there is no reading of "the safe ticks, plus these" that is not a guess.
A caller that wants anything the policy declines - a deletion, a field somebody edited - states the rows itself, which is what the app does the moment a user changes a tick.

`skipped` comes back **only** for a `policy` call and counts what it refused: `requests` left untouched entirely, `fields` the document moved that were not written (whether their request was skipped whole or applied around them), `deletions` not made, and `declined` operations not re-created.
An explicit payload gets no such key - nothing was declined, because the caller chose the rows.
It is reported for the reason the diff bounds its buckets rather than dropping entries: a call that answered only with what it wrote would read as "applied the drift", and the part it did not apply is exactly the part somebody has to decide about.

Five rules the payload cannot opt out of:

- **A `delete` here is permanent - it does not go to the [Trash](trash.md#trash)** (issues #988, #1046).
  Every other delete in the engine is soft: the row is stamped and restorable.
  A sync is not a person removing a request, it is a *reconciliation* to a document, and the two differ in where the decision is made - [`POST /specs/diff`](#post-specsdiff) reports every removal before anything is written, the app renders them as ticks the user unticks one by one, and `policy: "safe"` refuses deletions outright, so a deletion here is one a caller stated after being shown it.
  Leaving those rows stamped instead would put the operations a document no longer declares back in the trash on every sync, where restoring one re-creates a request the document cannot explain.
  The rows and the examples they own are removed in the sync's own transaction.
  A caller that wants the deletions recoverable omits them from the payload and issues `DELETE /requests/:id` per row, which is soft.
- **The bound subtree is the boundary.**
  Every request an `update` or a `delete` names, and every collection a created request lands in, must be the collection being synced or one beneath it.
  Anything else is a `400` naming the item - without this the route would be a way to delete any row by id.
  A sub-collection bound to a *different* document (and everything beneath it) is outside the boundary (issue #3034): its requests belong to that document's contract, so a sync of this one cannot update or delete them, and a diff does not list them.
  A sub-collection bound to the same document is inside.
- **The engine mints every id**, as `/import/apply` does: new rows are named by `tempId` and translated through `idMap`, and a body `id` is a `400`.
- **`examples` is a decision, and the rows are the document's** (issue #869).
  `true` on an update refreshes that request's imported examples from the document this call is storing; **absent** (or `false`) leaves every example alone.
  A created request always gets the responses its operation documents, so `examples` on a `create` item is a `400` - as is a *list* on an update, which is what a caller sent before this and what let a payload write an example for a response no document describes.
  A refresh whose request records no operation of the document being stored is a `400` too, rather than a silent no-op.
  Rows with `origin: "user"` (issue #588) always survive; the replacements take the block the replaced rows occupied, so a saved example never loses its position - "the first example" is what a mock server answers with.
  An operation whose documented responses were removed refreshes to *no* rows, which is how the last import's examples go.
  An example whose **status the user deleted** is not written back either (issue #722) - the delete left a tombstone and the refresh skips that status, so a sync of any field cannot undo it.
  The identity is the status, not the name, because a name carries the document's response description and moves when the document rewords it.
- **A request cannot be moved here.**
  `collectionId` inside an `update` item is a `400`; use `PUT /requests/:id`.
- **Creating a declined operation takes the decline back** (issue #3031).
  A `create` item whose `specOperation` names the operation a [`declined`](#post-specsdiff) entry stands for - followed into the document being stored by the diff's own identity rule - forgets that record in the same transaction, so ticking the entry is the user changing their mind and a later delete of the new request records afresh.
  The deletes in `delete` record nothing: the document dropped those operations, nobody declined them.

**Errors:** `404` when the collection does not exist.
`400` when it is bound to no spec, when `policy` is not `"safe"` or arrives beside a row section, when a section is not an array, when a payload item is malformed (with `error.item` naming the `tempId` or the request id, as `/import/apply` does), or when the document is over `maxSpecDocumentBytes` - the same helper `POST /specs` uses.
`409` when an `update` names a request that no longer exists: nothing about the payload is wrong, the ground the diff was computed against has moved, and re-checking is what the client should do.
A `delete` naming a request that is already gone is **not** an error - that is the state the caller asked for.
Nothing is written unless all of it is.
