---
description: >-
  What carries over when you import a Postman Collection v2.0 or v2.1 export into Vayu - folders, variables, auth, scripts, and bodies.
---

# Postman Collection v2.1 / v2.0

Parses exported Postman Collection JSON (schema v2.1.0 and v2.0.0) into the Vayu draft model. Both versions share the same parse implementation; the only differences are detection and the shape of the `url`/`auth` objects (handled transparently by the shared helpers).

- **Source:** `engine/src/core/import_document.cpp`
- **Exports:**

> **The parse moved engine-side** (issue
> [#877](https://github.com/athrvk/vayu/issues/877)). Every rule on this page is
> the same rule it always was - the corpus in
> `engine/tests/fixtures/import-conformance.json` was recorded from the parser
> this replaced and is asserted against on every build - it is simply read by
> `engine/src/core/import_document.cpp` now, behind
> [`POST /import/parse`](../../engine/api-reference.md#post-importparse), rather
> than in the renderer. Module names in C++ style below name that file's
> functions; the app holds no parser.

  | Class | `formatName` | `formatKey` |
  |-------|--------------|-------------|
  | `PostmanV21Parser` | `Postman Collection v2.1` | `postman-v21` |
  | `PostmanV20Parser` | `Postman Collection v2.0` | `postman-v20` |

Both implement `ImportParser` (`detect` + `parse`) from `./types`.

## Detection

The factory (`core::parse_import`) parses the raw string once (JSON, then YAML fallback) and runs each parser's `detect(parsed, raw)` in registration order until one returns `true`.

| Class | `detect()` logic |
|-------|------------------|
| `PostmanV21Parser` | `parsed.info.schema` is a string **containing** `"v2.1.0"`. |
| `PostmanV20Parser` | `parsed.info.schema` is a string **containing** `"v2.0.0"`; **or** `parsed.info` is present, `parsed.item` is an array, and `schema == null` (no schema field at all → treated as v2.0). |

The match is a substring check (`schema.includes(...)`), so the full schema URL (e.g. `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`) is accepted.

**Why v2.1 is tried first:** the factory's `PARSERS` array lists `PostmanV21Parser` before `PostmanV20Parser`. v2.1 has the stricter test (exact `v2.1.0` substring), and v2.0's fallback branch is permissive (it claims any `info` + `item[]` document with no schema). Ordering v2.1 first ensures a true v2.1 file is never swallowed by v2.0's loose fallback.

## Parse flow

`parse_postman(parsed, options, format)` serves both versions:

1. Creates one `PostmanCounts` (the options, the request and folder counts, a counter per skipped kind, the client-certificate candidates, and the request names each counter grew on) threaded through the whole walk.
2. Calls `pm_folder(parsed, {}, counts)` on the **top-level collection object itself** - the root collection is just a folder whose `info` carries the collection name/description.
3. Builds `meta`, adding a `SkippedItem` for each counter that is greater than zero.

### Tree walk - `pm_folder`

`pm_folder(node, inherited, counts)` walks `node.item[]`, passing down `resolved`: `inherited` (the enclosing nodes' `protocolProfileBehavior`, merged) overlaid with the node's own - see [Redirect settings](#redirect-settings). For each `child`:

- **Folder** (`child.item` is an array) → `counts.folders += 1`, recurse via `pm_folder(child, resolved, counts)`, push into `children`.
- **Request** (`child.request` is truthy) → `pm_request_named(child, resolved, counts)`, push into `requests`.
- **Not an object at all** (`null`, a string, a number) → skipped, counting toward `malformed_item`. Hand-edited or script-filtered JSON can contain these, and the v2.0 detector's permissive fallback accepts such a file; such an entry used to fail the whole import with an error naming neither the format nor an item. `event[]` entries are filtered the same way (`pm_events`).
- Anything else (an object with no `item[]` and no `request`) is silently ignored.

Folder vs request discrimination is purely structural: **presence of an `item` array makes a node a folder**, otherwise presence of a `request` makes it a request. Nesting is bounded by the engine's reader, not by the walk: `read_document` refuses a document nested past `MAX_READ_DEPTH` (100 levels, about 50 folders) before `pm_folder` runs, so a hostile file fails with a "nests deeper" error rather than overflowing the stack.

**Document order is kept** (issue [#2535](https://github.com/athrvk/vayu/issues/2535)). Postman runs a folder's items in the order the file lists them and descends into a sub-folder where it sits, so a "Log in" request at the top of a collection runs before the folders after it. Each folder and request draft records its position among the items kept from its parent's `item[]` as `order`, and the apply numbers a parent's sub-folders and requests in that one sequence: the sidebar lists them, a recursive run visits them and an export writes them in the file's order. Postman's own `collection-v2.json` example, two requests then a folder at the root and three requests then a folder inside it, imports exactly so.

The returned `CollectionDraft` carries `name`, `description`, `variables`, `auth`, its script elements, and its `children`/`requests`. The root and every folder are built by the same function - the root is simply the outermost `pm_folder` result and becomes `collections[0]` (the only root; `parentId = null`, and no `order`, because it joins the roots already stored).

### Request build - `pm_request`

`pm_request(item, inherited, counts)` reads `item.request`, derives `url`/`params` via `pm_url`, maps auth via `map_postman_auth`, and increments `counts.requests`. Whether its auth is data-only is not decided here: it depends on the folders above the request, so `parse_postman` reads it off the finished tree (see [`nonExecutableAuth` counting](#auth-mapping)). Scripts come from `item.event[]` (`prerequest`, `test`); redirect settings come from `item.protocolProfileBehavior` resolved through its folders (see [Redirect settings](#redirect-settings)). `pm_request_named` wraps it to record which request each per-request counter grew on.

## Field mapping

### Collection (root)

The root is produced by `pm_folder(parsed, {}, counts)`; `parsed` is the whole collection object.

| Postman | Vayu `CollectionDraft` | Notes |
|---------|------------------------|-------|
| `info.name` → `name` (fallback `name` → `"Imported Collection"`) | `name` | `info.name ?? name ?? "Imported Collection"` |
| `info.description` (fallback `description`) | `description` | string used directly; if object, `.content` is used; else `""` |
| `variable[]` | `variables` | via `to_var_record` |
| `auth` | `auth` | via `collectionAuth` (see [Auth](#auth-mapping)) |
| `event[]` | `elements` | via `set_event_elements` - see [Scripts](#scripts); none when `importScripts` is false |
| nested `item[]` (folders) | `children` | recursion |
| `item[]` (requests) | `requests` | |
| an item's position in its parent's `item[]` | `order` on each folder and request draft | one count across both kinds, malformed entries skipped - see [Tree walk](#tree-walk---pm_folder) |

### Collection (folder)

Same `pm_folder` mapping. A folder node has `name`/`description`/`variable`/`auth`/`event` at the top level (no `info` wrapper), but the code reads `node.info?.name ?? node.name` and `node.info?.description ?? node.description`, so both shapes work. Each nested folder increments `counts.folders`.

### Request

| Postman (`item` / `item.request`) | Vayu `RequestDraft` | Notes |
|-----------------------------------|---------------------|-------|
| `item.name` | `name` | fallback `"Untitled"` |
| `request.description`, else `item.description` | `description` | string used directly; if object, `.content`; else `""`. The schema allows either place and generated collections use the item's; the export writes it on the request, where Postman's own export puts it |
| `request.method` | `method` | `toMethod`: upper-cased; if not one of GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS → `GET`, counted as `unsupported_method` (a custom verb such as `PROPFIND` or `PURGE`) |
| `request.url` | `url`, `params` | via `pmUrl` (see [URL handling](#url-handling)) |
| `request.header[]` | `headers` | via `map_key_values`; a row's `type` other than `"text"` (recent Postman writes `"default"`) is kept on the row for the export to write back. The v2.1 schema also allows `header` to be a **string** (the text of the headers pane); it is read as Postman's `Header.parse` reads it, line by line (`map_header_rows`): `name: value` with the value trimmed, so a Hawk `Authorization` keeps its colons; a line with no colon, with leading whitespace, or with a space before the colon (`Key : v`) names nothing and is skipped; a line continued by a following space- or tab-led one (header folding) is joined with one space; CRLF and LF both end a line. One difference: the name ends at the first colon, where Postman's `\S+` may run to the last colon of an unspaced line (`Location:http://x`). A saved response's `header` takes the same string form |
| `request.body` | `body` | via `pmBody` (see [Body mapping](#body-mapping)) |
| `request.auth` | `auth` | via `map_postman_auth`; `inherit` allowed for requests |
| `item.event[]` | `elements` | via `set_event_elements` - see [Scripts](#scripts); none when `importScripts` is false |
| `item.protocolProfileBehavior.followRedirects` (and the five like it: read from the object resolved through the folders, see [Redirect settings](#redirect-settings)) | `followRedirects` | only when it is a boolean; otherwise **absent** (engine default `true`) |
| `item.protocolProfileBehavior.maxRedirects` | `maxRedirects` | only when it is a finite number; otherwise **absent** (engine default `10`) |
| `item.protocolProfileBehavior.strictSSL` | `verifySSL` | only when it is a boolean; otherwise **absent** (engine default `true`) |
| `item.protocolProfileBehavior.disableCookies` | `disableCookies` | only when it is a boolean; otherwise **absent** (engine default `false`) - issue #1765 |
| `item.protocolProfileBehavior.disableUrlEncoding` | `disableUrlEncoding` | only when it is a boolean; otherwise **absent** (engine default `false`) |
| `item.protocolProfileBehavior.disabledSystemHeaders` | `disabledSystemHeaders` | the names set to `true`, lowercased, in source order, when it is an object |
| `item.protocolProfileBehavior` | `postmanProtocolBehavior` | the whole object as JSON text in source member order, `{}` included, for the export to write back |
| `item.response[]` | `examples` | via `pmExamples` (see [Saved responses](#saved-responses)); **absent** when the item saved none |
| `request.certificate` | `clientCertificates[]` (top-level, not a request field) | resolved into a `client_certificates` registry entry keyed on the request's own host, applied best-effort by `POST /import/apply` after the rest of the tree commits (issue #1656) - Vayu's client certificates belong to a host, not a request. A candidate is resolved only when it would pass the same check `POST /client-certificates` runs: a readable PEM pair or PKCS#12 file, a literal (not `{{var}}`) host, and no earlier request in this import already claiming a different certificate for that (host, port). Anything else counts as `certificate` instead |
| `request.proxy` | - | not imported - Vayu has no per-request proxy override, and none is planned: `TransportPolicy` is workspace/run-scoped (`engine/CLAUDE.md`), so this stays a permanent tally rather than a mapping (issue #1656's own recorded decision); counted as `proxy_config` |

### Scripts

`set_event_elements` turns every `event[]` entry into one element, in the
order the document lists them: `prerequest` becomes `script.pre`, `test`
becomes `script.post`, and the script is `join_exec` of its `exec`. Postman
runs every event of a listen in order, and Vayu runs every script element of
a phase in order, so a second `test` event is a second element (it used to be
dropped without a count) and a level that lists `test` before `prerequest`
exports back that way. An event marked `disabled: true` is one Postman's
runtime skips, so it imports as an element with `enabled: false` rather than
a script that runs. A blank script contributes nothing. A `script` that is
itself a string is the script's text, as in Postman's SDK (it used to import as
nothing).

**Scripts that cannot be imported are counted, not dropped** (issue #2541). An
enabled event whose `script.src` is set (Postman reads `src` as a URL to fetch
the script from and ignores `exec` beside it, so neither is imported) or whose
`listen` is not `prerequest` or `test` (Vayu has no phase for it) and carries
script text is counted under the `script_unsupported` kind in `meta.skipped`,
once per event. The request, folder or collection that declares it is named in
`requests`; a folder's requests come first, then the folder, then the
collection last, as with `nonExecutableAuthRequests`. A disabled event, a blank
unknown-`listen` script and every event of an import with `importScripts` off
count nothing. `script.packages` is not counted here: it is reported once, by
[`meta.unsupportedScriptApis`](#options--lossy-behavior), and that holds for an
event whose `exec` is blank too.

**Scripts that use an API Vayu does not run.** The scripts that will run are
also read for a fixed list of Postman script APIs Vayu has no implementation
of, and each request, folder or collection that uses any is named in
[`meta.unsupportedScriptApis`](#options--lossy-behavior). The list is a table in
`engine/src/core/script_api_scan.cpp` (`API_RULES`): `require(...)` of a module
that is not on [the `require` shelf](../pm-api-compatibility.md#the-require-shelf)
(`crypto-js`, the one name the scan reads from the call's string literal; a
computed name such as `require(name)` is named) and `pm.require`, a non-empty
`script.packages`, the libraries Postman bundles that the shelf does not carry
(`_`, `tv4`, `xml2Json`, `cheerio`, `moment`, `Backbone`), `Buffer`, `pm.variables.set`,
`pm.test.skip`, `pm.execution.runRequest`, and the one chai family `pm.expect` still refuses,
chai-postman's `.postmanRequest`, `.postmanResponse` and `.postmanRequestOrResponse`
(named as one row). Every other chai and chai-postman member runs, so none is named
(`engine/tests/fixtures/chai-conformance.json` is the authority, and
`script_api_scan_test.cpp` holds the table to it). `require('crypto-js')` and the
`CryptoJS` members the shim defines run (#2578), so they are not named; the rest of
crypto-js is, under the one name `CryptoJS` (`CryptoJS.AES`, `PBKDF2`, `SHA3`,
`RIPEMD160`, `algo.*`, `enc.Base64url`, `lib.WordArray.random`, a computed
`CryptoJS[name]`, ...), whether it is read off `CryptoJS`, off a name bound to it
(`const C = CryptoJS; C.AES`), off `require('crypto-js')` or through a
destructure of either (`const { AES } = CryptoJS`). The scan follows a name from
its `const`, `let` or `var` declaration on, whole-script and without scopes; a
reassignment, a second declarator of a statement and a name passed through a
parameter are not followed. The supported members are one list,
`CRYPTO_JS_MEMBERS` in `engine/include/vayu/runtime/shelf_modules.hpp`, that
`script_completions_test.cpp` holds to what the runtime defines and the editor
offers. Postman's pre-`pm.*` globals
(`tests[...]`, `responseBody`, `environment`, ...) and the `postman.*` methods
run (see [Postman's legacy globals](../pm-api-compatibility.md#postmans-legacy-globals)),
and `pm.visualizer` is accepted with a console warning (see
[Visualizer](../pm-api-compatibility.md#visualizer-pmvisualizer)), so none is
named. A row is retired in the commit that makes Vayu run the API.

The scan reads tokens, not text: comments, string and template-literal text and
regular-expression bodies are blanked first, so a name that only appears in a
comment or a string is not named, while the expressions inside a template's
`${ }` still are. A property (`x.moment`) is not the global of that name,
and a script that declares the name itself (`const moment = ...`, a parameter
named `moment`) is not reading the global. It is a notice, so it errs toward
naming too much and never toward missing a listed name. A disabled event runs nothing
and names nothing; with `importScripts` off nothing is read. The scripts are
imported either way: this never blocks or alters the import. The import
preview shows it as one amber line naming the requests and the APIs (`Sign in:
script uses APIs Vayu does not run yet (require(), moment)`), and the
import-scripts toggle is untouched.

### Saved responses

Postman stores a request's recorded responses in `item.response[]`. They were read by nothing until the engine had a table for them (issue #481), so importing a collection whose value *was* its documented responses produced a collection with none - and the loss was not even counted.

`pmExamples(item, ctx)` maps each entry to an `ExampleDraft`:

| Postman (`item.response[]` entry) | Vayu `ExampleDraft` | Notes |
|-----------------------------------|---------------------|-------|
| `name` | `name` | fallback `"Example"` |
| `code` | `status` | only when it is a finite number; otherwise `200`, which is what Postman shows for a saved response with no code |
| `header[]` | `headers` | via `map_key_values` - source order and duplicates (`Set-Cookie`) preserved |
| `body` | `body` | stored verbatim |
| `header[]` `Content-Type` | `contentType` | `""` when the recorded response carried none |
| the whole entry | `postmanResponse` | JSON text, source member order, `name` and `body` as `null` placeholders; left out when over 1 MiB |

`_postman_previewlanguage` is deliberately **not** read into `contentType`: it is an editor mode (`"json"`, `"html"`), not a media type, and storing it would put a value in that field which is not one.

`postmanResponse` keeps what no example field models - the request the response was recorded against (`originalRequest`, which usually differs per example: its own query values, headers, body and path variables), the status text as recorded, `_postman_previewlanguage` / `_postman_previewtype`, `cookie[]`, `responseTime`, and the header rows as written (`name` fields, number values) - so an export writes them back. It is stored in `request_examples.postman_response` and read only by the Postman export; nothing is lost, so nothing is counted in `meta.skipped`. An entry whose text would pass the cap is imported without it and its export regenerates those members.

An entry that is not an object counts toward `malformed_item`, the same treatment `pm_folder` gives a malformed item. A request that saved no responses omits `examples` entirely rather than sending `[]` - the orchestrator forwards presence, and an empty array reads as "this request documents no responses".

`meta.exampleCount` totals what survived, counted off the drafts by `count_examples` (the same read-the-result approach `unattached_file_parts` uses), and the import preview shows it.

### Redirect settings

Postman writes item-level `protocolProfileBehavior` exactly when the user overrides redirect, TLS, cookie, header or encoding handling for that request, so it is present precisely where it matters. `pmRedirects(item)` reads the fields Vayu stores per request and the orchestrator forwards them on `POST /import/apply`.

The three redirect and TLS fields are **optional on the draft and omitted from the payload when the source did not state them** - the engine then applies its own defaults (`followRedirects: true`, `maxRedirects: 10`, `verifySSL: true`). An absent field must not look like a stated `true`: the engine follows redirects and verifies certificates by default, so dropping a source `false` silently follows the 3xx the request exists to inspect, or trusts a host the export deliberately did not.

Values of the wrong type are ignored rather than coerced (a `"false"` string would read as the user's setting while being its opposite). A folder's or the collection's `protocolProfileBehavior` is read too (issue [#2538](https://github.com/athrvk/vayu/issues/2538)). Postman resolves it the way `postman-collection`'s `getProtocolProfileBehaviorResolved` does: the collection's object, each enclosing folder's and the request's own are merged in that order with the nearest winning, key by key and one level deep, whatever the value's type. Vayu stores these settings per request, so the import flattens that merge: `pm_folder` hands `pm_request` the object resolved so far (`inherit_protocol_behavior`), and the six settings Vayu applies (`followRedirects`, `maxRedirects`, `strictSSL`, `disableCookies`, `disableUrlEncoding`, `disabledSystemHeaders`) land on every request below the node that does not state its own. A request stating `followRedirects: true` under a folder that states `false` keeps `true`. There is no per-header merge: a request's own `disabledSystemHeaders` replaces the folder's wholesale, as in Postman (checked against Newman). The resolved values are what the request applies; `postmanProtocolBehavior` stays the request's **own** object alone, so a request with none states none. `disableBodyPruning` is resolved the same way but applies to nothing: it only decides whether a GET or HEAD body is reported (see below).


Since issue #1765 the three settings that change what Postman sends are
stored and applied per request, the same optional-on-the-draft way:
`disableCookies` (the cookie jar neither sends nor stores for the request),
`disableUrlEncoding` (path values and an api-key query sent as typed; the
query rows of such a request are joined into its URL unencoded too) and
`disabledSystemHeaders` (Postman's names set to a truthy value: `user-agent`,
`accept`, `accept-encoding` and `content-type` are refused on the wire,
`connection`, `cache-control` and `postman-token` are headers Vayu never sends
anyway). The whole object also rides along as `postmanProtocolBehavior`, JSON
text rather than an object so its member order survives the apply, and the
export writes it back.

`disabledSystemHeaders` is read the way Postman's runtime reads it, with one
deliberate difference. A value counts when it is truthy (`true`, `1`,
`"yes"`, an object), since the runtime tests `disabledHeaders[key]` in an
`if`; `false`, `0`, `""` and `null` do not. A key that is not a header name
(`"bad name"`) is left out of what the request applies rather than failing the
whole import, and still rides in the carried object. The difference: the
runtime looks each header up by its lowercase name without lowercasing the
object's keys, so an `"Accept": true` written by hand does nothing in Postman,
while Vayu lowercases the keys and honours it. Postman's own editor only ever
writes lowercase keys set to `true`, so the two agree on anything Postman
wrote.

A request is counted once as `protocol_behavior` only when its object names
something Vayu keeps for the export but does not apply: a key outside
`followRedirects`, `maxRedirects`, `strictSSL`, `disableBodyPruning`,
`disableCookies`, `disableUrlEncoding` and `disabledSystemHeaders` whose value
is not Postman's default (`false`, or an empty object or array) - a TLS option,
`insecureHTTPParser` - or `host` / `content-length` set in
`disabledSystemHeaders`, which Vayu cannot omit without breaking the request's
framing. `disableBodyPruning` is not counted as a setting: Vayu always sends a body.
It is read for a different count, `body_on_get`, below.

**A body on a GET or HEAD (`body_on_get`, issue [#2540](https://github.com/athrvk/vayu/issues/2540)).**
Postman drops the body of a GET or HEAD request before it sends, unless the resolved
`protocolProfileBehavior.disableBodyPruning` is the boolean `true`. Vayu sends whatever the Body
tab holds, so such a request goes out with a body it never had in Postman. The import counts it
as `body_on_get` and names it under `requests`; the import itself is unchanged and the body
is kept. The preview line is amber: clear the body to match Postman, or leave it on purpose. A
request is counted when all of these hold, judged on the *mapped* request:

- its method is GET or HEAD (an unsupported verb that fell back to GET is counted as
  `unsupported_method` only);
- its body is not empty: a raw body with content, a GraphQL body, a binary file with a chosen
  `src` (Postman's unselected `src: null` is not sent by Vayu either), or a urlencoded or form-data body with at least one **enabled** field. A body of mode
  `none` - including one switched off with `disabled: true` - a file body with no `src`, and a
  body whose rows are all disabled send nothing, so they are not counted;
- `disableBodyPruning` is not `true` once resolved. It is resolved through the collection and
  folders like the applied settings (`inherit_protocol_behavior`, nearest wins), so a request
  stating `false` under a folder stating `true` is counted. Only the boolean `true` opts out; a
  string or number is not Postman's opt-out either.

A GraphQL body on a GET is sent by Vayu as URL query parameters rather than a JSON body (see
[GraphQL](../graphql.md)); it is counted all the same, because Postman would send neither.

The same test runs on a folder's and on the collection's own object, with the result counted once per declaring node as `protocol_behavior_folder` (not once per request below it, and not again on those requests), with that folder's or collection's name under `names`. The preview says "folder or collection" for it where the `protocol_behavior` line says "request". The applied settings need no line: they arrive on the requests, where the Settings tab shows them.

## URL handling

`pmUrl(url)` handles both shapes:

- **String url** (v2.0, sometimes v2.1): the text is cut at its first `#` before anything else, as Postman's `Url.parse` cuts it, so a fragment never lands in a query value (`?a=b&abcd#{{search}}` is the query `a=b&abcd` and the hash `{{search}}`); the hash stays on the base URL and the join puts the query before it. With no `?`, the rest is the base URL (`normalize_template_vars` applied), `params = []`. If there is a `?`, the substring before `?` is the base and the query string goes through `queryEntries`: split on `&` and each pair on its first `=`, **never decoded** (Postman's `QueryParam.parse` does not decode either), with `value` run through `normalize_template_vars`; a missing `=` yields an empty value marked `valueless: true`, which rejoins as a bare `key` where `key=` rejoins as `key=`. All extracted params are `enabled: true`.
- **Object url** (v2.1): `url.raw` is cut at its first `#` and then at the first `?` to get the base (the fragment kept on it, as above; `url.hash` is appended as `#<hash>` only when `raw` has no `#` of its own) (`normalize_template_vars` applied); query parameters come from `url.query[]` via `map_key_values` (so disabled query params and descriptions are preserved, and a row's boolean `equals` rides on the row for the export - it does not change how the row joins into the URL; a `"value": null` or absent value is what does, stored as `valueless: true` and joined as a bare `key`). When `query[]` is absent or empty **and** `raw` carries a query string, `raw`'s query is parsed instead via the same `queryEntries` - schema-legal and produced by hand-written or script-generated collections that populate only `raw`, where the query used to be discarded silently. When `query[]` has entries it always wins, since it carries disabled state and descriptions `raw` cannot.
- **Object url with no `raw`** (schema-legal, rare - most exports always write `raw`): `host_path_url` assembles a base from `protocol` (default `https`), `host[]` (or a bare string) joined with `.`, an optional `port`, and `path[]` (string or `{value}` variable entries) joined with `/`. A `url.hash` is appended as `#<hash>`. Counted as `url_without_raw`, informational rather than lossy - the URL is built, not dropped.

**A query row holds raw query text** (issue #1771), as a Postman row does: `?q=a%2Bb` is the row `a%2Bb`, not `a+b`. Decoding first and re-encoding on the join is not lossless - `%2B` would become a `+` a server reads as a space, and `%2541` would become `%41` - so nothing is decoded and a literal `%` (`?discount=50%`, `%ZZ`) is kept byte for byte. The join (below) writes each enabled row with Postman's own query rule, `core::encode_query_component`: Postman's `QUERY_ENCODE_SET` (the C0 controls, DEL, every byte above `~` as UTF-8, space, `"`, `#`, `'`, `<`, `>`), plus `&` in a key or a value and `=` in a key. Everything else goes out as written - `+`, `|`, `/`, `?`, `:`, `[`, `]` and `%` - so an escape already in a row is never encoded twice, and a whole `{{token}}` is kept verbatim. `?q=a|b&r=c d` is stored as `?q=a|b&r=c%20d`, which is what Postman sends. An item with `disableUrlEncoding` joins its rows as written. The rule is pinned to the app's Params table by `engine/tests/fixtures/query-encoding-conformance.json`.

**Path variables (`url.variable[]`, issue #1764):** the URL keeps its `:name` segments verbatim, and each `url.variable[]` entry becomes one of the request's own Params rows marked `"in": "path"` - `key` (a v2.0 entry naming itself by `id` alone is read by that name, as Postman's `Url` does), `value` (through `normalize_template_vars`), `description`, `type` and `disabled` kept, in the order the entry lists them. A `:name` the path spells that no entry declares gets no stored row, and neither does any `:name` of a string url (v2.0), which has no `url.variable[]`: the Params tab shows an empty row for it until it is edited, and an export writes `url.variable[]` only for rows that exist, so a round trip does not add an entry the source never had. A declared entry no segment uses is kept. Which segments are path variables is Postman's own rule (`core::path_variable_segments`): a whole path segment after the authority that starts with `:`, the name running to the first `.`. Nothing is promoted to a collection variable and nothing is counted: two requests on `:id` keep their own values, and composition writes each request's value into its segment at send time (see [`POST /compose`](../../engine/api-reference.md#path-variables)).

**The split is `pmUrl`'s output, not the stored shape.** `parseImport` rejoins each request's *enabled* query params (never a path row) onto its `url` afterwards, because that is where every execution path reads the query from - see [The url/params invariant](./README.md#the-urlparams-invariant). So `{{baseUrl}}/users?page=1&trace=1` with `trace` disabled parses to base + two params here, and is stored as `{{baseUrl}}/users?page=1` with both params still in the table.

## Body mapping

`pmBody(body, ctx)` switches on `body.mode`. A missing `body` or missing `body.mode` → `{ mode: "none" }`. `body.disabled: true` ("prevent request body from being sent") is checked first and also imports as `{ mode: "none" }` regardless of `mode` - counted as `disabled_body` (issue #1444) rather than sending a body the user had turned off.

A non-empty body on a GET or HEAD is mapped like any other and additionally counted as `body_on_get` (see [Redirect settings](#redirect-settings)): Postman does not send it, Vayu does.

| Postman `body.mode` | Vayu `RequestBody` | Notes |
|---------------------|--------------------|-------|
| `raw` | `postman_raw_body(body.raw, body.options.raw.language)` | see raw sniffing below |
| `urlencoded` | `{ mode: "x-www-form-urlencoded", fields }` | `fields` = `mapKeyValues(body.urlencoded)`, a row's non-`"text"` `type` kept as on a header |
| `formdata` | `{ mode: "form-data", fields }` | text entries via `map_key_values`, a non-empty `contentType` on one kept on the field (the engine sends it as that part's own `Content-Type`, issue #2539); a `type: "file"` entry becomes a **file row** per path in `src` (a string or an array - Postman allows several files per field), which the parse answer marks `unresolved` unless this machine already allows it. A file entry naming no path becomes one file row with `src: ""` (no file chosen), counted in `meta.unattachedFileParts`. |
| `graphql` | `{ mode: "graphql", content }` | via `graphqlContent` - the graphql object is serialized to JSON with `variables` **parsed** (see below); `operationName` rides along, and the request gains a `Content-Type` (see below) |
| `file` | `{ mode: "binary", file: { src, fileName } }` | `src` is `body.file.src` as written and `fileName` its base name; `src: null` or no `file` (Postman's shape before a file is chosen) imports as `{ src: "" }`, no file chosen. Counted as `file_body`, a file reference to relink |
| anything else | `{ mode: "none" }` | |

**GraphQL `variables` (`graphqlContent`):** Postman stores `body.graphql` as `{ query, variables }` where `variables` is the *text* of the Variables pane - a JSON-encoded string. Vayu's own `serializeGraphQLBody` writes `variables` as an object, and the engine sends the stored content verbatim, so the string is parsed here; embedding it as-is put `"variables": "{\"limit\": 10}"` on the wire (spec-invalid) and showed a double-escaped blob in the Variables pane. Two deliberate fallbacks: a variables string that is **not valid JSON is kept as text** (the pane text is the only copy of the user's work, so an import that deletes it is worse than one that shows it unparsed - and the pane now shows a string-typed `variables` verbatim rather than as an escaped blob, converting it to an object once an edit makes it parse), and an **empty or whitespace-only** string drops the key entirely, which is what Vayu writes for an empty pane. Every other key on the object rides along untouched.

**GraphQL `operationName`:** preserved verbatim, like every other key on the object. It names which operation in a multi-operation document to execute, and Vayu's GraphQL panes carry it through an edit and expose it as an operation picker above the query pane - so an imported request keeps running the operation it was imported with.

**GraphQL `Content-Type` (`with_required_content_type` in `import_document.cpp`):** a GraphQL body is a JSON envelope, so the request needs `Content-Type: application/json` - and Vayu's request builder adds that header only when you *pick* GraphQL, which an import never does. The header was therefore absent, and libcurl defaults to `application/x-www-form-urlencoded`, which most GraphQL servers answer with a `400`; nothing in the app said why. The header is now written at import, by the engine's port of the rule the mode picker uses (`contentTypeToAdd`): a Content-Type the collection declares wins (including a deliberate `application/graphql`), and a **disabled** row does not count as declaring one. The row is written as the body mode's own (`"source": "body-mode"`, the marker the Body panel writes), because Postman treats a body's Content-Type as a system header: a request whose `disabledSystemHeaders` refuses `content-type` gets no row at all, and a later opt-out in Vayu removes the marked row from the wire while a Content-Type the user typed is always sent (issue #1765). The export leaves the marked row out while Postman would add the same header on its own.

**Raw language (`postman_raw_body` in `import_document.cpp`):**

| `options.raw.language` | Result |
|------------------------|--------|
| `"json"` | `{ mode: "json", content }` |
| `"text"` | `{ mode: "text", content }` |
| `"xml"` | `{ mode: "xml", content }` - and the request gains `Content-Type: application/xml` through the same `with_required_content_type` rule GraphQL uses (above) |
| `"html"`, `"javascript"` | `{ mode: "text", content, rawLanguage }` - and the request gains `Content-Type: text/html` / `application/javascript` as the body mode's own row (`"source": "body-mode"`), whatever the content looks like (HTML that happens to parse as JSON is still `text/html`) |
| any other declared language (`"yaml"`, ...) | `{ mode: "text", content, rawLanguage }`, no row: sent as `text/plain`, as Postman sends it, even when the content parses as JSON |
| absent | tries `JSON.parse(content)`; success → `{ mode: "json" }`, failure → `{ mode: "text" }` - with `rawLanguage: ""` beside it |

The language-to-type table is `LANGUAGE_CONTENT_TYPES` in `postman_format.hpp`,
beside `RAW_LANGUAGES`, and holds only the languages that need a row: `json`,
`xml` and `text` are modes the engine already sends under their own type.
The row follows the GraphQL rules: an enabled Content-Type the request
declares wins, a disabled one does not count, and a request whose
`disabledSystemHeaders` refuses `content-type` gets none.

`rawLanguage` is what the Postman export reads to write the body's `options`
back as the document had them: none at all for an unlabelled body (the common
shape in generated collections), the declared language otherwise.
`postman_raw_body` is the one mapping both directions call, so the exporter
writes a kept `rawLanguage` only while importing the body again would still
give its stored mode. The export leaves the `html` / `javascript` row out for
the same reason it leaves GraphQL's: Postman adds that header itself from the
language.

**An unlabelled body still differs from Postman.** Postman sends a body with no
declared language as `text/plain`; Vayu sniffs it, so JSON-looking content is
sent as `application/json` and the rest as `text/plain`. That is the one
place a body's wire type differs from Postman's. It is also never sniffed into `xml`:
without Postman's language, a `<`-shaped document is as likely to be HTML, and
guessing would hand the request a Content-Type the server may disagree with.

**File references are imported, never dropped.** A `file` body and every
`formdata` file entry keep the path the export named. A path names a file on
the exporting machine, so Vayu sends it only once you pick the file again in
the request, or once it lies under a folder you allowed in Settings > Files;
the parse answer marks each one this machine would refuse `unresolved`. Each `file` body is counted as
`{ kind: "file_body", count, requests }` - informational, the requests whose
body file to relink - and each file entry with no path as an
`unattachedFileParts` field to fill.

## Auth mapping

Auth is mapped by `mapPostmanAuth(auth)` (`import_document.cpp`). It reads `auth.type`, then flattens the type-specific detail via `authDetail(auth[type])`.

| Postman `auth.type` | Vayu `RequestAuth` | Notes |
|---------------------|--------------------|-------|
| (absent / no `type`) | `{ mode: "inherit" }` | |
| `bearer` | `{ mode: "bearer", token }` | `token` normalized |
| `basic` | `{ mode: "basic", username, password }` | both normalized |
| `apikey` | `{ mode: "apikey", key, value, in }` | `in` = `"query"` only if detail `in === "query"`, else `"header"` |
| `oauth2` | `{ mode: "oauth2", config: OAuth2Config }` | mapped via `map_postman_oauth2` (`import_document.cpp`) - **executable**; grant normalized. `tokenName`, when present, is stored as `config.credentialsId` - Vayu's field for keeping otherwise-identical token-cache entries apart. A block holding only a seeded `accessToken` (no grant, token URL or auth URL - commercetools writes one on every request) is what Postman sends as is, so it imports as what sends the same bytes: a bearer token, or, when `addTokenTo` is `queryParams` or `headerPrefix` is not `Bearer`, an API key (`access_token` in the query, or `Authorization: <prefix> <token>`). A seeded `accessToken` beside an explicit grant (Vayu fetches a new one through the grant) is not used when sending and is counted as `oauth2_dropped_field`, named per request; `state` (Vayu generates and validates its own per authorization attempt) is counted apart as `oauth2_state_regenerated`, because it changes nothing sent (issues #1460, #2536). Both are kept in the block's `postman` source below, so an export writes them back. The extra request parameter lists are read as described [below](#oauth-20-extra-request-parameters) |
| `awsv4` | `{ mode: "aws", config }` | `awsv4` is the schema's enum value for AWS Signature; Vayu's internal mode is `aws`, so the name is translated rather than passed through. Matching on `"aws"` here dropped every real SigV4 export to `{mode:"none"}` *and* suppressed the `nonExecutableAuth` warning. The mode is **not executed**: the request is sent without auth, and the send's `authNotice` says so ([api-reference](../../engine/api-reference.md#authentication)) |
| `digest` / `ntlm` / `hawk` / `oauth1` / `edgegrid` / `jwt` | `{ mode: type, config }` | `config` is the raw flattened detail map; **not executed** by Vayu - the request is sent without auth, and the send's `authNotice` says so (reported through `nonExecutableAuth`, as `aws` is - see [counting](#auth-mapping)). The table is `CONFIG_AUTH_TYPES` in `postman_format.hpp`, which the exporter reads too, so each exports back as its own type |
| `inherit` | `{ mode: "inherit" }` | |
| `noauth` | `{ mode: "none" }` | on a **request**; a collection/folder `noauth` is terminal - see below; this is the correct mapping, not a drop, so it is not counted |
| a type the schema does not define / non-string `type` | `{ mode: "none" }` | counted as `unsupported_auth` |

**The block itself, kept for the export (`with_postman_source`).** When the
Postman exporter would not write a request's or collection's `auth` back
exactly as the document had it - an attribute Vayu has no field for
(`tokenType`, `state`, a parameter row it does not carry), a type stored as another mode
(the seeded-token `oauth2` above), a different attribute order or attribute
`type`, `{{ x }}` spacing the importer tightened - the document's block is
stored beside the mapped auth as `postman`, in v2.1 form (a v2.0 detail object
becomes the attribute array Postman's own conversion writes). Nothing sends
it. The exporter writes it back verbatim, key order restored, while mapping it
through `map_postman_auth` again still gives the stored auth; once the auth is
edited in Vayu the block no longer describes it and the stored auth is written
instead; the engine drops it from the stored auth at that same write, so the
credential an edit replaced does not stay behind in it. Its credentials are
blanked like any other when an export leaves credentials out, including the
PKCE `code_verifier` and the credential rows (`client_secret`,
`client_assertion`, `refresh_token` and the like) of an `oauth2` block's
`tokenRequestParams`, `authRequestParams` and `refreshRequestParams`.

**`authDetail` - v2.1 array vs v2.0 object:** Postman stores auth detail either as an array of `{ key, value }` entries (v2.1) or as a plain object (v2.0). `authDetail` handles both: arrays are folded into a `{ key: value }` map (skipping entries without `key`); objects have every entry coerced to a string. The result is the same flat string map regardless of source version, so the rest of `map_postman_auth` is version-agnostic.

**Collection / folder vs request inherit rules:**

- **Requests** keep `map_postman_auth` output verbatim - `inherit` is a valid mode for a `RequestDraft` and is resolved at execution time. A request's own `noauth` becomes `{ mode: "none" }`, which already means "send nothing" for a request.
- **Collections and folders** go through `collectionAuth`, which distinguishes two states Postman keeps apart:

  | Postman collection/folder `auth` | `CollectionDraft.auth` | Inheritance |
  |---|---|---|
  | absent, or `{"type":"inherit"}` | `{ mode: "none" }` | transparent - a descendant's `inherit` keeps climbing |
  | `{"type":"noauth"}` (explicit No Auth) | `{ mode: "noauth" }` | **terminal** - descendants send no credentials |
  | any concrete type | that mode | the descendant inherits it |

  Collections never inherit (`CollectionDraft.auth` excludes `inherit`), which is why `inherit` collapses to `none`. The explicit-`noauth` case must not collapse with it: the resolution walk steps over `none`, so a request set to Inherit inside a No Auth folder used to resolve to the *root* collection's credentials - sending a bearer token to the endpoints the user had marked unauthenticated. The terminal mode is read by `resolveAuthSource` (renderer) and `composeAuth` (MCP); see [variable resolution → auth inheritance](../variable-resolution.md#auth-inheritance).

**`nonExecutableAuth` counting:** `nonExecutableAuth` counts the **requests** that go out without their auth, and the other members say where it is declared. One pass over the finished draft tree (`find_data_only_auth`) resolves each request's mode the way a send does, keyed off the *mapped* mode (so `awsv4` counts as `aws`): a request with its own mode uses it, one set to Inherit takes the nearest ancestor's concrete mode, a folder's or collection's `none` is transparent and its `noauth` is terminal. A request whose resolved mode is in `CONFIG_AUTH_TYPES` (`aws`, `digest`, `ntlm`, `hawk`, `oauth1`, `edgegrid`, `jwt`) counts and is named in `nonExecutableAuthRequests`, in document order. The folders that declare such an auth themselves are named in `nonExecutableAuthFolders` and the root collection's name is `nonExecutableAuthCollection`; neither is counted as a request, and the preview names them in a "set on ..." clause beside the request line. A request set to No Auth under a data-only folder is not counted; a request inheriting through a transparent folder is. `oauth2` is executable and never counts. Insomnia counts the same way, through the same pass (#2610; [Insomnia v4](./insomnia-v4.md#auth-mapping)).

### OAuth 2.0 extra request parameters

Postman keeps an `oauth2` block's "Advanced" parameters as three attributes,
`tokenRequestParams`, `authRequestParams` and `refreshRequestParams`, each an
array of `{key, value, enabled, send_as}` rows (`send_as` is `request_body`,
`request_url` or `request_header`; none means the body). `map_postman_oauth2`
reads them from the raw detail block, in either schema shape, in that order
(issue #2536):

- A row Postman has switched off (`enabled: false`) is not read.
- An `audience` or `resource` row of the token or authorization list sent in
  the body becomes `config.audience` / `config.resource`, which the engine
  already sends in both requests. The first such value wins; a later row of
  the same name with a different value is carried in its own list instead.
- Every other row is carried in the config list of its request, `tokenParams`,
  `authorizationParams` or `refreshParams`, as `{key, value, enabled: true,
  sendAs}` with `sendAs` `body`, `url` or `header`. An `authorizationParams`
  row stores no `sendAs`: the authorization request is a browser navigation,
  so its parameters ride in the authorize URL's query. A value is kept as
  typed, `{{ x }}` tightened as every imported value is.
- A row with no key, a `send_as` Vayu has no target for, or a key the engine
  writes itself (`grant_type`, `client_id`, `client_secret`, `code`,
  `redirect_uri`, `code_verifier`, `refresh_token`, `username`, `password`,
  `scope`, `state`, `code_challenge`, `code_challenge_method`,
  `response_type`: `RESERVED_PARAM_NAMES` in `oauth_client.hpp`) is not
  carried and is counted as `oauth2_unmapped_param`. The count names its
  requests and, under `names`, the parameter keys; a value is never recorded,
  since it can be a credential. The Preview shows it as an amber line naming
  the request and the keys. A saved `accessToken` (`oauth2_dropped_field`) is a
  muted note that the grant fetches a new token, and a regenerated `state`
  (`oauth2_state_regenerated`) is not shown: nothing sent changes.

The token cache key reads `credentialsId` and not `audience` or `resource`, so
two imported requests differing only in their audience would share one cached
token. When a block names no `tokenName`, the promoted audience (else the
resource) is stored as `config.credentialsId` to keep them apart. (A carried
row is read by the key itself, so two audiences sent as rows are two tokens
already.)

The export writes the lists back as Postman's three attributes, each row with
its `send_as` (an `authorizationParams` row as `request_url`), and
`config.audience` / `config.resource` as `request_body` rows opening
`tokenRequestParams`, where the next import promotes them from again. A
`credentialsId` equal to what the import derived is not written as a
`tokenName`, so import -> export -> import gives back the same config.

## Variables & environments

Collection- and folder-level `variable[]` arrays map to `CollectionDraft.variables` via `to_var_record`:

- entries without a `key` are skipped;
- enabled state is `!disabled` if `disabled` is set, else `enabled` if set, else `true`;
- the value is coerced to a string (`as_string`) and run through `normalize_template_vars`;
- `type: "secret"` sets `secret: true`; `"string"`, `"number"` and `"boolean"` are Vayu's own variable types and are stored as `type` (a script reads a `number` variable as a number, as in Postman); `"default"` is Postman's unset marker and stores nothing;
- a `description` is stored on the variable for the Postman export to write back (the variables editor does not show it);
- any other declared `type` (`"any"`, a custom string) has no Vayu counterpart and is dropped, counted once per row as `variable_metadata`.

Postman **collection** files do not embed environments, so this parser always returns `environments: []` and `meta.environmentCount: 0`. Postman exports environments as separate files, which [`import_document.cpp`](./postman-environment.md) reads.

## Options & lossy behavior

**`importScripts`** is honored: when `opts.importScripts` is false, `pm_request` and `pm_folder` write no script elements (the `set_event_elements` call is gated behind the flag). When true, each event's `script.exec` array is joined with `\n` by `join_exec` (or its string form is used, else `""`; a `script` that is itself a string is used as the text). `importEnvironments` is accepted but unused by this parser (no environments to import).

Not carried by design, and not counted: a collection's `info.version` and the ids Postman stamps on a collection, folder, request or event (`info._postman_id`, `item[].id`, `event[].id`, `script.id`). They identify a copy inside Postman's workspace, Vayu mints its own ids, and nothing reads them back, so there is nothing to lose that a person would finish by hand.

**`meta.skipped`** - this parser populates: `file_body` (`file`-mode bodies, imported as binary file references to relink - not a loss), `malformed_item` (non-object `item[]`/`event[]` entries), `unsupported_method` (a custom HTTP verb, falls back to `GET`), `unsupported_auth` (an auth type the schema does not define, or a non-string `type`, falls back to no auth), `oauth2_dropped_field` (a pre-fetched `accessToken` beside an explicit grant config, named per request - see [Auth mapping](#auth-mapping)), `oauth2_state_regenerated` (an oauth2 block's `state`, which Vayu regenerates per authorization attempt; nothing sent changes), `oauth2_unmapped_param` (an OAuth 2.0 extra request parameter not carried, with its key under `names` - see [OAuth 2.0 extra request parameters](#oauth-20-extra-request-parameters)), `url_without_raw` (informational - a URL shape that was mapped rather than dropped, see [URL handling](#url-handling)), `variable_metadata` (a variable `type` Vayu has no counterpart for - `"any"` or a custom string - or an environment or globals variable's `description`), `disabled_body` (a request body whose own `disabled` was `true` - see [Body mapping](#body-mapping)), `certificate` (a request's own `certificate` the engine could not resolve into a `client_certificates` registry candidate - no `cert.src`/`key.src`, an unreadable file, an unresolved `{{var}}` host, or a second, different certificate for a (host, port) an earlier request in this import already claimed; a resolvable one is applied instead, see the field table above and [issue #1656](https://github.com/athrvk/vayu/issues/1656)), `protocol_behavior` (a request's `protocolProfileBehavior` key Vayu stores but does not apply, or `host` / `content-length` in its `disabledSystemHeaders` - see [Redirect settings](#redirect-settings)), `protocol_behavior_folder` (the same, declared on a folder or the collection, counted once per declaring node with its name under `names`), `body_on_get` (a GET or HEAD request whose body is not empty and whose resolved `disableBodyPruning` is not `true`, named per request - Postman does not send that body and Vayu does, see [Redirect settings](#redirect-settings)), `proxy_config` (a request's own `proxy` override - there is no per-request proxy mechanism to import it into, and none is planned, so this tally is permanent), and `script_unsupported` (an enabled event with a `script.src`, or with script text under a `listen` other than `prerequest` / `test`, which has no element to become; one per event, with the request, folder or collection that declares it under `requests` - see [Scripts](#scripts)). It does **not** emit `websocket`, `grpc`, `api_spec`, or `unit_test` items.

**`meta.unsupportedScriptApis`** - `[{request, names}]`, present **only when non-empty** (no other importer sends it, and it is not a `meta.skipped` kind: it carries a list per subject, which `ImportTally` cannot hold). `request` is the request's name, or the folder's or collection's (`info.name`) for a script declared there; `names` are the table's spellings (`require()`, `moment`, `script.packages`, `pm.variables.set`, ...), deduplicated and in table order, across all of that subject's scripts. Entries follow the walk: a folder's requests, then the folder, then the collection last, as with `nonExecutableAuthRequests`. A request name used twice is listed twice - they are different requests. See [Scripts](#scripts).

**`meta.nonExecutableAuth`** - populated: the number of **requests** whose resolved auth mode is data-only, named in `meta.nonExecutableAuthRequests`; `meta.nonExecutableAuthFolders` (sub-folder names) and `meta.nonExecutableAuthCollection` (the root collection's name) report the declaring sites, each present only when there is one. The rule is stated once, under [`nonExecutableAuth` counting](#auth-mapping). These auths are stored on the draft (with their `config`) but Vayu has no execution path for them.

## Shared helpers used

All defined in `engine/src/core/import_document.cpp` (except `normalize_template_vars`, which is `engine/src/core/path_template.cpp`); see the [index](./README.md#shared-helpers) for full reference.

| Helper | Use in this parser |
|--------|--------------------|
| [`as_string`](./README.md#as_string) | coerce any scalar to its string form (values are stored as strings) - used inside `to_var_record`/`authDetail` |
| [`to_var_record`](./README.md#to_var_record) | collection/folder `variable[]` → `CollectionDraft.variables` |
| [`map_key_values`](./README.md#map_key_values) | `header[]`, `query[]`, `urlencoded[]`, `formdata[]` → `KeyValueEntry[]` (preserves disabled + duplicates) |
| [`map_postman_auth`](./README.md#map_postman_auth) | `auth` object → `RequestAuth` (request and, via `collectionAuth`, collection/folder) |
| `postman_raw_body` | raw-mode body → `RequestBody`: a declared language maps to its mode or to `text` (kept as `rawLanguage`), an unlabelled body is sniffed for JSON (shared with the exporter) |
| [`join_exec`](./README.md#join_exec) | `event.script.exec` → joined script string |
| [`normalize_template_vars`](./README.md#normalize_template_vars--normalize_path_templates) | rewrite `{{ x }}` / `{{ _.x }}` template syntax to Vayu `{{x}}` (`path_template.cpp`); applied to URLs, values, vars, and auth fields. Called **without** `pathTemplates`, so a literal single-brace `{x}` is left alone - in Postman only `{{x}}` is a template, and rewriting `/tags/{beta}` or `fields=friends{name}` invented a variable that resolved to nothing |

## Exporting to Postman

The way back is an export, not a parse: any collection writes out as a Postman
Collection v2.1 file, from its ⋯ menu in the sidebar (**Export as Postman
Collection**) or from the Spec tab's **Export** menu (**Postman Collection
v2.1…**). The engine assembles the document
(`POST /export/postman`) from what is stored - folders, requests, variables,
auth and scripts - and the dialog offers **Copy** or **Download**, saving
`<collection name>.postman_collection.json`. Nothing is sent anywhere, and
nothing is written: an export is a read of what the collection already is.

**Credentials stay out by default.** With **Include credentials** off, auth
secrets and variables marked secret are written empty, and so are the
credentials typed outside an auth block: a request header such as
`Authorization` or `X-Api-Key` (and the API-key auth's own header), a query
parameter such as `api_key` or `signature` in the Params rows and the URL, the
password in a URL's `user:pass@`, and on every saved example the recorded
request's headers and URL, the response's sensitive headers (a `Set-Cookie`
row in full) and the value of every cookie. The dialog says how many. Request
and response **bodies and scripts are not checked** and are written as they
are, which the dialog also says. Turn it on to write everything as stored,
which is what Postman's own export does - only for a file that stays with you.

**Saved responses come back as they were recorded.** An example imported from
Postman keeps the request it was recorded against, its status text, preview
settings, cookies and response time, and exports with them. Change its status or
headers (through the API or an MCP agent) and the export writes that change, regenerating the status text,
header rows and preview settings that described the old value. The cookies are
rebuilt only when a `Set-Cookie` header changes, so a cookie whose `Set-Cookie`
header you removed is not exported, while fixing an unrelated header keeps the
cookies as recorded; the recorded request stays as recorded.

**A response you save as an example keeps the request that produced it**
(issue #1763). *Save as example* on a response you just sent records the
request as it was when you pressed Send - method, URL, params, headers and
body, with `{{variables}}` left unresolved and auth left out - together with
the server's own status text, the response's cookies (a `Max-Age` counted from
when the response arrived) and its response time.
The export writes those back, so editing the request afterwards does not change
what the example says it was sent with. A value typed literally into a header
or the URL at Send stays in that example after you remove it from the request;
with **Include credentials** off it is exported empty, by the same name rules as
a header on the request itself, and counted. A streamed response keeps the
record too: the copy the app reloads when the stream ends is matched to the
Send that started it. An
example saved before this, or from a response the app fetched without a Send
of its own to match it to (the last run shown again after a restart, or a
response opened from History), has no such record and exports regenerated from
the request as it is at export time.

**What Postman has no place for is listed, not dropped.** Before you download,
the dialog states how many requests and folders the file carries and names each
kind of thing the export could not carry, with a count, in the engine's words.

A form-data part exports with its own `contentType` when it has one, a text
part as well as a file part.

A binary body exports as Postman's `file` mode naming the file's path
(`file.src`), as a form-data file part names its own; a file's own content type
or a file name other than its path's has no place in that mode and is listed.

An agent can ask for the same document over MCP (`export_postman`), which always
leaves credentials out.

**What an imported collection gives back as Postman wrote it.** The import
keeps, beside what Vayu uses, what the export needs to write a Postman document
back unchanged: every event in its order, a disabled one still disabled; a raw
body's declared language, or its absence (`rawLanguage`); a header's
`type: "default"` and a query row's `equals`; a request's path variables
(issue #1764), which export as the `:name` segments of `raw` and `path[]` and
their rows as `url.variable[]` (`key`, `value`, then a `type` and
`description` the import kept, and `disabled`), written after the query rows
and never into `query[]`; a variable's `string` / `number`
/ `boolean` type and its description; an item-level description; and the
document's own `auth` block whenever the mapped auth alone would not give it
back (`auth.postman`) - an `oauth2` block holding only a seeded token, the
attributes Vayu has no field for, attribute order and types, and the
Hawk, OAuth 1.0, EdgeGrid and JWT types Vayu keeps as data. Each is written
back only while it still describes what Vayu holds; after an edit in Vayu the
export writes the edit.

**What still comes back differently**, and why:

- **Method case.** A `get` or `post` typed in lower case exports upper case.
  Vayu stores the method as one of its seven verbs, and both Postman's runtime
  and Vayu's composer send it upper-cased, so the wire is the same.
- **`url.raw` is rebuilt** from the stored URL: the query rows Postman sends
  (a stale `raw` a generator left without an enabled row gains it), encoded
  by Postman's own query rule, so a reserved character (`filter[type]`, `a|b`)
  comes back as written. One difference remains. A space or non-ASCII
  character typed into `raw` comes back percent-encoded (`c%20d`), because
  Postman's `raw` holds the typed text and Vayu stores the wire form. An
  empty value comes back as `key=` and a `"value": null` row as a bare `key`,
  as Postman writes them: the row keeps the null as `valueless: true`. The
  `query[]` rows themselves come back as written, a null value as `null`.
- **Variable order** within a collection or folder follows name order, the
  order the stored variables object keeps.
- **A folder's or the collection's `protocolProfileBehavior`** is not written
  back at the level it was declared on. The import flattened its applied
  settings onto the requests below it, so they come back as request-level keys
  (generated, or reconciled into the request's own object by the rule below);
  a key Vayu does not apply (`insecureHTTPParser`, a TLS option) is counted at
  import and not carried, because there is no folder-level carrier.
- **`protocolProfileBehavior`** is written back as imported, member order and
  every key included, while it agrees with the request's settings; a setting
  edited in Vayu since is written over its key in place (or appended), and a
  changed `disabledSystemHeaders` is rewritten as `{name: true}` in stored
  order. A request with no imported object gets one generated in the order
  `strictSSL, followRedirects, maxRedirects, disableUrlEncoding, disableCookies,
  disabledSystemHeaders, disableBodyPruning`. `disableBodyPruning` stays as
  imported, except on a GET or HEAD that has a body: Postman strips such a
  body unless told not to, so an imported object without `disableBodyPruning:
  true` gets it (in place, or appended). An untouched import with no body is
  written back unchanged.
- **Empty-name rows** (a disabled header with no key, an editor's trailing
  blank row) are not imported.

## Related

- [Import pipeline index](./README.md)
- [Insomnia v4](./insomnia-v4.md)
- [Insomnia v5](./insomnia-v5.md)
- [OpenAPI v3](./openapi-v3.md)
- [OpenAPI v2](./openapi-v2.md)
