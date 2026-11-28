---
description: >-
  How a request with the Event stream setting travels: the shared composition, the 202 answer, the live events and how a stopped or failed stream ends.
---

# Streaming Request Execution

A request whose **Event stream** setting is on takes the same composition and a different answer (#574).
`buildSendBody` is shared with the buffered path - the two must put the identical request on the wire, or a stream would measure something Send does not - and only the last two steps differ:

4. **API Call**: `apiService.executeStreamRequest()` → `POST /execute` with `stream: true`, answered `202 {runId, eventsUrl, status}` at once.
   There is no exchange yet: the engine has created the run row and handed the transfer to a managed consumer worker.
5. **Tail**: `useExecutionEvents` opens an `EventSource` on the answer's `eventsUrl` **as given** - the engine names where its own events are, and a second spelling of that path in `api-endpoints.ts` would be a copy that can disagree with the answer.
   Frames land in `execution-events-store`; the Events tab renders them live.
6. **Swap to stored truth**: on the relay's `complete` frame the provider fetches `GET /runs/:id/report` and `restore-response.ts` maps the trace's `events` node and its `response.body` - the stream's bytes, stored once and read back into that list by the engine (#3770) - onto the response, which is the record from then on.
   The node also carries `startedAt` (epoch ms, the clock of each item's `receivedAt`, #3805) when the engine knew when the transfer began; a row stored before it, or a stream refused before it began, has none.
   One fetch is enough: the engine sends `complete` only after the post-request script has run and the run row and trace are stored (#3239).

**The stream text path** (issue #3773) is the request's declared JSONPath for the reply inside each event's JSON `data` (`$.choices[0].delta.content`, `$.delta.text`).
It is stored (`requests.stream_text_path`; `streamTextPath` on `POST`/`PUT /requests`, where `null` clears and an absent key keeps), held in the editor as a string (empty is none) and sent on the wire only beside `stream: true`.
An inline `POST /compose` carries no path, so `streamTextPathOf` (`utils/execute-mapping.ts`) adds it to the streaming `POST /execute` and to the load run's `POST /runs` payload, from the request and never the load dialog; the buffered execute never carries one, and an empty or blank field is left off.
The engine refuses a path outside the JSONPath subset, or one beside a buffered request, with a `400` that names `streamTextPath`; the streaming Send shows it in the pane and as a toast like any other refusal.
Turning Event stream off empties the field (`streamPatch`) so a save never pairs a path with a buffered request.
What the path reads comes back as `text` on each relayed `message` frame and each stored item, and as `streamText` on the stored `events` node, joined over every stored event (past the stored-items cap) and present only when a path was declared; a captured load sample carries both the same way.
The renderer joins live `text` itself in `execution-events-store` (`streamText`), and `restore-response.ts` carries the stored string, which wins at the swap.

**An in-band error** (issue #3996) rides each relayed `message` frame and each stored item as `isError: true`, judged by the engine ([the rule](../../engine/api-reference/execute.md)) and never re-derived here.
`parseMessageFrame` copies it only when it is `true`, `eventsFromTrace` passes items through, and `events-funnels.test.ts` holds the two agreeing.
The store keeps a running `errorCount` beside `streamText`, for the Events header's "N errors".

**The first content marker** (issue #3774) is the request's declared literal for the first token: the bytes a load run watches each stream's raw wire for, so the report's `stream.timeToFirstMatch` (and the `streamTimeToFirstMatchP95Ms` budget) times the first content and not a preamble event, which `timeToFirstEvent` reads as near zero.
It is stored beside the path (`requests.stream_first_content_marker`; `streamFirstContentMarker` on `POST`/`PUT /requests`, `null` clears, an absent key keeps), held as a string (empty is none) and, unlike the path, **never trimmed**, since the engine matches its bytes as written.
The Settings tab offers two presets (`content_block_delta`, `"delta":{"content":"`) and any literal typed in, with the caveat that the match is on the raw stream, so a server's JSON spacing and escaping decide what it must say.
Only a load run times a stream to it (a Send checks the field and times nothing), so `streamFirstContentMarkerOf` (`utils/execute-mapping.ts`) adds it to the load run's `POST /runs` payload alone, from the request and never the load dialog, and only while the request streams; the engine refuses one beside a buffered request, and Event stream going off empties it (`streamPatch`) with the path.
A Vayu export carries it in its settings and the importer reads it back.

**A different `EventSource` from the `SSEClient` singleton below.**
That client belongs to load and scenario runs, is a single connection whose lifetime is the dashboard's, and deliberately never reconnects.
This one owns its retry, for the reason the inbox capture stream does (issue #506): `EventSource` treats any non-200 as fatal, and a reconnect landing inside the engine's stale-claim window meets a `409 run_events_in_use` from the claim the previous socket still holds - so a single unlucky disconnect would otherwise end the stream for the life of the tab, silently.
Resume travels as `?lastEventId=`, which picks up at the frame *after* the one named, so a dropped consumer re-renders nothing.

An answer missing `runId` or `eventsUrl` is a malformed answer and throws, rather than leaving the pane on "streaming" with no run to stop.
Refusals - `stream` with `transient`, or a stream cap on a payload that declares no stream - come back as a `400` the user has to read, so they are rendered as the response *and* raised as a toast.
A script is no longer one of them: scripts run on a streaming send (issue #575), the pre-request half before the transfer and the post-request half once the stream has terminated.

**The payload carries `allowScriptRequests` here for the same reason the buffered one does** (issue #653): the asker is a user at the request editor pressing Send, and the **Event stream** setting describes the shape of the answer, not what that user's scripts may do.
The engine reads the flag before it branches on `stream`, so a `pm.sendRequest` behaves identically with the toggle on and off.
While only the buffered call sent it, the same button allowed a script-issued request one way and refused it the other.

The renderer sends the **inline** compose shape (`{ request, collectionId, environmentId }`) rather than compose-by-id, because Send executes the *editor state* - possibly unsaved, or a detached History replay copy that has no saved row at all.
For the same reason the inline `request` carries the editor's **path rows** as `params` (issue #1764, `composePathParams` in `modules/request-builder/utils/path-variables.ts`): the engine fills the URL's `:name` segments from them.
Only the path rows - the query is already in `url` - and always the key, `[]` for a request without any: the engine answers an absent `params` from the *stored* rows, which would let a row the editor removed fill a segment.
Every member of a row is kept (a Postman import's `type`, `description`), only the editor `id` is dropped.
All four inline sites send them: Send, a load test, a History replay and GraphQL introspection.
`requestId` is attached to the execute payload afterwards to link the run to the saved request in History; `environmentId` scopes both composition and the engine's script context / variable persistence.
The collection scope reaches the engine's script context through the composed answer's `collectionId`, which every one of these sites passes on by spreading the answer (issue #3461).
A linked `requestId`'s own collection wins, so it changes nothing for a Send of a saved request; an orphaned History replay composes with no `collectionId` and the answer carries none.
A replay's `elements` come from the run's own record, not from the saved request or today's chain: see "A design run stores the `elements` it ran" below.
`useEngine.composeRequest` strips only `deferredVariables`.
`useVariableResolver()` still exists but is **preview-only** (tab titles, previews, unresolved-token painting) - see [variable-resolution](.././variable-resolution.md).

Auth (bearer/basic/api-key/oauth2) is resolved **engine-side** from the request's `auth` object - the app no longer builds `Authorization` headers itself.
When a non-interactive OAuth 2.0 token can't be obtained, the response carries an `errorCode` of `AUTH_REQUIRED` (interactive sign-in needed) or `AUTH_FAILED`, and the request builder surfaces a toast pointing the user at the Auth tab.

`headers` is an ordered array of `{ name, value }` lines (issue #2466): the Headers table's enabled rows with a key, in row order, a repeated name repeated and each row in the case typed with the spaces and tabs around its name trimmed (`toHeaderRows`), and `POST /compose` answers the same shape, so a repeat survives compose to execute.
The older single-valued record (`{ "Accept": "..." }`) is still accepted by the engine, but the app no longer sends it: a record keeps one value per key and sends a different header from the one its table shows.
The same holds for `POST /runs`.

The engine trims the spaces and tabs around every header name (`Authorization ` goes out as `Authorization`, never as a wire line with a space before its colon) and then requires a token: a name with an interior space, a colon or a non-ASCII byte is a `400` with code `invalid_header_name`, quoting the name, from `POST /compose`, `POST /execute` and `POST /runs` alike.
A name of only spaces and tabs is no name (`empty_header_name`).
A bearer token and an API key's name and value are trimmed the same way when auth is resolved; see the [API reference](../../engine/api-reference/compose.md#post-compose).

**Example Request:**
```typescript
await apiService.executeRequest({
  method: "GET",
  url: "https://api.example.com/users",
  headers: [{ name: "Authorization", value: "Bearer {{token}}" }],
  elements: [
    {
      id: "el_1",
      kind: "script.pre",
      enabled: true,
      config: { script: "console.log('Pre-request');" },
      origin: { kind: "request", id: "req_123" }
    },
    {
      id: "el_2",
      kind: "script.post",
      enabled: true,
      config: {
        script: "pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));"
      },
      origin: { kind: "request", id: "req_123" }
    }
  ],
  followRedirects: true,
  maxRedirects: 10,
  httpVersion: "auto",
  verifySSL: true,
  disableCookies: false,
  disabledSystemHeaders: [],
  disableUrlEncoding: false,
  requestId: "req_123",
  environmentId: "env_456"
});
```

`elements` (issue #1512) is the resolved, ordered list of typed behaviours to run -
the collection chain's (root→leaf), then the request's own, minus whatever an `inherit.disable` entry at any level names (a folder's can name a root element, a collection's the request's own; `POST /compose` gathers the targets the same way, and the entries themselves are never forwarded), each stamped with its `origin`.
A script is one of these now (`kind: "script.pre"` / `"script.post"`, `config.script` the text) - it replaces the old `preRequestScripts` / `postRequestScripts` `ScriptPart[]` fields, which the engine now refuses outright (400 naming `elements`).
The renderer builds the list from its editor state (`elementsParts()` in `request-builder/utils/elements-parts.ts`, generalizing the old `scriptParts()`) and it rides through `POST /compose` untouched - script text is never interpolated; the by-id compose path (used by MCP) resolves the same list engine-side (`compose_elements`).
The **engine** runs each element at its kind's phase - see `docs/engine/elements.md`.

**A design run stores the `elements` it ran** (issue #3669).
The run's `configSnapshot` is the sanitized `POST /execute` body, so its `elements` is the composed list above exactly as sent: the collection chain's, then the request's own, each entry `{id, kind, enabled, name?, config, origin?}` with `origin` as `{kind: "collection", scope: "collection" | "folder", id, name?}` or `{kind: "request", scope: "request", id}`.
It holds only what the send ran, so a disabled or incomplete element (left out by Send, #3066) is not in it.
History seeds its copy of the run from that list (`seedFromRun`, `modules/history/main/design-run-seed.ts`): an entry whose `origin.kind` is `"request"`, or that has no origin, becomes the copy's own Elements list with `id`, `kind`, `enabled`, `name` and `config` intact;
every other entry is the recorded inherited list, shown by the Elements tab's "Runs before your own" notice and replayed as stored, `origin` and `scope` included.
A script element with no text is left out of both (`isBlankScriptElement`).
**Save to request** writes the copy's own list, so an untouched copy changes nothing; the run never recorded a disabled element, so the save keeps the saved request's disabled ones (`elementsToWrite`) instead of deleting them.
The retired `preRequestScripts` / `postRequestScripts` `ScriptPart[]` keys are read only when `elements` is absent, which is a run recorded before #1514 (and the older glued `preRequestScript` / `postRequestScript` strings only when neither is there).
`elements` takes precedence when both are present.
A load run's snapshot also has an `elements` key, but it is the run-level override object, not a list.

**Send leaves out the request's own draft elements that cannot run** (issue #3066).
`POST /execute` validates inline `elements` and refuses the whole request over one that fails its kind's schema, and an element just added has `config: {}`.
So Send and the Code section (both build through `buildComposeBody` with `onlyRunnable`, `sendElementsParts`) omit a draft element that is switched off, or that fails the app's own check (`elementNeeds` in `lib/elements.ts`: `missingRequiredKeys`, `validateElementConfig` and `missingOperand`, the judgement behind the editor's "Needs ..." chip and the save gate).
Only the request's own elements are judged; the collection chain's pass through as composed.
The incomplete ones come back as `leftOut` and ride the response as `ResponseState.leftOutElements` - on a buffered send, a failed one (the handlers take it before the compose call, so a send that throws still says it), and a streamed one, which carries it in `execution-events-store` for both the live placeholder and the stored response that replaces it.
The response's Elements section draws each as `Not run - needs <fields>`, so a check that did not run is never read as one that passed.
The element's own row says the same before the send, collapsed or open, through the mark in the summary's place (`describeNeeds`, the wording `notRunReason` builds on): "Needs <fields>" for a missing key, `<field>: <message>` for a refused value.
It reads `elementNeeds` live and shows for every element Send leaves out as incomplete; a switched-off element is left out too but is not flagged, its switch says so.
A response restored from History carries none: it is not the send that composed the payload.
With the catalogue not yet loaded, disabled elements and the operand rules still apply and a kind's required keys wait for the engine.
The engine keeps validating: an element that reaches `/execute` invalid by another road (an MCP caller, a `{{variable}}` that resolves badly) is still a `400`.
A load run composes the chain without the filter.

**Redirect policy, protocol and TLS verification are always sent, never elided - and the request's timeout is the deliberate exception.**
`followRedirects`, `maxRedirects`, `httpVersion` and `verifySSL` all come from the request's **Settings** tab and are included on every execute even when they equal the defaults.
The engine defaults `follow_redirects` to `true`, so omitting a `false` would follow the 3xx the user asked to inspect - a bug the app shipped with for a long time, when nothing in the renderer sent these fields at all.
`verifySSL` carries the same rule for a sharper reason: the engine verifies unless told otherwise, so an omitted `false` verifies the certificate the user turned verification off for, and the send fails against the one host the setting exists for.
All four go out with `startLoadTest()`, so a load test exercises the same policy, protocol and trust the request was configured with - there is no separate, load-test-only protocol control; the Settings tab's picker is the only one, and it governs Send and load test alike.
`httpVersion` is `"auto" | "http1.1" | "http2"`: `"auto"` lets ALPN negotiate, `"http1.1"` forces HTTP/1.1, and `"http2"` attempts h2 over TLS with a silent fallback to 1.1 over plain `http://` (curl's `CURL_HTTP_VERSION_2TLS` semantics).

**`timeout` is the one Settings field that is not always sent** (issue #2937).
A request's own timeout is `number | null`, and `buildComposeBody` writes `timeout` onto the inline compose request only when it is a number.
`null` means "use the `defaultTimeout` setting", and the engine can only read the live setting when the key is absent: sending today's value instead would pin it on the request, and `POST /execute` refuses a `null`.
The composed payload carries the key on to `/execute` and `/runs`, so Send, a collection run and a load test wait as long as the Settings tab says.
A History replay seeds it from the run's recorded body, and Save to request does not write it back.

**Postman's protocol switches ride the same rule** (issue #1765).
`disableCookies`, `disabledSystemHeaders` and `disableUrlEncoding` come from the Settings tab too, and every Send, streaming Send, load run and History replay puts all three on the inline compose request through one helper, `protocolSettings()` in `request-builder/utils/execute-mapping.ts`, so the editor's value wins over the saved row's and composition carries them on to `/execute` and `/runs`.
`disableUrlEncoding` also changes what the renderer writes: the Params table always reads the URL's query into rows without decoding it (`parseQueryParams`, issue #1771), and with the flag on joins a row the URL does not already carry back as typed rather than with Postman's query rule, so editing one row rebuilds exactly the query the others held.
Turning the flag on or off writes only the flag: the URL and the rows stay as they are.
With the flag on, the Sends line and the code snippets substitute path values raw, the Sends line writes a value a `{{variable}}` brings into the URL, and the literal text around it, as typed, and a query-located API key is appended raw, all matching what the engine sends.
With the flag off, the Sends line and the snippets show the line Vayu sends, which is the URL written as Postman's `toNodeUrl` writes it (issue #2465; the engine's `core::encode_url_as_postman`, pinned by `engine/tests/fixtures/query-encoding-conformance.json`).
A value a `{{variable}}` brings in is first encoded by the part of the URL it lands in (issues #1773 and #2465): the path by `PATH_ENCODE_SET`, the query by `QUERY_ENCODE_SET`, the fragment by `FRAGMENT_ENCODE_SET`, and the scheme and authority as they stand.
The whole URL is then written: leading whitespace dropped, a backslash before the query a `/`, user info by `USERINFO_ENCODE_SET`, the host lowercased and a non-ASCII one written by its punycode name (the `url.domainToASCII` `toNodeUrl` calls; the renderer asks `URL` for it, and a host with no ASCII name stays as typed),
and the path, each query key and value and the fragment by their sets, so a literal `"`, `<`, `>`, backtick, `{` or `}` in the path is `%22 %3C %3E %60 %7B %7D` and `/a b` is `/a%20b`.
`%` is in no set, so an escape already in the text, a `:name` path value or a pre-signed URL's signature passes unchanged and nothing is encoded twice; a byte no set holds (`+`, `|`, `^`, `[`, `]`, and a backtick or brace in the query) goes out as typed.
A `{{token}}` is kept whole wherever it sits.
`resolveUrlTemplate` and `encodeUrlAsPostman` in `request-builder/utils/query-encoding.ts` are the one writer; `prepare.ts` runs the same resolver, with the tokens left in place, so a snippet carries the line Vayu sends and not the one typed.
The Sends line draws that URL with every secret variable value and auth credential (each encoded spelling too) replaced by `••••`; the masking is at render, so what resolves and what is sent are unchanged (#1806).
The imported `protocolProfileBehavior` object itself (`postmanProtocolBehavior`) is read by the Postman exporter only: `GET /requests/:id` returns it as the stored JSON text, which the app keeps as a string and never parses, so an import and a Duplicate (which copies that detail read) carry it byte for byte, and nothing sends it.
The ordered `headers` lines every inline compose sends (`toHeaderRows`: enabled rows with a key, in row order, a repeated name repeated, issue #2466) lose each row's `source`, so beside them goes `bodyModeHeaders` (`bodyModeHeaders()` in `request-builder/utils/key-value.ts`):
the names whose last row the body mode wrote (names compared without case), which a `content-type` opt-out removes on the wire while a Content-Type the user typed is always sent.
A History replay puts the run's recorded list back on its seeded rows.

**Example Response:**
```typescript
{
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  body: null,  // { users: [...] } when the request leaves includeParsedBody unset; the app sends false
  bodyRaw: '{"users":[...]}',
  bodyEncoding: "utf8",
  httpVersion: "HTTP/1.1",
  httpVersionDowngraded: false,
  // authNotice: "auth mode 'ntlm' is not executed by Vayu; ..."  (absent here)
  // authHeaders: ["X-Api-Key"], authQueryParam: "access_token"  (absent here)
  method: "GET",  // what was dialled, after any pre-request script (#3650)
  url: "https://api.example.com/users",
  warnings: [],  // [{ code: "cookie_not_sent", message: "..." }, ...]
  clientCertificate: "",
  bodyCapped: false,
  headerLines: [{ name: "Content-Type", value: "application/json" }],
  redirects: [],
  timing: { totalMs: 150, engineMs: 3.4, scriptMs: 118.6, dnsMs: 10, connectMs: 20, ... },
  testResults: [
    { name: "Token was issued", passed: true, source: "pre", scope: "collection" },
    { name: "Status 200", passed: true, source: "test", scope: "request" }
  ],
  consoleLogs: [
    { source: "pre", scope: "collection", level: "info",
      message: "pm.sendRequest POST https://auth.example.test/token -> 200 (41 ms)",
      scriptRequest: 0 },
    { source: "pre", scope: "collection", level: "log", message: "Pre-request" },
    { source: "test", scope: "request", level: "warn", message: "slow response" }
  ],
  scriptRequests: [
    { source: "pre", scope: "collection", startedAt: 1763452800123,
      status: 200, statusText: "OK",
      request: { method: "POST", url: "https://auth.example.test/token", ... },
      response: { headers: { ... }, headerLines: [...], body: "...", ... },
      totalMs: 41.2, dnsMs: 0, connectMs: 0.4, ... }
  ]
}
```

`testResults` entries name the script that asserted them, in execution order: `pm.test` runs in a pre-request script too, and the Tests pane groups the list by `source` so an assertion made before the request went out does not read as one about the response (issue #810).
An entry restored from a trace written before that carries no `source`, and is read as the test script's.

Both lists also name the **level** that wrote an entry, in `scope`: `collection` (the root), `folder` (any collection below it) or `request` (issue #2522).
A request runs every level's scripts and the engine reports all of them.
`scope` is not the console `level`; it is absent on a trace stored before the field and on a send whose elements carry no origin, and absent reads as the request's own.
The Tests list and the Console label an inherited level ("Collection", "Nested collection") and leave the request's own bare.
An inline Send resolves the chain in the renderer (`elements-parts.ts`) and stamps each element's `origin.scope` itself - the root as `collection`, every level under it as `folder` - the same way the engine stamps a stored request's chain.
A script that threw at an inherited level is named in `preScriptError` / `postScriptError` ("Collection pre-request script failed - ...").

`consoleLogs` entries name the script that wrote them and the `console.*` level that was called.
A bare `string` is the pre-structured shape an older engine sidecar sends; `console/parse-logs.ts` decodes both and is the only place that knows the difference (see [the engine API reference](../../engine/api-reference/execute.md#post-execute)).

`scriptRequests` is every `pm.sendRequest` the scripts made (issue #3633), one record per call in execution order, in the stored trace's own shape (`ScriptRequestRecord` in `types/domain.ts`).
The call's summary line carries `scriptRequest`, the record's index, and the Console draws the two as one expandable row in the line's position; a record no line points at (the console was off, or its cap dropped the line) is drawn after the last line of its script.
The engine masks credentials where it builds the record, so the app renders it as written and adds no masking of its own.
Both funnels carry it: `responseFromExecuteResult` from the live body and `scriptsFromTrace` from the stored `scripts` node, and `script-funnels.test.ts` holds them equal.
A setup or teardown script's records ride its `lifecycle` row instead, with no line index, and the run's Setup / teardown card lists them under the row.

`httpVersion` here is the **negotiated** protocol (`"HTTP/1.1"` / `"HTTP/2"` / `""` when nothing was negotiated) - an outcome, not an echo of the request's own `httpVersion`.
The Raw tab in the response viewer prints it on the request/status line instead of a hardcoded `HTTP/1.1`.

`httpVersionDowngraded` says the request asked for `http2` and the connection negotiated something older - the one thing neither `httpVersion` can say alone, since neither knows about the other.
The engine computes it, and the renderer carries it as-is rather than comparing the negotiated protocol against the tab's current setting: a restored or replayed response sits beside request state that may have changed since, and the answer belongs to the exchange.
`ResponseStatusBar` draws it as a warning beside the status chip, and only when it is true.
A collection run's step card, whose viewer has no status bar, draws the same line from the step's trace.
Load runs and collection runs both carry the whole-run count of requests that fell back as `report.summary.httpVersionDowngraded`:
`LoadTestDetail` shows it next to the requested protocol - without it a run measured entirely over HTTP/1.1 still read "HTTP/2" there ([#215](https://github.com/athrvk/vayu/issues/215)) - and `ScenarioRunView` shows it in the run's header ([#3262](https://github.com/athrvk/vayu/issues/3262)).

Load runs also carry `report.summary.connectionReplays`, the count of requests libcurl re-sent on a new connection after the server dropped or refused a reused one before answering ([#2799](https://github.com/athrvk/vayu/issues/2799)).
The app does not draw the number: the engine's `connection_replayed` entry in `report.warnings` is the surface, and `RunWarnings` renders it as a callout titled "Some requests were re-sent after a dropped connection" with the count in its message.
The number is for MCP and export readers.
The same list carries `cookies_dropped` ([#3307](https://github.com/athrvk/vayu/issues/3307)): the `Set-Cookie` headers libcurl's cookie engine discarded across the run (`count`), titled "Some cookies the server set were dropped" in `RunWarnings`, the count again in the engine's message and no cookie name in it.
Unlike `httpVersionDowngraded`, **absent and `0` differ**: `0` is a run that counted and saw none, absent a run stored before the count existed.

A constant-rate run with a `timer.think` carries `think_timer_skipped_open_loop` ([#3541](https://github.com/athrvk/vayu/issues/3541)): the timer is skipped, not waited, because requests go out on a schedule.
`timers` is the number of enabled timers skipped, `RunWarnings` titles it "Think timer skipped on a constant-rate run", and the Elements card tallies the element `skipped`.

A load run's `report.warnings` also carry the three Retry-After codes ([#3782](https://github.com/athrvk/vayu/issues/3782)), each titled by `RunWarnings` for what the run did rather than as a failure:
`rate_limited_dominant` ("Most responses were rate limited", the option off and more than half the responses `429`, its message naming `retryAfterBackoff` on a closed-loop run and saying back-off does not apply on a constant-rate one),
`retry_after_backoff` ("Virtual users waited out Retry-After", `count` the waits) and `retry_after_skipped_open_loop` ("Retry-After back-off skipped on a constant-rate run").

`authNotice` is the engine's sentence for a request whose auth sent nothing: a mode it stores but does not execute (`digest`, `ntlm`, ..., issue #2474), or a bearer token or API key name that is empty (issue #3203).
The request is still sent, without that credential.
It is also the sentence for a request whose own `Authorization` header was sent in place of an OAuth 2.0 token it never fetched (issue #3202).
The key is **absent** when there is nothing to say, on the live body and in the stored trace alike; the trace holds it on `trace.request`, so a failed exchange that received no header block, and so has no `response` node, still has it, and a streaming send carries it only there.
`responseFromExecuteResult` and `responseFromRunResult` both set `ResponseState.authNotice` (an empty string reads as absent), held together by `auth-notice-funnels.test.ts`.
`ResponseViewer` draws it as a warning `Callout` between the status band and the tabs, so it shows on every tab and on a 401 from the target, which is the response it explains.

`authHeaders` and `authQueryParam` name what the request's auth wrote (#1845): the header names an API-key block filled, and the raw name of the query parameter an API key or OAuth 2.0 token was placed in.
Each is **absent** when auth wrote none of that kind, at the top level of the live body and on `trace.request` in the stored trace, and their values stay raw beside them.
Both funnels set `ResponseState.authHeaders` / `authQueryParam` through `authProvenance` (an empty list or string reads as absent), held together by `auth-provenance-funnels.test.ts`.
Their one reader is the session Console's row builder (`modules/console/console-rows.ts`, #3634), which masks the values under these names before a Send's row is stored.

`method` and `url` (#3650) are the request line the transfer was dialled with, the live spelling of `trace.request.method` / `url`, raw (the URL keeps an auth-written query value, masked by the reader through `authQueryParam`).
A pre-request script can retarget a send after `/compose`, so the buffered Send's Console row reads them (`handleExecute`: `result.url ?? composed.url`, the composed request standing in for an engine that predates them), never the composed request alone.
They live on `SanityResult` only, not on `ResponseState`: the one reader is that call site, and a History replay does not list a Send.
A stream's `202` carries none; its row reads the stored trace.

`runId` (#3679) is the run the engine recorded the buffered Send under, **absent** from a `transient` Send, from an engine that predates it and when the engine could not write the result row (`resultId`, its one result row, has no renderer reader).
It is on `SanityResult` only, for the same reason as `method` and `url`: `handleExecute` passes it to `appendSendToConsole`, so the Send's Console row offers "Open run", as a stream's row does with the run it finalized.
A Send that got no answer has none.

`warnings` lists what the engine did to a design send that the response does not show ([#3307](https://github.com/athrvk/vayu/issues/3307)), each as `{ code, message }`: a jar cookie libcurl left off the `Cookie` line (`cookie_not_sent`, `cookie_limit_reached`) or a `Set-Cookie` it discarded unread (`cookie_dropped_oversized`, `cookie_dropped_too_many`).
A warning never fails the send, and the message names a cookie by name, never by value.
The live body **always** carries the array, `[]` when empty; the stored trace holds it at the top level of `trace` (beside `clientCertificate`, not under `response`) and only when non-empty, so a failed exchange that has no `response` node still has it.
A streaming send's `202` carries none and no relay frame does either; its stored trace does, and the end-of-stream fetch of the run report (`responseFromRunResult`, the same swap that restores `events`) is what puts them on `ResponseState`, so the pane draws them when the stream ends and not before.
Both funnels read it through `receivedWarnings` (`lib/exchange-warnings.ts`), which maps an empty list, an absent key and entries that are not a string `code` and `message` to `undefined`, so `ResponseState.warnings` is a non-empty list or absent and `warnings-funnels.test.ts` holds the two together.
`ResponseViewer` draws one warning `Callout` per entry, from `ExchangeWarnings`, between the status band and the tabs, so it shows on every tab and on a `status: 0` failure; a collection run's step card draws the same component above its response viewer.
The title comes from the code and an unknown code gets a neutral one, since the engine adds codes without the app learning them first.

`clientCertificate` names the client-certificate registry entry the exchange presented, as `host` or `host:port`, and `""` when none matched (issue #707) or the final hop was `http://`, where nothing is presented (#3260).
It is the entry's own spelling, so a wildcard row reads as `*.example.com` rather than as the host that was dialled - which is the point: it says which row answered (issue #803).
The renderer maps that empty string to `undefined` and `ResponseStatusBar` draws a chip only when there is one - the same show-it-only-when-it-happened rule the downgrade warning follows.
Its tooltip says the certificate was *offered*, not accepted: the server decides, and the connection test's line says the same.
Nothing on the request names a certificate (the engine matches one per transfer by host), which is exactly why the *response* has to say which was used: two calls to what looks like the same API can differ only in which registry entry matched.
The stored trace carries the same value under the same key, so `responseFromExecuteResult` and `responseFromRunResult` agree - see `client-certificate-funnels.test.ts`.

`timing.engineMs` is Vayu's own cost for the exchange: the engine's elapsed time less the transfer, the user's scripts and an OAuth 2.0 token fetch (issue #2132, #2185; the engine's definition is under [One timing convention](../../engine/api-reference/execute.md#post-execute)).
It is optional - a stream, an auth-failure reply and rows stored before the key existed carry none - and the stored trace holds it **flat** as `trace.engineMs` where the live body nests it under `timing`, so `timingFromTrace` copies it across.
`ResponseStatusBar` draws it as "in Vayu" beside the elapsed time and the Timing tab as its **Vayu** stat; neither shows a figure that is absent, and `queueWaitMs` (the sliver before libcurl) is never presented as it.
`engine-ms-funnels.test.ts` holds the two funnels together.

`timing.scriptMs` is the other half of what `engineMs` leaves out: the time the pre-request and test scripts took, `pm.sendRequest` inside them included (issue #3676).
It is **not** folded into `totalMs`, `wireMs` or `engineMs`.
`0` means a send with no script, and it is absent in the same cases as `engineMs`.
The stored trace holds it flat as `trace.scriptMs` (a collection run's step trace too), and `timingFromTrace` copies it across like `engineMs`.
The Timing tab always shows it as its **Scripts** stat when reported, a zero included; `ResponseStatusBar` draws "in scripts" beside the elapsed time only when `scriptMs` exceeds `wireMs` (both reported, so a response with no `wireMs` shows none), because that is when the user's code, not the network, is what made the send slow.

`bodyCapped` says the engine stopped **reading** this response at `maxDesignResponseBodyBytes` (Settings → Limits, default 32MB), so `body`, `bodyRaw` and `bodySize` describe the prefix it read rather than what the server sent (issue #1157).
The status and headers are the server's own, so this is a successful response carrying a flag.
It is always present on the live body - absent means an engine too old to say, not "not capped" - and the stored trace carries the same key under `trace.response.bodyCapped`, written only when it happened, so `responseFromExecuteResult` normalises its `false` to `undefined` and the two funnels agree (`body-capped-funnels.test.ts`).

`headerLines` is the response's headers as received (issue #2460): one `{ name, value }` per wire line, in order, the name in the server's case and the value trimmed by the engine, so a `Set-Cookie` sent twice is two entries and a comma inside one cookie's value is not mistaken for the boundary between two.
`headers` beside it is the same headers folded (lowercased, repeats joined with `", "`) and is unchanged.
The live body always carries the key (`[]` when there were none); the stored trace writes `trace.response.headerLines` only when there were lines, and a load sample, a stream's `open` frame and any row stored before the key have none.
Both funnels pass it through `receivedHeaderLines` (`lib/header-lines.ts`), which reads an empty list as an absent one, so the live and the restored `ResponseState.headerLines` agree (`header-lines-funnels.test.ts`).
Absent is **not** filled in from `headers`: it is how the Cookies tab knows the `set-cookie` it holds is folded and must be split by the legacy `parseSetCookie` rather than read one cookie per line.
The Headers and Raw tabs and the History step pane show the lines when there are some and `headers` when there are not (`resolveHeaderLines`); Save as example does the same, one row per received line, so a `Set-Cookie` pair stays two rows (issue #3422).
It also saves a `bodyCapped` body as partial.

`redirects` is the redirect responses the send followed (issue #2461): one `{ status, statusText, headerLines, url?, schemeDowngrade? }` per 3xx, in arrival order.
`url` is the request that hop answered (the requested URL for the first hop, the previous hop's `Location` resolved against it after that), with the values of credential query parameters written as `<redacted>` engine-side; `schemeDowngrade` is true when that request went over `https` and the next over `http` (issue #2949).
Both are absent on a hop from an engine or a stored trace from before the field, and a reader treats absent as unknown.
`headers` and `headerLines` hold the final response only, so a `Set-Cookie` on the `302` that answers a login is readable nowhere else.
The live body always carries the key (`[]` when nothing was followed, and always for `followRedirects: false`); the stored trace writes `trace.response.redirects` only when a hop was followed, and a load sample or a row stored before the key has none.
Both funnels pass it through `receivedRedirects` (`lib/header-lines.ts`), the same empty-is-absent rule, so the live and restored `ResponseState.redirects` agree (`redirects-funnels.test.ts`).
The Cookies tab reads it: with no cookie on any hop it is the one table it always was;
once a hop set one it shows two groups, **Set by this response** (the final response's lines, as above) and **Set during redirects**, one sub-heading per hop that set a cookie ("302 Found, to /home": the hop's status, and its `Location` when it sent one) over that hop's table, each `Set-Cookie` line parsed on its own.
The empty state ("No cookies in response") shows only when neither group has a cookie; the tab carries no count.
A hop with `schemeDowngrade: true` is announced above both groups by a warning `Callout` ("Redirected from https to http") listing each such hop as "301 Moved Permanently from https://api.example.com/start, to /plain" - the resolved `url` when the engine sent one, then the `Location` - whether or not the hop set a cookie, because the common downgrade is a bare `301`.
The same "from <url>" labels the hop's cookie sub-heading. the engine drops `Authorization` and `Cookie` across a scheme, host or port change; an API key sent as a header is not withheld, which is what the notice says.
The rows say what the server sent and never that the jar stored it, because the engine withholds a hop's cookie when the redirect changes origin.
`GET /cookies` and the Settings cookie card are what the jar holds.

The renderer keeps it strictly apart from `bodyTruncated`, which is `maxTraceBodyBytes` shortening a *stored* body after the whole of it was read: a re-send recovers from that one, while a capped read is reproduced by a re-send and only a bigger `maxDesignResponseBodyBytes` changes it.
The response pane renders one `Callout` per fact and both can be on screen at once - "Body truncated for storage" tells the user to re-send, "Body capped while reading" tells them to raise the setting, and collapsing the two into one notice would give the wrong instruction to half the cases.

The pane reads the **received text** (`bodyRaw`), never the engine's parsed `body`, which is key-sorted, keeps only the last of a repeated key and has rounded any integer past 2^53 (issue #2459).
The app does not even ask for it now: `executeRequest` sends `includeParsedBody: false`, so the answer's `body` is `null` (#2544; the engine leaves it `null` past 4 MiB whatever is asked).
`responseFromExecuteResult` builds `ResponseState.body` - the string Pretty reads - by indenting `bodyRaw` with `lib/json-format.ts`, a single pass that copies every token through without parsing a value, so member order, duplicate keys and number spellings survive; text that is not well-formed JSON comes back as received.
The stored trace takes the same path (`paneBody`, shared by `responseFromRunResult`), so a send reads the same live and from History (`json-body-funnels.test.ts`).
Everything that takes the body *out* of the pane reads the text as received (`receivedBody`, `request-builder/utils/response-bytes.ts`) and not the indented copy: Copy, Download, Save as example and the Raw tab, which therefore print what the server sent.

A body's size is a **UTF-8 byte count** everywhere it is recorded.
The live `bodySize` is one, and the stored trace carries the same number as `trace.response.bodyBytes` on every response (#3423; the original length when `bodyTruncated`, and a stream's wire count, which its held body falls short of once `bodyCapped` cut it), so `responseFromRunResult` takes `ResponseState.size` from it and the two funnels agree.
A row stored before that has `bodyBytes` only when the body was cut or streamed, and the restore then counts the held text's UTF-8 bytes (`heldBodySize`, never `string.length`, which counts UTF-16 code units and reads a multibyte body smaller than it was).
`json-body-funnels.test.ts` drives a non-ASCII body through both.

**A failure after the server answered restores with the server's headers.**
The engine stores `trace.response` beside `error_type` / `error_message` when the header block arrived before the transfer failed (an undecodable body, a timeout mid-body, a redirect limit), the way the live answer carries both.
`responseFromRunResult` reads such a trace as the failed exchange - status 0, `errorCode`, `errorMessage`, so the pane is `ClientErrorView` as it was live - and keeps `headers`, `headerLines`, `redirects`, the protocol, the body and its size from the node (`responseHeadFromTrace`).
A trace with an error and no `response` node keeps the shape it always had, `headers: {}`; a row with neither is `null`.
Only the engine's own `error_type` / `error_message` mark the failure when a node is present: the result row's `error` column also holds a step's post-request script failure, for a response that did arrive.
`header-lines-funnels.test.ts` holds the live and the restored failure together.

A third limit is the renderer's alone and reaches no wire field: `LARGE_BODY_BYTES` (2MB, `shared/response-viewer/utils.ts`).
Above it `paneBody` stops indenting - it hands back `bodyRaw`, which is what would be displayed anyway - and `ResponseBody` stops formatting, hides the view toggle and shows the first 2MB of the raw body under its own notice.
The request builder's Raw tab applies the same cap to the received text it prints (decided from that one string's length) and shows the same notice, since building the exchange and handing Monaco a multi-megabyte model is the same freeze (#3138).
Copy and Download still take the whole received text.
Both limits are about *rendering* cost, not about what arrived, and both count the decoded text below, never base64 characters.

`bodyEncoding` says how to read `bodyRaw` (issue #2458): `"utf8"` is the text itself, `"base64"` is a body that is not UTF-8 text (an image, a PDF, Latin-1, UTF-16) in standard padded base64, with `body` null and `bodySize` still the byte count.
The stored trace writes `trace.response.bodyEncoding: "base64"` only when it applies and keeps the same base64 in `trace.response.body`; absent is text, as on every older row.
Both funnels hand the body to one decoder, `decodeResponseBody` (`request-builder/utils/response-bytes.ts`), so the live and the restored pane hold the same state: the bytes go to `ResponseState.rawBytes`, and `body` / `bodyRaw` get their decoding - by the byte-order mark, else the declared `charset`, else UTF-8, through `TextDecoder` - for a text Content-Type, and nothing for any other.
A BOM on a `"utf8"` body is part of the text, so it stays in `bodyRaw` (Raw, Copy and Download keep it); Pretty skips one leading BOM when it indents JSON, and a body that then fails to scan comes back whole, BOM included (#3140).
A text type is `text/*`, a declared `charset`, or a subtype whose name (after any `x-`) or `+suffix` is one of the text syntaxes (`json`, `xml`, `yaml`, `javascript`, `graphql` and their kin), compared as whole tokens by `mediaTypeOf`: an Office document's `vnd.openxmlformats-...` subtype holds `xml` and is still a zip.
The pane's `detectBodyType` reads the type through the same parts.
A label the platform does not know, or bytes the charset cannot read, put a notice in `rawBytes.notice` that `ResponseBody` shows over the text.
A non-text body has `rawBytes.isText` false and no text; the pane draws an image from its bytes through a Blob object URL, names a PDF or other bytes with their size, and Download writes the bytes as a Blob under the response's own Content-Type.
Copy is off for such a body and the Raw tab prints one line in place of it; Save as example is off for any base64 body, since an example's body is UTF-8 text.
Both disabled controls carry their reason.
`binary-body-funnels.test.ts` holds the two funnels together.

`report.sampling` carries what each of the run's bounded stores thinned away -
`successTracesDropped` / `slowTracesDropped` for the trace records behind `report.results` (`slowTracesDropped` thins the slow traces only: since issue #2399 `report.slowRequests.count` is the run's exact slow count and `slowRequests.tracesStored` the sample of it that was kept), and `responseSamplesDropped` for the buffer post-run test scripts are graded on.
That buffer is bounded twice, and one counter reports both: by count (`max_response_samples`), which displaces an incumbent and so keeps the graded set uniform over the run, and by bytes (`max_response_sample_bytes`), which stops admitting once the retained bodies fill it.
The renderer now reads `sampling.responseSampleBudgetSpent` to tell which one applied (issue #1192): `true` means the byte budget ended at least one sample, so the graded set is drawn from the part of the run whose bodies fit rather than uniformly from the whole of it; `false` means only the count cap displaced anything, so the graded set stays uniform.
The key is absent on a summary written before the marker existed, and absent keeps today's uniformity sentence rather than weakening it - only a target whose retained bodies average more than ~256 KiB reaches the budget at the defaults, so absent-as-uniform is the accurate message for nearly every older run.
The renderer treats a non-zero count as "this list is a *sample* of a larger set": `SampleRetentionNote` (shared) renders under the dashboard's Sampled Requests, the history Samples tab and the Test validation card, and the sample-count badges say **shown** rather than *captured*, since `results` is capped at 100 for a single-request run by the report route irrespective of retention.
That cap is a failures-first selection listed by time, not a uniform sample (#2210): the top-level `resultsStored` and `resultsCap` say how many rows the run stored and the cap applied, `resultsStored > resultsCap` is the only sign the array was cut, and the history Samples tab reads the pair as "N of M stored".
Both are absent from an older engine, which is read as "say nothing", not "nothing was cut".
The traces note therefore never calls `results` uniform; only the tested-response buffer's sentence does.
`sampling.errorsDropped` has a reader of its own: the shared `ErrorSummary` card (history Overview) says under By error type that "N errors beyond the first M are not broken down by type" (issue #2400).
It reads `errorsDropped` only when `errors.types` sums to less than the no-response count, which is a run stored before the engine kept exact per-type counts or a design-mode run; on any other run the types are exact past the error store's cap and the note stays silent.
The Test validation card (titled **Sampled replay** when a scenario load report also carries `scenario.assertions`, which gets its own Assertions card counted on every response, #2820) also states its denominator:
for a single-request run `summary.totalRequests` ("Tested N of M requests"), worded so it holds for requests that never got a response as well as for displaced ones, and for a scenario load run the responses that carried a deferred test script,
the sum of `deferred` over its `script.*` elements ("Replayed N of the M responses that carried a test script (1 step)", #2824), because most requests of a sequence have no script to replay;
`samplesTested` counts responses and `testsPassed` / `testsFailed` count assertions, and the card's labels say so (issue #2144).
A report's `elements[]` row may carry `deferred` (absent from older reports): a post-request script left to the post-run replay, rendered as "N requests deferred to a post-run replay over M sampled responses" rather than "0 passed", where M is `testValidation.samplesTested` (a scenario step's `tests.sampled`; a row whose report does not carry one reads "replay of sampled responses").
An inline `script.*` row may also carry `messages` (the error it threw and each failing `pm.test`, `{kind: "error" | "test", text}`), `console` (`{level, text}`), each entry with `count` when it was seen more than once, and the `messagesDropped` / `consoleDropped` counts of the occurrences a full list turned away (#3127);
each key is absent when empty (`count` when the entry was seen once), and the Elements card and the Steps tab list them under the row.
The deferred replay's failures arrive on the synthetic `results[]` row as `failures` (each distinct message once), `failureCounts` (how often each failed), `failuresDistinct` and the occurrence totals `totalFailed` / `totalPassed`; the Test validation card shows each message once with `x3` beside a repeat and says "Showing N of M distinct" when the engine kept fewer than it saw.
A row from before #3127 has no `failureCounts` or `failuresDistinct`, and each of its entries counts as one.
The replay's console lines ride on the aggregate instead:
`testValidation.console` and `consoleDropped` on a single-request run, `scenario.steps[].tests.console` and `consoleDropped` per step on a scenario run (same `{level, text, count?}` lines and occurrence count as an inline row, each key absent when nothing was logged and on a report from before the field), drawn under "Console from the post-run replay over N sampled responses" by `ReplayConsole`.

An **absent** `sampling` is a run whose stored summary predates the counts, not a run that dropped nothing, so the note stays out rather than asserting a completeness it cannot verify - the same absent-vs-zero rule `httpVersionDowngraded` follows above.

`report.auth` follows that rule too.
The engine refreshes a header-placed OAuth 2.0 token *while a load run is going*, and this section is what it did: `refreshes[].atSeconds` per renewal, plus `refreshFailures` and a `lastError` when one was refused.
`LoadTestDetail` renders it as a one-line note in the header (`authRefreshNote`), a warning when a refresh failed - that failure is what explains 401s appearing partway through an otherwise healthy run.
Absent means the run could never refresh (no OAuth 2.0 auth, a non-expiring or query-placed token, `autoRefreshToken: false`, or an older sidecar); present with an empty `refreshes` means it was watched and never needed to.
A collection load run fills it too (#3199): the engine keeps one token current per distinct cache key its steps send and folds them into this one shape, so `refreshes` holds every renewal in order and `refreshFailures` is the sum.
The same eligibility rule decides whether `OAuth2LoadTestGuard` still blocks a run longer than its token, in the request's load dialog and, once per distinct token, in `RunCollectionDialog` - `isMidRunRefreshable` mirrors the config-and-token cases of the engine's `plan_oauth2_refresh`, not what the engine decides from the composed request:
a user-supplied `Authorization` header that beats the token, and for a collection step an auth that waited on its scripts or a different `headerPrefix` than the first step sharing its cache key.
The guard is never handed the headers to see the first.
The two must change together.
