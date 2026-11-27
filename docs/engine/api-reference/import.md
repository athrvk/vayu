---
description: >-
  The import routes: fetch a document, parse it, import it and apply a reviewed plan.
---

# Import

## POST /import/fetch

Fetch a remote collection or spec by URL, server-side, so the app can import a resource that browser CORS would otherwise block.
The engine proxies the `GET` via libcurl and returns the raw body and content type.

**Request:**
```json
{ "url": "https://example.com/collection.json", "maxBytes": 10485760 }
```

The `url` must be a string whose scheme is `http` or `https`, in any case (see [URL schemes](compose.md#url-schemes)).

**`maxBytes` is the caller's bound on the response, and the caller states it** because this route is one proxy for *every* import format - a Postman or Insomnia export rides it exactly as an OpenAPI document does.
Bounding it by `maxSpecDocumentBytes` would refuse a collection that imports today with a message naming a setting that governs nothing about it, so the callers that *are* fetching a spec (`$ref` bundling and spec re-fetch) pass that live cap themselves and the rest pass nothing.

- Absent or `null` means the engine's **transport ceiling**, 256 MiB.
  So does a larger value: a bound over the ceiling is clamped to it rather than refused, because `maxSpecDocumentBytes` can be raised to 100 MiB and an import the setting allows must not be turned into a `400`.
- Anything that is not a positive integer - `0`, a negative, a string, a fraction - is a `400`.
  It is not rounded into a bound the caller did not ask for.
- The bound is on what is **read**, not on what is returned: the transfer is cut off as soon as the body grows past it, whether the server declared a length or not, so nothing buffers the whole document first.
  A declared length is what the refusal names as the size.

**A fetch is bounded by a stall, not by a total** (issue [#882](https://github.com/athrvk/vayu/issues/882)).
The 30-second `timeout_ms` every request carries would bound a download's *size* rather than its health: 10 MB needs better than 340 KB/s merely to arrive, and a transfer that had never once stopped would fail with `Operation timed out ... bytes received`.
So this route is abandoned only after `constants::import_fetch::STALL_TIMEOUT_MS` below `STALL_FLOOR_BYTES_PER_SEC` - so a slow link finishes, slowly, and a dead one still ends.
What bounds a transfer that never ends at all is `maxBytes` above.
Connecting is bounded apart from the stall, at the stall window capped at 30 seconds (issue #2835): the stall window only runs once a connection is made, so a host that never completes the handshake would otherwise hold the fetch for libcurl's 300-second default.
Both forms of the route get this: a document must not arrive on one and time out on the other.

**`reference: true` marks a fetch a document asked for, not a person** (issue [#2364](https://github.com/athrvk/vayu/issues/2364)): `$ref` bundling sends it, with `sourceUrl` set to the URL of the document the reference was found in.
A URL typed into the import dialog or a spec re-fetch sends neither field and is fetched exactly as before, loopback and redirects included.

```json
{ "url": "http://localhost:3000/schemas/pet.json", "maxBytes": 10485760,
  "reference": true, "sourceUrl": "http://localhost:3000/openapi.yaml" }
```

- `reference` is a boolean, default `false`; `sourceUrl` is an `http` or `https` URL.
  Absent or `null` means the default for either; any other shape is a `400`, and a malformed `sourceUrl` is refused even without `reference`.
- **No redirect is followed.**
  A `3xx` is the upstream's answer and is refused as every non-`2xx` one is (`502` `The server answered HTTP 302`): a hop is a target the document never named.
- **A loopback or link-local peer is refused unless it is the source's own.**
  Judged on the address libcurl connected to, so a name that resolves there (`localhost`, `*.localhost`, a DNS record pointing at `127.0.0.1`) is caught as surely as a literal.
  Refused: `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`, the unspecified `0.0.0.0` and `::`, `169.254.0.0/16` (cloud metadata lives there), `::ffff:169.254.0.0/112` and `fe80::/10`.
  Allowed: a peer on `sourceUrl`'s port (its scheme default when it names none) when either the source host is itself loopback (`localhost`, `*.localhost` or a loopback address) and the peer is loopback, or the source host is the peer's address written as a literal - the only way a link-local peer is ever the source's.
  A source named by a host name that resolves to loopback earns nothing: that is what a rebinding DNS answer looks like.
  With no `sourceUrl`, every loopback and link-local peer is refused.
- The refusal is `502` `Couldn't fetch the document: Cannot send this request: Vayu does not fetch a reference from a loopback or link-local address other than its source document's own host and port - not when the URL names one and not when a host name resolves to one`, on both forms of the route.
  With no `sourceUrl` there is no source to except, and the sentence after the colon is `Vayu does not send it to a loopback or link-local address - not when the URL names one and not when a host name resolves to one`.
- **The URL is judged before anything is dialled**, by the same source rule: a reference whose host names a loopback or link-local address in any spelling, `localhost` or a `*.localhost` name is refused with the same `502`, and the source's own host and port stay allowed (issue [#2605](https://github.com/athrvk/vayu/issues/2605)).
- **A proxy you configured is not refused.**
  With a proxy in force the connected peer is the proxy, so the rule passes the one the transport names (`manual`, or `system` when it resolved one; matched on its address and port, a `localhost` proxy URL meeting any loopback address) and the URL check above is what judges the reference.
  Behind a proxy the engine cannot see where the proxy sends the request next, so a host *name* the proxy resolves to loopback is the proxy's to answer.
  A proxy URL with no port is dialled on libcurl's proxy default, `1080` (`443` for an `https` proxy).
- **`environment` mode stays uncovered**, as does `system` when it resolved nothing and falls back to it.
  There libcurl reads the proxy from the process environment (`http_proxy`, `https_proxy`) and the engine never learns it, so a proxy on loopback picked up that way is still refused for every reference unless it is the source's host and port.
  Set it as `manual` to fetch references through it.
- Vayu's own engine and MCP ports stay refused whatever the source ([Reserved local ports](compose.md#reserved-local-ports)); this rule is added to that one, never in place of it.

**Response:** `200`
```json
{
  "content": "...raw response body...",
  "contentType": "application/json"
}
```

`contentType` echoes the fetched response's `Content-Type` header, defaulting to `application/octet-stream` when absent.
The response JSON is serialized with invalid UTF-8 replaced rather than throwing, so binary or malformed content can never turn into a `500`.

**Errors:**
- `400` `Invalid JSON: <parser message>` - the request body did not parse; `request body is nested deeper than 128 levels` when it nests past the bound.
- `400` `Invalid URL` - `url` is missing, not a string, or names no scheme.
- `400` `Invalid URL: scheme '<scheme>' is not supported - only http and https URLs can be sent` - `url` names any other scheme (`ftp`, `file`, ...).
- `400` `Invalid 'maxBytes': must be a positive integer`.
- `400` `Invalid 'reference': must be a boolean`.
- `400` `Invalid 'sourceUrl': must be an http or https URL` - also a URL that names no host.
- `413` `Refused to fetch: <detail>` - the response was over the bound in force.
  The detail names the bound that was applied (the clamped one, not the one asked for) and the size when the upstream declared one.
- `502` `Couldn't fetch the document: <detail>` - the upstream request failed (connection error, transport failure), or a reference's peer was refused (see `reference` above).
- `502` `The server answered HTTP <status>` - the upstream answered, but with a status outside `2xx`.
  Its body is not the document, so it is not returned as `content`: handed on, a `404` or `500` page would reach the format reader and be reported as an unrecognised format.

**With `Accept: text/event-stream` the same fetch answers as a stream** (issue [#882](https://github.com/athrvk/vayu/issues/882)), reporting the download as it arrives.
An 8 MB spec behind a URL is otherwise a client with nothing to draw: the buffered form above cannot say a word until libcurl holds the entire body, and the wait is on the *upstream* download, so no amount of streaming between engine and client would help.

Three events, and the last one is always terminal:

| Event | Data | Meaning |
|-------|------|---------|
| `progress` | `{"received": 262144, "total": 8388608}` | Bytes buffered so far. `total` is the upstream's `Content-Length` and is **null** when it declared none - a chunked response has no denominator, so a client shows bytes received rather than a percentage of a number nobody stated. |
| `result` | `{"content": "...", "contentType": "application/json"}` | Exactly what the buffered form returns. |
| `error` | `{"status": 413, "error": {"code": "error", "message": "..."}}` | The failure the buffered form would have answered with. |

- **A malformed request is still the `400` above**, on both forms: it is decided before any of the response has gone out, while a status is still available to say it with.
- **A failed fetch is an `error` event, not a status.**
  The response headers left before the download began, so the `200` is already spent - which is why that event carries the numeric `status` itself.
  The standard error body could not: its `code` is a slug, and `413` and `404` both slug to plain `error`.
- Progress is throttled to at most one frame per 256 KiB or 100 ms (`constants::import_fetch::PROGRESS_EVERY_BYTES` / `_MS`). libcurl reports every ~16 KiB write, which for a 10 MB document is ~640 frames for a bar with a few hundred pixels to cross.
- **Closing the stream stops the download.**
  The engine abandons the transfer as soon as a write to the SSE sink fails, rather than reading the remaining megabytes for a client that has gone.
- Every caller that sends no `Accept` gets the buffered JSON unchanged, which is what `$ref` bundling, spec re-fetch and the MCP tools do.

## POST /import/parse

Parse a raw import document into the tree [`POST /import/apply`](#post-importapply) persists (issue [#877](https://github.com/athrvk/vayu/issues/877)).
Reads only - nothing is stored, so a preview costs no write.

**Every format Vayu accepts, detected by content**, in a fixed order, so a document carrying two formats' keys is always claimed by the same one:

| Claimed by | `meta.format` |
|------------|---------------|
| `info.schema` naming `v2.1.0` | `Postman Collection v2.1` |
| `info.schema` naming `v2.0.0`, or `info` + `item[]` with no `schema` | `Postman Collection v2.0` |
| `_postman_variable_scope: "environment"` + `values[]` | `Postman Environment` |
| `_postman_variable_scope: "globals"` + `values[]` | `Postman Globals` |
| `_type: "export"` + `__export_format: 4` | `Insomnia Export v4` |
| `type: collection.insomnia.rest/5.x` or `environment.insomnia.rest/5.x` | `Insomnia Export v5` |
| `openapi` starting `3.1` | `OpenAPI 3.1` |
| `openapi` starting `3.` (any other 3.x) | `OpenAPI 3.0` |
| `swagger` being `2.0` (string or number) | `OpenAPI 2.0 (Swagger)` |
| the raw text contains `<jmeterTestPlan` | `JMeter <version> Test Plan` |

The bytes are read once, JSON first and YAML second, through the same `core::read_document` behind [`POST /specs`](specs.md#post-specs) and [`POST /specs/describe`](specs.md#post-specsdescribe).
**This is the only parser**: the renderer holds none, which is what makes "exactly one reader has an opinion about a document" true rather than nearly true.
JMeter's `.jmx` is the one exception to "read once through `read_document`": it is XML, checked on the raw text (issue #1518, `is_jmeter_document`) before that reader ever runs, since XML fails both of its formats the same way genuinely unrecognised bytes do - see `docs/app/import-collections/jmeter.md` for the class mapping.

**Insomnia v5** (issue [#2119](https://github.com/athrvk/vayu/issues/2119)) is the YAML document Insomnia 11 and later export, one per collection or environment.
It is read through the v4 mapping: the nested `collection[]` tree (a `children` array makes a folder) and the `environments` object with its `subEnvironments[]` are flattened into v4's resource list, so both versions of one workspace import as the same tree and only `meta.format` tells them apart.
An `environment.insomnia.rest/5.x` document imports environments only, under `importEnvironments` like a Postman environment export; with no sub-environment its one environment is named after the document.
A gRPC or WebSocket item is counted in `meta.skipped` as `grpc` / `websocket`, as in v4, and `cookieJar` and `certificates` are not imported.
The member spellings are those of Insomnia's v5 schema; a member spelled otherwise reads as absent.

**Variable names are trimmed (#3251).**
`{{ name }}` looks a variable up trimmed, and the write routes refuse a stored name that is blank or differs from its trim ([Accepted field shapes](resource-writes.md#accepted-field-shapes)).
The parse therefore trims every variable name it reads (Postman `variable[]` and `values[]`, an Insomnia environment's `data` keys, a dotted nested name as a whole) and skips a row whose name trims to nothing, uncounted, as an empty name always was.
Two names that trim alike collide and the later row wins, as exact duplicates do.
An `x-vayu-collection` / `x-vayu-folder` `variables` object carrying such a name is an invalid extension piece (`vayu_extension_invalid`) and the standard reading stands.
`POST /import` writes the parsed globals through the same trimmed names.
A hand-built `POST /import/apply` tree is not repaired: a padded name in it is the same `400`, and the whole atomic apply fails.

**A Postman variable carries its file position as `createdAt` (#3252).**
A stored variables object keeps its keys in name order, and the app lists a scope by `createdAt` ([VariableValue shape](../db-schema/indexes.md#variablevalue-shape)), so every row of a Postman `variable[]` or `values[]` is stamped with one clock reading per parse plus its position in the array: strictly ascending in the file's order, in epoch milliseconds.

**Request:**
```json
{
  "content": "{\"info\": {...}, \"item\": [...]}",
  "importEnvironments": true,
  "importScripts": true,
  "fileName": "collection.json",
  "sourceUrl": "https://acme.dev/openapi.json",
  "unresolvedRefs": 0
}
```

| Field | Type | Notes |
|-------|------|-------|
| `content` | string, **required** | The document, verbatim. An OpenAPI import stores exactly these bytes as its spec document, so it is never re-serialized. |
| `importEnvironments` | bool, default `true` | Off, the environments and global variables a document carries are not built and the counts report `0` - gated at parse time, so a preview shows what will actually be created. |
| `importScripts` | bool, default `true` | Off, every script imports empty. |
| `fileName` | string | Display only; echoed on `meta.fileName`. Never stored. |
| `sourceUrl` | string | Recorded on a stored OpenAPI document (so a later sync knows what to re-fetch) and is used to resolve a relative `servers[0].url`. |
| `unresolvedRefs` | int ≥ 0 | External `$ref`s a bundling pass could not reach, counted into `meta.skipped` as `external_ref`. Nothing here follows a ref. |

**Response:** `200` - the whole import tree.
```json
{
  "collections": [ { "name": "Sample API", "description": "", "variables": {}, "auth": {"mode":"none"},
                     "elements": [], "children": [], "requests": [] } ],
  "environments": [],
  "globals": {},
  "clientCertificates": [],
  "meta": {
    "format": "Postman Collection v2.1", "requestCount": 2, "folderCount": 1,
    "environmentCount": 0, "globalCount": 0, "exampleCount": 0,
    "skipped": [ { "kind": "unsupported_auth", "count": 1, "requests": ["Get user"] } ],
    "nonExecutableAuth": 0, "unattachedFileParts": 0,
    "unsupportedScriptApis": [ { "request": "Sign in", "names": ["require()", "cheerio"] } ]
  }
}
```

**`meta.unsupportedScriptApis`** (Postman only, issue [#2576](https://github.com/athrvk/vayu/issues/2576)) is `[{request, names}]`:
each request, folder or collection (by its name) whose imported scripts use a Postman script API Vayu does not run, and which ones -
`require()` of a module off the `crypto-js` / `uuid` / `lodash` / `moment` / `csv-parse/lib/sync` / `xml2js` / `chai` / `ajv` / `tv4` shelf, `script.packages`, a bundled library such as `cheerio`, a host global such as `fetch` or `URL`,
an undefined `pm.*` member such as `pm.cookies.set`, a console method such as `console.debug`, and the other rows of the table in `engine/src/core/script_api_scan.cpp` (it does not scan `process`, `window`, `document` or `alert`).
It is **absent when empty** and for every other format, is not a `meta.skipped` kind, and never changes what is imported; `docs/app/import-collections/postman.md#scripts` has the rules.

**`meta.skipped`** is one `{kind, count}` per kind the parse counted, in a fixed kind order.
**`requests`**, when present, names the requests the count applies to, in the order the walk met them: every count an OpenAPI parse takes while on an operation, Postman's per-request counters (and, for `script_unsupported`, the folder or collection that declares the script), and Insomnia's file bodies, unsupported auth types, cookie API keys, `insomnia` scripts and the resources it cannot import.
A count that belongs to the document (a second server URL, a malformed section) has none.
**`names`**, when present, names what the count dropped, never its value: `oauth2_unmapped_param`, whose `names` are the keys of the OAuth 2.0 request parameters a Postman parse did not carry, and `protocol_behavior_folder`, whose `names` are the folders or collection that declared a setting Vayu cannot apply.
A Postman parse also counts `body_on_get` (#2540), named under `requests`: a GET or HEAD whose mapped body is not empty and whose resolved `protocolProfileBehavior.disableBodyPruning` is not boolean `true`, a body Postman drops before sending and Vayu sends.
The parse maps the body as written.

**`clientCertificates`** is present, and only ever non-empty, from a Postman parse (issue [#1656](https://github.com/athrvk/vayu/issues/1656)): a `client_certificates` registry candidate resolved from a request's own `certificate`, in the same field shape `POST /client-certificates` takes (`host`, `port?`, `certPath`, `keyPath?`, `certFormat?`, `passphrase?`).
A candidate is resolved only when it would pass that route's own check - a readable PEM pair or PKCS#12 file, a literal (not `{{var}}`) host, no earlier request in this parse already claiming a different certificate for the same `(host, port)` -
so resolving one is the common case only when the collection's certificate paths are reachable from this machine, which a real-world Postman export's rarely are (its paths name files on the *exporting* machine).
Anything that does not resolve counts into `meta.skipped` as `certificate` instead of appearing here.
Every other format sends no such key.
See `docs/app/import-collections/postman.md`.

`meta.skipped` is what the document declared and Vayu cannot represent, counted per kind.
The fixed kinds, in the order they are reported (`ORDER` in `ImportTally::items()`, `engine/src/core/openapi_drafts.cpp`):

| `kind` | Counted when |
|--------|--------------|
| `websocket`, `grpc` | An Insomnia resource that is a WebSocket or gRPC request, which has no Vayu request shape |
| `api_spec` | An Insomnia design document (`api_spec` resource) |
| `unit_test` | An Insomnia unit test or unit test suite |
| `file_body` | A whole-file body (Postman `file`, Insomnia binary, an OpenAPI `application/octet-stream` or `format: binary` body), imported as a `binary` body whose file is still to choose |
| `malformed_item` | A Postman `item[]` or `event[]` entry that is not an object, or a saved response that is not an object, whose numeric `code` is not an integer from 200 to 599, whose `body` is over 1 MiB, or that comes past the request's first 100 (the request still imports) |
| `unsupported_method` | A Postman custom HTTP verb (imported as `GET`), or an OpenAPI `trace` operation (dropped; `HttpMethod` has no `TRACE`) |
| `malformed_spec` | An OpenAPI path item, `parameters` list or response whose shape the specification does not allow, stepped over so the rest of the file still imports |
| `example_no_status` | An OpenAPI response key that is neither `default` nor a status from 200 to 599 (a `2XX` wildcard, a `1xx` interim response, junk) |
| `example_no_media_type` | An OpenAPI response that documents a body (a 3.x `content` map with entries, a 2.0 `examples` map or `schema`) and yields none: no JSON type that yields one, and no declared string or text-family (`text/*`, `*/xml`, `*/html`) example, a media range (a key containing `*`) never counting; the example imports without a body (#3424) |
| `default_response` | An OpenAPI response keyed `default` - conformant, and counted as information rather than as a loss |
| `external_ref` | A `$ref` into another file that a bundling pass could not reach (the request's `unresolvedRefs`) |
| `duplicate_operation_id` | An OpenAPI `operationId` that an earlier operation already declared; the first keeps the id |
| `webhook_operations` | An operation under a 3.1 top-level `webhooks` entry: it describes a call the API makes to the user, not a request Vayu can send |
| `deprecated_operation` | An OpenAPI operation declared `deprecated: true`; the request model has no such flag, so it imports like a current one |
| `cookie_param` | An OpenAPI parameter declared `in: "cookie"`, which has no row to land in |
| `unmapped_body` | An OpenAPI `requestBody` declaring only media types with no Vayu body mode and no binary schema, one per operation |
| `unresolved_base_url` | `servers[0].url` still holds a `{variable}` with no default, or is relative and the document has no source URL; it is kept as written |
| `no_server_url` | The OpenAPI document names no server URL, so no `{{baseUrl}}` variable is created |
| `servers_dropped` | An OpenAPI 3.x document with more than one `servers` entry: only `servers[0]` becomes `{{baseUrl}}`, and the count is the entries past the first |
| `unsupported_auth` | A Postman auth block whose type the schema does not define, or an Insomnia `authentication.type` with no Vayu mode (`asap`, `netrc`) or that is not a string; either way it imports as no auth, never `inherit` (an Insomnia folder's ends the inherit walk as `noauth`) |
| `security_unmapped_or` | An OpenAPI operation whose `security` lists more than one alternative requirement; it stays `inherit` |
| `security_unmapped_and` | An OpenAPI operation whose `security` requirement names more than one scheme at once; it stays `inherit` |
| `security_unmapped_scheme` | An OpenAPI operation whose `security` names a scheme the document never declares; it stays `inherit` |
| `security_unmapped_mutualtls` | An operation's `security` names a `mutualTLS` scheme, which has no Vayu auth mode; it stays `inherit` |
| `security_unmapped_openidconnect` | An operation's `security` names an `openIdConnect` scheme, which has no Vayu auth mode; it stays `inherit` |
| `security_unmapped_type` | An operation's `security` names a scheme of any other type with no Vayu mode (an `http` scheme other than bearer or basic, or no readable `type`); it stays `inherit` |
| `security_unmapped_apikey_cookie` | An operation's `security` names an `apiKey` scheme with `in: "cookie"`; Vayu's API-key mode has only header and query placements, so it stays `inherit`. An Insomnia API key with `addTo: "cookie"` that has no place to go is the same kind: a folder's (imported as `noauth`, ending the inherit walk) or the workspace's (`none`), which have no header row to hold it, and a request's with no key name, which has no cookie to write. Folders and the workspace are unnamed |
| `apikey_cookie_header` | An Insomnia request's API key with `addTo: "cookie"`, imported as no auth plus a `Cookie: key=value` header row (merged into an enabled `Cookie` row the request already has) - a mapping the user may want to check, not a loss |
| `oauth2_dropped_field` | A Postman OAuth 2.0 block carrying a pre-fetched `accessToken` beside an explicit grant configuration; the token is not imported |
| `oauth2_state_regenerated` | A Postman OAuth 2.0 block with a fixed `state`; Vayu generates its own per authorization attempt |
| `oauth2_unmapped_param` | A Postman OAuth 2.0 extra request parameter that was not carried, its key under `names` |
| `url_without_raw` | A Postman URL object with no `raw` form, assembled from its `host`, `port` and `path` - a mapping, not a loss |
| `variable_metadata` | A Postman variable `type` with no Vayu counterpart (`"any"`, a custom string), or an environment or globals variable's `description` |
| `disabled_body` | A Postman request body whose own `disabled` is `true`; it imports as no body rather than sending what the user switched off |
| `certificate` | A Postman request's own `certificate` that did not become a registry candidate (no `cert.src` / `key.src`, an unreadable file, a `{{var}}` host, or a conflict for the same `(host, port)`), plus the candidates left unticked in the preview |
| `proxy_config` | A Postman request's own `proxy` override; there is no per-request proxy to import it into, so this count is permanent |
| `protocol_behavior` | A Postman request's `protocolProfileBehavior` setting that Vayu stores for the export but does not apply, or `host` / `content-length` in its `disabledSystemHeaders` |
| `protocol_behavior_folder` | The same, declared on a folder or the collection: counted once per declaring node, its name under `names` |
| `body_on_get` | A Postman GET or HEAD with a non-empty body whose resolved `disableBodyPruning` is not `true`: Postman does not send it, Vayu does |
| `script_unsupported` | A Postman enabled event with a `script.src`, or script text under a `listen` other than `prerequest` / `test`, which has no element to become |
| `script_unsupported_insomnia` | An Insomnia request, folder or workspace whose imported, non-blank script uses the `insomnia` object, which Vayu does not define; the script is kept and throws when it runs. Counted once per owner, only with `importScripts` on, the owner under `requests` |

Four kinds are counted but are not in that order, so they come after it, in first-encountered order:
`elements_invalid` (an `elements` array, from a document a Vayu export wrote, that fails the element registry's validation and is not applied), `mock_example_missing` (a stored mock setting that names an example the document does not carry),
`vayu_extension_invalid` (a piece of an `x-vayu-*` extension that fails its check; the standard reading stays in place) and `unusable_tool_schema` (an MCP tool whose `inputSchema` a send refuses, the tool under `requests`; see [`POST /import/mcp`](#post-importmcp)).
Not every kind is a loss: `default_response` and `url_without_raw` count a mapping the import made rather than something it dropped (see `docs/app/import-collections/postman.md`), and so does `file_body`:
a whole-file body (Postman `file`, Insomnia binary, an OpenAPI `application/octet-stream` or `format: binary` body) imports as a `binary` body naming the file, and the count, with its `requests`, says which bodies have a file to relink or choose.
**Every file reference an import writes** - a binary body's `file`, a form-data file part - carries the path the document named, which the engine sends only once the file is picked again or lies under an allowed folder.
`POST /import/parse` answers each with the derived `unresolved` ([the trust rule](request-body.md#file-references-binary-bodies-and-file-parts)): `true` for a path this machine would refuse, so the preview can offer to allow its folder.
A reference with no path (`"src": ""`) imports as no file chosen; form parts in that state are counted in `meta.unattachedFileParts`.
An import that loses something and says nothing is the defect this list exists to prevent, so a format with nothing to report answers `[]` rather than omitting the field.
**A JMeter import's `kind` is not limited to this list** (issue #1518):
a `.jmx` class this parser has no element-kind mapping for is counted under its own literal class name (`CookieManager`, `CSVDataSet`, ...), since JMeter's own class list is open-ended - `ImportTally::items()` emits every kind it was given a count for, the enumerable ones first in the fixed order above, anything else after in first-encountered order.
A JMeter `ThreadGroup` whose threads, ramp-up, duration or loops are not the defaults is counted as `ThreadGroup_profile` (one per group), and the item's `names` lists one line per group with the values as written, e.g. `Users: 10 threads; ramp-up 5s; 3 loops`, so a client can show what to set on the load run;
a setUp or tearDown group is counted under `SetupThreadGroup` / `PostThreadGroup`, once per sampler left out (`docs/app/import-collections/jmeter.md`).
A JMeter request with both a connect and a response timeout is counted as `Timeout_total` (one per request, its name in `names`) because Vayu keeps one total timeout and adds them, and a timeout that is not a number (a `${var}`) as `HTTPSampler_timeout_unrecognised`.
`meta.folderStrategy` (`tags` / `paths` / `mixed`) is present only when an OpenAPI import built folders, since a document that declares no operation tags gets a tree it never spelled out.

**A document Vayu exported reads back as the collection it came from.**
An operation's `x-vayu-request` and the root's `x-vayu-collection` (see [`POST /specs/export`](specs.md#post-specsexport)) are applied over what the standard members produced: the request's name, method, URL, rows, body, auth, settings and saved examples, and the collection's variables, auth, data contract and whole folder tree.
With `x-vayu-collection` present the document states its own tree, so folders nest as it says, each request is filed under its `x-vayu-request.folder`, folders and requests take their stored order (below), a request with none stays on the root (no folder named after its path, and no `folderStrategy`), and the `requests` no operation could hold are created too.
A document is a file anyone can edit, so none of it is trusted: every piece is checked against what the write routes accept before it replaces anything, and a piece that fails is dropped, counted as `vayu_extension_invalid`, and leaves the standard reading in place - never a refused import.
Neither key is read on the sync/diff path, for the reason `x-vayu-elements` is not.

**A folder or request draft may state `order`**, its position among its parent's sub-folders and requests, which share one [order space](resource-writes.md#ordering) (#2535).
A Postman parse states it on every one: the item's position in its parent's `item[]`, so the collection keeps the order Postman runs it in.
A JMeter parse (#2573) states it the same way on every sampler and controller folder: its position among the parent's enabled elements in the plan's tree, one count across both kinds, which a `ThreadGroup` shares with the parent it flattens into.
An Insomnia parse, v4 or v5 (#2573), states it as each folder's and request's rank, `0..k-1`, among the parent's siblings that import, ordered by ascending `metaSortKey` (v5's `meta.sortKey`) with ties in document order; a parent where any such sibling has no numeric key states none, so its folders come first.
A Vayu-written OpenAPI document states each request's `x-vayu-request.order` and each folder's `x-vayu-collection.folders[].order`; one written before folders carried an `order` states none, and its requests then follow its folders as they did.
No other format states one.
The flattening into [`POST /import/apply`](#post-importapply) (`POST /import`, and the app's apply of a previewed parse) numbers each parent's children `0..k-1` in one sequence: by stated `order`, a draft stating none placed as though its parent listed its folders first and its requests after them, and a folder first on a tie.
The preview tree lists them in the same order.

**Errors:**
- `400` `Invalid 'content': must be the document's text`, and `400` `Invalid 'content': an empty document is not an import`.
- `400` `Unrecognised format` - readable, and no format claims it.
  Kept as its own sentence: "Vayu does not read this kind of file" and "this file is broken" are different answers.
- `400` `Couldn't read the document: <detail>` - neither JSON nor YAML, with the line named.
- `400` `Couldn't read the document: this is an Insomnia <kind> export, which Vayu does not read. Export the collection instead.` - an Insomnia document that is not a collection or an environment: `<kind>` reads `design document (spec)` for `spec.insomnia.rest/`, `mock server` for `mock.insomnia.rest/`, and the `type`'s own prefix otherwise.
  A collection or environment in a format other than 5.x gets `... this is an Insomnia collection export in format 6.0, which this version of Vayu does not read. It reads format 5.` Neither is `Unrecognised format`, so the app shows the sentence as written.
- `400` `Malformed Insomnia export: <field> must be an array` (or `an object`) - Insomnia's resource list (v4) or nested tree (v5) broken where the walk needs it, so there is nothing to walk; a v5 field is named by its path (`collection[0].children[2]`).
- `400` `Malformed JMeter test plan: <detail>` - XML pugixml could not parse, or well-formed XML with no `<jmeterTestPlan>` root.
- `400` `Invalid 'importScripts': must be a boolean` (and the same for `importEnvironments`, `fileName`, `sourceUrl`, `unresolvedRefs`).
- `413` `Import document is N bytes, over the limit of M (raise the 'maxSpecDocumentBytes' setting to allow more)`.

**Body cap (`POST /import`, `/import/parse`, `/import/document`, `/import/mcp`).**
The management API buffers a request body before a route sees it, so these four routes are bounded from the `Content-Length` header, before the body is read:
a body over `maxSpecDocumentBytes` plus half again plus 1 MiB (headroom for the JSON string escaping of the document) answers `413` `Request body is N bytes, over the limit of M for an import (raise the 'maxSpecDocumentBytes' setting to allow more)`.
The limit is read live, so a raised setting applies to the next request.
A chunked body is refused with `411` like on every route (see [Request bodies](index.md#request-bodies)).
The exact check on the `content` string described below still runs after the parse.
A client that streams a very large body may see the connection closed rather than the `413`, since the body is not read.

## POST /import/mcp

Import from a live MCP server (issue [#3838](https://github.com/athrvk/vayu/issues/3838)): ask it what it offers and answer the tree [`POST /import/parse`](#post-importparse) answers.
[`POST /import/apply`](#post-importapply) persists it unchanged and the import preview reads it as any other format.
Reads only - nothing is stored.
The app's Import dialog calls it from its MCP server tab ([MCP server import](../../app/import-collections/mcp-server.md)).

Every call to a modern-era (`2026-07-28`) server is a Streamable HTTP POST sent as an `mcp` body ([The `mcp` body](request-body.md#the-mcp-body)); a legacy-era server's session is the exception ([A legacy-era server](#a-legacy-era-server)).
The envelope, `_meta` and the derived headers are the ones a saved request sends.
The reply is read by the same reader ([The `mcp` reply](request-body.md#the-mcp-reply)), an event stream included.
In order:

1. `server/discover`, **best effort**, for the collection's name (`serverInfo.name`).
   A server that answers JSON-RPC `-32601` (a modern-era one with no `server/discover`) is read on, and the collection is named after the URL's host.
   The plain `400` with no JSON-RPC error that a legacy-era server answers with opens a session first ([A legacy-era server](#a-legacy-era-server)).
   A version refusal (`-32022`) and every other failure (a refused connection, a `401`/`403`, a `5xx`) fail the import.
2. `tools/list`, then `resources/list` and `resources/templates/list`, then `prompts/list`, each as `include` asks and each **following `nextCursor`** until a page carries none.
   A server that answers `resources/templates/list` with `-32601` lists no templates.
   Any other failure of a list call fails the import.

**Request:**
```json
{
  "url": "https://mcp.example.com/mcp",
  "headers": [{ "name": "X-Tenant", "value": "acme" }],
  "auth": { "mode": "bearer", "token": "..." },
  "include": { "tools": true, "resources": false, "prompts": false }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `url` | string, **required** | The server's endpoint, `http` or `https`, with no `user:password@` (a `400`: put credentials in `auth` or `headers`). Stored as given in the root collection's `mcpBaseUrl` variable, so a key in its query string is stored too. |
| `headers` | `[{name, value}]` or object | Sent on every call, read by the rule [`POST /execute`](execute.md#post-execute) reads them by: a name is trimmed and must be a token, a value cannot hold CR, LF or NUL. |
| `auth` | `{mode: "bearer", token}` | The shape a saved request's auth has. Written as `Authorization: Bearer <token>` (trimmed), unless `headers` already names `Authorization`, which wins. No other mode. |
| `include` | object | `tools` (default `true`), `resources` and `prompts` (default `false`), each a boolean. An unknown member, and an `include` that leaves nothing included, is a `400`. |

**Response:** `200` - `{collections, environments, globals, meta}`, the `POST /import/parse` shape, `meta.format` `MCP server`.
One root collection named after the server, holding a folder per included primitive:

| Folder | One request per | Body (`mode: "mcp"`) | Named by |
|--------|-----------------|----------------------|----------|
| `Tools` | listed tool | `{"method": "tools/call", "params": {"name": <tool>, "arguments": <sampled>}}`, plus `mcpTool` (below) | `name` |
| `Resources` | listed resource, then resource template | `{"method": "resources/read", "params": {"uri": <uri>}}`; a template's `uriTemplate` as written, with `URI template: <uriTemplate>` leading its description | `name`, else the URI |
| `Prompts` | listed prompt | `{"method": "prompts/get", "params": {"name": <prompt>, "arguments": {}}}` | `name` |

In the tree of a modern-era server every request is a `POST` to `{{mcpBaseUrl}}`, a collection variable on the root holding the `url` the import was sent, described by the entry's `description`, with the `Content-Type: application/json` row an `mcp` body carries and `inherit` auth.
The body is a bare call (no `jsonrpc` or `id`), so the engine stamps the envelope and `_meta` at send.
Each carries one element, `assert.status` with `in: [200]`; the MCP reply's own failure classes (a JSON-RPC error, a tool's `isError`) need none.
A legacy-era server's tree differs in its calls (full envelopes), its handshake and close requests and what they expect ([below](#a-legacy-era-server)).
There is no `assert.jsonschema` from a tool's `outputSchema`: that kind reads draft-07, which a 2020-12 schema can fail by construction (issue [#3763](https://github.com/athrvk/vayu/issues/3763)).

**A tool's schema (issue [#3839](https://github.com/athrvk/vayu/issues/3839)).**
A tool with an object `inputSchema` stores `mcpTool: {name, inputSchema}` in its body, so the `x-mcp-header` mirrors are derived at send ([The `mcp` body](request-body.md#the-mcp-body)); `outputSchema` is not stored.
A tool with no such schema stores `mcpTool: {name}`.
`arguments` is drawn from the `inputSchema` (`$ref` resolved against the schema itself, so `#/$defs/x` works): only the properties `required` names, each as its schema states it, in order of preference a `const`, a `default`, an `example`, an `enum`'s first member, then a typed stub (`""`, `0`, `false`, `{}`, `[]`).
These are values, not `{{variables}}`, so the generated collection runs as it stands: a name left unresolved at send is refused, and a placeholder would fail every run until it was edited.
A tool with no `required` array is called with `{}`.

A tool whose `inputSchema` a send would refuse (an `x-mcp-header` that is not a string or a header name, or one repeated) keeps its request and sampled `arguments` but gets no `mcpTool`, because `POST /import/apply` refuses a whole tree over one such body.
It is counted in `meta.skipped` as `unusable_tool_schema`, naming the tool under `requests`.
An entry with no usable identity is skipped and counted in `meta.skipped` as `malformed_item`.
That is a tool or prompt with no non-empty `name`, a resource with no `uri`, or a template with no `uriTemplate`.

**No credential reaches the tree.**
With `auth`, the root collection's auth is `{"mode": "bearer", "token": "{{mcpToken}}"}` over a secret collection variable `mcpToken` left empty, for the user to fill.
A `headers` line whose name is a credential's (`Authorization`, `Cookie`, `X-API-Key` and the rest of the set the logger redacts) is carried onto each request with its value blank and the row disabled.
The request says which header the server wanted without holding or sending it.
Every other line is carried as sent.

**Bounds.**
The server is one a user typed, so each call is held on every side (`constants::import_mcp`):
- a reply of at most 4 MiB, and 32 MiB of replies across the import;
- 20 seconds per call (an event stream a server keeps open ends there) and 120 seconds for the whole import, a call being given no more than what is left;
- no redirect followed;
- at most 100 pages per list, a list that hands back a cursor it was already sent stopped at once, and 10,000 entries across the import.

An engine shutdown cancels a call in flight.
Vayu's own engine and MCP ports are refused as on every send path ([Reserved local ports](compose.md#reserved-local-ports)); every other loopback server is reachable.
The transfer leaves through the [transport policy](health-config.md#proxy-settings).
Header and token values are never logged.

**Errors:**
- `400` `Invalid 'url': ...` (`Invalid 'url': put credentials in auth or headers, not the URL` for a URL with userinfo), `Invalid 'headers': ...`, `Invalid 'auth': ...`, `Invalid 'include': ...`, or `Body must be a JSON object`; nothing is sent.
- `413` `<method> failed: <reason>` for a reply over 4 MiB, `The server's replies came to more than 33554432 bytes, the most one import reads`, or `The server lists more than 10000 tools, resources and prompts, the most one import reads`.
- `502` `<method> failed: <reason>`, where the reason is the reply reader's own message:
  - `server supports 2025-11-25, 2025-06-18; this request is 2026-07-28` for a version refusal;
  - `insufficient_scope: needs "<scopes>"` for a `403` naming them;
  - `HTTP 400 with no JSON-RPC error: the server looks legacy-era ...` for a call the handshake did not satisfy;
  - a transfer's own error (a refused connection, a timeout, a reserved port).
- `502` `initialize answered with no result` or `initialize answered with no protocolVersion`.
- `502` `<method> answered with no '<key>' list`, `<method> repeated a cursor it had already been sent, so the list would never end`, or `<method> still had a nextCursor after 100 pages, the most one import follows`.
- `502` `The import ran past its 120000 ms total at <method>, the longest one import takes`: a timeout is a `502` here, as it is on `POST /import/fetch`.

### A legacy-era server

A server from before `server/discover` (issue [#3840](https://github.com/athrvk/vayu/issues/3840)) needs an `initialize` handshake and, usually, a session.
This is the one place an `mcp` exchange falls back: the import speaks the handshake itself, then generates it as requests the user can read and edit, so a run holds no session state the collection does not show.

The import sends, after the refused `server/discover`:

1. `initialize`, offering `2025-11-25` (the newest revision with the handshake), with empty `capabilities` and `clientInfo` `{name: "vayu", version}`.
   Its result's `protocolVersion` is the negotiated one; `serverInfo.name` names the collection.
   A failed `initialize`, one with no `result`, or one naming no `protocolVersion` fails the import.
2. `notifications/initialized`, an envelope with no `id`, which a server answers `202` with no body; any `2xx` passes.
3. The list calls above.
4. A `DELETE` ending the session, **best effort**: whatever it answers, `405` included, the import's answer is unchanged.
   It is sent when a step above failed too, so a failed import leaves no session open: one that ran past the 120 seconds, or whose reply the byte cap refused, included.
   It carries the negotiated `MCP-Protocol-Version` and has a bound of its own, 5 seconds, since what is left of the total may be none; its reply counts against no budget.

Every call after `initialize` carries `MCP-Protocol-Version: <negotiated>` and, when `initialize` answered one, `Mcp-Session-Id`.
Every call is a full JSON-RPC envelope numbered from `1`, because a session refuses an `id` it has seen, so nothing modern is stamped into it.

The tree's root then holds the handshake as its own requests, around the folders, each draft's `order` stating its place so the sidebar and a recursive run read one sequence:

| `order` | Request | Body | Expects |
|---------|---------|------|---------|
| 0 | `initialize` | `mcp`, the envelope the import sent, `id` `1` | `200`, and `extract.header` of `Mcp-Session-Id` into `mcpSessionId` (`scope: "collection"`, `required: true`) |
| 1 | `notifications/initialized` | `mcp`, `{"jsonrpc": "2.0", "method": "notifications/initialized"}` | any of `200`, `202`, `204` |
| 2.. | the `Tools`, `Resources` and `Prompts` folders | each call a full envelope, `id` from `2` in run order | `200` |
| last | `Close session`, a `DELETE` | `none` | any of `200`, `202`, `204`, `405` (a server may refuse to let a client end a session) |

`initialize` carries `MCP-Protocol-Version: 2025-11-25`; every later request carries the negotiated version and `Mcp-Session-Id: {{mcpSessionId}}` as header rows, which win over the headers the `mcp` mode derives.
`{{mcpSessionId}}` is undefined until `initialize` has run, and the session a run opened is ended by its last step: a later request sent on its own carries the name unresolved, or a closed session, and the server refuses it until `initialize` runs again.
A stateless server, whose `initialize` answers no `Mcp-Session-Id`, gets no extract, no session rows and no `DELETE`: there is no session to carry or end.
`meta.requestCount` counts the handshake's requests.
The folders are children of the root, so the tree is run with **Include nested collections** on (`recursive: true` in a scenario): a run of the root alone sends only `initialize`, `notifications/initialized` and `Close session`, and no tool.

## POST /import

Parse a document **and persist it**, in one call - `POST /import/parse`, the flattening into temp-id'd sections, and `POST /import/apply`, for a caller with no preview to show (issue [#877](https://github.com/athrvk/vayu/issues/877)).
This is what the MCP `import_document` tool wraps.
The app deliberately does not use it: a person picks which files of a batch to import and toggles two options between the parse and the apply.

**Request:** the same body as `POST /import/parse`.

**Response:** `200`
```json
{
  "idMap": { "c1": "col_<uuid>", "r1": "req_<uuid>" },
  "meta": { "format": "Postman Collection v2.1", "requestCount": 2, "...": "..." },
  "collections": 2, "requests": 2, "environments": 0, "globals": 0
}
```

**Atomicity:** the tree is one `POST /import/apply` transaction, so a refused document creates nothing.
The **globals** a Postman globals export carries are the one write outside it, and they run **last** and **merge**: `POST /globals` replaces the whole set, so running it in front of a write that can still fail would leave a user's globals half-rewritten by an import that then failed.
On a key collision the imported value wins - the caller asked for this file's variables, and skipping them would be a silent no-op - but the stored row keeps its `createdAt` (or its lack of one), so a replaced global keeps its place in the list (#3252).
A Postman import's **`clientCertificates`** candidates (issue #1656) are also outside the tree's transaction, applied best-effort inside `POST /import/apply` itself after it commits; a candidate `POST /import/apply` cannot register is skipped, never fails the call.

**Errors:** every error of `POST /import/parse`, plus every error of `POST /import/apply` (including the per-item `400`s naming a `tempId`).

## POST /import/document

Read a document's bytes (JSON or YAML) into a JSON DOM, through the engine's one reader.
Stores nothing and interprets nothing: this is what the bytes **are**, where [`POST /specs/describe`](specs.md#post-specsdescribe) says what they **declare**.

One caller, and it is the reason the route exists: the app's `ref-bundler.ts` walks a multi-file OpenAPI document to inline the files it references *before* anything is parsed or stored, and finding and rewriting those `$ref`s needs a tree.
A YAML reader in the renderer to get one was the last thing keeping a second parser in `app/src` after issue #877.

**Request:** `{"content": "openapi: 3.0.0\npaths: {}\n"}`

**Response:** `200` `{"document": { "openapi": "3.0.0", "paths": {} }}` - in the document's own key order, which is a promise a JavaScript object cannot keep (it orders integer-like keys numerically ahead of the rest).

**Errors:**
- `400` `Invalid 'content': must be the document's text`.
- `400` `Invalid 'content': <detail>` - neither JSON nor YAML.
- `413` `Document is N bytes, over the limit of M (raise the 'maxSpecDocumentBytes' setting to allow more)`.

## POST /import/apply

Persist an entire parsed import - collections, their requests, environments, and the OpenAPI documents they bind - in **one atomic call**.
Items reference each other by opaque **temp ids** the client invents; the engine generates every real id via `generate_id` and returns the translation in `idMap`.
A fifth section, **`clientCertificates`** (issue #1656), is not part of that atomic tree or its temp-id namespace - see its own bullet below.

This takes the place of ~500 sequential `POST /collections` + `POST /requests` calls for a 500-request import, and with it the only reason those endpoints would accept a client-supplied `id` - which they do not (see [The engine owns every id](resource-writes.md#the-engine-owns-every-id)).

**Request:**
```json
{
  "specs": [
    { "tempId": "s1", "content": "{\"openapi\":\"3.1.0\", ...}",
      "sourceUrl": "https://api.example.com/openapi.json" }
  ],
  "collections": [
    { "tempId": "c1", "parentTempId": null, "name": "My API", "order": 0,
      "variables": {}, "auth": {"mode":"none"},
      "openapi": {"specTempId": "s1"},
      "elements": [] },
    { "tempId": "c2", "parentTempId": "c1", "name": "Users", "order": 0 }
  ],
  "requests": [
    { "tempId": "r1", "collectionTempId": "c2", "name": "List users",
      "method": "GET", "url": "https://api.example.com/users",
      "params": [], "headers": [], "body": {"mode":"none"}, "bodyType": "none",
      "auth": {"mode":"inherit"}, "order": 0,
      "examples": [
        { "name": "200 - A user", "status": 200, "headers": [], "body": "{}",
          "contentType": "application/json" }
      ] }
  ],
  "environments": [
    { "tempId": "e1", "name": "Prod", "variables": {} }
  ],
  "clientCertificates": [
    { "host": "api.example.com", "port": 8443, "certPath": "/home/alice/certs/client.pem",
      "keyPath": "/home/alice/certs/client-key.pem", "certFormat": "pem" }
  ]
}
```

- All five sections are optional; absent or `null` means "none of that kind" (the [null-vs-absent rule](resource-writes.md#the-null-vs-absent-rule)).
  An empty payload is a `200` with an empty `idMap`.
- Every item needs a non-empty string `tempId`, **unique across the four tree sections** (they share one namespace, because `idMap` is one flat map) - `clientCertificates` items carry no `tempId` at all, see below.
  Temp ids are never stored.
- A collection's `parentTempId` and a request's `collectionTempId` must name a collection `tempId` **in the same payload**; references may point forward, so a child may appear before its parent.
  `parentTempId` is `null` (or absent) for a root.
- Every other field is the one the matching `POST /<resource>` accepts, with the same defaults and the same null rule - the engine runs the same per-resource field appliers for both paths.
  `id` is **not** accepted here: the engine owns ID generation on this path.
- `order` is optional, and a stated one is written as given.
  An omitted `order` appends after the parent's existing children and then in payload order: each row gets the next slot of its parent (the per-item default cannot do this in bulk, because none of the payload's own siblings are stored yet).
  A parent's sub-collections and requests share those slots (#2535): the sub-collections that state no `order` take them first, in payload order, and then its requests, so a request with no `order` lands after its folder's sub-collections rather than tied with the first of them.
  The roots hold collections only.
  The app's importer states every order below the roots, one sequence per parent in the order the parse placed the drafts (see [`POST /import/parse`](#post-importparse)), and deliberately omits it on its **root** collections, so an import into a non-empty workspace lands after the roots already there instead of colliding with their `0, 1, 2...`.
- A request may carry **`examples`**, an array of [saved example responses](examples.md#request-examples).
  They are nested rather than a fourth section because nothing references them: they need no `tempId`, get engine-generated ids, and so **do not appear in `idMap`**.
  Each entry takes the fields `POST /requests/:id/examples` accepts, through the same field applier, and an entry that fails validation is a per-item `400` naming the *request's* `tempId`.
  `origin` is among those fields: a spec or Postman import leaves it at its `"import"` default, which is what those rows are, and a Vayu OpenAPI export re-imported passes through the `origin` it wrote into `x-vayu-request.examples` (#2430), so a user-saved example stays `"user"`.
  An entry with no `order` takes its payload position, so the stored order is the order the source file listed the responses in.
- A **`specs`** item carries `content` (required, non-empty) and an optional `sourceUrl`; its `hash` and `fetchedAt` are engine-computed and a per-item `400` if sent, and the size cap is the same live `maxSpecDocumentBytes` that [`POST /specs`](specs.md#post-specs) enforces, through the same helper.
  Spec rows are written **before** the collections that bind them, in the same transaction.
- A collection binds a spec through **`openapi.specTempId`** (a spec in this payload, resolved through the temp-id map exactly as `collectionTempId` is) or **`openapi.specId`** (one already stored).
  Sending both is a per-item `400`, and so is either one that resolves to nothing.
  The resolved value is stored as `openapi.specId`; `specTempId` is never persisted.
  The binding's `specHash` and `syncedAt` are stamped by the engine from the document - the one this payload just wrote, or the stored one an `openapi.specId` names - so an imported collection is bound to a *version* and its runs are measured against the contract (issue #709).
  A `specHash` or `syncedAt` the item sends is dropped, never stored (issue #3348).
- A **`clientCertificates`** item is a `client_certificates` registry candidate (issue #1656), in the same field shape `POST /client-certificates` takes (`host`, `port`, `certPath`, `keyPath`, `certFormat`, `passphrase`) - `id` is refused here too.
  Unlike every other section it carries no `tempId` (nothing else in the payload references a certificate) and is applied **after** the tree's own transaction commits rather than inside it: the engine reuses `POST /client-certificates`'s own check-and-write, which takes its own lock, and taking it from inside the tree's transaction would deadlock.
  A candidate that fails that route's own checks (an unreadable file, a `(host, port)` pair another row already claims) is **skipped** rather than failing the call or naming an `item` error - the tree it does not reference has already committed by the time this section runs, and nothing in the response says which candidates landed.
  The engine registers every candidate it is sent: the app sends only the ones the user ticked in the preview, so an empty array registers nothing.
  Each registration is logged at info (`http`: host, port and certificate path, never the passphrase or the key), and a skipped candidate at warning.
  Only a Postman preview's own `clientCertificates` array (`POST /import/parse`) ever populates this; every other format sends `[]`.
- Up to **10,000 items** per call (collections + requests + environments + specs + nested examples + clientCertificates - they are rows this call allocates and writes, so they count).

**Response:** `200`
```json
{ "idMap": { "c1": "col_<uuid>", "c2": "col_<uuid>", "r1": "req_<uuid>", "e1": "env_<uuid>", "s1": "spec_<uuid>" } }
```

Every `tempId` sent appears in `idMap`.
Nested examples do not - they carry no `tempId` to map.

**Atomicity:** validation runs over the whole payload before anything is written, and the write itself is a single SQLite transaction.
A `400` therefore means **nothing was persisted** - there is no partial tree to clean up.

**Errors:** every `400` uses the standard error object, and the per-item ones add an `item` key **inside** it (the offending `tempId`) so a large import can name what broke:

```json
{ "error": { "code": "bad_request", "message": "Duplicate tempId 'c1'", "item": "c1" } }
```

Messages, by case:
- `400` `Invalid JSON: <parser message>` - the body did not parse; `request body is nested deeper than 128 levels` when it nests past the bound.
- `400` `Body must be a JSON object`.
- `400` `Invalid 'collections': must be an array` - a section was present but not an array (same for `requests` / `environments` / `specs`).
- `400` `Invalid collection at index 2: 'tempId' must be a non-empty string`.
- `400` `Invalid collection at index 0: 'id' is not accepted - the engine assigns ids; reference items by 'tempId'`.
- `400` `Duplicate tempId 'c1'`, with `item: "c1"`.
- `400` `Unknown parentTempId 'c9'`, with `item: "c2"`, and the same for `collectionTempId` - including a `collectionTempId` that names an environment rather than a collection.
- `400` `Unknown openapi.specTempId 's9'`, with `item: "c1"`, and `400` `Spec 'spec_...' does not exist` for an `openapi.specId` that resolves to no stored document.
- `400` `Cycle in parentTempId references at 'c1'`, with `item: "c2"` - a cycle (including a self-parent) in the payload's own parent graph.
  The stored-tree walk that guards `POST /collections` cannot see this one, because none of these rows exist yet, and a cycle makes cascade delete loop forever (issue #79).
- `400` `Missing required field: name`, with `item: "c1"`, and the other per-field errors of the matching `POST /<resource>`, including a wrong-typed field (`"name": 42`), which is a `400` rather than a `500`.
- `400` `'specFile' is not part of an import: it binds a file on this machine, set with PUT /collections/:id`, with `item: "c1"`, and the same for `dataFile` (issue #2765); `null` passes.
- `400` `Import too large: 10001 items exceeds the limit of 10000 per call`.
- `500` `<detail>` - the transaction itself failed; nothing was written.
