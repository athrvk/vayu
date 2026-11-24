---
description: >-
  The saved-request routes - list, read, create, update, delete - and the element-kind catalogue.
---

# Requests and elements

## Requests

### GET /requests

List requests in a collection, or in every live collection.
Results are ordered by `order`, then `createdAt`, then `id` - the same contract `GET /collections` has for collections.
See [Ordering](resource-writes.md#ordering) for why the tiebreak is part of the contract.

**Query Parameters:**
- `collectionId` (optional): Collection ID to fetch requests from.
  Absent, the response is every live request of every live collection, grouped by `collectionId` and ordered within each group exactly as that collection's own list is - nothing in the trash.
- `fields` (optional): `summary` answers each row cut to the keys a tree is built from (#2546), described below; absent (or empty), the full request objects.
  Any other value is a `400` with code `invalid_fields`, never the full list.
  The app builds its whole tree at launch from one `GET /requests?fields=summary` call.
- `q`, `limit`, `offset` (optional): one page of the rows whose `name` holds `q`, in the `{data, pagination}` envelope - see [Paged lists](resource-writes.md#paged-lists).
  Each `data` row is the row the list would have carried, in the shape `fields` names, and `collectionId` scopes it as above.
  A row that fails to serialize is skipped (as it is in the bare list) and is not counted in `total`.
  A bad `limit` or `offset` is a `400` (`invalid_limit`, `invalid_offset`); a bad `fields` is refused first.

**Summary response** (`fields=summary`): the same rows in the same order as the full form, each carrying exactly `id`, `collectionId`, `name`, `method`, `url`, `order`, `createdAt` and `specOperation`, spelled and valued as the full row writes them (`specOperation` is the object or `null`).
Nothing else is read from the database, so a large body, header set, auth block or element list costs its row nothing, and no row carries `truncatedFields`.
```json
[
  {
    "id": "req_1234567890",
    "collectionId": "col_1234567890",
    "name": "Get Users",
    "method": "GET",
    "url": "{{baseUrl}}/users",
    "order": 0,
    "createdAt": 1234567890,
    "specOperation": null
  }
]
```

**Response** (no `fields`): An array of request objects, each in the same shape as a `GET /requests/:id` response:
`params`/`headers` are arrays of `{key, value, enabled}` entries and `body` is a JSON discriminated union (see the `requests` table in [db-schema.md](../db-schema.md)) - with one deliberate exception (issue #1485):
a row whose `params` / `headers` / `body` / `auth` is over the engine's [field cap](resource-writes.md#a-stored-json-field-has-a-write-time-cap) carries that field's documented default here instead of the stored value, and names which fields were substituted in `truncatedFields` (omitted when nothing was).
`GET /requests/:id` never substitutes - it answers with the field whole, however large.
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
    "elements": [],
    "followRedirects": true,
    "maxRedirects": 10,
    "timeout": null,
    "httpVersion": "auto",
    "verifySSL": true,
    "stream": false,
    "streamTextPath": null,
    "streamFirstContentMarker": null,
    "disableCookies": false,
    "disabledSystemHeaders": [],
    "disableUrlEncoding": false,
    "postmanProtocolBehavior": null,
    "updatedAt": 1234567890,
    "createdAt": 1234567890
  }
]
```

`followRedirects` / `maxRedirects` / `httpVersion` / `verifySSL` / `stream` are the request's stored execution options.
They are always present in the response: a request saved before these columns existed reads back as the engine defaults (`true` / `10` / `"auto"` / `true` / `false`), which is the behaviour it already had.
`streamTextPath` is the JSONPath a stream's events are read through for its reply's text (issue #3773), and `streamFirstContentMarker` the literal a run's stream is timed to (issue #3774); both always present, `null` when the request declares none - see [POST /requests](#post-requests).
`timeout` is the request's own timeout in milliseconds (issue #2937), always present on a stored-row response (`GET /requests`, `GET /requests/:id` and the `POST` / `PUT` answers): a number, or `null` when the request states none and sends with the `defaultTimeout` setting.
`disableCookies` / `disabledSystemHeaders` / `disableUrlEncoding` are Postman's per-request protocol settings (issue #1765), always present too (`false` / `[]` / `false` for a request that states none); `postmanProtocolBehavior` is the imported Postman object they came from, `null` when there is none - see [POST /requests](#post-requests).
`httpVersion` is `"auto"` | `"http1.1"` | `"http2"` - what was *requested*, not what was negotiated; see [POST /execute](execute.md#post-execute) for the negotiated value on a response.

### GET /requests/:id

Fetch a single request by id, in one lookup.
The app uses this to load a restored request tab or a design-run copy on cold start, instead of fetching every collection's request list and scanning them for the id.

**Path Parameters:**
- `id` (required): The request ID to fetch

**Response:** The request object, in the same shape as a full `GET /requests` list entry, with its `ETag` (`W/"<updatedAt>"`, see [Conditional updates](resource-writes.md#conditional-updates-with-if-match)).
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
  "elements": [],
  "followRedirects": true,
  "maxRedirects": 10,
  "httpVersion": "auto",
  "verifySSL": true,
  "stream": false,
  "streamTextPath": null,
  "streamFirstContentMarker": null,
  "createdAt": 1234567890,
  "updatedAt": 1234567890
}
```

**404** when the request genuinely does not exist.
This is distinct from a `5xx`: the caller relies on that difference to tell a real deletion from an unreachable engine, and must not treat a transport failure as "deleted".

### POST /requests

Create a request.
**Create only** - see [Resource writes](resource-writes.md#resource-writes-create-vs-update) for the shared contract and the null-vs-absent rule.

**Request:**
```json
{
  "collectionId": "col_1234567890", // Required, no default (null is a 400)
  "name": "Get Users",               // Required, no default (null is a 400)
  "method": "GET",                   // Required: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
  "url": "{{baseUrl}}/users",        // Required, no default (null is a 400)
  "params": [],                      // Optional, array of {key, value, enabled, in?, valueless?};
                                      // derived from `url`'s query when absent - see below
  "headers": [],                     // Optional, array of {key, value, enabled}
  "body": {"mode": "none"},          // Optional, request body
  "bodyType": "none",                // Optional, mirrors body.mode - see The request body union
  "auth": {"mode": "inherit"},       // Optional, default {"mode":"inherit"}; mode must be a known one - see Auth modes
  "elements": [],                    // Optional, typed behaviours - see Elements. The only
                                      // script source; preRequestScript/postRequestScript/tests
                                      // are refused (400, naming "elements")
  "order": 0,                        // Optional, 0..2147483647; appended after the collection's
                                      // sub-collections and requests if omitted - see Ordering
  "followRedirects": true,           // Optional, follow 3xx responses. Default true
  "maxRedirects": 10,                // Optional, hops while following, clamped to 0..100. Default 10
  "timeout": null,                   // Optional, this request's timeout in ms, 1..86400000.
                                      // Absent/null: the "defaultTimeout" setting - see below
  "httpVersion": "auto",             // Optional: "auto" | "http1.1" | "http2". Absent/null seeds
                                      // from the "defaultHttpVersion" config entry
  "verifySSL": true,                 // Optional, verify the TLS certificate. Default true
  "stream": false,                   // Optional, consume the response as an event stream.
                                      // Default false - see below
  "streamTextPath": null,            // Optional, the JSONPath each event's text is read
                                      // through; needs "stream": true - see below
  "streamFirstContentMarker": null,  // Optional, the literal a run times its stream to;
                                      // needs "stream": true - see below
  "specOperation": null,             // Optional, which spec operation this request is - see below
  "methodSource": null,              // Optional, which app setting wrote `method` - see below
  "mockResponseMode": "first",       // Optional: "first" | "fixed" | "random". Default "first"
                                      // - which saved example a mock server answers with, see below
  "mockExampleId": null,             // Optional, the example id `mockResponseMode: "fixed"` targets
  "disableCookies": false,           // Optional, keep the cookie jar out of this request. Default false
  "disabledSystemHeaders": [],       // Optional, header names the engine does not add. Default []
  "disableUrlEncoding": false,       // Optional, send the URL as typed, with no percent-encoding.
                                      // Default false
  "postmanProtocolBehavior": null    // Optional, the imported Postman object - see below
}
```

**A query row in `params` describes the query in `url`; `url` is the wire truth.**
Nothing in the request-composition path reads a query row, so a query parameter that must reach the wire belongs **in `url`**: a caller that puts the query only in `params` stores a request that sends none of it (issue #590).
The write keeps the rows in step with the URL (issue #3551).
A `POST` or `PUT` that states `url` and **no** `params` has its query rows reconciled with the URL's query, the rule the app's Params table follows on every URL keystroke (`mergeParamsFromUrl`):

- each enabled row claims the first unclaimed pair whose key its own key writes (under any of the query joins, so an OpenAPI import's `a b` claims `a%20b`), rows in stored order, and the merged rows follow the URL's pair order;
- a claimed row keeps every other member (`description`, `source`, ...); one that no longer writes its pair takes the pair's key and value, and `valueless` follows the pair (`true` for a bare `key` with no `=`);
- a pair no row claims becomes a fresh `{key, value, enabled: true}` row (plus `valueless: true` for a bare `key`), and an enabled row the URL no longer carries is dropped;
- a disabled row is kept, after the nearest enabled row before it that the URL still carries, or first when there is none; path rows are left untouched.

Rows that already state the URL's query are left byte for byte, so a host or path edit sent as `url` alone rewrites nothing.
A body that states `params` stores them as sent, whatever `url` says, and a body that states neither keeps the stored rows.
`POST /import/apply` and `POST /specs/sync` reach the same applier: a sync update that applies a request's `url` without its `params` reconciles the kept rows with the new URL's query.
So a request created from a URL alone (every MCP request) reads back with one row per query pair, and the [OpenAPI export](specs.md#post-specsexport), the [spec diff](specs.md#post-specsdiff) and the [Postman export](export.md#post-exportpostman) see its query.
Rows stored before the rule are not rewritten until their next URL-only write, so the Postman export still writes a URL pair no enabled row states into `url.query[]` (issue #3242), and the app still merges a URL-only query into the Params table when it opens one, without marking the tab unsaved (issue #3491).

**A path row is the one row composition reads** (issue #1764).
A row carrying `"in": "path"` is a Postman-style path variable: `key` is the name without its colon, and the URL keeps the `:name` segment verbatim (`{{baseUrl}}/users/:id`).
[`POST /compose`](compose.md#post-compose) writes the row's value in place of the segment at send time - see [Path variables](compose.md#path-variables) there.
A row with `in` absent, `"query"` or anything else is a query row, and everything that joins or splits the query (the importers' URL join, the Postman and OpenAPI exports) skips path rows.
The field needs no schema change: rows are stored verbatim, extra keys included.

**`stream` is the saved half of [`POST /execute`'s `stream`](execute.md#post-execute)** (issue #574).
It records that *this endpoint* is a `text/event-stream`, which is a property of the endpoint rather than of one send, so the app's Event stream toggle persists here and a bulk import carries it.
The engine never acts on the stored value by itself: `POST /execute` reads the flag off the payload it is given, which a by-id [`POST /compose`](compose.md#post-compose) always fills from this column (issue #3561).

**`streamTextPath` is the saved half of [`POST /execute`'s `streamTextPath`](execute.md#post-execute)** (issue #3773): the JSONPath, in the subset the elements read, that each event's JSON `data` is read through for the reply's text, such as `$.choices[0].delta.content` (OpenAI-compatible) or `$.delta.text` (Anthropic-style).
A value that is not a string or not in the subset is a `400`, and so is a path stated on a request that does not stream once the write lands (here, on `PUT` and in `POST /import/apply`): it reads as text the request will not produce.
A `PUT` that only switches `stream` off keeps the stored path, which nothing reads until the stream is switched on again; `null` clears it.
A by-id [`POST /compose`](compose.md#post-compose) carries it beside `stream: true` only, and a collection run's streaming step reads its events through it ([`POST /runs`](load-runs.md#post-runs)).
An OpenAPI export carries it in `x-vayu-request.settings` beside `stream`; a Postman export lists it under `notCarried` (`event_stream`).

**`streamFirstContentMarker` is the saved half of the marker a [single-request run](load-runs.md#post-runs) takes** (issue #3774): a literal byte string, such as `content_block_delta` (Anthropic-style) or `"delta":{"content":"` (OpenAI-compatible), that a run's stream is watched for, so the report's `stream.timeToFirstMatch` times the first content rather than a preamble event.
It is stored under `streamTextPath`'s rules: a value that is not a string, is empty, is longer than 256 bytes or holds a NUL byte is a `400`, and so is a marker stated on a request that does not stream once the write lands; a `PUT` that only switches `stream` off keeps it, `null` clears it.
A by-id [`POST /compose`](compose.md#post-compose) carries it beside `stream: true` only, and a collection run's streaming step is timed to it.
An OpenAPI export carries it in `x-vayu-request.settings` beside `stream`; a Postman export lists it under `notCarried` (`event_stream`).

**`timeout` is the saved half of [`POST /execute`'s `timeout`](execute.md#post-execute)** (issue #2937): one slow endpoint can wait longer, or a fast one fail sooner, without changing the `defaultTimeout` setting for every request.
It is held to the same `1`-`86400000` ms, and a number outside it or a value that is not a number is a `400` naming `'timeout'` here, on `PUT` and in `POST /import/apply`.
Absent or `null` on create stores none, and the request sends with the setting in force at each send rather than a copy of it.
[`POST /compose`](compose.md#post-compose) by `requestId` emits `timeout` only when the request states one, so a Send, a sequential collection run, a single-request load run built from the composed payload and a scenario load step all take it, and a request that states none still takes the setting.
A Postman collection has no per-request timeout, so `POST /export/postman` lists one under `notCarried` (`request_timeout`); an OpenAPI export carries it in `x-vayu-request.settings`.

**`specOperation` names which operation of the collection's [bound spec](collections.md#post-collections) this request is** (issue #637):

```json
{"operationId": "listPets", "method": "GET", "path": "/pets/{petId}"}
```

`method` and `path` are required inside the object and `operationId` is optional, because an OpenAPI operation may declare none.
`path` is the **templated** path from the document, never a concrete URL - it is the identity a re-fetched spec is diffed against - so a `path` that does not start with `/` is a `400`, as is a missing or empty `method` / `path`, a non-object value, or a non-string `operationId`.
`null` (or absent on create) means the request declares no operation, and both request serializers emit `specOperation: null` for it - the key is always present, so a client never has to tell "no operation" from "not serialized".
Two requests may name the same operation.

**`methodSource` names which app setting last wrote `method`, still unclaimed by the user** (issue #1505).
The only value a client writes is `"graphql"` - the GraphQL body mode setting `method` to `POST` on a fresh `GET` - and `null` (or absent on create) means no marker: either the user chose `method` themselves, or nothing has set it.
`"graphql"` is the only accepted value; anything else is a `400`.
The app clears the marker itself the moment `method` is written by anything other than the GraphQL switch, so a method the user has since picked is never reverted - the same "still ours" contract `KeyValueEntry.source` (issue #1481) gives a header row.

**`mockResponseMode` names which saved example a mock server answers with** (issue #481 phase 3): `"first"` (the default, absent or `null` on create both mean this), `"fixed"` (the example named by `mockExampleId`) or `"random"`.
Anything else is a `400`, the same way an unrecognized `methodSource` is.
`mockExampleId` follows the same null-vs-absent rule as `specOperation`: absent keeps the current target, `null` clears it, and a non-empty string sets it - it is not checked against the request's saved examples at write time, because the target can be created afterwards or deleted later, and a mock server falls back to `"first"` for either case rather than this write refusing one up front.
Deleting the target through `DELETE /requests/:id/examples/:exampleId` clears `mockExampleId` to `null` (issue #3422) and leaves `mockResponseMode` as it was; restoring the example from the trash does not set it again.

**Postman's per-request protocol settings** (issue #1765), under the same null-vs-absent rule (absent keeps on update, `null` resets):

- `disableCookies` keeps the cookie jar out of every send of this request: no jar cookie is attached and no `Set-Cookie` is stored.
  A `Cookie` header the request carries still goes out, and a pre-request script's `pm.cookies.jar()` write is still persisted.
  With the jar on, a typed `Cookie` and the jar's matches go out as one `Cookie` line, the jar's first, never as two (issue #2788).
  The one case it does not go out is a jar line that reaches libcurl's 8190-byte limit: libcurl drops the typed rows with the jar cookie it leaves off, and the answer says so under `warnings` (`cookie_not_sent`, issue #3307).
- `disabledSystemHeaders` names headers the engine does not add on its own.
  It is stored lowercased and deduplicated in first-appearance order,
  and unioned on every send with the per-send `disabledDefaultHeaders` (see [POST /execute](execute.md#post-execute)):
  `user-agent`, `accept-encoding` and the correlation id as that list refuses them, `accept` removes libcurl's implicit `Accept: */*`, `content-type` removes the Content-Type a body implies (multipart keeps its boundary header), and with it a `Content-Type` header row marked `"source": "body-mode"` -
  the row the app's Body panel writes and the importer adds for a GraphQL, JSON-RPC or XML body, which is the body's own header, not the user's.
  A `Content-Type` row without that marker is the user's and is always sent.
  Other names (`host`, `content-length`, `postman-token`, ...) are stored for the export and change nothing on the wire.
- `disableUrlEncoding` writes the URL as typed rather than percent-encoded:
  a path variable's value skips Postman's path encode set, an api-key (or OAuth 2.0 query-placed) credential and a substituted `{{variable}}` skip their rules, and the rest of the URL is not rewritten either ([Query encoding](compose.md#query-encoding)), so `a"b` goes out as `a"b`, not `a%22b`, as Postman's `toNodeUrl (url, disableEncoding)` sends it.
  With encoding on, a raw space is percent-encoded to `%20`; with the toggle on it is refused, and the send fails with a message that names the space and the toggle ([URL schemes](compose.md#url-schemes)).
- `postmanProtocolBehavior` is the Postman item's `protocolProfileBehavior`, kept for [POST /export/postman](export.md#post-exportpostman) and sent by nothing.
  It takes an object or a string holding a JSON object; the string is the spelling the importer writes, because it keeps the source's member order (an object crossing the engine's reader does not).
  `GET` answers it as that stored text, a string (or `null`), the way it is written: a client that sends the record back, as the app's Duplicate does, stores the same bytes, and the copy exports the same `protocolProfileBehavior`.
  The string is read again by the engine, so it is held to the request-body depth bound too (see [Request bodies](index.md#request-bodies)): a string nested deeper than 128 levels is a `400`.

A non-boolean `disableCookies` / `disableUrlEncoding`, a `disabledSystemHeaders` that is not an array of header-name tokens, or a `postmanProtocolBehavior` that is not an object, such a string or `null` is a `400` naming the field, as is a `postmanProtocolBehavior` string nested deeper than 128 levels (`Invalid 'postmanProtocolBehavior': nested deeper than 128 levels`);
the last two are `413` over the field cap.
`POST /import/apply` answers the same `400`, with the item's `tempId` under `error.item`, and writes nothing.

**Response:** The created request object, carrying the engine-generated `id`.

**Errors:** `400` if the body carries an `id` ([the engine owns it](resource-writes.md#the-engine-owns-every-id)), if a required field is missing or `null`, if `collectionId` names a collection that does not exist (message `Collection '<id>' does not exist`),
on an unrecognized `method`, on a `params` / `headers` entry that is not `{key: string, value: string, enabled: bool}`, on a `methodSource` that is not `"graphql"` or `null`,
on a `mockResponseMode` that is not `"first"` / `"fixed"` / `"random"`, on a `mockExampleId` that is not a non-empty string or `null`,
on an `order` that is not an integer from `0` to `2147483647` or an append that finds no slot left ([Ordering](resource-writes.md#ordering)), on an `auth` whose `mode` is not a [known one](resource-writes.md#auth-modes) (#3464), or on an `httpVersion` that is not `"auto"` / `"http1.1"` / `"http2"` (the body names the field and lists the valid values);
`413` naming the field, its size and the cap, when a serialized `params` / `headers` / `body` / `auth` is over the engine's field cap (issue #1485, [see Resource writes](resource-writes.md#a-stored-json-field-has-a-write-time-cap)).

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

Unlike a collection's `parentId` (which may name a collection not written yet, though not one in the trash), a request's `collectionId` **must** resolve to a stored collection.
A request under no collection is unreachable: no per-collection `GET` lists it, and no cascade delete ever reaps it.
Bulk import is unaffected - `POST /import/apply` resolves owners from the payload's own temp ids before any row is written.

### PUT /requests/:id

Update an existing request.
**Update only** - a `404` when the id does not exist, never a silent create.
Merge-patch body, same rule as collections.

**Request:** any subset of the `POST /requests` fields, minus `id` (it is the path).
Sending `collectionId` moves the request to another collection; the id must resolve to a stored collection (`400` otherwise), and a move that states no `order` appends in the destination - see [Ordering](resource-writes.md#ordering).
An update that states no `collectionId` is not checked against the request's stored one, so a row stranded before this validation existed stays editable, and repairable by a `PUT` that moves it somewhere real.
A move that takes a request recording an operation (`specOperation`) out of the spec contract that answers for it is removing it from that contract (#3446): out means the destination's nearest binding names another document, none, or the same document from a collection outside the source's contract (a sibling root bound to it too).
The operation is recorded as declined under the source binding, as [`DELETE /requests/:id`](#delete-requestsid) records it, and the stamp is cleared in the same write, so the source's [`POST /specs/diff`](specs.md#post-specsdiff) lists it under `declined` rather than `added`.
A move within one contract keeps the stamp, a move between the bound collection and a sub-collection bound to the same document included; a body that states `specOperation` beside the move keeps the stated value.
Omitting `followRedirects` / `maxRedirects` / `timeout` / `verifySSL` / `stream` / `specOperation` / `methodSource` / `mockResponseMode` / `mockExampleId` / `disableCookies` / `disabledSystemHeaders` / `disableUrlEncoding` / `postmanProtocolBehavior` leaves the stored values untouched;
sending `null` resets them to `true` / `10` / "the `defaultTimeout` setting" / `true` / `false` / "no operation" / "no marker" / `"first"` / "no target" / `false` / `[]` / `false` / "none".
A non-boolean `followRedirects`, `verifySSL` or `stream`, or a non-integer `maxRedirects`, is ignored rather than rejected.
`maxRedirects` is clamped to `0..100` on the way in.
`timeout` is the exception among them: a value outside `1`-`86400000` or one that is not a number is a `400` naming `'timeout'`, and nothing is written.
`order` is held the same way (#3451): a stated value that is not an integer from `0` to `2147483647` is a `400` naming `'order'`, so `{"collectionId": "col_2", "order": "9"}` refuses the move rather than making it at the old position - see [Ordering](resource-writes.md#ordering).

**`httpVersion`** follows the same [null-vs-absent rule](resource-writes.md#the-null-vs-absent-rule) as the fields above, but validates more strictly: absent keeps the stored value;
explicit `null` resets it to the live `defaultHttpVersion` config value; a recognized string stores as given; anything else - an unrecognized string, or a non-string - is a `400` naming the field and the valid values, never silently coerced.
Changing the global `defaultHttpVersion` afterward does not retroactively alter a request already saved; only an explicit `null` on this request re-seeds it.

**`preRequestScript`, `postRequestScript` and `tests` are refused.**
Issue #1514's cut-over is a clean cut, not a transitional alias: any of these three keys present (even `null` is accepted as a no-op, but a real value is not) is a `400` naming `elements` as the replacement.
Scripts are `elements` now - `{"kind": "script.pre" | "script.post", "config": {"script": "..."}}`.

**`elements`** (issue #1513, run by issue #1514's pipeline) takes the array rule: absent keeps the stored list; `null` resets it to `[]`; a present value must be an array the element registry accepts (see [Elements](../elements.md)) or the write is a `400` naming the index, the kind and the field.
That includes a kind's own rules beyond its schema: a JSONPath outside the supported subset, a pattern RE2 does not compile (`'pattern' is not a valid regular expression -
<reason>`, likewise `'regex'` and `'text'`, #3043), an `assert.status` with
neither a non-empty `in` nor a `range`, an `assert.jsonpath` with none of `expected`, `regex` or `exists`, and one that sets `exists` beside `expected` or `regex` (#3049), an `assert.jsonschema` whose `schema` is not an object or a boolean, whose `source` is `jsonpath` with no `path` (or a `path` beside any other `source`),
or whose `schema` refers to itself without describing any value (#3806), an `assert.snapshot` whose `baseline` is not an array of objects each carrying a unique text `name` (`uri` for `resources/list`, #3807), and what the engine would otherwise accept and ignore (#3055):
a `control.throughput` naming neither or both of `percent` and `everyN`, a `timer.think` with no `ms`, `gaussian` or `minMs` + `maxMs` pair, an `assert.contains` with an empty `text` in `contains` mode, and an `extract.*` `variable` no `{{name}}` can read (a brace in it, whitespace at an edge, the `data.` namespace, `$vu` or `$iteration`).
The only script source - `GET /requests/:id` and every full list response carry it and no longer carry `preRequestScript` / `postRequestScript` at all.

**`auth.postman`**, the Postman block an import kept beside the mapped auth (see [`db-schema.md`](../db-schema.md)), is kept on a write only while mapping it through the Postman importer still gives the auth being written; otherwise it is dropped.
So a changed credential never leaves the old one behind in the stored block, whichever client wrote it, and a save that changed nothing keeps it.
`POST /requests`, `POST /collections`, `PUT /collections/:id` and `POST /import/apply` apply the same rule.

**Headers:** `If-Match` (optional), see [Conditional updates](resource-writes.md#conditional-updates-with-if-match).

**Response:** The updated request object, with its `ETag`.

**Errors:** `404` if the request does not exist; `412` if `If-Match` no longer names the stored row;
`400` on a malformed `If-Match`, on a `null` `collectionId` / `name` / `method` / `url`, a `collectionId` naming a collection that does not exist, an unrecognized `method`, a malformed `params` / `headers` entry,
a malformed `specOperation`, a `methodSource` that is not `"graphql"` or `null`, a `mockResponseMode` that is not `"first"` / `"fixed"` / `"random"`, a `mockExampleId` that is not a non-empty string or `null`,
an `auth` whose `mode` is not a [known one](resource-writes.md#auth-modes) (#3464), a malformed protocol setting (see [POST /requests](#post-requests)), or an `httpVersion` that is not `"auto"` / `"http1.1"` / `"http2"`;
`413` naming the field, its size and the cap, when a serialized `params` / `headers` / `body` / `auth` is over the engine's field cap (issue #1485, [see Resource writes](resource-writes.md#a-stored-json-field-has-a-write-time-cap)).

A storage failure answers `507`, `503` or `500`, never `400` - see [A storage failure is not a 400](resource-writes.md#a-storage-failure-is-not-a-400).

### DELETE /requests/:id

Delete a request.
**The delete is soft** (issue #988) - the row is stamped `deleted_at` and [`GET /trash`](trash.md#get-trash) lists it until a purge.
Its [saved examples](examples.md#request-examples) stay on the row rather than being removed: every read of them is by request id and runs the owner check first, so they are as unreachable as the request is, and a restore gets them back with it.
A purge takes them.

**Deleting the request for an operation declines the operation** (issue #3031).
When the request records an operation (`specOperation`) and a collection above it binds a document, the same transaction records that operation under the nearest bound ancestor in `spec_declined_operations`.
[`POST /specs/diff`](specs.md#post-specsdiff) then lists the operation as `declined` rather than `added`, and a `policy: "safe"` [sync](specs.md#post-specssync) never re-creates it, so a sync of the unchanged document cannot bring the request back.
Restoring the request from the trash forgets the record, and so does a sync that creates the operation on purpose; purging the request, by hand or by `trashRetentionDays`, does not - the decision outlives the row it was made on.
Unbinding the collection, or binding it to a document with other bytes, forgets every record under it.
A sync's own deletes record nothing.
Moving the request out of the contract records the same decline (#3446, see [`PUT /requests/:id`](#put-requestsid) and [`POST /reorder`](collections.md#post-reorder)), and so does moving a folder above it out with [`PUT /collections/:id`](collections.md#put-collectionsid) (#3470);
the move clears the stamp, and a restore forgets only the record of a request that still records an operation, so deleting and restoring the moved request later leaves the source's record standing.

**Response:**
```json
{
  "message": "Request deleted successfully",
  "id": "req_1234567890"
}
```

## Elements

### GET /elements/kinds

The element registry's catalogue (issue #1513): every kind a request's or collection's `elements` array may name, whatever the engine build actually registers - a kind added in one file (`engine/src/core/elements/`) appears here with nothing else changed, per [Elements](../elements.md)'s extensibility contract.
This is what #1516 (app) and #1517 (MCP) render a kind's editor from, and what `docs/engine/elements.md`'s kind table is checked against.

**Response:**
```json
[
  {
    "kind": "inherit.disable",
    "version": 1,
    "phases": [],
    "label": "Disable inherited element",
    "description": "Drops one element inherited from an ancestor collection, named by id, out of this request or collection's resolved list.",
    "category": "inherit",
    "hotPathClass": "declarative",
    "collectionOnly": false,
    "configSchema": {
      "type": "object",
      "properties": {
        "elementId": {
          "type": "string",
          "minLength": 1,
          "title": "Element to disable",
          "description": "The id of an inherited element to drop from this request or collection's resolved list."
        }
      },
      "required": ["elementId"],
      "additionalProperties": false
    }
  }
]
```

Every property of every kind's `configSchema` carries a `title` and a `description` (issue #1607), plus, where relevant, `x-vayu-group: "advanced"` (folds the property under a disclosure) or `x-vayu-unit` (`"ms"`, `"%"` or `"B"`, a numeric suffix to render) - see [Elements](../elements.md#schema-annotations).
A property the engine gives a value when its key is absent also carries `default` (issue #3045), taken from the constant the kind reads -
`assert.size` `op` is `"lte"`, `assert.jsonschema` `source` is `"body"`, `assert.snapshot` `method` is `"tools/list"`, an `extract.*` `scope` is `"collection"`, `timer.pacing` and `control.throughput` `perUser` are `true`, `timer.throughput` `perUser` is `false`.
An absent key means that default; a client shows it without writing the key.

Phase 0 also registers `script.pre` and `script.post`, validate-only like `inherit.disable` - so a request or collection the startup fold migrated (`docs/engine/db-schema.md`) can be read back and written as-is without its own `elements` failing the registry that produced them - plus, in the test build only, a `test.echo` kind proving the registration path.
`collectionOnly` (issue #1499) is `true` only for `script.setup` / `script.teardown` - the app's Add menu on a request hides a kind marked so, and the registry itself refuses one on a request's own `elements` with a `400`.
See [Elements](../elements.md) for the full kind table.
