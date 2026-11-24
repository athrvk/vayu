---
description: >-
  The environment routes and the global-variables routes: list, create, update and delete.
---

# Environments and global variables

## Environments

### GET /environments

List every environment, except those in the [trash](trash.md#trash) (#2970).

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

Create an environment.
**Create only** - see [Resource writes](resource-writes.md#resource-writes-create-vs-update) for the shared contract and the null-vs-absent rule.

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

**Errors:** `400` if the body carries an `id` ([the engine owns it](resource-writes.md#the-engine-owns-every-id)), if `name` is missing or `null`, if `name` is empty or whitespace-only ([#3253](resource-writes.md#blank-names)), or if a `variables` key is blank or padded ([#3251](resource-writes.md#accepted-field-shapes));
`413` naming the field, its size and the cap, when a serialized `variables` is over the engine's [field cap](resource-writes.md#a-stored-json-field-has-a-write-time-cap).

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

### PUT /environments/:id

Update an existing environment.
**Update only** - a `404` when the id does not exist, never a silent create.
Merge-patch body, same rule as collections.

`variables` replaces the whole map, so a caller doing a partial edit reads the current map first and sends the merged result under the version it read, `If-Match: W/"<updatedAt>"` (this is what the MCP `update_environment` tool does; see [Conditional updates](resource-writes.md#conditional-updates-with-if-match)).
Sending `variables: null` resets it to `{}`, never the literal string `null`.
`isActive` is honored here too, not only on create.

**Writing `isActive: true` is how a client switches the active environment**, and one request does the whole switch: the engine deactivates whichever environment held the flag in the same transaction, so at most one row is ever active and a client sends no companion write to clear the old one.
Clearing entirely is `isActive: false` on the environment that holds it.
The engine still never *applies* the active environment to a request - every execution names its own `environmentId` - but because the choice is stored rather than kept client-side, it survives a restart and is shared by every client on the same database.
See [db-schema/environments-and-globals.md](../db-schema/environments-and-globals.md#environments).

**Request:**
```json
{
  "name": "Production",    // Optional; null is a 400 (no default)
  "variables": {},          // Optional, null resets to {}
  "isActive": true          // Optional, null resets to false; true is the switch
}
```

**Headers:** `If-Match` (optional), see [Conditional updates](resource-writes.md#conditional-updates-with-if-match).

**Response:** The updated environment object, with its `ETag`.

**Errors:** `404` if the environment does not exist; `412` if `If-Match` no longer names the stored row;
`400` on a `null` or empty or whitespace-only `name` ([#3253](resource-writes.md#blank-names)), a malformed `If-Match` or a blank or padded `variables` key ([#3251](resource-writes.md#accepted-field-shapes)); `413` naming the field, its size and the cap, when a serialized `variables` is over the engine's [field cap](resource-writes.md#a-stored-json-field-has-a-write-time-cap).

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

### DELETE /environments/:id

Delete an environment.
**The delete is soft** (#2970): the row is stamped `deleted_at`, its `isActive` is cleared in the same write, and [`GET /trash`](trash.md#get-trash) lists it until a purge.
From then on every route here treats the id as missing - `GET /environments` leaves it out, `PUT` and a second `DELETE` are a `404`, `POST /export/postman-environment` is a `404`, and an `environmentId` naming it composes and sends as an id naming nothing: an empty scope, so its `{{names}}` stay unresolved.

Restore it with [`POST /trash/:id/restore`](trash.md#post-trashidrestore), which brings it back inactive; destroy it for good with [`DELETE /trash/:id`](trash.md#delete-trashid), which is also what the startup sweep does once `trashRetentionDays` has passed.
Its [cookie jar](cookies-and-certificates.md#get-cookies) is kept while it is in the trash, out of `GET /cookies`, so a restore brings its session back; a purge drops it.

**Response:**
```json
{
  "success": true
}
```

**Errors:** `404` if no live environment has that id, a trashed one included.
A storage failure answers `507`, `503` or `500` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

## Global Variables

### GET /globals

Get global variables (singleton).
An engine that never saved any answers the empty set at `updatedAt: 0`.
The row is created by the first `POST /globals`, the first import carrying globals, or the first script or extractor write to a global (`pm.globals.set`, an `extract.*` element with `scope: globals`): a `POST /execute` or collection run on a workspace with no globals stores what its scripts set rather than discarding it.

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

The answer carries the row's `ETag`, `W/"<updatedAt>"` (`W/"0"` for the never-written row), which a later `POST /globals` may name in `If-Match`.

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

**Headers:** `If-Match` (optional), see [Conditional updates](resource-writes.md#conditional-updates-with-if-match).

**Response:** The saved globals object, with its `ETag`.

**Errors:** `412` if `If-Match` no longer names the stored row (the stored `updatedAt` rides inside the error); `400` on a malformed `If-Match`, a non-object `variables` or a blank or padded `variables` key ([#3251](resource-writes.md#accepted-field-shapes)).
None writes anything.

Globals is a singleton, so there is no create/update pair: a `POST` **replaces** the whole set rather than merging into it.
Every write is therefore a create as far as the [null-vs-absent rule](resource-writes.md#the-null-vs-absent-rule) goes - `variables` absent and `variables: null` both mean the default, `{}`.
A caller that keeps the globals it did not name reads first, merges, and saves under the version it read with `If-Match: W/"<updatedAt>"` (this is what the MCP `update_globals` tool does).
The engine judges the tag in the same lock acquisition as the write, so a save that landed after the caller's read turns its write into a `412` rather than a silent loss.

`variables: null` is never stored as the literal four-character text `null`, which parses as JSON but is not an object.
`GET /globals` returns `{}` for anything it cannot read as an object, so storing it would make globals silently disappear rather than fail.
A non-object `variables` (`42`, a string, an array) would do the same and is a `400` - see [Accepted field shapes](resource-writes.md#accepted-field-shapes).
