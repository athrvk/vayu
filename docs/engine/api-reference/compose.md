---
description: >-
  The compose route: what the engine would send for a request, without sending it - query encoding, path variables and the composed result.
---

# POST /compose

Compose a request without sending it: resolve `{{variables}}` and `inherit` auth engine-side and return the execute-ready payload that `POST /execute` and `POST /runs` accept unchanged (issue #226).
Pure - no traffic, no run row - which is what lets a client (e.g. MCP's allowlist gate) inspect the *resolved* request before anything is sent.
Composition is still the only place a payload is composed; a payload that skips it is sent byte-for-byte as supplied.
Since issue #1008 the execution endpoints are not silent past that point either: a name composition could not answer keeps its braces (issue #1009) instead of resolving to `""`, and both `POST /execute` and a scenario step resolve it once more, after the pre-request script and before the send, against whatever the script just wrote.
Since issue #2521 the same is true of every name a variable scope *does* answer, in a request that a pre-request script (its own, a folder's or the collection's) runs before: composition leaves it written and lists it in [`deferredVariables`](#deferredvariables), because the script may change the value; a collection run's plan does the same in every step when any element in it writes a variable.
A value composition did substitute is finished text and is never re-resolved - see [POST /execute](execute.md#post-execute) and [Scenario runs](scenario-runs.md#scenario-runs) for what that changes.

**Request** - at least one of `requestId` / `request` is required:

```json
{
  "requestId": "req_1234567890",   // Optional: compose the saved request
  "request": {                      // Optional: an inline unresolved request
    "method": "POST",
    "url": "https://{{host}}/users",
    "headers": [{ "name": "X-Token", "value": "{{token}}" }],
    "body": { "mode": "json", "content": "{\"name\":\"{{name}}\"}" },
    "auth": { "mode": "inherit" },
    "elements": []
  },
  "collectionId": "col_1234567890", // Optional: chain scope for an inline request, echoed on the answer
  "environmentId": "env_1234567890", // Optional: environment scope
  "dataColumns": ["username", "city"], // Optional: bare names a bound row will substitute
  "deferDynamicVariables": true      // Optional: this payload is for a run that repeats it
}
```

- **`dataColumns`** (issue #1007) names the columns of the data file a caller will bind a row from **after** this compose call - an array of column names, never values, since a plan is composed once and a row is bound per iteration.
  Every name it lists is left written as it stands, exactly as the reserved `{{data.*}}` namespace already is, for a later per-row bind to join - `{{username}}` behaves as `{{data.username}}` always has, deferred rather than resolved from a same-named variable.
  **Absent or `null` means no dataset: composition resolves exactly as it did before this field existed.**
  Refused with `400` `invalid_compose_request` when the field is present and not an array, or holds an entry that is not a string or is the empty string.
  A `data.`-prefixed entry is accepted but redundant - the reserved namespace answers that spelling first regardless of whether it is also listed here, so either way it is deferred.
  See [`{{data.*}}` puts the row into the request itself](scenario-runs.md#scenario-runs) and [D18](../../app/variable-resolution.md#d18---a-bound-rows-bare-column-names-outrank-the-environment) for the precedence this buys.

- **`deferDynamicVariables`** (issue #995) says this payload is being composed for a **run**, which will send it many times.
  A generator resolved here would be one value repeated by every iteration of every virtual user - the uniqueness `{{$randomUUID}}` is written for, lost exactly where concurrency makes collisions matter -
  so with the field true every name the dynamic table generates is left written as it stands, the way `{{data.*}}` and the identity names already are, and the run's executor generates a fresh value per occurrence immediately before each send.
  It also resolves an OAuth 2.0 config **now**, cache key included:
  a run acquires its token once, when it is planned, from the stored values (a script's write to an OAuth 2.0 variable has no effect under load), and every virtual user sends that one, so without the field (a Send) the config is left for the send to resolve after the pre-request script (see [Authentication](authentication.md#authentication)).
  **Absent, `null` or `false` composes exactly as it did before this field existed**, which is what a Send, a preview and a script's `replaceIn` want: composed once, sent once.
  Refused with `400` `invalid_compose_request` when present and not a boolean.
  Two limits worth knowing: an unknown `{{$typo}}` is unaffected (nothing would generate it either way, so it keeps its braces - issue #186), and a generator inside the **auth block** is generated here even when the field is true, because `apply_auth` encodes a credential when the request is built and a token left for the bind would go out as base64 of its own text.
  That is a generator's case alone: a credential carrying a `{{data.*}}` or a `{{$vu}}` defers the whole build and is bound before the encoding (issue #1055), and one carrying a name no scope answered defers it until after the pre-request script (#2473, see [Authentication](authentication.md#authentication)), where a generator has nothing to wait for.
  A scenario plan's steps are composed with it internally, so a collection run needs no field at all (a sequential run's steps keep their OAuth 2.0 config for after the script, as a Send does; a collection load run's resolve it at planning).

- **`requestId`** composes the stored request wholesale:
  URL, headers (every enabled row with a key, in row order, as `{name, value}` lines - a repeated name repeated, each in the spelling typed, issue #2466), body, auth (absent auth defaults to `inherit`),
  the resolved `elements` list (collection chain root→leaf, then the request's own, each stamped with its origin, disabled and blank `script.*` entries dropped the same way - see [Elements](../elements.md)), the stored execution options (`followRedirects` / `maxRedirects` / `httpVersion` / `verifySSL`, always emitted;
  the request's own `timeout`, emitted only when it states one, so a request that states none sends with the `defaultTimeout` setting in force at the send, issue #2937), its Event stream setting as `stream`, always emitted (issue #3561: a caller that hands the payload to `POST /execute` gets `202 {runId, eventsUrl}` for a streaming request unless it states `stream` itself),
  its stored `streamTextPath` beside a `stream: true` only (issue #3773: never beside a buffered send, which `POST /execute` refuses, so a request whose stream is off composes none, and an inline `request` that sets `stream` to anything but `true` without stating a path of its own drops the stored one),
  its stored `streamFirstContentMarker` by the same rule (issue #3774) and its `requestName` (the script sandbox reads it as `pm.info.requestName`; omitted when the row's name is empty).
  The request's own collection scopes resolution; `collectionId` is only a fallback for a request without one.
  An unknown id is a definitive **404**.
- **`request`** is an inline unresolved request in the `POST /execute` body shape.
  Given *alongside* `requestId`, its fields lay over the stored ones before resolution - how an override like "retarget this saved request at another URL" works.
  Given alone, `collectionId` scopes the variable chain and the `inherit` walk.
  Unknown scope ids degrade to an empty scope rather than erroring - composition works with no collection or environment at all.
  That rule is for the app and direct callers: the MCP server checks an `environmentId` against `GET /environments` before composing and refuses one that names no environment ([MCP](../mcp/index.md)).

## deferredVariables

Composition decides from the composed `elements` (never from a flag the caller sends) whether a pre-request script runs before the send: an **enabled, non-blank `script.pre`** on the request, on a folder above it or on the collection, after an `inherit.disable` entry and a disabled-by-id entry have been applied and an inline `elements` array has been laid over the stored one.
A `script.setup` does not count - it runs once, before a collection run's first step.
When a pre-request script does run, every `{{name}}` that a variable scope answers is **left written** in the URL, the `:name` path rows, header names and values, body `content` and form-field strings,
and the credentials of an `auth` block that is not OAuth 2.0 (an OAuth 2.0 config defers too on a Send and a sequential run, as [Authentication](authentication.md#authentication) describes), and the response lists the names in `deferredVariables`: a sorted array of the names as written, **omitted when nothing was deferred**.
`POST /execute` and `POST /runs` resolve them after the script, against the variable scopes as the script left them, and ignore the member itself - it describes this answer, not the request, so a client that posts the composed payload onward may leave it or drop it (the app and the MCP server drop it).
A request no pre-request script runs before is composed exactly as it was before issue #2521: no `deferredVariables`.
A collection run's plan, which composes each step engine-side and returns nothing, defers the same names in every step of a plan in which any element writes a variable before some send, scripted or not ([Scenario runs](scenario-runs.md#scenario-runs)).

Four kinds of name resolve at composition whatever a script does, each exactly once:

- the `{{data.*}}` namespace and the names listed in `dataColumns`, which the per-iteration bind answers;
- a `$` name - a dynamic variable (generated once here, or by the run's executor under `deferDynamicVariables`) or the iteration identity (`{{$vu}}`, `{{$iteration}}`);
- a name whose value, followed through the scopes, reaches a token the bind owns (`{{user}}` holding `{{data.user}}`), so the bind finds the token it needs;
- a file path: the `src` of a form-data file part or a binary body file, which the later pass never resolves, so a script cannot choose which file is sent.

A name nothing defines stays written as it always did, and is not listed.

Deferral also moves refusals to the send.
A header value or name that depends on a deferred variable cannot be checked here,
so the refusals described under [Errors](#post-compose) below (`unsendable_header`, `empty_header_name`, `invalid_header_name`, `colliding_header_names`) are made by the residual pass at send time instead, in the same words and under the same codes: a buffered `POST /execute` answers `statusCode: 0` with the code as `refusalCode`, and a streaming send answers a `400` carrying it.

## collectionId on the answer

The answer names the collection whose chain this composition read, as `collectionId`: the leaf, so a sub-folder's id rather than its root's.
That is the stored request's own collection for `requestId`, else the body's `collectionId`, and the member is **omitted when composition read no chain**: an inline request with no `collectionId`, or one naming a collection that does not exist or is in the Trash (issue #3461).
Like `deferredVariables` it is composition's own answer, never taken from the input: a `collectionId` inside `request` is dropped, so an inline request cannot claim a scope composition did not read.

It is what lets an inline request keep its scope past composition.
A request composed by `requestId`, or sent with one linked (the app's Send does both), carries the id onward and `POST /execute` reads the stored request's collection again;
an inline one that links no row (MCP's ad-hoc `run_request` with a `collectionId`, a direct caller) has nothing else to name it, so without the member the names deferred past its pre-request script would meet no collection scope at the send, and the script would read an empty `pm.collectionVariables`.
`POST /execute` and `POST /runs` read it as described under [POST /execute](execute.md#post-execute).
An engine older than issue #3461 neither writes nor reads it, and ignores it in a body.

## Query encoding

With `disableUrlEncoding` off, a URL is sent as Postman sends it, by every writer: Send, a load or collection run, a streaming request, MCP and `pm.sendRequest` put out one request line for one URL (issue #2465, `core::encode_url_as_postman` in `core/url_encoding.hpp`, after `postman-url-encoder` 3.0.8's `toNodeUrl`).
Each component is percent-encoded by its own Postman set, every one of which holds the C0 controls, space, DEL and every byte above `~` (each UTF-8 byte):

- the path by `PATH_ENCODE_SET`, which adds `"`, `<`, `>`, backtick, `{` and `}`;
- the query by `QUERY_ENCODE_SET`, which adds `"`, `'`, `<` and `>` (a backtick, the braces and a backslash are not in it);
- the fragment by `FRAGMENT_ENCODE_SET`, which adds `"`, `<`, `>` and backtick;
- user info by `USERINFO_ENCODE_SET`, the path set plus `/ : ; = @ [ \ ] ^ |`, with the last `@` ending it.

Two normalisations come with it: a backslash before the query becomes `/`, and the host is lowercased and a non-ASCII one written by its punycode name ([Non-ASCII hosts](#non-ascii-hosts)).
Leading whitespace is dropped, as Postman's parser drops it.
So `GET http://H/a"b{c}?q='<x>` goes to host `h` as `GET /a%22b%7Bc%7D?q=%27%3Cx%3E`, and `GET http://h/a b?q=é` as `GET /a%20b?q=%C3%A9`.
`%` is in no set, so an escape such as `%41` is sent as typed and nothing is encoded twice: a pre-signed URL's signature is sent unchanged, as is every byte no set holds (`+`, `|`, `^`, `[`, `]`, `!`, `'` outside the query).
A `{{token}}` nothing answered is kept whole, where Postman would encode its braces in the path.
The rule is applied where every driver takes its URL (`wire_url`) and at the end of composition, so `POST /compose` answers the line that will be sent.
Every check made beside the transfer reads that same URL -
the [scheme rule](#url-schemes), the [reserved-port refusal](#reserved-local-ports), the DNS pin and the client-certificate match - so a leading space or a backslash cannot make the typed text name another scheme, host or port than the one dialled: `localhost:9876/x` with a leading space is refused as it is without one, and `https://h/` with one pins and matches port 443.
With `disableUrlEncoding` on the URL goes out exactly as typed (a non-ASCII host still by its punycode name), and libcurl refuses a raw space:
the send fails with status `0` and error code `INVALID_URL`, and a message that names the space and the toggle (`Cannot send this request: the URL contains a space or control character; percent-encode it, or turn Send URL without encoding off`), derived from scanning the URL and not from libcurl's wording.

Where the engine itself writes a query pair into a URL, it uses Postman's rule (issue #1771, `core::encode_query_component` in `core/query_encoding.hpp`, pinned to the app's Params table by `engine/tests/fixtures/query-encoding-conformance.json`), read from `postman-url-encoder` 3.0.8's `toNodeUrl` over `postman-collection`'s `QueryParam.unparse`:

- Encoded as `%XX` (uppercase hex): Postman's `QUERY_ENCODE_SET` - the C0 controls, DEL, every byte above `~` (each UTF-8 byte), space, `"`, `#`, `'`, `<` and `>` - plus `&` in a key or a value and `=` in a key only (a value cannot split a pair, because a parser splits on the first `=`).
- Everything else goes out as typed: `+`, `|`, `/`, `?`, `:`, `@`, `[`, `]`, `{`, `}` and `%`, so an escape already in the text is never encoded twice.
  A whole `{{token}}` is kept verbatim, with the text around it encoded.
- The writers are an `apikey` auth with `in: "query"` and an OAuth 2.0 token with `tokenPlacement: "query"` (a value `a|b+c=d` goes out as `?k=a|b+c=d`; `key=` is written even for an empty value),
  and the join of a Postman import's query rows into the stored URL ([POST /import/parse](import.md#post-importparse)), which writes a row with an empty value as `key=` and a `valueless: true` row (Postman's `"value": null`) as a bare `key`.
  A request with `disableUrlEncoding` writes the pair as typed.
- A value known only at send time is URL text, not a row: a `{{variable}}` substituted into the URL (by composition, a data row's bind, or the residual pass after the pre-request script).
  Postman substitutes into the URL string, parses it again and then encodes it, so a value's `&` and `=` split pairs as they would typed, a `?` it brings into the head opens the query, and a `#` opens the fragment.
  Each component then encodes the value by its own Postman set (issue #2465): the query by `QUERY_ENCODE_SET` above, alike in a key and a value (the `&`/`=` step of a row never applies);
  the path by `PATH_ENCODE_SET` (see [Path variables](#path-variables)), so `http://h/users/{{name}}` with `name = "John Doe"` sends `/users/John%20Doe`; the fragment by `FRAGMENT_ENCODE_SET` (the C0 controls, DEL, every byte above `~`, space, `"`, `<`, `>` and backtick).
  `GET {{base}}/?q={{term}}` with `term = "a b#c"` sends `/?q=a%20b`, with `#c` as the fragment (which is not sent), and `?{{qs}}` with `qs = "a=1&b=2 c"` sends `?a=1&b=2%20c`.
  Where a value lands is read left to right from the URL written so far, substituted values included: in the scheme and authority a `/` opens the path unless it follows a `:` or a `/` (so `://` is not a path), the first `?` opens the query, `#` opens the fragment.
  A layered value is resolved whole and encoded once.
  The scheme and the authority are never percent-encoded (the host is lowercased and written by its ASCII name, as above), so a `{{base}}` holding `https://x/p?k=a b` has its query part encoded and nothing else changed.
  `disableUrlEncoding` writes every value as typed.
- A pair a script adds with `pm.request.url.query.add`, `upsert` or `pm.request.url.addQueryParams` is a row and is written by the row rule above ([scripting](../scripting/request-mutation.md#writing)).
- A `pm.sendRequest` URL is encoded whole after its variables resolve, by the same `encode_url_as_postman`, and `disableUrlEncoding` does not apply to it ([scripting](../scripting/send-request.md#sending-a-request-from-a-script-pmsendrequest)).
  A script and Send write the same request line for every URL; `tests/url_encoding_test.cpp` (`PostmanUrlEncodingAgreement`) pins it.
- OpenAPI, Insomnia and JMeter imports join with `encodeURIComponent` instead: the OpenAPI sync diff compares stored URLs against that form, and neither other source uses Postman's set.

## URL schemes

Only `http` and `https` URLs are sent, on every send path: Send, a load or collection run, a streaming request, History replay, MCP, `pm.sendRequest`, an OAuth 2.0 token request, `POST /import/fetch`, `POST /import/mcp` and the server-vitals monitor.
The scheme is read case-insensitively from the URL as it stands just before the transfer - after composition, a data row's bind, the pre-request script and the residual pass, and as the transfer is handed it ([Query encoding](#query-encoding)) - so a `{{baseUrl}}` that resolves to `file:///etc` is refused like a typed one, and so is `file:///etc` with a leading space.
A refused send never reaches the network: status `0`, error code `INVALID_URL`, and the message `Cannot send this request: scheme 'file' is not supported - only http and https URLs can be sent`, naming the scheme as written.
A `pm.sendRequest` gets the same code and message as its callback's `err`.

A scheme is what libcurl reads as one: letters, digits, `+`, `-` and `.` after a leading letter, followed by `:/`.
A URL with no scheme is sent as before, with the scheme libcurl guesses from the host - `http` for `localhost:8080/x` or `example.com/x`.
Every transfer handle is also held to `http,https` (`CURLOPT_PROTOCOLS_STR`), which covers what the URL check cannot see: a guessed scheme (`ftp.example.com/x` would be FTP).
It fails as status `0` with error code `INVALID_URL` and libcurl's own message (`Protocol "ftp" is disabled`), and nothing is read.
A redirect's `Location` never reaches the handle's allowlist: the engine follows redirects itself and refuses a `Location` naming another scheme before making the hop, as status `0` with error code `INVALID_URL` and the message `Protocol "ftp" is disabled (in redirect)`, worded as libcurl worded it.
A `Location` that does not parse is `INVALID_URL` too, with `The redirect target URL could not be parsed: ` and the reason.
The libcurl the engine links carries every protocol curl builds by default, so the check and the option, not the build, are what restrict each transfer to `http` and `https`.

A URL libcurl cannot parse is also status `0` with error code `INVALID_URL`.
When the URL the transfer was handed holds a space, a C0 control character or DEL, which is how one reaches libcurl once `disableUrlEncoding` is on (or a space sits in the host), the message says so instead of repeating libcurl's component wording (`URL rejected: Bad query`):
`Cannot send this request: the URL contains a space or control character; percent-encode it, or turn Send URL without encoding off`.
The last clause is left out when the toggle is already off, because it is no remedy.
The scan is of the bytes, not of libcurl's text, and a malformed URL with none of them keeps libcurl's message.

## Non-ASCII hosts

A host written with non-ASCII characters is dialled by its ASCII (punycode) name, on every send path: Send, a load or collection run, History replay, MCP, `pm.sendRequest`, an OAuth 2.0 token request and GraphQL introspection.
`https://bücher.example/` goes to `xn--bcher-kva.example`, which is the name DNS resolves, the `Host` header and TLS SNI carry and the server certificate is checked against.
It is the name Postman sends to (`url.domainToASCII`, UTS #46 nontransitional processing): uppercase and full-width letters are mapped (`BÜCHER`, `ＡＢＣ`), and `ß` is kept, so `faß.de` is `xn--fa-hia.de`, not `fass.de`.
The stored URL keeps the spelling that was typed; a composed URL, and so `pm.request.url` in the request's own scripts, carries the ASCII name, because composition ends with the encoder the send uses ([Query encoding](#query-encoding)).

The conversion is ada's, the WHATWG URL library Node's `domainToASCII` is built on, applied to the one URL every driver hands libcurl (which is built without IDN support), so it matches Postman case for case, the IDNA hyphen rules included: Node does not enforce them, so `bücher-.example` and `ab--cd.bücher.example` convert.
The conversion rewrites only the host, and an ASCII host, an unresolved `{{host}}` included, is not converted; the rest of the URL is written as [Query encoding](#query-encoding) says.
The raw request a response carries shows the punycode name, because that is what was sent.
Everything that compares a host beside the transfer uses the same name - the cookie jar, the DNS cache, the client-certificate registry, the proxy bypass list and a proxy URL - so a cookie, certificate or bypass entry written with either spelling applies to both.

A host with no ASCII name at all, such as `xn--iñvalid.com` (a punycode label that does not decode) or one holding a space, is refused before anything is sent: status `0`, error code `INVALID_URL`, and a message naming the host.
Postman sends such a host as typed and the lookup fails; libcurl without IDN would refuse it as "IDN support not present", which names the wrong cause.

## Reserved local ports

No request the engine sends reaches Vayu itself:
the engine's own port (the `--port` it bound, 9876 by default) and the MCP server's port (the daemon's `--mcp-port`, 9877 when it is started without one) are refused on this machine, on every send path - Send, a load or collection run, a streaming request, History replay, MCP, `pm.sendRequest`, an OAuth 2.0 token request, `POST /import/fetch`, `POST /import/mcp` and the server-vitals monitor.
The API's [gate](index.md#who-may-call-the-api) admits a loopback request with no `Origin`, which is exactly what the engine's own client sends, so without this a request in an imported collection could read and write everything the API holds (issue [#2355](https://github.com/athrvk/vayu/issues/2355)).

"This machine" is any loopback spelling - `127.0.0.0/8` (`127.1` and other shorthand included), `::1`, `::ffff:127.0.0.1`, `localhost` in any case with or without a trailing dot - and the unspecified `0.0.0.0` and `::`, which connect to the local host.
Every other port on loopback is sent as usual.
The rule is applied twice:

- **The URL the transfer is handed** ([Query encoding](#query-encoding)), before anything is dialled: status `0`, error code `INVALID_URL`, and the message `Cannot send this request: Vayu does not send requests to its own engine port 9876 on this machine - not when the URL names it, a redirect leads there or a host name resolves there` (`MCP port 9877`, or the `--mcp-port` value, for the other).
  This holds with a proxy configured too.
  Once a `--mcp-port` is given, 9877 is an ordinary port like any other.
- **The address libcurl connected to**, for every connection a transfer uses, before a byte of the request is written.
  This is what refuses a redirect to one of those ports and a name that resolves to loopback (`*.localhost`, a DNS record pointing at `127.0.0.1`), with the same code and message.
  With a proxy in force the connected address is the proxy's, so this half cannot see the origin behind it; the URL check above still applies, and where a proxy you configured forwards to is your choice.

A `$ref` fetched through `POST /import/fetch` with `reference: true` runs a wider rule on the same connected-address check: every loopback and link-local peer is refused unless it is the source document's own host and port (issue [#2364](https://github.com/athrvk/vayu/issues/2364), see [POST /import/fetch](import.md#post-importfetch)).
It is added to the reserved ports, so a source on one of them does not open it.
The rule passes the proxy the transport names and judges the reference's URL instead (issue [#2605](https://github.com/athrvk/vayu/issues/2605)); the reserved ports do not: a proxy on one of them is still refused.

## Path variables

A `:name` segment of the URL is answered by the request's own `in: "path"` Params row of that key (issue #1764) - the inline `request.params` when the inline request carries a `params` array, the stored row's otherwise (so an inline `url` override still reads the stored rows).
This runs before the URL's own `{{var}}` pass, on the URL as written, and follows Postman's parse (`postman-url-encoder/parser`, `postman-collection`'s `Url.parse` / `Url.getPath`):

- A segment is a path variable when it is a whole path segment - after the authority, between `/` and the next `/`, `?`, `#` or the end - that starts with `:`.
  The name runs to the first `.`, and a suffix after it stays (`:id.json` sends `7.json`); `:` alone or `:.x` names nothing.
  A `{{variable}}` token is opaque, a backslash is a `/`, and a port (`host:8080`), the query and the fragment are never read.
- Only an **enabled** row answers; among several rows of one key the **last** enabled one does.
  Postman's `VariableList` answers with the last row whatever its `disabled` flag, but Postman's editor has no toggle for a path variable; Vayu's does, and a disabled row answers nothing.
  A segment with no such row stays literal, which is also how every request stored before #1764 composes: a `:x` segment with no path row is sent as written.
- The value is `{{var}}`-resolved exactly as the URL is, then written in place of `:name` percent-encoded as Postman encodes it:
  Postman joins the raw value into the path (`Url.getPath`) and encodes the path with `postman-url-encoder`'s `PATH_ENCODE_SET`, which is the C0 controls, DEL and every byte above it (UTF-8, `%XX` with uppercase hex), space, `"`, `<`, `>`, `` ` ``, `#`, `?`, `{` and `}` -
  and nothing else. So a `/` in a value makes more segments (`a b/c` sends `/users/a%20b/c`), `@ : , ; = & + ! $ ' ( ) *` and `%` go out as typed (`user@x.com`, `12:30`, `100%`, and an imported `a%40b.com` is not encoded twice), and a `?` or `#` is `%3F` / `%23`, so a value never ends the path. A whole `{{token}}` in the value is kept verbatim rather than encoded (see the next point).
- A value that still holds a `{{token}}` after that resolution - a bound data column, a deferred `{{$guid}}`, a name a pre-request script sets - is **not written yet**: its segment stays `:name` in the composed `url`, and the row goes out in the composed payload's `params` as `{"key": "id", "value": "{{username}}", "in": "path"}`, its value resolved as far as composition could.
  Whatever answers the token later - the per-iteration bind, or the residual pass after the pre-request script - writes the answer into the segment through the same encoding, so a data cell `a b?c` goes out as `/users/a%20b%3Fc`, never with a raw space and a query.
  A token nothing answers is written verbatim, as composition keeps one.
  Until then a pre-request script reads `pm.request.url` with the `:name` still in it.
- A value that resolves to the **empty string leaves the segment literal** (`:id` goes out as written), as Postman's `Url.getPath` (it writes only a non-empty string) and Insomnia's `applyPathParametersToUrl` both do.

The composed payload's `url` is the substituted URL, and its `params` holds exactly the path rows still waiting (absent when none is; an inline request's own `params` is consumed, never echoed).
`/execute`, `/runs` and a scenario plan step (which is composed through this same path) read that `params` back and write each waiting value into its `:name` segment once it is answered, at the latest just before the send:
a run with no residual pass writes it after the bind, or once at the start for a load run that binds nothing (a raw run naming an `environmentId` or `requestId` writes the values its start-of-run pass answered there, the rest after the bind).
A caller posting its own `params` path rows to `/execute` or `/runs` gets the same writing.

**What gets resolved:** the URL, header keys and values, body `content` and `fields`, and every string inside the winning auth block - after `inherit` is walked (leaf→root; an explicit `noauth` terminates the walk, `none` is stepped over) and before any OAuth 2.0 cache key is derived from the config:
the key is always computed from the resolved config, here for a run, after the pre-request script for a Send (below).
A request no pre-request script runs before is resolved here, once.
One that has one keeps what the script may change as `{{name}}`, as [`deferredVariables`](#deferredvariables) describes.
Script text is **never** interpolated - a `{{...}}` in a script is user JavaScript.
Resolution semantics (precedence, unknown names, dynamic variables, the D17 malformed-data rules) are specified in [variable-resolution](../../app/variable-resolution.md) and pinned by the shared conformance fixture (`engine/tests/fixtures/variable-resolution-conformance.json`).

**Response:** `200` with the composed payload - the `POST /execute` body shape, with `requestId` / `environmentId` echoed so the result can be POSTed onward unchanged, the [`collectionId`](#collectionid-on-the-answer) whose chain it read, and `deferredVariables` when a pre-request script defers names (above).
An auth that resolves to "send nothing" is an absent `auth` field.
`headers` always comes back as the line array (issue #2466), whichever shape an inline request used, so a repeated header survives compose to execute; it is absent when there are no lines.

**Errors** use the engine's single nested shape (see the top of this page), with specific codes:

- `404` `{"error": {"code": "request_not_found", "message": "..."}}` - unknown `requestId`.
- `400` `{"error": {"code": "invalid_compose_request", "message": "..."}}` - malformed JSON, neither `requestId` nor `request`, or a field of the wrong type.
- `400` `{"error": {"code": "unsendable_header", "message": "..."}}` - a variable substituted into a header name or value, or into a credential the engine writes into a header line as it stands (a bearer token, an api key sent in a header), carries a byte no header line can hold.
  Basic auth's pair and an api key sent in the query are encoded before they reach the wire, and an OAuth 2.0 config is not a header, so a variable in those composes unchanged.
  This is the one payload composition rejects over a *value* rather than over its shape, and it is deliberate: a header line ends at CRLF and has no escape for it, so `ok\r\nX-Admin: true` arriving from an environment variable does not sit in the header - it ends the line and makes the remainder a header nobody wrote.
  The message names the variable, because composition is the last layer that knows which one carried the byte.
  A NUL is refused with it: the engine spells a header `key + ": " + value` for `curl_slist_append`, which reads to the first NUL, so the rest of the line would go out missing rather than refused.
  The same bytes remain ordinary text in a URL, a body and a form field's value, which compose unchanged.
  For a request a pre-request script runs before, a variable written into a header or a header-line credential is not substituted here (see [`deferredVariables`](#deferredvariables)), so the same refusal, naming the variable, is made after the script: `statusCode: 0` and `refusalCode: "unsendable_header"` on a buffered send, a `400` with that code on a streaming one.
  A header row is refused with nothing rewritten first.

  A header carrying either byte from any *other* origin - a script's assignment to `pm.request.headers`, a credential typed with the byte in it, an import, a payload posted straight to `POST /execute` - is refused one step later, before any transfer starts: the response carries `statusCode: 0` and an `errorCode` of `INTERNAL_ERROR` whose message names the header instead of a variable.
  The same refusal covers a multipart part's field name, declared filename and per-part content type, which libcurl writes into that part's own header block.
  A bound `{{data.column}}` is refused earlier still, at bind time, naming the column and the row (see [Scenario runs](scenario-runs.md#scenario-runs)).
- `400` `{"error": {"code": "colliding_header_names", "message": "..."}}` - two header names written differently resolved to one, so the request would send that header twice where its rows show two different names.
  `{{tenant_header}}: acme` beside a literal `X-Tenant: legacy` is two `X-Tenant` lines once the variable answers `X-Tenant`, and no row says so.
  Names are compared **without case**, so a `{{h}}` resolving to `authorization` refuses beside an `Authorization` the caller typed.
  The message names both spellings as written, never the name they produced (a variable can hold a secret); nothing is repaired, for the reason a forged header is refused rather than stripped.

  Only a collision **resolution produced** is refused.
  Two names the caller *wrote* alike - `X-Dup` and `x-dup` typed on two rows, or one `{{h}}` typed twice - are a repeated header they can see, and every one of those lines is sent, in order (issue #2466) - the same distinction the bind-time refusal draws (see [Scenario runs](scenario-runs.md#scenario-runs)).
  The execute-time residual pass refuses the same collision in the same words, since it resolves names the same way:
  a buffered send answers `statusCode: 0` with an `errorCode` of `INTERNAL_ERROR` carrying the message and this code as `refusalCode`, exactly as the pre-send gate answers its own refusals, while a streaming send - which has not answered yet - is a `400` with this same code and fails its run row.
  A script's own `pm.sendRequest` refuses it as well, with the call named in front of the same wording, because it too resolves header names (issue #1067).
- `400` `{"error": {"code": "empty_header_name", "message": "..."}}` - a header name resolved to the empty string, so the line would go out under no name at all.
  `{{blank}}: acme` with `blank` holding `""` is not a header the caller can see: the name is empty, and what libcurl is handed is the line `": acme"`.
  A name of nothing but spaces and tabs counts as empty: it is trimmed to nothing first (see `invalid_header_name`, below).
  Nothing further down refuses it - the pre-send gate reads a header's text for the bytes that end a line early, and an absent name ends nothing - so composition is where it is caught.
  The message names the name as written, which is all there is to name; what it produced is nothing.

  Refused however the name got there, unlike the collision above.
  A collision has to be one resolution produced, because two names the caller typed are two entries they can see; a name that is not there is nothing to see whoever wrote it.
  Both flattenings that feed composition drop such a row before it arrives - a stored request's headers and the app's - so what this catches beyond a produced name is a payload built by hand.
  The execute-time residual pass refuses it in the same words and under this same code, in each of the two shapes it answers a refusal in (above), and for this rule it reads **every** header name rather than only the ones still holding a token (issue #1095) - so a name a pre-request script has just emptied and an empty key posted straight to `POST /execute` are refused there as well.
  The collision rule keeps the narrower reach and loses nothing by it: a request that arrives already resolved cannot carry a collision, two names that are already equal being already one key.
  `pm.sendRequest` has refused it since its own header names began resolving, with the call named in front of the same wording, and a data row that binds a name away is refused at bind time with the row in front of it (see [Scenario runs](scenario-runs.md#scenario-runs)).
- `400` `{"error": {"code": "invalid_header_name", "message": "..."}}` - a header name that is not an RFC 9110 `token` once the spaces and tabs around it are trimmed (issue #2467): `X Bad` (an interior space), `X:Bad` (a colon), `X-é` (a byte outside ASCII).
  The message quotes the name as written - `{{h}}`, not what the variable resolved to, which can be a secret - and says which character cannot appear in one.
  Nothing is rewritten into a different header: the trim below is for padding, which has one reading, and this refusal is for what has none.
  The same refusal, under the same code, answers a `headers` name posted to `POST /execute` or `POST /runs` and the execute-time residual pass (a buffered send answers `statusCode: 0` with `INTERNAL_ERROR`, a streaming send a `400`, as above), which is where a name a pre-request script defined, or one a script's variable completes, is judged;
  a script's `pm.sendRequest` and a data cell bound into a name refuse the same way, with the call or the row in front of the wording.
  A `{{token}}` nothing answered is not judged, since like every unanswered token it is sent as written, but the text around it is: `X-{{a}}-b` passes, `X Bad {{x}}` and `Evil: injected{{` (a `{{` that closes no token is ordinary text) are refused, quoted as written.

  **Header names are trimmed, then checked.**
  A name loses the spaces and tabs (SP and HTAB, nothing else) at either end before it is checked or sent, wherever it enters: a stored request's header rows, a composed or resolved name, and the `headers` of `POST /execute` and `POST /runs`.
  `Authorization ` therefore goes out as `Authorization`, not as the line `Authorization : Bearer x` with a space before its colon.
  A row whose key is only padding is no row, as an empty key always was.
  A value is not trimmed.
  Two lines written `X-A` and ` X-A` are a repeat the caller typed, sent as two lines, not a collision.
  In the object form of `headers` two keys that differ only by padding or case fold to one line (the last value wins), because an object has one slot per key; the array form sends both.
