---
description: >-
  The request `body` union a stored request and a send carry: every mode, its fields and what the engine accepts.
---

# The request `body` union

`body` is a discriminated union on `mode`, and the shape of what it carries depends on which mode it is.
The same union is read on the execution endpoints (`POST /compose`, `POST /execute`, `POST /runs`) and stored on a request row, so a body that round-trips through storage sends the same bytes.

| `mode` | Carries | On the wire |
|---|---|---|
| `none` | nothing | no body; a `POST` sends `Content-Length: 0` and no Content-Type |
| `json` / `text` | `content` (string) | `content`, verbatim |
| `graphql` | `content` (string) | the GraphQL-over-HTTP envelope on POST, query parameters on GET (see below) |
| `jsonrpc` | `content` (string) | the JSON-RPC 2.0 call envelope (see below) |
| `mcp` | `content` (string), optional `mcpTool` | the JSON-RPC envelope plus `params._meta`, and the headers MCP mirrors out of the body (see below) |
| `xml` | `content` (string) | `content`, verbatim |
| `x-www-form-urlencoded` | `fields` | percent-encoded `key=value&…` |
| `form-data` | `fields` | `multipart/form-data`, boundary engine-generated |
| `binary` | `file` (a file reference) | the file's bytes, verbatim (see [File references](#file-references-binary-bodies-and-file-parts)) |

`fields` is an array of `{key: string, value: string, enabled?: bool}` - the same row shape `params` and `headers` use.
`key` is required and must be a string; `value` defaults to `""` and a non-boolean `enabled` reads as enabled.
A `form-data` row may add `contentType`, the part's own Content-Type, on a text part as well as a file part (a Postman import writes it for a text row that carries one); a part without it sends none.
A form mode carrying no `fields` array is a `400`, as is a `fields` on a mode whose content is a string.
Rows with `enabled: false` are stored and returned but never sent, so switching one back on needs no re-compose; `{{variables}}` resolve inside `key`, `value`, `contentType` on a part, and a file reference's `src` / `fileName` / `contentType` (a file part's, or a binary body's `file`) during composition.

The Content-Type rules follow from the encoding:

- `x-www-form-urlencoded` sets `Content-Type: application/x-www-form-urlencoded` **only when the request declares no Content-Type of its own** - an explicit header wins.
- `json` sets `Content-Type: application/json` under the same rule (issue #889).
  It did **not** until then, and libcurl's default for a `CURLOPT_POSTFIELDS` body (every mode but `form-data` and a streamed `binary`, on every verb) is `application/x-www-form-urlencoded` - so a request whose `body.mode` said `json` went out declaring itself a form.
  The app's body panel wrote the header row for a request built in the UI, which is why it survived: every request created any other way - MCP `create_request`, an import, a payload posted straight to `/execute` - sent the wrong type.
  A declared header still wins, so `application/vnd.api+json` reaches the server unchanged.
- `graphql`, `jsonrpc` and `mcp` set `Content-Type: application/json` under the same rule - a Content-Type the caller wrote wins.
  `graphql` only on the method that carries a body at all: a GraphQL `GET` has no body and derives no Content-Type, since there is nothing to describe (see below).
- `text` sets `Content-Type: text/plain` under the same rule (issue #2464).
  Until then it derived nothing, by decision - `text/csv`, a JWT and a raw signature are all `text` - but an author who wrote no header got libcurl's form type rather than no type.
  Postman and Bruno send `text/plain` for the same body.
  A typed row (`text/csv`, `application/jwt`) still wins, and `disabledSystemHeaders: ["content-type"]` sends none.
- `xml` sets `Content-Type: application/xml`, again only when the caller declared none.
  It has no envelope and nothing is done to `content`; the header is the whole of what sets the mode apart from `text`, which is why an endpoint expecting `application/soap+xml` keeps the header it was given.
- `form-data` **always** sets its own Content-Type, and a caller-supplied one is dropped.
  The header has to carry the boundary of the body that was actually encoded, which no caller can name in advance.

- `binary` derives its Content-Type from the file, in four tiers, an empty string counting as absent at each: an enabled `Content-Type` header row, then `file.contentType`, then the type the file's extension names (one engine table of common types), then `application/octet-stream`.
  `POST /compose` writes the effective type into an empty `file.contentType` (unless a non-blank `Content-Type` header row is present, which wins at send anyway), so the composed payload - and a snippet generated from it - names the type the send uses.

**No request goes out under libcurl's `x-www-form-urlencoded` default** (issue #2464). libcurl writes that type into any `CURLOPT_POSTFIELDS` body, and into a bodyless `POST`, whenever the header list names no Content-Type.
So where nothing declares one - a `content-type` refusal in `disabledSystemHeaders`, a typed `Content-Type` row left blank (on any mode but `binary`, where a blank row is absent), a body mode of `none` on a `POST` - the engine hands libcurl its removal line instead, and the request carries no Content-Type at all, as Postman sends a bodyless `POST`.
A bodyless `PUT`, `PATCH` or `GET` never had one.
The removal line is not a sent header and is not in `requestHeaders`.

## The `graphql` envelope

A GraphQL server reads its query out of a JSON object, so a `graphql` body is enveloped on its way to the wire rather than sent as typed.
`content` may be either shape and the engine normalizes both:

| `content` | Sent as |
|---|---|
| a JSON object with a string `query` | itself, **byte for byte** |
| anything else (a bare document, JSON that is not an envelope) | `{"query": <content>}` |

The pass-through is byte-exact deliberately: the envelope also carries `operationName`, `variables` and whatever else a server has agreed with its clients, and re-serializing it would reorder keys the caller never edited.
The app's request builder writes the envelope itself, so its requests take the first row; MCP and raw callers can hand over the document alone and take the second.

One case is neither: `content` that *looks* like a JSON object (`{` then a quoted key) but does not parse - an envelope whose `{{token}}` went unresolved, or a mistyped one - is passed through unchanged rather than wrapped.
Wrapping a body the engine could not read would turn a broken envelope into a valid request carrying the wrong query.
A bare GraphQL document cannot take that shape, so nothing legitimate falls into it.

GraphQL-over-HTTP defines two transports, and the request's method picks between them (issue #1228).
Everything above is the POST transport - the envelope goes out as a JSON body.
On a **GET**, the same fields travel as percent-encoded query parameters instead, and the request has **no body and no derived Content-Type**:

| Parameter | From |
|---|---|
| `query` | the envelope's `query`, or the whole of `content` when it is a bare document |
| `operationName` | the envelope's `operationName`, when present and not `null` |
| `variables` | the envelope's `variables`, JSON-encoded, when present and not `null` |
| `extensions` | the envelope's `extensions`, JSON-encoded, when present and not `null` |

The order the author wrote is the order sent: the parameters follow the envelope's member order, and the keys inside `variables` and `extensions` keep theirs (issue #2789), written compactly with no whitespace.
The encoding re-renders numbers from their parsed value rather than copying the text: an integer up to 64 bits unsigned (`18446744073709551615`) is exact, a larger one becomes a double (`18446744073709551616` is sent as `1.8446744073709552e+19`), and a fraction or exponent form is a double (`1e2` is sent as `100.0`).
The POST transport is unaffected and stays byte for byte.

These parameters are merged into whatever query string the request's URL already has rather than replacing it - a `GET` sent to `/graphql?debug=1` keeps `debug=1` alongside `query=…`.
The engine sends a body on a GraphQL `GET` in three cases, each because dropping the alternative would send a request the caller did not write rather than the one it wrote:
`content` is empty, `content` is envelope-shaped but does not parse (the same unreadable-envelope case above), or the envelope carries a member this transport has no parameter for, or one of `operationName` / `variables` / `extensions` whose value is not the type the specification gives it.
A fourth case is an envelope nested deeper than 128 levels, its own root counted (issue #2672): `content` is a string, so the request-body depth bound never looks inside it, and encoding `variables` or `extensions` would re-serialize them recursively.
Like the unreadable envelope it is not split, and the engine does not guess at it.
In all four, the request falls back to the POST-style JSON body even though the method is `GET`.

## The `jsonrpc` envelope

A JSON-RPC 2.0 server refuses a frame that does not declare its version, so a `jsonrpc` body is completed on its way to the wire in the same place, and by the same rule, as the `graphql` one.
`content` may be either shape:

| `content` | Sent as |
|---|---|
| a JSON object with a **string** `jsonrpc` member | itself, **byte for byte** |
| a JSON object without one | itself plus `"jsonrpc":"2.0"`, and `"id":1` if it declares no `id` |
| a JSON array (a batch call) | itself, verbatim |
| anything else (a non-object, text that does not parse, or a call nested deeper than 128 levels) | itself, verbatim |

The added `id` is the constant `1`, never a random or time-derived value: a load run sends the same call thousands of times and a replay has to send the bytes it replays, so a per-send id would make two runs of the same request incomparable.
A caller who needs their own ids writes the full frame - which is passed through - and so does a caller sending a **notification**, the frame with no `id` that a server must not answer.
Members the caller wrote keep the order they wrote them in, and the two the engine may add go on the end.

The member's *type* is what is checked, not its presence: `{"jsonrpc": 2.0}` is the JSON number and the spec asks for the string, so such a frame is completed (the version stamped over) rather than sent as the invalid request it is.

A batch array needs nothing done to it - every element carries its own envelope
- and passes through for the same reason any non-object does: there is no single call object to complete.

The unresolved-`{{token}}` caveat is the `graphql` one, and it matters more here because a JSON-RPC `params` is where a variable usually sits.
Composition resolves the body first (`POST /compose`), and the envelope rule then runs on the *resolved* text; a body still holding a token at wire time does not parse, so it is passed through as typed rather than completed into a well-formed request carrying an unresolved template.

## The `mcp` body

An `mcp` body is one call to a Model Context Protocol server over the Streamable HTTP transport, modern era, revision **`2026-07-28`** (`vayu::http::mcp::PROTOCOL_VERSION`, `http/mcp_body.hpp`; issue #3762).
The revision asks for metadata inside the body and for headers that repeat the body, and a server refuses a request whose headers disagree with its body (`400`, JSON-RPC error `-32020`, HeaderMismatch).
The engine writes both, for every client (Send, a collection run, a load run, MCP `run_request`, the CLI), so nobody keeps them in step by hand.

**The body** follows [the `jsonrpc` envelope](#the-jsonrpc-envelope) row for row - a full envelope, a non-object, unparseable text and a call past 128 levels pass through byte for byte; a bare call gains `"jsonrpc":"2.0"` and `"id":1` - and a bare call also gains `params._meta` (`params` is created when absent or `null`):

```json
"_meta": {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { "name": "vayu", "version": "<engine version>" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

A call whose `params` already carries `_meta` keeps it untouched, and a full envelope is never stamped.

**The headers** are derived from the resolved bytes about to be sent, in the one header-list builder every driver uses, so they appear in `requestHeaders` / `requestHeaderLines` and a run's `sentHeaders` like any other sent header:

| Header | Value |
|---|---|
| `Accept` | `application/json, text/event-stream`, always |
| `MCP-Protocol-Version` | the body's `params._meta` protocol version when it is a string, else `2026-07-28` |
| `Mcp-Method` | the call's `method` |
| `Mcp-Name` | `params.name` for `tools/call` and `prompts/get`, `params.uri` for `resources/read` |
| `Mcp-Param-<Name>` | for a `tools/call` of the tool `mcpTool` describes, each `x-mcp-header` argument (below) |

The precedence is the body-implied `Content-Type`'s: a header the request carries under the same name (any case) is sent instead of the derived one, and a name in `disabledSystemHeaders` (or a send's `disabledDefaultHeaders`) is not added; a refused `Accept` also keeps libcurl's `Accept: */*` off.
`Mcp-Name` and `Mcp-Param-*` values that are not plain printable ASCII (non-ASCII, a control character, an edge space, an empty value, or text that itself looks like the sentinel) are sent as `=?base64?<Base64 of the UTF-8 bytes>?=`.
A `method` or protocol version that cannot be a header line is left out, since neither has that form, and the server's `-32020` names it.
A body that is not one JSON object (an unresolved `{{token}}`) derives only `Accept` and `MCP-Protocol-Version`.
A correlation id cannot be configured under any of these names (`correlationIdHeader`).

**The constant `id` under concurrency** (#3832).
Every bare call is stamped `"id":1`, so a load run sends the same id on every request.
Under a stateless Streamable HTTP transport (a fresh transport per POST) each POST is its own exchange, so the id only pairs a reply to its request on that connection; the stamping stays constant (a replay sends the same bytes) and no per-VU id exists.
A server that keys a cache or a rate limit on the id is the case this does not cover, and would show as a run whose latency collapses.
A call carrying `params._meta."io.modelcontextprotocol/protocolVersion"` (`"2025-11-25"`, say) has the derived `MCP-Protocol-Version` header follow it; the revision does not touch the id.

**`mcpTool`** is the tool a `tools/call` body calls, stored inside the body object, so it needs no column and a `PUT` that leaves `body` out keeps it:

```json
{
  "mode": "mcp",
  "content": "{\"method\":\"tools/call\",\"params\":{\"name\":\"execute_sql\",\"arguments\":{\"region\":\"us-west1\"}}}",
  "mcpTool": {
    "name": "execute_sql",
    "inputSchema": { "type": "object", "properties": {
      "region": { "type": "string", "x-mcp-header": "Region" } } }
  }
}
```

Each property reached from `inputSchema` through `properties` keys alone that carries `x-mcp-header` mirrors the argument at the same path in `params.arguments` as `Mcp-Param-<value>`: a string as written, an integer, number or boolean as JSON spells it; a `null`, absent, object or array argument sends no header.
Mirroring needs `params.name` to equal `mcpTool.name`; without a stored `mcpTool`, no `Mcp-Param-*` header is sent.
`name` must be a non-empty string, `inputSchema` (optional) an object, and every annotation a header-name token unique without regard to case: anything else is a `400` where it is written (`POST`/`PUT /requests`, `POST /import/apply`) and where it is sent.
A body of another mode keeps an `mcpTool` it carries unread.
An `outputSchema` member (#3806) is stored with the tool and never read by a send: the builder reads it to prefill an `assert.jsonschema` element.
An `x-vayu-request` export carries it and its import reads it back; a Postman export cannot carry it (counted under `mcp_bodies`).

## The `mcp` reply

A server answers with one JSON object or with a request-scoped `text/event-stream` whose progress and log notifications come before the final response.
The **reply reader** (`vayu::http::read_mcp_reply`, `http/mcp_reply.hpp`) finds that final response once, where each driver hands its response on: Send (buffered or streamed), a collection run's steps, and both load-run shapes.
Two paths are not read and keep the raw reply: a collection run's OpenAPI response validation (`validate_step_response` in `scenario_runner.cpp`), which checks the body as it arrived, and `pm.sendRequest`, which has no `mcp` body mode: a call it sends to an MCP server is a `raw` body, and its response is the raw reply with no `mcp` member and no failure class.
For a JSON reply it is the body.
For an event stream it is the last `message` event whose `data` is a JSON-RPC response (a `result` or `error` member) carrying the request's `id`: the envelope's own, else the constant `1` a bare call is stamped with.
A `stream: false` request answered with an event stream is read from its buffered bytes by the same rule; a streamed one is read from its events as they arrive, so an event cut at `sseMaxEventBytes` cannot be read, and the failure says so.

**What reads it.**
The element pipeline reads the final response in place of the body, so `assert.jsonpath`, `assert.jsonschema`, `assert.snapshot`, `assert.contains`, `assert.size`, `extract.json`, `extract.regex` and `extract.boundary` address `$.result.content[0].text` whatever shape the reply took;
an `assert.jsonschema` with `source: "jsonpath"` and `path: "$.result.structuredContent"` holds a tool's structured result to a JSON Schema, and an `assert.snapshot` holds the answer to `tools/list`, `resources/list` or `prompts/list` to a recorded baseline.
Everything else keeps the raw reply: the stored and live `body`, `pm.response.text()` and `json()`, `pm.response.events` and the Events view.
A reply with no final response leaves the elements the raw body.

**Failure classes.**
A failed reply carries one of three stable wire names:

| `errorClass` | When |
|---|---|
| `transport` | the transfer failed (no reply); a non-2xx status with no JSON-RPC error; a 2xx with no JSON-RPC response; an event stream a cap or the server's close ended before the final response |
| `protocol` | the final response carries an `error` member, whatever the status (`-32020` header mismatch, `-32022` version refusal, `-32600` and the rest) |
| `tool` | the call succeeded and `result.isError` is `true` |

A JSON-RPC notification (an envelope with no `id`) expects no response, so a 2xx with none is a success.
Two messages name an era mismatch without retrying or falling back, since a retry hides the mismatch from a regression test and doubles a load run's traffic: a `-32022` that lists `error.data.supported` reads `server supports 2025-11-25, 2025-06-18; this request is 2026-07-28`, and a `400` with no JSON-RPC error says the server looks legacy-era and to send an explicit `initialize` request first.

A `401` or `403` whose `WWW-Authenticate` is a `Bearer` challenge with `error="insufficient_scope"` (RFC 6750 section 3.1) stays `transport` and names what the token lacks (#3795): `insufficient_scope: needs "db:read db:write"` from the challenge's `scope`, or `insufficient_scope: the token lacks a scope the server did not name` when it gives none.
The challenge is read by `classify_bearer_challenge`, the classifier behind [`POST /oauth2/step-up`](authentication.md#post-oauth2step-up); the run never retries, refreshes or re-authorizes, and its status counts are the ones the `403` always had.
A collection run carries the message as the step's error; a load run counts the `403` as a status, not an error (an error record would move it to status 0), so the message is on the kept trace's `mcp` node (the status exemplars, the sample and the slow ones), not in the run's error list.
`invalid_token`, any other challenge and a refusal with no `WWW-Authenticate` keep `HTTP <status> with no JSON-RPC response` (`HTTP <status> answered with a JSON-RPC result` when the body is a result).
A JSON-RPC `error` body is the server's own answer and stays `protocol`.

A failed class **fails the step as a failed assertion does**, with or without an element on it: the exchange gains a failed test named `MCP reply`, whose error is `<errorClass> failure: <message>`.
A collection run's step is `failed`, and a scenario load run's step execution is `failed` too.
A failed transfer is not given that test, since it already fails its step as an error.

**Where it is reported.**
An `mcp` request's response carries `mcp`, on the live `POST /execute` answer and on the stored trace's `response` node alike: `{}` for a reply that succeeded, `{ "errorClass", "code"?, "message" }` for one that failed, `code` being the JSON-RPC `error.code` when there was one.
Absent for every other body mode.
Scripts read the same object as `pm.response.mcp` ([scripting](../scripting/response.md#pmresponsemcp---an-mcp-replys-failure-class)).

**Under load** a failed reply whose status reads as a success (2xx, 3xx) is recorded as an error of the run under the error type `mcp_transport`, `mcp_protocol` or `mcp_tool` (`error_types` in the summary, `error_type` on the stored error record, which also carries the `mcp` node), and in a scenario run as its step's `httpErrors` too.
Like every completion recorded with an error type, it is bucketed under status `0` in the status distribution.
A failed reply under a `4xx` or `5xx` is an error by its status already and is counted once, there, with no error record or error type; the cause is named instead on the trace the run keeps for that completion (a status exemplar, a sampled or a slow result), which carries the same `mcp` node, so a `-32022` refusal or a legacy-era `400` still reads as one.

**Every run counts its failed replies by class** (issue #3828), whatever their status, a failed transfer's `transport` included: the stored summary's `error_classes` and the report's [`summary.errorClasses`](runs.md#get-runsrunidreport), `{ "transport"?, "protocol"?, "tool"?, "protocolCodes"? }`, each class present only when counted and `protocolCodes` a `protocol` failure's `error.code` by code.
It is therefore a superset of the three `mcp_*` error types: a 4xx or 5xx failure has a class and no error type, and a failed transfer keeps its own error type (`timeout`, `connection_failed`, ...) beside its `transport` class.
A collection run counts the same, and buckets a failed reply under a 2xx or 3xx under status `0` as a load run does, so it is in the run's `errorRate` and its `maxErrorRatePct` budget on every run shape; the step's own row keeps the status the server sent.

## File references: `binary` bodies and file parts

Two body shapes name a file on the machine running the engine.
They carry a path, never bytes, and answer to one rule.

A **`binary`** body is one whole file:

```json
{
  "mode": "binary",
  "file": {
    "src": "/home/ada/fixtures/avatar.png",
    "fileName": "avatar.png",
    "contentType": "image/png"
  }
}
```

A **`form-data` file part** is a row with `"type": "file"`:

```json
{
  "mode": "form-data",
  "fields": [
    { "key": "caption", "value": "my avatar", "enabled": true },
    {
      "key": "avatar",
      "type": "file",
      "src": "/home/ada/portrait.png",
      "fileName": "profile.png",
      "contentType": "image/png",
      "enabled": true
    }
  ]
}
```

| Member | Meaning |
|---|---|
| `type` | Form rows only: `"text"` (default) or `"file"`. Any other value is a `400`. |
| `src` | Absolute path of the file. Required. |
| `fileName` | The name the file goes by. Defaults to the basename of `src`. |
| `contentType` | A binary body's Content-Type tier (above); a file part's own Content-Type, else derived from its name (see Sending, below). A text part takes it too (see above). |
| `unresolved` | Read-only, derived by the engine on every read (below): `true` when `src` is a concrete path this machine would refuse. Accepted and ignored on input. |

Shape refusals (`400`):

- `mode: "binary"` without a `file` object, or a `file` object on any other mode.
  An engine older than this shape sent a binary body bodiless, which is why the workspace schema moved to version 3 with it.
- A file part in an `x-www-form-urlencoded` body - that media type's wire form is a string of pairs and has no file form.
- A `src` on a part that is not `"type": "file"`: it names a file nothing would send.

**The trust rule.**
Vayu sends a file under a folder you allowed in Settings ([Allowed folders](file-access.md#allowed-folders-file-roots)), or a file a person picked ([Picked files](file-access.md#picked-files-file-grants), #2356).
A reference is sendable when its canonical path lies under an allowed folder or equals a picked file's: containment is decided on canonical paths, component by component, so a symlink inside an allowed folder that points outside it is outside, and `/data/fixtures-old` is not under `/data/fixtures`;
a picked file is the canonical path recorded when it was picked, matched exactly, so a link re-pointed after the pick names another file and is refused.
**What a request body says about trust is ignored**: the `unresolved` member an older client sends is accepted and dropped, on `POST /execute`, `POST /runs`, `POST /compose` and every write, so no caller can claim a file was chosen.
A path composition or a data row fills in is held to the same rule as a literal one.
**Scripts can never choose a path**: the residual pass after the pre-request script resolves a reference's `fileName` and `contentType` but never `src`.

**`unresolved` is derived on read.**
No stored body carries the key: the request writes (`POST`/`PUT /requests`, `POST /import/apply`, `POST /specs/sync`) and a run's `configSnapshot` drop it, and the [schema version 6 migration](../db-schema/startup-and-recovery.md#the-file-grants-migration-schema-version-6) removed it from every body stored before.
Every read that hands a body to an editor writes it back as the engine's answer for this machine now: `GET /requests`, `GET /requests/:id`, the `POST`/`PUT /requests` responses, `POST /reorder`'s request rows, `GET /runs/:id`'s `configSnapshot.body` and `POST /import/parse`.
`true` means a concrete path that is neither under an allowed folder nor picked, which the send would refuse; `false` means an allowed path or one still holding `{{` (decided after composition).
A reference with no path carries no `unresolved` at all.

Every enabled reference is checked, in this order, and the first failure refuses the send:

1. `src` is empty: `"Body file has no file selected - ..."` (a part: `"Form field 'avatar' has no file selected - ..."`).
2. `src` still holds `{{`: an unresolved variable.
3. The file does not exist or cannot be read: `"...: cannot read file '<path>' (<reason>)"`.
4. Untrusted: `"Body file '<path>' was not picked on this machine and is not under an allowed folder - pick it again in the request, or allow its folder in Settings › Files"`.
5. Not a regular file (a directory, a FIFO, `/dev/zero`): refused.
6. It cannot be opened: refused, naming the path and the reason.

On `POST /execute` a refusal is the pre-send gate's shape: `200` with `statusCode: 0`, `errorCode: UNSENDABLE_FILE` (#3693; a trace stored before it reads `INTERNAL_ERROR`) and the message above in `errorMessage`.
A streaming execute (`stream: true`) has no response to carry the code, so it answers `400` with the rule code `unsendable_file`, which the app shows as `UNSENDABLE_FILE` (`responseCodeOfFailure`, `execute-mapping.ts`).
`POST /runs` checks every file the run can send before the run row exists and answers `400` with code `unsendable_file`; for a path a data row binds, each distinct bound path is checked and the message starts with `data row N:` (a scenario's with `Step N ('name'):` too).
A path that changes per iteration in a way no row explains (an identity or generator token) cannot be checked ahead and is refused per submission.

**Sending.**
The check runs **once per send** and **once per run**, never per transfer.
It opens the file it approved, on the path the check resolved and without following a final symlink, and everything after reads that open file, never the path again: a link re-pointed or a file replaced at the path after the check, or between a run's iterations, is not what is sent.
A **binary body** of at most 4 MiB is read through it in that pass and its bytes are shared by every transfer of the run; a larger one is hashed through it in that pass and every transfer streams from it (`Content-Length` from the size the open saw; a redirect rewinds it).
A **form part's** file is read from it by every transfer of the send or run.
A path a data row binds is the exception: it is checked when the run starts but opened per submission, through the same check again, so a large data file holds no file open per row.
A streamed body's or a part's length is the one the open saw; a file truncated below it under the open handle fails the transfer.
**What the open does not cover.**
`O_NOFOLLOW` covers the last path component only, so a parent directory swapped for a link between the canonicalisation and the open is followed.
Windows opens the canonical path following a final reparse point, because a cloud placeholder is one.
A data-bound path's recorded `size` and `sha256` are the plan's read, while each request streams what its own open finds.
A part with no declared Content-Type is typed by its filename's extension, then its path's, from libcurl's table (`gif`, `jpg`, `jpeg`, `png`, `svg`, `txt`, `htm`, `html`, `pdf`, `xml`), else `application/octet-stream`.
A **disabled** file part is neither checked nor sent.

**What a record keeps.**
A view of a request never carries a file's bytes: the raw-request view shows `<file avatar.png, 1234 bytes>` in their place.
A binary body's send records `bodyFile: {fileName, size, sha256}` (`sha256` lowercase hex; `size` and `sha256` absent when the send was refused before the file was read) - never the path:

| Where | JSON path |
|---|---|
| `POST /execute` response | `bodyFile` (top level) |
| A design send's or a collection run step's stored trace (`GET /runs/:id`, `result.trace`; `GET /runs/:id/results`) | `trace.request.bodyFile` |
| A single-request load run | `config_snapshot.bodyFile`, echoed by `GET /runs/:id/report` as `metadata.bodyFile` |
| A scenario run's steps | `config_snapshot.scenario.steps[i].bodyFile` (absent for a step whose path a data row binds) |

The older mode spellings `form` (for `x-www-form-urlencoded`) and `formdata` (for `form-data`) are still accepted on input; responses always use the long names.
