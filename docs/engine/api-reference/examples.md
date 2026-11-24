---
description: >-
  The routes for a request's saved examples - list, create, update and delete.
---

# Request examples

Saved example responses for a request: what an importer found next to it (Postman's `item.response[]`, an OpenAPI operation's `responses`), and the responses a mock server will serve.
Nested under the request because an example is owned by exactly one - the owner is checked before the example on every path, so an example reached through the wrong request is a `404`, not a cross-request write.

**Ordering is part of the contract**, not a display preference: the list is returned by `order`, then `createdAt`, then `id`, and a mock server answers with the first example of the matched request.
A create that states no `order` appends after the request's current examples; a bulk import numbers them by payload position, because every row it writes shares one `createdAt` and would otherwise come back shuffled by the id tiebreak.

**Caps.**
A `body` over **1 MiB** is a `400` rather than a truncation - an example served as if it were whole when it is not is worse than a refused write
- and a request holds at most **100** examples.
Only live ones count: a tombstoned or trashed example does not, which is why restoring one into a full request is refused (see [Trash](trash.md#trash)).

A zero byte in a `body` (`"ab\u0000cd"`) is preserved: it is stored, listed and served by a mock server whole, never cut at the zero.

**`origin` says who wrote the row** (issue #588): `"import"` for everything an importer or a spec sync produced, `"user"` for one a person saved from a live response.
It defaults to `"import"`, which is honest for every row written before the column existed, and an unrecognised value is a `400` rather than a silent fall back - the OpenAPI spec sync (#627) may replace `"import"` rows wholesale and must never touch a `"user"` one, so an absorbed typo would cost a user their saved example.
An OpenAPI export carries it on every example in `x-vayu-request.examples` so a re-import keeps it (#2430).

**`bodyTruncated` says the body stops short** (issue #659).
A mock server serves a stored example verbatim, with nothing in the response to say anything is missing, so an example saved from a capped trace body (`maxTraceBodyBytes`) is served as though it were a whole response.
Only the client that captured it can know, so the flag is stored rather than inferred - a short body is a legitimate body.
It defaults to `false`, which is honest for every row written before the column existed: import copies a whole documented body, and the app's save-as-example is the only writer that ever had a partial one.
The app disclosed this in the example's *name* until the column landed, which a rename at save time erased.

## GET /requests/:id/examples

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
    "bodyTruncated": false,
    "createdAt": 1730000000000,
    "updatedAt": 1730000000000
  }
]
```

An empty array and a missing request are different answers: `404` (message `Request not found`) means the request does not exist, `[]` means it has no examples yet.

## POST /requests/:id/examples

Create one example.
**Create only**, and the engine owns the id - see [Resource writes](resource-writes.md#resource-writes-create-vs-update).

**Request:**
```json
{
  "name": "200 - A user",   // Required, no default (null is a 400)
  "status": 200,             // Optional, must be 200-599. Default 200
  "headers": [],             // Optional, array of {key, value, enabled}
  "body": "",                // Optional. Default ""
  "contentType": "",         // Optional. Default ""
  "order": 0,                // Optional, appended after the request's examples if omitted
  "origin": "import",        // Optional, "import" | "user". Default "import"
  "bodyTruncated": false,    // Optional. Default false - true when `body` is
                             // only the first slice of the captured response
  "postmanResponse": null,   // Optional. The Postman saved response an import
                             // took this from, as JSON text; null = none
  "savedFrom": null          // Optional, create only. What a save in the app
                             // says produced the response (see below); null = none
}
```

`savedFrom` is what the app's save-as-example sends from a live response (#1763): the request as written when it was sent (`{{variables}}` unresolved) and the server's own reason phrase.
The engine builds the example's Postman saved response from it with the exporter's own mapping, so `POST /export/postman` writes that request as `originalRequest` even after the request is edited.

```json
"savedFrom": {
  "request": {                          // Required; the request columns' own shapes
    "method": "POST",                   // Required, an HTTP method (any case)
    "url": "{{baseUrl}}/users/:id",     // Required string, as written
    "params": [],                       // Optional array, default []; path rows too
    "headers": [],                      // Optional array, default []
    "body": {"mode": "none"}            // Optional object, default {"mode":"none"}
  },
  "statusText": "Totally Fine",         // Required string; "" = the status table's
  "responseTimeMs": 123,                // Optional number, 0 or more; absent = null
  "receivedAt": 1767225600000           // Optional epoch ms, 0 or more: when the
                                        // response came in; absent = the save's clock
}
```

The stored copy holds `name` (`null`), `originalRequest` (method, headers, body and url as the export writes a request's, with no `auth`), `status` (`statusText`), `code`, `_postman_previewlanguage`, `header` (the example's own rows),
`cookie` (one entry per cookie the enabled `Set-Cookie` rows set, in Postman's member order: `expires`, `hostOnly`, `httpOnly`, `domain`, `path`, `secure`, `session`, `value`, `key`;
`expires` is JavaScript's date text in UTC, from `Max-Age` counted from `receivedAt` (the engine's clock at the save when absent) when there is one, else `Expires`, and `"Invalid Date"` with `session: true` for a cookie with neither;
the attributes are read as RFC 6265 and Postman's cookie store read them: an empty `Domain` is ignored, a leading `.` dropped, a `Path` not starting with `/` is `/`, and the space around `=` is not part of a name or value),
`responseTime` (whole milliseconds) and `body` (`null`).
When it would be over the 1 MiB cap (a large request body) the example is still created, without it, and a warning is logged; the export then regenerates those members.
`PUT` ignores a `savedFrom` key.
`POST /import/apply` does not read it either: it describes a live send, so the create route alone takes it.

`postmanResponse` is what the Postman importer sends (schema version 2): the `item.response[]` entry as JSON **text** in the source's member order, `name` and `body` replaced by `null` placeholders.
A string rather than an object so the order survives a parse into sorted JSON on the way here; it must parse as a JSON object, and it is capped at 1 MiB.
`POST /export/postman` is its reader, and no read route returns it.

`headers` is an array of `KeyValueEntry`, the same shape a request's headers use - not a JSON object.
A stored example is re-served rather than only displayed, so repeated names (`Set-Cookie`) and the author's ordering both have to survive.

**Response:** the created example object.

**Errors:** `404` if the request does not exist.
`400` if the body carries an `id`, if `name` is missing or `null`, on a `status` outside `200`-`599` (rejected rather than clamped - a stored `700` would be re-served as a status line nobody can send, and a `1xx` is an interim response a mock cannot serve as its final answer),
on a malformed `headers` entry, on an `origin` that is neither `"import"` nor `"user"`, on a `body` over the cap, or on a `postmanResponse` that is not a string holding a JSON object or is over its cap.
`400` naming the field on a `savedFrom` that is not an object, whose `request` is not an object, whose `method` is missing or not an HTTP method, whose `url` is not a string, whose `params` or `headers` is not an array,
whose `body` is not an object, whose `statusText` is not a string, whose `responseTimeMs` or `receivedAt` is negative or not a number, and on a `savedFrom` beside a non-null `postmanResponse` (two writers of one column).
`409` when the request already holds the maximum number of examples.

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

## PUT /requests/:id/examples/:exampleId

Update one example.
**Update only** - a `404` when the example does not exist, and the same `404` when it exists under a different request.
Merge-patch body: absent keeps, `null` resets to the field's default (`name` has none, so `null` is a `400`).
A `status` outside `200`-`599` is a `400` as on create; only a body that names `status` is judged, so an example stored with a `1xx` before create began refusing them can still be renamed.
`postmanResponse` accepts only `null`, which clears it; any other value is a `400` - it records what a file said, and the export already regenerates each part of it an edit to `status` or `headers` makes stale.

**Headers:** `If-Match` (optional), see [Conditional updates](resource-writes.md#conditional-updates-with-if-match).

**Response:** the updated example object, with its `ETag`.

**Errors:** `404` as above; `412` if `If-Match` no longer names the stored row; `400` on a malformed `If-Match` or a rejected field.

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

## DELETE /requests/:id/examples/:exampleId

**Deleting an imported example is a decision that lasts** (issue #722).
A spec sync rewrites the `origin: "import"` examples of every request it applies a change to, so a removed row would come back on the next sync of any field - even a rename.
The engine therefore keeps the row as a **tombstone**: the example is gone from every read (the list, a mock server, an export, and a `GET` or `PUT` on its id, all `404`), and a later sync leaves that response status alone rather than writing the document's example for it back.
Re-importing the document is a fresh import and does bring it back, which is the only way it returns.

**Deleting an example a person saved moves it to the [trash](trash.md#trash)** (#2971).
An `origin: "user"` example is stamped `deleted_at` rather than removed: nothing re-creates one, so the row is the only copy of the response.
It is gone from the same reads a tombstone is, a second `DELETE` is a `404`, it no longer counts against the 100-example cap, and [`GET /trash`](trash.md#get-trash) lists it (kind `example`, `parentId` its request) while its request is live.
[`POST /trash/:id/restore`](trash.md#post-trashidrestore) brings it back as it was; [`DELETE /trash/:id`](trash.md#delete-trashid), or the startup sweep after `trashRetentionDays`, destroys it.

**Either way, a request that named the example as its fixed mock answer stops naming it** (issue #3422).
When the request's `mockExampleId` is this example's id, the same write clears it to `null`, advances the request's `updatedAt` (so a `PUT /requests/:id` sent with the old `If-Match` is a `412`) and publishes a `request` `update` on [`GET /changes`](changes.md#get-changes) after the example's `delete`.
`mockResponseMode` is not touched: a `"fixed"` request with no target answers with its first example.
A `mockExampleId` naming any other example is left alone, and a restore from the trash does not set it again.

The response is the same either way, because from the caller's side so is the outcome:

**Response:**
```json
{
  "message": "Example deleted successfully",
  "id": "exa_1234567890"
}
```
