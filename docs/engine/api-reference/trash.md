---
description: >-
  The trash routes: what a delete leaves behind, how to list it, restore it or purge it.
---

# Trash

What deleting a collection, a request, an environment, a saved example or a client certificate now does, and how to undo it (issue #988; environments #2970; examples #2971; client certificates #2973).
`DELETE /collections/:id`, `DELETE /requests/:id`, `DELETE /environments/:id`, `DELETE /client-certificates/:id` and, for an example a person saved (`origin: "user"`), `DELETE /requests/:id/examples/:exampleId` stamp rows instead of removing them;
every other read surface filters stamped rows out, so the tree, the environment list, a request's examples and the certificate registry look the same as after a hard delete, and these three endpoints are the whole of what the stamp buys.
An imported example is not trashed: its delete leaves the tombstone a spec sync reads (see [DELETE /requests/:id/examples/:exampleId](examples.md#delete-requestsidexamplesexampleid)).

Two rules decide what a restore of a collection or request puts back:

- **Cohort.**
  One delete stamps its whole subtree with one timestamp, and a restore clears exactly the rows carrying the timestamp of the row it was given.
  So restoring a collection cannot resurrect a request the user had deleted separately beforehand - that request stays in the trash and becomes a root of its own again, since its collection is live.
- **Re-parent.**
  A restored collection whose parent is gone, or is itself in the trash, comes back at the tree root (`parentId` cleared).
  A *request* has no such root - `collectionId` is required - so restoring one whose collection is in the trash is a `409` naming the request and its collection by name, and the trash root to restore first by name and id (issue #3449).
  That root is the listed entry holding the collection: the collection itself, or the ancestor whose delete took it.

An environment needs neither: it owns no rows and hangs under nothing, so its delete stamps one row, it is always a root, and its restore is unconditional.
**A trashed environment is never active.**
The delete clears `isActive` in the same write, so the active slot is free for another environment, and a restore brings it back inactive: making it active again is a `PUT` with `isActive: true`, the client's choice rather than the trash's.

An example hangs under its request, one level below where a request hangs under its collection, and follows the request's rule.
Its delete stamps its one row.
It is a root only while its request is live: under a trashed request it is part of what that request's entry stands for, and restoring the request leaves the example's own earlier delete in the trash as a root again.
Restoring an example whose request is in the trash is a `409` naming the example and its request by name, and the trash root to restore first by name and id: the request, or the collection whose delete took it.
One whose request is gone is a `409` saying so, and so is restoring one into a request that already holds the maximum of 100 examples.
A stamped example whose request row is gone entirely is listed nowhere.
The delete clears the request's `mockExampleId` when it named the example, and the restore does not set it again: choosing it as the fixed mock answer is the client's write, as making an environment active is.

A client certificate hangs under nothing, like an environment: its delete stamps its one row and it is always a root, named by its target (`host`, or `host:port` when the entry names a port).
**A trashed certificate is never presented.**
The transport policy every send resolves reads live entries only, so from the delete on no new design send, stream, collection run or load run offers it to its host, and the target is free for a new entry.
That is also why a restore can be refused: the registry holds one entry per host and port, so restoring a certificate while a live entry claims its target is a `409` naming that entry.
The row keeps its passphrase, stored plaintext like every live entry's, until a purge removes it.

Rows sit in the trash until they are purged: explicitly through `DELETE /trash/:id`, or by the startup sweep once they are older than `trashRetentionDays` (default 30; `0` keeps them forever).

## GET /trash

Everything deleted and still restorable, newest first.
**Roots only** - the rows a user asked to delete, never what their cascade took with them; that is what `collections` and `requests` count, and `purgeCollections` and `purgeRequests` count what a purge would destroy.
Every deleted environment and client certificate is a root; a deleted request is one while its collection is live, and a deleted example while its request is.

**Query Parameters:**
- `q`, `limit`, `offset` (optional): one page of the roots whose `name` holds `q`, newest first, in the `{data, pagination}` envelope instead of `{items, total}` - see [Paged lists](resource-writes.md#paged-lists).
  A cascaded row is not a root and never matches.
  A bad `limit` or `offset` is a `400` (`invalid_limit`, `invalid_offset`).

**Response** (none of the three):
```json
{
  "items": [
    {
      "id": "col_1234567890",
      "kind": "collection",
      "name": "Payments API",
      "deletedAt": 1787745600000,
      "parentId": null,
      "collections": 2,
      "requests": 14,
      "purgeCollections": 3,
      "purgeRequests": 16
    },
    {
      "id": "env_1234567890",
      "kind": "environment",
      "name": "Staging",
      "deletedAt": 1787745500000,
      "parentId": null,
      "collections": 0,
      "requests": 0,
      "purgeCollections": 0,
      "purgeRequests": 0,
      "variables": 6
    },
    {
      "id": "exa_1234567890",
      "kind": "example",
      "name": "200 - created",
      "deletedAt": 1787745400000,
      "parentId": "req_1234567890",
      "parentName": "Create payment",
      "collections": 0,
      "requests": 0,
      "purgeCollections": 0,
      "purgeRequests": 0
    },
    {
      "id": "cert_1234567890",
      "kind": "clientCertificate",
      "name": "api.example.com:8443",
      "deletedAt": 1787745300000,
      "parentId": null,
      "collections": 0,
      "requests": 0,
      "purgeCollections": 0,
      "purgeRequests": 0
    }
  ],
  "total": 4
}
```

`kind` is `"collection"`, `"request"`, `"environment"`, `"example"` or `"clientCertificate"`.
A client certificate's `name` is its target, `host` or `host:port`, which is what `q` matches.
`parentId` is a collection's parent (`null` at the tree root), a request's owning collection, an example's owning **request**, or `null` for an environment and a client certificate.
`parentName` (issue #3449) is the name of the row `parentId` names, carried by a request and an example entry only, so two same-named entries tell apart by their owner.
It is absent on the other three kinds, and on a request or example whose owner row is gone, which no write path leaves behind.

`collections` and `requests` are the **cohort**: the sub-collections (the root not counted) and requests this delete took, which is exactly what a restore puts back.
`purgeCollections` and `purgeRequests` (issue #3449) are what a [purge](#delete-trashid) destroys: every deleted sub-collection and request under the root, whichever delete stamped it, stopping at a live collection as the purge does.
They are never below the cohort counts, and exceed them when an earlier delete inside the subtree - a request, or a folder with its requests - is waiting under the root, unlisted.
All four are `0` for every kind but a collection.
`variables` is carried by an environment entry only - the number of variables its stored map holds - and is absent, not `0`, on the other four kinds.
An empty trash is `{"items": [], "total": 0}`, never a `404`.

## POST /trash/:id/restore

Put a deleted collection, request, environment, example or client certificate back, with everything the same delete took.
Takes no body.
An environment comes back exactly as it was deleted except that it is inactive (see [Trash](#trash)), and its answer carries `variables` like its list entry.
An example comes back exactly as it was deleted, `order` included, but its request's `mockExampleId`, cleared by the delete, stays `null` (issue #3422); a client certificate comes back exactly as it was, passphrase included.
A restored request, alone or with its collection, takes back the operation its delete declined (issue #3031), so the next sync sees it claimed again.

**Response:** the entry that was restored, plus what happened to it:
```json
{
  "id": "col_1234567890",
  "kind": "collection",
  "name": "Payments API",
  "deletedAt": 1787745600000,
  "parentId": null,
  "collections": 2,
  "requests": 14,
  "purgeCollections": 3,
  "purgeRequests": 16,
  "restored": true,
  "reparentedToRoot": false
}
```

**Errors:**

| Status | When |
|--------|------|
| `404` | Nothing in the trash carries that id - a live row, or one already purged |
| `409` | A request whose collection is itself deleted or gone; the message names the request and its collection, and the trash root to restore first by name and id |
| `409` | An example whose request is itself deleted or gone; the message names the example and its request, and the trash root to restore first by name and id |
| `409` | An example whose request already holds the maximum of 100 examples; delete one first |
| `409` | A client certificate whose host and port a live entry now claims; the message names that entry, to delete first |

## DELETE /trash/:id

Destroy a deleted collection, request, environment, example or client certificate for good, with its whole subtree - requests, and the examples they own, trashed ones included; an environment, an example or a client certificate is its one row (a certificate's passphrase goes with it), and an environment takes its [cookie jar](cookies-and-certificates.md#get-cookies) with it.
This is the hard cascade soft delete replaced, asked for deliberately; there is no undo for it.

Unlike a restore, a purge is not limited to the cohort: a row an earlier delete left inside the subtree goes too, because a request under a removed collection is reachable by no read and restorable by nothing.
It takes deleted rows only (issue #1883): a live collection under the purged one, which no trash entry ever listed, is moved to the tree root (`parentId` cleared) with everything under it left as it was.

A purged request's declined operation (issue #3031) stays declined: purging is emptying the trash, not changing one's mind.
A purged *bound* collection takes the declined operations recorded under it, which nothing could read any more.

**Response:** the entry that was purged, with `"purged": true`.
Its `purgeCollections` / `purgeRequests` count what this purge destroyed, an earlier delete's rows under the root included; its `collections` / `requests` are still the deleted row's own cohort.
A `404` if the trash does not hold that id - which is also what stops a mistyped id from destroying a live collection.
