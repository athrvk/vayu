---
description: >-
  POST /execute: the fields a send takes, every key of the answer, the timing convention and what a send that failed returns.
---

# Execution

## POST /execute

Execute a single HTTP request (Design Mode).
Returns immediate response with test results.

A body nested deeper than 128 levels in any field answers `400` `request body is nested deeper than 128 levels` (code `bad_request`) before anything is recorded or sent (issue #2417).
The one exception is a `data` cell, held to its own bound of 100 below.


The request's `auth` (see [Authentication](authentication.md#authentication)) is resolved before the pre-request script runs, so `pm.request` reflects the real outgoing headers - unless a credential still holds a name that waits for that script (one compose could not answer, or any name of a request a pre-request script runs before), when it is applied after that script instead (#2473, #2521).
If a non-interactive OAuth 2.0 token cannot be obtained, the engine still returns `200` but the body carries `statusCode: 0`, an `errorCode` of `AUTH_REQUIRED` (interactive sign-in needed) or `AUTH_FAILED`, and an `authErrorCode` hint.
The hint is the same whether the token was sought at the build or, for a config that waited for the script, after it.

**A name still written after compose is resolved after the pre-request script and before the send** (issues #1008 and #2521).
Composition still runs first and is still the only place a payload is *composed*.
Two kinds of name reach this pass: an unknown ordinary `{{name}}`, which keeps its braces at compose time instead of becoming `""` (issue #1009), and, in a request that a pre-request script (its own, a folder's or the collection's) runs before, every name a scope answers, which compose leaves written and lists in [`deferredVariables`](compose.md#deferredvariables).
Either is resolved here against the variable scopes as the pre-request script left them, and there is no flag for the caller to set: the braces in the payload are the whole signal.
This is what makes the canonical imported auth pattern work: a pre-request script does `pm.environment.set("token", …)` and the same send's `Authorization: Bearer {{token}}` carries the fresh value - on every run, not only the first, which is Postman's order - rather than the previous run's token or `""`.
In a pre-request script, `pm.request.url` and `pm.request.headers` therefore still hold the `{{token}}` as written, and resolve after the script ends.
A credential that waited (above) is applied once this pass has answered, against the same scopes, so a basic pair carries the value a script set rather than base64 of its token.
It resolves the same fields composition does -
the URL, header names and values, body content, and the five strings a form field carries,
plus the value of a `:name` path variable composition left waiting (written into its segment, encoded, as the pass ends; see [Path variables](compose.md#path-variables)) - by the same resolver and the same rules (scope precedence, nested resolution, cycles, the 8-level bound); a value composition already substituted is finished text and is not touched again.
`{{data.column}}` is left alone here too - the data namespace is bound per iteration by whoever owns the row.
A request skipped by `pm.execution.skipRequest()` resolves nothing, having nothing left to send.
A header value or name this pass resolves is checked by the rules compose applies, before anything is rewritten, and a refusal is answered with `statusCode: 0`,
the sentence in `errorMessage` and the rule's code in **`refusalCode`** (`unsendable_header`, `empty_header_name`, `invalid_header_name`, `colliding_header_names`, and the two codes of [`targetPolicy`](#post-execute) below); a streaming send answers a `400` under the same code.
The member is absent on any other answer.
A preview, a tab title, the unresolved-token painting and "Copy as cURL" show what compose returned, so for a scripted request a preview shows `{{token}}` where the wire will carry the value the script set (the Code section says so).
**A load run runs this pass per submission only where it has one** (a collection load run's steps, a single-request run that declares `requestElements`), and under load it never refuses: see [Authentication](authentication.md#authentication) and [Scenario load runs](scenario-load.md#scenario-load-runs).

**Request:**
```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": [                         // Optional, the lines to send, in order - see below
    { "name": "Content-Type", "value": "application/json" }
  ],
  "body": {
    "mode": "json",
    "content": "{\"name\":\"John\"}"
  },
  "requestId": "req_1234567890",      // Optional, links to saved request
  "requestName": "Create user",       // Optional, read by scripts as pm.info.requestName
  "environmentId": "env_1234567890",  // Optional, uses environment variables
  "collectionId": "col_1234567890",   // Optional, the collection scope of a request no row names - see below
  "timeout": 30000,                    // Optional, ms, 1-86400000 - see below
  "elements": [                        // Optional, typed behaviours - see Elements. The only
                                       // script source; preRequestScript/postRequestScript(s)/tests
                                       // are refused (400, naming "elements"), and so is a list
                                       // the element registry refuses - see below
    { "kind": "script.post", "config": { "script":
      "pm.test('Status is 200', () => pm.expect(pm.response.code).to.equal(200));" } }
  ],
  "allowScriptRequests": false,        // Optional, default false - see below
  "followRedirects": true,             // Optional, default true
  "maxRedirects": 10,                  // Optional, default 10
  "verifySSL": true,                   // Optional, default true - stored per request and
                                       // settable in the request builder's Settings tab
  "httpVersion": "auto",               // Optional: "auto" | "http1.1" | "http2", default "auto"
  "transient": false,                  // Optional, default false - see below
  "persistVariables": true,            // Optional, default true - see below
  "includeParsedBody": true,           // Optional, default true - see below
  "origin": { "kind": "app" },         // Optional, who started the run - see below
  "targetPolicy": {                    // Optional, the hosts this send may reach - see below
    "allowAll": false, "allowedHosts": ["api.example.com"]
  },
  "stream": false,                     // Optional, default false - see below
  "maxStreamDurationMs": 600000,       // Optional, streaming only - see below
  "maxStreamEvents": 100000,           // Optional, streaming only - see below
  "data": { "id": "7" },               // Optional, one data row - see below
  "disabledDefaultHeaders": [],        // Optional, headers Vayu adds that this send refuses
  "disableCookies": false,             // Optional, default false - stored per request, see below
  "disabledSystemHeaders": [],         // Optional, default [] - stored per request, see below
  "disableUrlEncoding": false,         // Optional, default false - stored per request, see below
  "bodyModeHeaders": ["Content-Type"]  // Optional, which `headers` the body mode wrote - see below
}
```

**`headers` is the request's header lines, in send order** (issue #2466): an array of `{"name", "value"}` objects, each sent as its own line in the order given and in its own spelling, so a name may repeat (`Link`, `Forwarded`, two `Accept` rows, `X-Dup` beside `x-dup`) and the authored order is the wire order.
The older object form (`{"Accept": "application/json"}`) is still accepted and behaves as it always did: one line per key, so it cannot repeat a name.
A line without a string `name` and a string `value`, or `headers` of any other type, is a `400`.
A name is **trimmed of the spaces and tabs around it** and what is left must be an RFC 9110 token: one that is not (`X Bad`, `X:Bad`, `X-é`) is a `400` with code `invalid_header_name` quoting the name, in either shape and before any run row exists (a name still holding a `{{token}}` waits for the residual pass below, which judges it once resolved);
a name of only padding is the empty name the residual pass refuses (`empty_header_name`).
The refusal and the trim are the ones [`POST /compose`](compose.md#post-compose) documents.
`POST /runs` reads the same field the same way, and refuses a single-request run's bad name with the same `400` before the run row exists.
What the engine adds (an auth header, the body-implied `Content-Type`, the [defaults](health-config.md#default-request-headers)) is added only under a name no line already carries, compared without case; a typed `Authorization` sent twice is sent twice and auth adds none.

**`timeout` is the whole-transfer deadline in milliseconds** (issue #1917), held to `1`-`86400000` and defaulting to the `defaultTimeout` setting when absent or `null`.
A stored request's own `timeout` (issue #2937) reaches this field the same way: [`POST /compose`](compose.md#post-compose) by `requestId` writes it into the payload only when the request states one, so a composed send takes the inline overlay's `timeout`, else the stored request's, else the setting.
A number outside that range, or a value that is not a number, is a `400` naming `'timeout'` before any run row exists and with nothing sent: libcurl reads `0` as "no timeout", and a negative value is a rejected option the transfer then runs without.
`POST /runs` holds the same bound (see its [run config table](load-runs.md#post-runs)).
Connecting (TCP and the TLS handshake) is additionally capped at 30 seconds (issue #2835), so a `timeout` above that does not extend how long a dead target is waited on.
A streaming send does not apply it to the transfer (see `stream` below) but refuses a malformed one all the same.
In a load run the latency histograms hold one hour at most (issue #2790): a completion longer than that, a timeout above `3600000` that ran out, is counted at one hour, so a percentile or `max` it reaches reads about `3600000` ms (within 0.1%) rather than the true duration, and the sample is never left out.
The same deadline bounds the OAuth 2.0 token request an `auth` block makes (issue #2833), a refresh, the wait for another call's refresh of the same token, and the fresh grant a rejected refresh falls back to counted together: a token endpoint that does not answer within it fails the send as `AUTH_FAILED` with `authErrorCode` `oauth2_timeout`, and the request itself is never sent.
It is also the default timeout of every `pm.sendRequest` the send's scripts make, buffered or streamed; a call's own `timeout` option replaces it, and the script's remaining budget can only lower either ([Scripting](../scripting.md#sending-a-request-from-a-script-pmsendrequest)).

**`requestId`, `environmentId` and `collectionId` must be strings** (issue #1917, `collectionId` since #3461): an id of any other JSON type (`"requestId": 7`) is a `400` naming the field - `'requestId' must be a string (got number)` - before any run row exists.
Absent and `null` mean no link.
`POST /runs` reads the same three fields under the same rule.

**The collection scope of a send is decided once** (issue #3461): the collection of the request row `requestId` names, when there is a live one, and otherwise `collectionId`, the member [`POST /compose`](compose.md#collectionid-on-the-answer) writes on an inline request's answer - composition's own precedence, so a request field and a script read one chain.
Its chain is what the pre-request and post-request scripts read and write (`pm.collectionVariables` answers the leaf's names and its ancestors', and a `set()` is stored on the leaf alone, never on an ancestor), what the names deferred past the pre-request script resolve against, and what the run's `configSnapshot` is masked against.
An id naming nothing, unknown or in the Trash since composition, is an empty collection scope and the send goes out, never a refusal, as composition treats it.
The field rides into `configSnapshot` with the rest of the payload, which is how a stored run records the scope it sent under.

**`disabledDefaultHeaders` refuses what the engine would add** (issue #1229).
The engine adds a small declared set to every request that does not name it - see [Default request headers](health-config.md#default-request-headers) - and a testing tool has to be able to send exactly the request that was written, including one with no `User-Agent` at all.
Names are matched case-insensitively; the field is accepted on `POST /execute` and `POST /runs` alike.
A value that is not an array of header names is a `400` naming the field, because a malformed opt-out would otherwise read as one that did nothing.
A name matching no current default is accepted and does nothing: config can switch a default off between the moment a client read the declared set and the moment it sends.
A name is checked as a header token only, so `User-Agent`, `Accept-Encoding` and `Content-Type` are all accepted (until issue #1765 the correlation-id validator refused those three with a `400`).

**`disableCookies` / `disabledSystemHeaders` / `disableUrlEncoding` are the request's stored Postman protocol settings** (issue #1765; see [POST /requests](requests.md#post-requests)).
`POST /compose` always emits them from the stored row and the app always sends them, on `POST /execute` and `POST /runs` alike, because each defaults to off: an omitted `true` would send the jar, the header or the encoding the user turned off.
`disabledSystemHeaders` is unioned with `disabledDefaultHeaders`, which stays the per-send, never-stored opt-out, and is refused on the same shape rules.
`disableCookies` takes the jar off the buffered and the streaming send and off a scenario load run's per-virtual-user session (the step neither sends nor updates it); a single-request load run never tracks cookies at all.

**`bodyModeHeaders` names the headers the body mode wrote** (issue #1765): the header names whose last row carried `"source": "body-mode"`, compared without case.
A `headers` line has no room for the marker, so `POST /compose` emits this list from a stored request's rows (only when it names something) and the app sends it beside an inline request's headers; inline `headers` replace the stored ones, so the stored list is dropped with them.
A name in it that `disabledSystemHeaders` or `disabledDefaultHeaders` refuses is left off the wire, as Postman leaves off the body's Content-Type as a system header; a name not in it is the user's and is sent.
A value that is not an array of strings is a `400`.

**`stream` consumes a `text/event-stream` response live** (issue #573) instead of buffering it.
It changes the *execution model*, so it is declared rather than detected: the engine creates the run row, hands the transfer to a managed consumer worker, and answers **`202`** at once with the run and the URL its events arrive on.
Nothing about a non-streaming send changes.

```json
{
  "runId": "run_1234567890",
  "eventsUrl": "/runs/run_1234567890/events",
  "status": "running"
}
```

The worker parses SSE frames into a bounded in-memory ring that [`GET /runs/:runId/events`](live-metrics.md#get-runsrunidevents) relays, and writes the stream into the run's stored trace when it ends, so History restores the timeline.
The cookie `warnings` a buffered send answers with (issue #3315) are written to the same stored trace, at its top level; the `202` carries none.

The final hop's bytes are the stored `response.body`, whatever its `Content-Type` (issues #3238, #3770): a `text/event-stream` reply's `event:`/`data:` bytes, a JSON `404`, NDJSON or chunked text alike, up to `maxDesignResponseBodyBytes`, the bound a buffered send reads under.
Past it the body is a prefix and the trace says so with `bodyCapped: true`, as on a buffered send; the stream itself still ends only by the rules below, and every byte still reaches the SSE parser, so a server that streams SSE under the wrong type still delivers its events.
The stored `response` carries `bodyBytes`, the body bytes the server delivered, whatever was kept: the relay carries no body, so the stored trace is where it lands.
The declarative elements and the post-request script read the same bytes, so `assert.contains`, `assert.size`, `extract.regex` and `pm.response.text()` judge a streamed Send as they judge a collection or load run's.

The bytes are stored once (issue #657).
The trace's `events` node is served as `{items, totalEvents, eventsTruncated, endReason, streamText?, startedAt?}` (each item `{event, data, sourceId?, dataTruncated?, dataBytes?, text?, receivedAt}`),
but the list is parsed from the stored body when the trace is read ([`GET /runs/:runId/results/:resultId`](runs.md#get-runsrunidresultsresultid), the report's `results[]` and `GET /runs/:runId`'s `result`): what the row stores is the sidecar `{totalEvents, endReason, maxEventBytes, receivedAt: [ms, ...], streamTextPath?, startedAt?}`, one arrival time per event `sseMaxStoredEvents` kept.
`startedAt` (issue #3805) is when the transfer began, in epoch milliseconds on the clock `receivedAt` reads, so `receivedAt[0] - startedAt` is the wait for the first event; it is absent - never `0` - for a stream refused before its transfer began and for a row stored before the key, and is served as stored.
The served list stops at the shorter of that and `totalEvents`, and `eventsTruncated` is `true` when either the list is shorter than `totalEvents` or the body is a prefix (`bodyCapped`, or `bodyTruncated` from `maxTraceBodyBytes`).
A trace stored before #3770 carries its `items` and is served as stored.

**`streamTextPath` reads the reply out of the events** (issue #3773).
A JSONPath in the subset the [elements](../elements.md#kinds) read, evaluated on each event's `data` parsed as JSON: `$.choices[0].delta.content` for an OpenAI-compatible chat completion, `$.delta.text` for an Anthropic-style `content_block_delta`.
The engine sniffs no provider; the path is declared.
An event's `text` is the path's **first** match, a string as it is and a number or boolean as its JSON text.
An event carries no `text` key at all (absent, not `""`) when the path matches nothing (a role-only chunk, a ping), matches `null`, an array or an object, when its `data` is not JSON (`[DONE]`), and when it was cut at `sseMaxEventBytes` (`dataTruncated`), whose data is only a prefix of the JSON.
Each relayed `message` frame carries its `text` as it arrives.
The stored sidecar keeps the path and never the text: a read derives each item's `text` and the node's **`streamText`**, every event's `text` joined with nothing between, from the stored body.
`streamText` covers every event the body holds up to `totalEvents`, the ones past `sseMaxStoredEvents` included, so it is the whole reply unless the body is a prefix (`bodyCapped` / `bodyTruncated`, which `eventsTruncated` also reports).
With no path the node has no `streamText` and no item has `text`.

```json
{
  "method": "POST",
  "url": "https://api.openai.com/v1/chat/completions",
  "stream": true,
  "streamTextPath": "$.choices[0].delta.content"
}
```

A UTF-8 byte-order mark at the very start of the stream is dropped, as the EventSource specification requires (issue #1917); without that the first line's field name would carry the mark and the first event would be lost.
One mark is dropped, however its three bytes are split across reads, and only at the start.

**Every stream ends, and the run says why.**
Seven terminations, never "the timeout happened to fire":

| Reason | What happened |
|--------|---------------|
| `completed` | The server closed the stream |
| `stopped` | [`POST /runs/:runId/stop`](runs.md#post-runsrunidstop) |
| `shutdown` | The engine shut down under the stream ([`POST /shutdown`](health-config.md#post-shutdown) or a signal), which no user asked for (#3342). The run ends `stopped`, as a load run still sending does; this reason is what tells it from a user's Stop |
| `maxStreamEvents` | The event cap was reached; the list ends exactly at the cap, however the server packed events into writes (an unterminated event behind the last one is not flushed) |
| `maxStreamDurationMs` | The duration cap elapsed, counted from the first hop of a redirect chain |
| `idleTimeout` | Nothing arrived for `sseIdleTimeoutMs` on a made connection; a header line counts as arriving, and each redirect hop's own connect is bounded by the connect deadline below, not counted as silence. The stream ends within a couple of seconds of the setting (the engine checks about once a second) |
| `error` | The transfer failed (a refused or timed-out connect, TLS, a protocol error, a redirect the chain refused); the run ends `failed` with the error fields set. Also what an end nobody recorded reads as, which the engine logs, since it is not known to be a completion |

The whole-transfer `timeout` is deliberately **not** applied to a stream - it would kill a healthy one mid-flight.
Two deadlines apply instead: connecting (TCP and the TLS handshake, on every redirect hop) is bounded by the smaller of `timeout` and 30 seconds (issue #2835), and once connected the idle one bounds silence; the two caps above are what bound a stream that talks forever.
A connect that runs out ends the stream as `error` with `errorCode` `TIMEOUT`, as a refused connection does, never as `idleTimeout`.
`maxStreamDurationMs` (1000–86400000) and `maxStreamEvents` (1–10000000) override the configured defaults per request; sending either **without** `"stream": true` is a **400**, since a cap that quietly did not apply is worse than no cap.

Refused with a **400** rather than silently reinterpreted:

- a non-boolean `stream` (`'stream' must be a boolean`);
- `"stream": true` with `"transient": true` - a stream **is** its run row: the row is what `eventsUrl` names, what carries the status, and what a stop finds, and a transient execution creates none;
- a `streamTextPath` that is not a string or not in the JSONPath subset (a filter, no leading `$`), and one **without** `"stream": true`, since a buffered send has no events to carry `text`.
  [`POST /runs`](load-runs.md#post-runs) reads the field the same way on a single-request run and refuses it on a collection run, whose steps read their stored requests' own.
  A saved request stores it too ([`POST /requests`](requests.md#post-requests)), and a by-id [`POST /compose`](compose.md#post-compose) carries it;
- a `streamFirstContentMarker` (issue #3774) that is not a string, is empty, is longer than 256 bytes or holds a NUL byte, and one **without** `"stream": true`.
  A Send checks it and times nothing with it, so a by-id compose's payload sends as it is: each relayed event carries its own `receivedAt`.
  A run times its stream to it ([`POST /runs`](load-runs.md#post-runs), `stream.timeToFirstMatch`).

**Scripts run on a streaming request** (issue #575), and were refused until they did.
The pre-request script runs before the transfer starts, exactly as on a buffered send, so its `pm.request` edits reach the wire.
The post-request script runs **once, after the stream has terminated**, and reads the bounded list parsed from the stream's bytes, the one its stored trace is served with, as `pm.response.events` with `pm.response.totalEvents` and `pm.response.eventsTruncated` beside it -
a script runs to completion, its timers included, before anything is reported, so a live per-event callback is not a feature that was skipped but one the runtime cannot have.
The same three properties reach every run that streams: a collection run's streaming step and a load run's post-request script, inline or deferred (issue #3769).
A stream whose request declared a `streamTextPath` also binds `pm.response.streamText`, the stored trace's `streamText`, and each entry's `text` (issue #3773), on a Send and on every run that streams alike.
See [Scripting](../scripting.md#pmresponseevents---a-streamed-runs-events).

Because the route has already answered `202`, a streaming run's script output has nowhere to be *returned*: the trace's `scripts` node is the only route it takes.
That node is not a streaming feature - every design send stores it (issue #725), with the same keys the buffered response body carries (`testResults`, `consoleLogs`, `preScriptError`, `postScriptError` and, since #3633, `scriptRequests`).
One engine object fills both, so a live pane and a restored one cannot disagree.
A run whose scripts said nothing stores no node at all.

Tuning: `sseMaxRetainedEvents`, `sseMaxEventBytes`, `sseMaxStoredEvents`, `sseMaxStreamDurationMs`, `sseMaxStreamEvents` and `sseIdleTimeoutMs` (see [GET /config](health-config.md#get-config)).

**`transient` runs the request without recording it** (issue #382).
The execution is otherwise identical - same composition, the cookie jar named by `environmentId`, the same scripts, the same response body - but the engine creates **no run row**: nothing appears in `GET /runs`, no result trace is written, and the count-based retention prune does not run, so no existing run is evicted.
Because the trace is where the post-auth request headers would have landed, a transient execution is also the only way to send with resolved credentials and leave none of them on disk.

Absent and `null` both mean `false`; a present non-boolean is a **400** (`'transient' must be a boolean`) rather than a silent `false`, because a caller that asked for privacy must not be quietly refused it.
The flag is **not valid on `POST /runs`** - a load or scenario run *is* the row it creates (the run id is the endpoint's return value), so sending it there is a **400** with `errorCode: "invalid_run_config"`.

The one caller today is the app's GraphQL schema introspection (`lib/graphql/introspect.ts`), a background fetch the user never made.
MCP's `run_request` deliberately does **not** set it: an agent's runs belong in History like anyone else's, and the tool builds its payload from named arguments, so an agent cannot supply the flag either.

**`origin` says who started the run** (#1817):
`{"kind": "app" | "mcp" | "other", "client": "<name>"}`, stored on the run row (`runs.origin` / `runs.origin_client`, see [the `runs` table](../db-schema.md#runs)) and returned on every run shape - [`GET /runs`](runs.md#get-runs) rows, [`GET /runs/:runId`](runs.md#get-runsrunid) and [`PUT /runs/:runId/baseline`](runs.md#put-runsrunidbaseline) - as `origin: {kind, client}`.
It is **client-asserted metadata, not identity**: any caller can claim any kind and nothing authorises on it; History reads it to say which runs an agent started.
The app sends `{"kind": "app"}`; the MCP server sends `{"kind": "mcp", "client": "<clientInfo.name>"}` with the name its client gave in the initialize handshake.

- Absent or `null` stores `other` with no client.
  `other` is also what every run recorded before the field existed reads as.
- `client` is kept for `mcp` only and dropped for `app` and `other`.
  It is trimmed of whitespace and cut to 128 characters (on a character boundary, never inside a UTF-8 sequence); one that is empty after trimming stores no client.
  Otherwise it is stored exactly as sent: turning an identifier into a product name is the client's job, so a new MCP client needs no engine change.
- A non-object `origin`, a `kind` outside the three (a missing one included) or a non-string `client` is a **400** naming the field, for example `'origin.kind' must be one of app, mcp, other`, before any run row exists and with nothing sent.
  A `transient` send reads and validates it the same way and stores nothing.
- The object is kept out of `config_snapshot`: the row's two columns are its one record.

[`POST /runs`](load-runs.md#post-runs) takes the same field under the same rules.

**`targetPolicy` holds the send to the hosts its caller allows** (#2521): `{"allowAll": boolean, "allowedHosts": string[]}`, both members optional.
The MCP server checks its allowlist against the *composed* URL, but a pre-request script can assign `pm.request.url` or set the variable a deferred `{{host}}` resolves from, so the caller also hands the engine the rule and the engine applies it to what it is about to send.
It is the caller's session rule, changing per request, and rides on the payload rather than in config.

- **What is judged.**
  The host of the URL as it will be dialled (the wire URL, after the pre-request script, the residual pass and the URL encoding), and, before any token is read from the cache or fetched,
  the host of an OAuth 2.0 config's `accessTokenUrl` and `refreshTokenUrl` (whichever are set, both whether or not this send would reach the refresh one, so the answer does not depend on what the cache holds), each also as the token request will dial it (#3162), so `http://evil.example\@idp.example/token` is judged as `evil.example`.
  A script can set an `accessTokenUrl` as easily as the request's URL, and the token request carries the client secret; a refused target fetches no token.
- **The match** is the MCP server's: the hostname as a WHATWG URL parser reports it (no port; an IP literal in its canonical spelling, an internationalised name by its punycode form), compared exactly with each `allowedHosts` entry once that is trimmed and lower-cased.
  There is no wildcard.
  `allowAll: true` passes any host that can be determined.
  A host that cannot be - an empty one, or one still holding a `{{template}}` nothing answered - is refused whatever the policy says.
  `{}` allows no host.
- **A refusal** never reaches the network.
  A buffered send answers `statusCode: 0`, an `errorCode` of `INVALID_URL`, the sentence naming the host in `errorMessage`, and `refusalCode` `target_not_allowed` (a host the policy does not list) or `target_host_unknown` (no determinable host); an OAuth 2.0 token endpoint it refuses at the build is answered the same way, and not as an auth failure.
  A streaming send answers a `400` carrying the same code before its stream opens.
- **A malformed policy** - not an object, an `allowAll` that is not a boolean, an `allowedHosts` that is not an array of strings, or any other member (so a misspelt `allowedHost` cannot quietly allow nothing) - is a `400` with code `invalid_target_policy`, before anything is recorded or sent.
  Absent or `null`, a send reaches whatever its request names.
- **It is never stored.**
  The top-level member is dropped from a run's `config_snapshot` (as `origin` is), and a run holds it in memory only.
- **What it does not cover:** the hops of a redirect a server answers with, and the requests a script makes with `pm.sendRequest`.

[`POST /runs`](load-runs.md#post-runs) takes the same field; see there for how a collection or load run is held to it.

**`data` binds one row to this send** (issue #601).
It is the single-send half of a run's `scenario.data`: every `{{data.column}}` in the URL, the header names and values, the body and both halves of every form field is substituted against it, and both scripts read it as `pm.iterationData` with `pm.info.iteration` `0` and `pm.info.iterationCount` `1` - the send *is* row 0 of 1.
Without the field nothing changes: `{{data.*}}` goes out written as it stands and `pm.iterationData` is `undefined`.

**The row's own keys are also its bound bare names** (issue #1007): the send derives its `dataColumns` set from `data`'s keys itself, so a bare `{{username}}` binds from the row exactly as `{{data.username}}` does, at the same precedence [D18](../../app/variable-resolution.md#d18---a-bound-rows-bare-column-names-outrank-the-environment-issue-1007) gives it.
A bare name the row does not carry is not deferred in the first place - it is an ordinary `{{name}}`, resolved from the scopes at compose time or, if nothing there answers either, by the residual pass after the pre-request script (issue #1008).

An **object** of name/value pairs, never the array a run sends - one row.
The row is bounded by `maxScenarioDataBytes` (the same setting a run's whole set is measured against) and composes freely with `transient` and `stream`: a streaming send binds the row before the transfer opens, so the URL and headers it opens with are the bound ones.

Refused with a **400**, before any run row exists and with nothing sent:

| What | Message |
|------|---------|
| `data` is not an object | `'data' must be an object of name/value pairs (got array). A single send binds one row; a set of rows is a collection run.` |
| over the byte cap | `'data' is N bytes, over the limit of M (raise the 'maxScenarioDataBytes' setting to allow more)` |
| a column nested deeper than 100 levels | `'data' column 'name' is nested deeper than 100 levels` - refused before the row is measured (issue #2362); a column nested exactly 100 levels is accepted |
| a token names a column the row lacks | the binder's own sentence, naming the token, the row and the row's columns |
| a `null` cell, a header collision, a header name bound to nothing, an unwritable XML placement | the binder's own sentence - identical to a run's, see [Scenario runs](scenario-runs.md#scenario-runs) |
| an OAuth 2.0 config carries a `{{data.*}}` token | `Auth credentials carry {{data.client}} in an OAuth 2.0 configuration, and no row can reach it: ...` |

**Credentials bind here too** (issue #642).
A `{{data.user}}` in a basic-auth username, a bearer token or an api key is substituted from the row like any other field, and it is bound **before** the credentials are encoded - so basic auth base64s the row's values, and an api key in the query is encoded by the [query rule](compose.md#query-encoding) after the substitution rather than before.
This is the same deferral a collection run performs per iteration (issue #591): the credentials are parsed and kept typed, the request is built without resolving them, and the auth is applied once the row has reached it.

**OAuth 2.0 is the one mode a row cannot reach**, and it is refused by name rather than sent wrong.
Its token is acquired against the token endpoint instead of being written into the request, so there is no moment at which a bind could happen - exactly the reason a scenario run refuses the same config.
Use a static credential there, or move the data token into the request itself.

**`requestName` is script identity, not an HTTP field** - it never reaches the wire.
The scripts read it as `pm.info.requestName` (with `requestId` as `pm.info.requestId`); a client sends it because Send executes editor state, which may be unsaved and therefore have a name no stored row carries.
Absent, the engine falls back to the name of the row named by `requestId`, so linking an id is enough.
An empty string is treated as absent - a script reads `undefined` rather than `""` - and a non-string is a **400** (`'requestName' must be a string`).
See [scripting.md](../scripting.md#script-identity-pminfo).

**`allowScriptRequests` lets this payload's scripts use `pm.sendRequest`.**
Absent, `null` or non-boolean all mean `false`, and that default is a security control rather than a convenience (issue #302): Vayu's MCP target allowlist is checked in the MCP server, before it calls this endpoint, and held by the engine to the URL a send is about to dial ([`targetPolicy`](#post-execute)), so a request issued from inside a script with `pm.sendRequest` never passes either.
Denying unless a caller asks means a client that forgets gets a script that cannot send rather than unchecked egress.
The app's Send and load runs send `true`; the MCP server never does.
`POST /runs` reads the same field for a `script.post` element's deferred validation (its [`requestElements`](load-runs.md#the-requestelements-array-a-single-request-runs-own-step-level-elements)), so one script behaves the same on both.
Read **before** the `stream` branch, so a streaming send's scripts are governed by it exactly as a buffered send's are - the app sends it on both halves of Send (issue #653).
See [scripting.md](../scripting.md#sending-a-request-from-a-script-pmsendrequest).

**`elements` is the only script source, and it runs** (issue #1514's cut-over, replacing #1513's `preRequestScript(s)` / `postRequestScript(s)`).
A caller still sending any of `preRequestScript`, `preRequestScripts`, `postRequestScript`, `postRequestScripts` or `tests` - even naming one with `null` is accepted as a no-op, but a real value is not - is refused with a `400` naming `elements` as the replacement, before any run row exists.
For the by-id path, an element list a caller supplies inline is laid over `POST /compose`'s own resolved chain (collection root to leaf, then the request's own, minus anything disabled or named by an `inherit.disable` entry, each stamped with `origin: {kind: "collection" | "request", scope, id, name?}`) exactly as any other inline field overlays the stored one;
an inline-only send has no chain to resolve one from, so its elements carry no `origin`.
`scope` is `collection` for the root, `folder` for every collection below it and `request` for the request's own (#2522); `kind` keeps its two values.
It is what each script result's `scope` (below) is read from, falling back to `kind` for an `origin` that carries none.

**`elements` is validated like a stored request's** (#3052):
a list the element registry refuses (an unrecognized kind, the message listing every kind the registry holds (#3559), a setting the kind does not declare, a pattern that does not compile, an assertion with nothing to compare against,
a repeated id, a `script.setup` on the request, a value that is not an array) is a `400` carrying the message [`POST /requests`](requests.md#post-requests) answers for the same list, before any run row exists and with nothing sent.
An entry without an `id` is given one rather than refused.
The list is a composed one, so an entry whose `origin.kind` is `collection` (a collection or folder level) is judged as a collection's own, each on its own: it may be a `script.setup` or `script.teardown`, and ids repeated across levels are allowed.
Every other entry is judged together as a request's, and an `Item N` in a refusal counts within those.
`null` or an absent `elements` sends none.

`vayu::core::ElementPipeline` runs the compiled list at each phase this send reaches: `script.pre` elements at `step.before`, immediately before the transfer (so a `pm.request` edit reaches the wire); `extract.*` / `assert.*` / `script.post` elements at `step.after`, once the response (or, for a streaming send, the terminated stream) is in.
Every level's script runs, in list order, and each one's tests and console lines are added to the step's result rather than replacing an earlier level's (#2522).
`assert.*` outcomes append to the same `pm.test()` channel a `script.post` element's assertions do, so the response body's `testResults` and `consoleLogs` (see below) do not distinguish a declarative assertion from one a script wrote by hand.
The response body and the stored trace both carry an `elements` array beside `scripts` -
one entry per element that ran, each `{id, kind, name?, origin, required?, outcome, message?, waitedMs?}` (`name` the element's own label, when it has one;
`required` present, as `true`, only for an element whose `config.required` is, which makes an extractor's `missing` a failed send) with `outcome` one of `ok` | `failed` | `missing` | `skipped` | `error` (a disabled element reports `skipped` without its `apply` ever running;
a script element reports `error` with the thrown message when its script threw and `failed` with the first failed `pm.test` as its message when only assertions did not hold; an `assert.*` that reports `error` because its own config cannot be judged, a row stored before #3043, also adds a failed entry to `testResults` under the same message, so the send fails) -
see [Elements](../elements.md#the-step-trace).

**The pre-request script can change what is sent.**
Its `pm.request` edits - method, url, headers, body - are applied to the request before it goes out, and because auth is resolved *before* the script runs, a script-set `Authorization` overrides the one the engine applied.
A credential that waits on the script (#2473) is applied after it instead, and a script-set `Authorization` still wins: auth never replaces a header the request already carries.
`requestHeaders` and `rawRequest` in the response below, and the stored trace behind `GET /runs/:id`, all report the post-script request.
A value the engine cannot send (a non-string url, an unknown method) rejects the whole write-back, leaves the request unchanged, and is reported as `preScriptError`.
See [scripting.md](../scripting.md#mutating-the-request-pre-request-scripts).

**Redirect policy.**
`followRedirects` defaults to **true**, so omitting it follows every 3xx and the final response is returned as the answer, with the earlier hops' status and header lines on its `redirects` member (field notes below the response example) - send `followRedirects: false` to make the 3xx itself the answer.
A chain longer than `maxRedirects` (default 10) fails the send with `TOO_MANY_REDIRECTS` rather than returning the last 3xx.
Both clients send these explicitly for exactly that reason (see [api-integration](../../app/api-integration.md)).
`POST /runs` accepts the same three fields with the same defaults, so a load test can be run under the policy the request was configured with.

**TLS verification.**
`verifySSL` defaults to **true** and is stored on the request (`requests.verify_ssl`, the Settings tab's *Verify TLS certificate* row).
Both clients send it on every execute and every load test rather than eliding the default, for a stronger reason than the redirect policy above: an omitted `false` **verifies** the certificate the user turned verification off for, so the request fails against the one host the setting exists for.
Off skips both the chain and the hostname check (`CURLOPT_SSL_VERIFYPEER` and `CURLOPT_SSL_VERIFYHOST`), which is why the app paints the state as a warning.
To keep verification on for a host with an internal authority, add the CA under [TLS trust settings](health-config.md#tls-trust-settings) instead.

**A redirect hop's cookie stays with the origin that set it.**
On a design send, a stream and a scenario load run's per-virtual-user session, a `Set-Cookie` returned by one hop is stored in the [cookie jar](cookies-and-certificates.md#cookies) under the origin that set it, exactly as before, but is applied to the follow-up request only when that request's origin - scheme, host **and port** - is the same.
A redirect that changes any of the three therefore starts without the hop's cookie: that includes a port-only change (`127.0.0.1:8080` to `127.0.0.1:9090`) and a hop to a sibling domain.
A same-origin hop is unchanged, and a hop back to the origin that set the cookie carries it again.
Later requests use the jar as normal.
This is Vayu's own rule, held by the engine's redirect loop, and it is not configurable.
The reason is the one behind curl's hardening in 8.21.0 (`http: don't pass on set cookies to new origins`, #679): what one origin handed the client is not the next origin's to read. libcurl's cookie engine matches by host and path alone, so without the rule a cookie set on `127.0.0.1:8080` would ride a redirect to `127.0.0.1:9090`.
A flow that depended on a cookie surviving a cross-origin hop (a login that bounces through an identity provider is the usual shape) sends the follow-up request without it.
A hop's `Set-Cookie` is reported in `redirects` whether or not a later hop carried it, so the member says what the server sent, not what went on to the next origin.

**Protocol.**
`httpVersion` selects which HTTP version curl attempts: `"auto"` lets ALPN negotiate (curl's own default), `"http1.1"` forces HTTP/1.1, and `"http2"` attempts h2 over TLS and falls back to 1.1 (`CURL_HTTP_VERSION_2TLS` - against a plain `http://` URL this silently negotiates 1.1, since h2 is not offered over cleartext).
A server on `http://` that speaks only h2c answers that HTTP/1.1 request with its HTTP/2 preface, and the send fails as `PROTOCOL_MISMATCH` with a hint naming h2c (the transport error codes are described under [Proxy settings](health-config.md#proxy-settings)); serve it over TLS or let it accept HTTP/1.1, since Vayu never sends h2c.
This is what was *requested*; the response's own `httpVersion` (below) reports what was actually negotiated, and the two can differ.
The renderer always sends this field on every execute, never eliding it even when it equals the default - the same rule `followRedirects` follows, and for the same reason: an omitted field lets an engine-side default win silently.
MCP's saved-request paths get the same guarantee from `POST /compose`, which always emits a stored request's execution options;
its two ad-hoc tools (`run_request` / `start_load_run`) forward `httpVersion` only when the caller supplies it, since there is no saved request behind an ad-hoc call for an omission to silently override (see [mcp/request-composition.md](../mcp/request-composition.md#request-composition)).
It governs **both** Send and load test - `POST /requests`/`PUT /requests/:id` is where a request's protocol is actually stored (see [Requests](requests.md#requests)); [`POST /runs`](load-runs.md#post-runs) is simply the run-shaped way of stating the same field, not a second store.

**Response:**
```json
{
  "runId": "run_1234567890",
  "resultId": 42,
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json"
  },
  "headerLines": [
    { "name": "Content-Type", "value": "application/json" }
  ],
  "redirects": [
    {
      "status": 302,
      "statusText": "Found",
      "headerLines": [
        { "name": "Set-Cookie", "value": "session=abc; Path=/" },
        { "name": "Location", "value": "/users" }
      ],
      "url": "https://api.example.com/login",
      "schemeDowngrade": false
    }
  ],
  "requestHeaders": { "accept": "*/*" },
  "requestHeaderLines": [
    { "name": "accept", "value": "*/*" }
  ],
  "rawRequest": "GET /users?access_token=... HTTP/1.1\n...",
  "method": "GET",
  "url": "https://api.example.com/users?access_token=...",
  "authQueryParam": "access_token",
  "body": { "id": 1, "name": "John" },
  "bodyRaw": "{\"id\":1,\"name\":\"John\"}",
  "bodyEncoding": "utf8",
  "bodySize": 20,
  "bodyCapped": false,
  "httpVersion": "HTTP/1.1",
  "httpVersionDowngraded": true,
  "warnings": [],
  "timing": {
    "totalMs": 245.5,
    "wireMs": 245.1,
    "queueWaitMs": 0.4,
    "dnsMs": 5.2,
    "connectMs": 12.3,
    "tlsMs": 45.1,
    "firstByteMs": 180.2,
    "downloadMs": 2.7,
    "engineMs": 3.4,
    "scriptMs": 118.6
  },
  "testResults": [
    {
      "name": "Token was issued",
      "passed": true,
      "source": "pre",
      "scope": "collection"
    },
    {
      "name": "Status is 200",
      "passed": true,
      "source": "test",
      "scope": "request"
    }
  ],
  "consoleLogs": [
    { "source": "pre", "scope": "collection", "level": "info",
      "message": "pm.sendRequest POST https://auth.example.test/token -> 200 (41 ms)",
      "scriptRequest": 0 },
    { "source": "pre", "scope": "collection", "level": "log", "message": "token refreshed" },
    { "source": "test", "scope": "request", "level": "error", "message": "unexpected shape" }
  ],
  "scriptRequests": [
    {
      "source": "pre",
      "scope": "collection",
      "startedAt": 1763452800123,
      "status": 200,
      "statusText": "OK",
      "request": {
        "method": "POST",
        "url": "https://auth.example.test/token",
        "headers": { "Authorization": "<redacted>", "Content-Type": "application/x-www-form-urlencoded" },
        "sentHeaders": { "Authorization": "<redacted>", "Content-Type": "application/x-www-form-urlencoded" },
        "sentHeaderLines": [ { "name": "Authorization", "value": "<redacted>" } ],
        "body": "grant_type=client_credentials"
      },
      "response": {
        "headers": { "content-type": "application/json", "set-cookie": "<redacted>" },
        "headerLines": [ { "name": "Set-Cookie", "value": "<redacted>" } ],
        "body": "{\"access_token\":\"tok_123\"}",
        "bodyBytes": 26,
        "httpVersion": "HTTP/1.1",
        "httpVersionDowngraded": false
      },
      "totalMs": 41.2, "wireMs": 40.8, "queueWaitMs": 0.1, "dnsMs": 0,
      "connectMs": 0.4, "tlsMs": 0, "firstByteMs": 38.9, "downloadMs": 1.1
    }
  ],
  "validation": {
    "checked": true,
    "valid": false,
    "matchedStatus": "200",
    "matchedContentType": "application/json",
    "failures": [
      { "path": "/id", "message": "Value type not permitted by 'type' constraint." }
    ],
    "failuresTotal": 1,
    "unevaluatedKeywords": [{ "keyword": "unevaluatedProperties", "count": 2 }]
  }
}
```

**`runId` and `resultId` name what a recorded send stored** (#3704): the run row and the id of its one `results` row, which [`GET /runs/:runId/results/:resultId`](runs.md#get-runsrunidresultsresultid) reads back whole, the trace's bodies at their stored length included.
A build that failed once the row existed (an OAuth 2.0 token refused or not acquired, see `refusalCode` below) is recorded too and answers both.
Both keys are **absent**, never `0` or `""`, from a [`transient`](#post-execute) send, which stores nothing, and from a send whose result row could not be written.
A streaming send answers its `runId` in the `202` instead.

**`bodyEncoding` says how to read `bodyRaw`** (issue #2458), and it is always present.
`"utf8"`: the whole body is valid UTF-8 with no NUL byte, `bodyRaw` is that text and `body` its JSON parse (or `null`).
`"base64"`: anything else - an image, a PDF, `application/octet-stream`, Latin-1 or Windows-1252 or UTF-16 text, a compressed body libcurl did not decode, text containing a NUL - and `bodyRaw` is the bytes in standard padded base64, `body` is `null`, and `bodySize` is still the number of bytes, not the length of the base64.
The check reads the whole body, not a sniffed prefix, and the engine decodes no declared charset: a body that is valid UTF-8 is `"utf8"` whatever its `Content-Type` says, and one whose `charset=utf-8` is wrong is `"base64"`, left for the client to decode by the declared charset.
A header value that is not UTF-8 has no such field and is answered with U+FFFD in place of each bad byte.

`bodyRaw` of a `"utf8"` answer is the byte-exact text received; `body` is the parsed convenience copy, whose member order is unspecified and in which a duplicate key collapses to the last value.
A client that shows or re-saves the body should use `bodyRaw`, as the app does (issue #2459).

`body` is also `null` on a `"utf8"` answer that is valid JSON in two cases (issue #2544): the request sent `includeParsedBody: false` (below), or the text is longer than 4 MiB (`MAX_PARSED_RESPONSE_BODY_BYTES`), whatever the request sent.
Past that size the engine does not build the parsed copy at all, because a JSON tree costs several times its text and the answer is serialised from it once more; `bodyRaw` still carries the whole body, up to `maxDesignResponseBodyBytes` below.
The key is always present.
Scripts, the schema check and the stored trace read the body itself, so none of them is affected.

So a response the server answered is a `200` whatever its bytes are; the end of this section has the `500` that remains.

**`bodyCapped` says the body is a prefix** (issue #1157).
A design-mode send reads at most `maxDesignResponseBodyBytes` (Settings → Limits, default 32MB); a response past that stops being read there, and `body` / `bodyRaw` / `bodySize` describe what arrived rather than what was sent.
The status and the headers are the server's own - they arrive before the body - so this is a successful response carrying a flag, not a transport failure.
The field is always present, so a client can tell "not capped" from an engine too old to say, and re-sending under the same setting reads the same amount: raise the setting to read more.
Two consequences worth stating, since both follow from reading less: a cut JSON body no longer parses, so `body` is `null` and a test script's `pm.response.json()` throws, and `validation` below reports `checked: false` with `body_not_json` rather than inventing a schema failure.
A body nested past 100 levels counts as not JSON for the same check, so a deep body is never walked by the schema validator (issue #2413).

The cap falls on a byte count, so it can land inside a UTF-8 character.
For a capped body only, `bodyEncoding` is decided with that incomplete last character (at most three bytes, and only bytes some continuation could still make valid) left out, and a `"utf8"` `bodyRaw` ends before it: a text body stays text rather than turning to base64 over its last character.
`bodySize` still counts every byte read, so it can exceed the UTF-8 length of `bodyRaw` by up to three.
A `"base64"` body is never trimmed, and a body that was not capped is judged whole.
The stored trace makes the same decision on the same bytes.

This is **not** the stored trace's `bodyTruncated` (see `GET /runs/:id`), which is `maxTraceBodyBytes` shortening a body for storage after the whole of it was read and shown - a re-send recovers from that one.
A design run whose live response was capped stores `trace_data.response.bodyCapped`, so a restored response says what the live one said.

A body the live answer sent as `bodyEncoding: "base64"` is stored the same way: `trace_data.response.body` holds the base64 and `trace_data.response` gains `"bodyEncoding": "base64"`.
The key is written only then; absent means the stored `body` is the text itself, which is what every row written before the field holds.
A collection run's step traces follow the same rule.

**`validation` is what the response was against the schema its contract declares** (issue #628), and it is **absent entirely** for a request whose collection ancestry binds no OpenAPI document.
That absence is load-bearing: a response nobody judged against a contract did not fail one, so there is no `checked: false` for it either.

The same object is stored on the design run's `trace_data.validation`, so a restored response shows the verdict the live one did rather than recomputing it.
A streaming send carries none - an event stream is not a document a response schema describes.

`testResults` lists **both** scripts' assertions in execution order, each naming the script that made it in `source` (`"pre"` / `"test"`, the spellings `consoleLogs` uses) - `pm.test` is bound in both phases, and until issue #810 a pre-request assertion failed a collection-run step while appearing in no list.
An entry stored before that carries no `source`; it is a test script's, which is all the list held.

A request runs the scripts of every level it inherits from - the collection's, each folder's from the outermost in, then its own - and every level's results are listed (#2522).
Each `testResults` and `consoleLogs` entry names its level in **`scope`**: `collection`, `folder` or `request`.
It is not `level`, which a console line already uses for the console method.
An entry stored before the field carries no `scope` and is the request's own; so is one from a payload whose `elements` carry no `origin`.
`success` folds the same way: a failing `pm.test` at any level is a failed assertion, and the first level that throws is the error.
`preScriptError` / `postScriptError` hold the thrown message as they always have when the request's own script threw (never empty or a bare `null`: a script that runs out of memory reads `Script ran out of memory at the 1 MiB limit`, see [Error Handling](../scripting.md#error-handling));
when an inherited level threw, they name it - "Collection pre-request script failed - <message>", "Folder test script failed - <message>".
An `assert.*` or `extract.*` element's entry carries the `scope` of the level that declared it.

**`scriptRequests` is every `pm.sendRequest` the scripts made** (issue #3633), one record per call in execution order, pre before test, in the stored trace's own shape (see [`GET /runs/:runId`](runs.md#get-runsrunid)) so a reader of a trace reads a record too:

- `request`, `response`, `error_type` / `error_message` and the eight `*Ms` timings are the trace's members for the call.
  `request.url` is the URL the transfer dialled, after `options.auth` and the Postman URL encoding; the redirect hops are `response.redirects`.
  A record has no `rawRequest`, so a reader synthesizes the raw view from `sentHeaderLines` as it does for a trace without one.
  A urlencoded body is recorded as the encoded bytes that went out; a `formdata` body is written by libcurl and has no `body`.
- `source` and `scope` are spelled as `consoleLogs` spells them, `scope` absent where no level was stamped.
  `startedAt` is when the call began, in epoch milliseconds.
  `status` is `0` for a transport failure, with the code in `error_type` and no `response` when nothing answered.
- The call's summary line in `consoleLogs` (the `info` line `pm.sendRequest <METHOD> <url> -> <status> (<n> ms)`) carries **`scriptRequest`**, the index of its record in this array, so a client can draw the two as one row in the line's position.
  A record with no line pointing at it - the console was off, or the console cap had already dropped the line - belongs after the last line of its script.
- **Credentials are masked where the record is built**, so the live answer, the stored trace and every reader of it hold the same masked record.
  In every header map and line list of the record, the request's, the response's and each redirect hop's,
  the value of a header the export blanks (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token` and the rest of the set the logger redacts) or of one the call's `options.auth` wrote (named in `request.authHeaders`) reads `"<redacted>"`, the marker `configSnapshot` uses;
  a header sent with an empty value stays empty.
  The three challenge headers, `WWW-Authenticate`, `Proxy-Authenticate` and `Authentication-Info`, are the exception: they name a scheme the server wants rather than carry a credential, so a record shows them (unless `options.auth` wrote one of those names itself), where the logger and an export still withhold them.
  Each `url`, the request's and each hop's, has a `user:pass@` password and the value of a credential-named query parameter, or of the one `options.auth` placed (`request.authQueryParam`), replaced by the same marker (`user:<redacted>@host`, `?client_secret=<redacted>&page=2`) as the summary line's URL is, so a withheld value never reads as one resolved empty;
  a hop's `url` carries no userinfo at all, as in the main trace's `redirects`, whose `redirects[].url` reads the same marker.
  An export blanks the same values to `""` instead.
  Bodies are not judged: a token endpoint's answer keeps its token.
  This is deliberately not the main exchange's rule, whose trace stays raw.
- **Bodies are bounded by `maxTraceBodyBytes`, all of them together**: in order, each request and response body of every record is cut to what the bodies before it left of one `maxTraceBodyBytes`, so a send's script requests store at most what its own response may.
  A cut body carries `bodyTruncated: true` and its true `bodyBytes` (a request body gains the pair too); once the budget is spent a body is stored as `""`.
  The script itself still received the whole response.
- Recorded on every design send, buffered and streaming, whatever `scriptEnableConsole` says: a record is trace, not console output.
  A sequential collection run records its steps' and its setup and teardown scripts' calls too (below); a **load run records none** and keeps only the summary line.
  Absent when no script sent a request.

**The script keys are stored the same way** (issue #725).
`testResults`, `consoleLogs`, `preScriptError`, `postScriptError` and `scriptRequests` are returned in the body above *and* written to the design run's `trace_data.scripts` as one object, so a response restored from History carries the assertions the live one showed.
A send whose scripts said nothing stores no `scripts` node at all - absent means no scripts, not no results - and a `transient` execution stores neither, as it stores nothing.

| Field | Meaning |
|---|---|
| `checked` | Whether anything was actually validated |
| `valid` | Present only when `checked`. A body with no failures |
| `reason` | Present only when **not** `checked` - the code, see below |
| `failures[]` | `path` (a JSON Pointer into the body; an unexpected property is at its own pointer, `/o/z` with `unexpected property 'z'`) and `message`, capped at 10 |
| `failuresTotal` | Every failure found, including any past the cap |
| `unevaluatedKeywords[]` | Schema keywords the validator could not evaluate, by name and count |
| `matchedStatus` / `matchedContentType` | Which declared response answered, verbatim |

A status answers to the **most specific** pattern that covers it - exact, then `2XX`, then `default` - the same rule contract coverage counts by, shared rather than restated, over the same set of statuses: every one the operation declares, whether or not it carries a schema (#3028).
A declared `200` with only a description therefore answers a 200 itself and is `no_schema_for_status`; a `default` or `4XX` beside it never judges that body.
A media type matches exactly first, then a declared `*/*` or `application/*`, among the media types that carry a schema.

**`unevaluatedKeywords` is the dialect disclosure and is not decoration.**
The validator reads draft-07; OpenAPI 3.1 schemas are JSON Schema 2020-12, whose `unevaluatedProperties`, `prefixItems` and `dependentSchemas` a draft-07 reader silently ignores - so a schema that meant to forbid something would permit it.
Every such keyword is named and counted, which makes a `valid: true` beside one narrower than it looks rather than wrong.

`format` is asserted for `date`, `time`, `date-time` and `ipv4` (the validator's own) and for `email`, `uri`, `uuid`, `hostname` and `ipv6` (the engine's `schema_format.hpp` table, #2581); any other name stays an annotation and fails no body.
A name added to that table must not be one the validator already checks, or each failure is counted twice.

`propertyNames` is the one draft-07 keyword on that list, and only when it is nested (#2729): valijson builds a `propertyNames` subschema from its parent's node path, so it validates the schema's root keyword but passes every body for one inside `properties`, `patternProperties`, `additionalProperties`, a `dependencies` schema, an `allOf`/`anyOf`/`oneOf`/`not` member, `items` or a `$ref` target.
Each nested occurrence is counted once, a `$ref` target reached twice included; the root keyword is validated and counted only when a `$ref` back to `#` reaches it from below.
In a script, `pm.response.to.have.jsonSchema` fails in both polarities on such a schema, as it does for any unevaluated keyword.

**`reason` codes** (all mean *bound to a document, and still not judged*):

| Code | What happened |
|---|---|
| `no_operation` | The request carries no `spec_operation` - it is not an operation |
| `no_index` | The bound document declares no response, or its schema could not be read (including one that refers to itself without describing any value, which is refused before it can run) |
| `hash_mismatch` | The stored document no longer hashes to what the binding recorded |
| `never_stamped` | The binding names a document and no version of it, so nothing can be compared - re-bind the collection. Distinct from `hash_mismatch` because a sync of an unchanged document would not repair it |
| `operation_not_declared` | The document does not declare this identity (the operation is not in the spec, or declares no response at all) |
| `no_schema_for_status` | Nothing the operation declares covers this status, or the status that answers it declares no schema to check a body against |
| `no_schema_for_content_type` | The status matched; none of its media types did |
| `no_response` | A transport error - there was no response to check |
| `body_not_json` | The body is not JSON (or nests past 100 levels, which counts as not JSON), and a JSON Schema cannot describe it |

**`headers` is keyed by the lower-cased header name, and a name the response sent more than once holds every value folded with `", "`** - the RFC 7230 §3.2.2 equivalence for comma-list headers.
So two `Set-Cookie` lines read back as one `"session=abc; Path=/, csrf=xyz; Path=/"` entry rather than the last one alone.
**`headerLines` is the lossless form of the same headers** (issue #2460): one `{name, value}` object per line the final response sent, in wire order, with the name in the case it arrived in and the value trimmed of the optional whitespace around it (RFC 9110 §5.5).
A name sent twice is two entries, and a `Set-Cookie` is always its own entry, so a client lists headers as received and reads each cookie from its own line.
It is always present on a design answer, an empty array when no headers arrived, so a client can tell "none" from "an engine too old to say" - the same rule as `httpVersion`.
A streaming send (`stream: true`) reports it on the completed trace, while its `open` frame carries the folded `headers` map only.
The map is unchanged and stays what assertions and the MCP `headers` member read; `pm.response.cookies` and MCP's `headerLines` read the lines.
Splitting a folded `Set-Cookie` out of `headers` is now needed only for a row stored before this field and an answer from an older engine, and it must split on a comma followed by `name=`, since an `Expires=` value contains a comma of its own (a cookie value that holds one is indistinguishable from a boundary there, which is why `headerLines` exists).
The same `headers` fold holds for the response headers stored on a design run's `trace_data.response` and on captured load-run samples, which come off the same parse.
The stored `trace_data.response` also carries `headerLines`, written only when non-empty; a load-run sample keeps the folded map alone, because the load path is the hot path and records no lines.

**`redirects` lists the redirect responses the send followed** (issue #2461), in the order they arrived, each as `{status, statusText, headerLines, url, schemeDowngrade}` with `headerLines` shaped as above.
`headers` and `headerLines` hold the final hop only, so a `Set-Cookie` or `Location` on an earlier hop - the `302` that answers a login and sets the session cookie - is readable nowhere else.
`url` is the URL of the request that hop answered:
the URL the send went to for the first hop, the previous hop's `Location` resolved against it for each later one (userinfo is removed), with the value of the request's auth-written query parameter,
and of any query parameter named like a credential, written as `<redacted>` (`?client_secret=<redacted>&page=2`), the form the answer's own `url` and the stored `request.url` read; `""` when libcurl reported none.
A script reads the same hop through `pm.response.redirects[].url`, where the value is blank (`?client_secret=`), and an export blanks it too; only what the engine serializes, this answer and the stored trace, carries the marker.
`schemeDowngrade` is true when that request went over `https` and the next one over `http`: the one hop on which an API-key header, which a redirect does not withhold, travels in clear text (see the Redirects paragraph under [Authentication](authentication.md#authentication)).
A row stored before these two members existed lacks them.
Only 3xx responses are hops: a `1xx` interim response such as `100 Continue` is not.
It is always present on a design answer, an empty array when nothing was followed (`followRedirects: false` always gives an empty one, the 3xx being the answer), and holds at most `maxRedirects` entries (every hop when `maxRedirects` is negative, which sets no limit), so a loop that ends in `TOO_MANY_REDIRECTS` reports the hops it made.
The stored `trace_data.response` carries it too, written only when non-empty; a load-run sample records none.
It reports what the server sent: see the cross-origin paragraph above for why a hop's cookie is not necessarily one a later hop carried.
A post-request script reads the same hops as [`pm.response.redirects`](../scripting.md#pmresponseredirects---the-hops-a-send-followed) (`code`/`status`/`headers` for `status`/`statusText`/`headerLines`), absent where the chain is not recorded.

**`warnings` lists what the engine did to the exchange that the response does not show** (issue #3307), each as `{code, message}` in the order it was found: `code` is a stable snake_case identifier a client branches on, `message` the sentence a person reads.
A warning never fails the send.
It is always present on a design answer, an empty array when there is nothing to say, so a client can tell "no warnings" from an engine too old to warn.
The stored `trace_data` carries it at the top level, beside `clientCertificate` and not inside `response`, because a send that failed before any header block arrived has no `response` node and can still have warned; it is written only when non-empty, so a row stored before the field reads as having none.
A load-run sample records none.
Codes are listed here as the engine starts producing them:

- `cookie_not_sent`: libcurl would not let the `Cookie` line pass 8190 bytes and left out the first jar cookie that did not fit, named in the message (the name only, never a value).
  It also drops every typed `Cookie` row with the line, so `requestHeaders` carries no `Cookie` entry then. libcurl skips the jar cookies after the named one without saying so.
- `cookie_limit_reached`: more than 150 jar cookies matched the URL and libcurl sent the first 150.
  A typed `Cookie` row is still sent in this case.

- `cookie_dropped_oversized`: a response carried `Set-Cookie` headers libcurl discarded unread, because the line was over 5000 bytes (counted from after `Set-Cookie:` to the end of the line) or the cookie's name and value together were over 4096.
  One warning counts them, across every hop, and names up to five (name only, cut at 64 bytes; a line that names no cookie, or whose name is not text, is counted but not named).
- `cookie_dropped_too_many`: a single response set more than 50 cookies and libcurl ignored the rest.
  The count restarts with each hop's response, so 30 cookies on each of two hops is not an overflow; one warning gives the total ignored over the chain.
  It counts the `Set-Cookie` lines libcurl would have stored, so a later cookie it rejects for another reason (a public suffix, a `__Secure-` prefix) can make the count one too high.

`cookie_not_sent` and `cookie_limit_reached` are read off libcurl's own notices at any log verbosity, once per cookie however many hops of a redirect chain report them.
The two `cookie_dropped_*` codes are counted from the response's header lines instead, only on a send that has a cookie jar.
A streaming send (`stream: true`) reports all four by the same rules, on its stored trace alone.
Under load the same two checks feed the run's `cookies_dropped` warning instead (see [GET /runs/:runId/report](runs.md#get-runsrunidreport)).

**`rawRequest` is the header block libcurl actually sent**, captured from the transfer's last outbound header frame and followed by the request body *when that frame declares one* (`Content-Length` above zero, or `Transfer-Encoding: chunked`).
So it carries what libcurl added on its own - the cookies the [cookie jar](../architecture.md#cookie-jar) matched, `Accept`, `Content-Length`, and an h2 request rendered in HTTP/1 form - none of which appear in `requestHeaders`.
The jar's cookies and the request's typed `Cookie` rows share one `Cookie` line, the jar's first and the typed rows after them joined with `"; "` (issue #2788); a redirect to another scheme, host or port drops the typed part, as it drops a typed `Authorization`.
The app's Headers tab lists the sent request from this block, line by line in wire order, so the tab shows the whole wire while the script-visible record stays the engine's.
When the final hop sent no body, the string ends at the blank line that closes the header block:
a `POST` answered `301`, `302` or `303` is re-sent as a body-less `GET` (any other method keeps its name and loses its body, a streamed file body included), without the `Content-Type` and `Content-Length` lines that described the body, so the body it started with is not shown on a request that never carried it (issue #2462).
`307` and `308` keep the method and the body, and so does the view.

**`requestHeaders` is the sent record**: the composed headers as the transfer issued them on its **first hop**.
After a followed redirect that changes the request (a `POST` answered `303`, which becomes a `GET`) the final hop's own header block is `rawRequest`'s.
It carries what the engine derives at send time - the body-implied `Content-Type` (`text/plain` for a `text` body since issue #2464), and every [default header](health-config.md#default-request-headers) this send adds (the `User-Agent`, the negotiated `Accept-Encoding`, an enabled correlation id) - and drops a `form-data` `Content-Type`, which libcurl writes itself with the boundary.
**An enabled header whose value is empty or only whitespace is sent empty** on every transport (issue #3220) and recorded with the value `""`: a header line with nothing after the colon is libcurl's spelling for *remove this header*, so the engine writes libcurl's `Key;` form instead, which sends `Key:` with no value.
A blank row never removes a header; refusing one of the engine's defaults is `disabledDefaultHeaders`' job.
A blank `Accept` or `Expect` row is therefore sent empty in place of libcurl's own `Accept: */*` or `Expect: 100-continue`.
Two blank rows keep a meaning of their own and are neither sent nor recorded: a blank `Content-Type` means no Content-Type (on a `binary` body, absent, so the file's type applies; see [the `body` union](request-body.md#the-request-body-union)), and a blank `Cookie` row joins nothing into the cookie line.
A disabled row is never sent.
The record does not carry libcurl's own additions or the jar's `Cookie` line; those are `rawRequest`'s alone.
A test script's `pm.request.headers` reads this same set (see [scripting.md](../scripting.md#request-object-pmrequest)), so an assertion about what was composed to go out reads the same set the engine recorded; the Headers tab lists `rawRequest`'s header block instead, which is that set plus the transport's own lines.

**`requestHeaderLines` is the same record unfolded** (issue #2466): one `{name, value}` entry per line the transfer appended, in wire order, a repeated name repeated and each in its own spelling - the request's own lines first, in the order the request gave them, then what the engine derived.
Always present, an empty array when nothing was recorded.
`requestHeaders` stays one value per name for the readers written against it: a repeated name's values are joined with `", "`, a `Cookie`'s with `"; "`, under the first line's spelling - and that folded form is what `pm.request.headers` shows, since the scripting API is single-valued.

**The stored trace keeps this map too**, as `trace_data.request.sentHeaders` beside the composed `request.headers` (issue #664), and the unfolded lines as `trace_data.request.sentHeaderLines` (issue #2466) -
so a restored response pane's sent-headers disclosure shows the set the live one showed, derived `User-Agent` and body-implied `Content-Type` included, rather than the composed map's different answer.
Both maps are stored because they answer different questions: the composed one is what a *pre-request* script saw and what reseeds a request tab from a run.
The key is **absent** on a step that sent nothing and on every row written before the field, so a reader falls back to `request.headers` - `restore-response.ts`'s `sentSide` is that reader.
A load run's sampled capture records no sent headers at all: its deferred replay and the Samples viewer both keep reading the composed map, as [scripting.md](../scripting.md#request-object-pmrequest) documents.
That map can differ from the wire in the way this record exists to state - the derived `User-Agent` and body-implied `Content-Type` are absent, and a blank `Content-Type` or `Cookie` row, which is not sent, is listed - and for load samples that divergence is **recorded as permanent** rather than treated as a gap to close (issue #677 item 7).
Which completions become samples is decided when they finish, so a sent record for the few that are kept would have to be built for every transfer, and a load run exists not to charge the hot path for what it throws away.

Values in `rawRequest` are not redacted: this field exists to say exactly what went out.
On a followed redirect it is the final hop - its method, its headers and the body that hop carried, if any - matching the response beside it.
A transfer that failed before sending anything (DNS failure, connection refused) has no frame to read, and falls back to a request synthesized from what was composed.

**The stored trace keeps the same string**, as `trace_data.request.rawRequest` on the design run this execute created (and on each step row of a scenario run)
- so reopening a run shows the raw request the live view showed, cookies included, rather than one rebuilt from `headers` that never had them.
Its body half is capped at `maxTraceBodyBytes` like `body` is, and the key is absent both on a step that sent nothing and on rows written before the field existed; see [db-schema](../db-schema.md#results).
The redaction posture is the live field's, for the reason [Security](../architecture.md#security) records: a trace is the record of what was sent.

**The answer names the request line the transfer was dialled with** (#3650): top-level `method` and `url`, the stored trace's `request.method` and `request.url`, written by the same function (`record_request_line`) so the two cannot disagree.
A pre-request script can retarget the send after the client composed it (`pm.request.url`, `pm.request.method`), so these, not the composed request, say where it went; the app's Console row reads them.
The `url` is raw, like `rawRequest` beside it: it keeps the query parameter auth wrote, which a reader masks by `authQueryParam` below.
A streaming send answers `202` before any of this exists, so only its stored trace carries them, and a build that failed before a request was dialled answers without them.

**The answer and the stored trace also name what auth wrote** (#1835, #1845), as two additive keys: `authQueryParam`, the raw (unencoded) name of the query parameter `apply_auth` appended to the URL for an API key with `in: "query"` or an OAuth 2.0 token with `tokenPlacement: "query"`, and `authHeaders`, the array of header names an API-key block filled.
The URL alone cannot say which query parameter is a credential, and a reader that masks one (the MCP server) needs the name.
In the trace they sit on `trace_data.request`; in this answer they sit at the top level, beside `rawRequest`, written by the same function (`record_auth_provenance`) so the two cannot disagree.
Each key is **absent** when auth wrote none of that kind, never an empty string or array - unlike the response fields above, which are always present - and absent on rows written before the field; the values beside them stay raw.
A streaming send answers `202` before any of this exists, so only its stored trace carries them.
A pre-request script that retargets the URL can leave `authQueryParam` naming a parameter the final URL no longer carries.

**And they say when auth was not sent at all** (#2474): `authNotice`, a plain string, appears when the request's `auth.mode` is one the engine stores but does not execute (`digest`, `aws`, `ntlm`, `hawk`, `oauth1`, `edgegrid`, `jwt`; an import can bring any of them in).
The request is still sent, without authentication, and the notice says so, naming the mode:

```json
"authNotice": "auth mode 'ntlm' is not executed by Vayu; the request was sent without authentication"
```

It appears too when an executed mode had nothing to write (#3203): a `bearer` token, or an `apikey` key, that is empty once trimmed of its spaces and tabs.
The request is sent without that credential rather than refused:

```json
"authNotice": "the bearer token is empty; the request was sent without an Authorization header"
```

and, for the API key, `"the API key has no name; the request was sent without it"`.
It also appears when an `oauth2` block placing its token in the header yielded to the `Authorization` header the request carried, so no token was fetched (#3202): `the request's own Authorization header was sent; no OAuth 2.0 token was fetched`.

It follows the same rules as the two keys above: one writer for both homes, **absent** when empty (no auth, and an executed mode that wrote its credential, or skipped it under a header the request already carries), absent on rows written before the field, and on a streaming send only in the stored trace.
A pre-request script that assigns `pm.request.auth` replaces the notice along with the credential: the record then describes the script's auth, so it is absent unless the script's own token or key name is empty.
A collection run's stored step traces carry it through the same trace writer; a load run sends such a request the same way and raises no run warning for it.

**`consoleLogs` entries carry their own source and level.**
`source` is which of the request's two scripts wrote the line (`"pre"` for the pre-request script, `"test"` for the post-request one) and `level` is the `console.*` method that was called - `"log"`, `"info"`, `"warn"` or `"error"`.
Releases before this one sent a flat `string[]` with the source encoded as a `"[pre] "` text prefix and no level at all, which was indistinguishable from a script logging that string itself; a client that may talk to an older engine should read a bare string as `{"source": "test", "level": "log"}`, or `"pre"` when the prefix is present.
The field is omitted entirely when neither script logged anything.
Each script execution keeps at most 1000 lines and 1 MiB (64 KiB a line); a script that passes either ends its entries with one `warn` line saying output was dropped.
A `pm.sendRequest` summary line also carries `scriptRequest`, the index of the call's record in `scriptRequests` (above, issue #3633).
See [scripting.md](../scripting.md#console-output).

**`httpVersion` on the response** is the protocol actually **negotiated** (`CURLINFO_HTTP_VERSION` after the transfer), e.g. `"HTTP/1.1"` or `"HTTP/2"` - an *outcome*, not an echo of the request's own `httpVersion` field, and deliberately a different value space (see [requests.http_version](../db-schema.md#requests) for the full distinction).
It is `""`, not omitted, when nothing was negotiated (e.g. the connection never reached a server) - empty rather than guessing `"HTTP/1.1"` and presenting a guess as fact.
The same field is stored in a design run's `trace_data.response` and reported back unchanged by `GET /runs/:runId` and `GET /runs/:runId/report`.

**`httpVersionDowngraded`** is `true` when the request explicitly asked for `"http2"` and the connection negotiated something older - the one thing the two `httpVersion` fields cannot say on their own, since neither knows about the other.
It is always present (never omitted), so a client can tell "not downgraded" from "an engine too old to say".
Only an explicit `http2` counts: `"auto"` promises nothing and `"http1.1"` got what it asked for, so neither can be downgraded.
A transfer that negotiated nothing at all (`httpVersion` `""`) is `false` - that is a transport failure, and `errorCode` already reports it.

**A plaintext `http://` URL always reports `true` for an explicit `"http2"`.**
`CURL_HTTP_VERSION_2TLS` offers h2 over TLS only, so a cleartext request never attempts it - the fallback noted above under the request's `httpVersion` is exactly the case this field is for, and it is honest rather than a false positive: h2 was asked for and HTTP/1.1 was used.
A local dev server on `http://` with the protocol set to HTTP/2 will show the warning on every request; either switch the request to `auto`, or serve over TLS.
A server there that speaks only h2c never gets as far as a downgrade: it cannot read the HTTP/1.1 request, so the send fails as `PROTOCOL_MISMATCH` with the h2c hint instead, and `auto` meets the same failure without the hint.

This exists because the failure it names is invisible otherwise: a `200`, a latency and a body look identical whether or not the protocol you asked for was granted.
A build whose HTTP/2 is unreachable puts every request silently on HTTP/1.1, and nothing else in the API says so ([#215](https://github.com/athrvk/vayu/issues/215)).
The same field is stored on a design run's `trace_data.response`, and load runs and collection runs carry the whole-run count as `summary.httpVersionDowngraded` in [`GET /runs/:runId/report`](runs.md#get-runsrunidreport).

**One timing convention.**
The eight phase keys above (`totalMs` through `downloadMs`) are the same `*Ms` names the stored trace uses (`record_design_result` / `load_strategy` → `results[].trace` in `GET /runs/:runId/report`), and the design-mode writer stores all eight unconditionally - so a live response and one restored from the stored trace carry the same fields with the same names, Wire/Queue included.
Traces written by earlier releases differ two ways, and readers must tolerate both: stored rows omitted zero-valued phases and all of `totalMs`/`wireMs`/`queueWaitMs` (see [db-schema.md](../db-schema.md)), and the live response named its keys without the suffix (`firstByte`, `dns`, …) - consumers of the raw `/execute` body written against that dialect must switch to the `*Ms` names.

**`refusalCode` and `authErrorCode` say why a send never went out.**
Both are **absent** from an answer that was sent.
A buffered send refused after the build and before the transfer (the residual pass of a name or header, the auth applied after the pre-request script, a [`targetPolicy`](#post-execute) verdict) answers `statusCode: 0` with the sentence in `errorMessage` and the rule's code in `refusalCode`:
`unsendable_header`, `empty_header_name`, `invalid_header_name`, `colliding_header_names`, `target_not_allowed`, `target_host_unknown`, or an auth code.
`authErrorCode` is the hint of an auth failure (`errorCode` `AUTH_REQUIRED` or `AUTH_FAILED`), whether the token was sought at the build or, for a config that waited for the script, after it (where it repeats `refusalCode`, #2521).
A streaming send answers the same codes as a `400` before its stream opens.

**`wireMs` and `queueWaitMs` split `totalMs` at the wire** ([#2394](https://github.com/athrvk/vayu/issues/2394)).
`totalMs` is perceived: submission to completion.
`wireMs` is libcurl's `CURLINFO_TOTAL_TIME` less the time libcurl held the transfer waiting for a connection slot (`CURLINFO_QUEUE_TIME_T`, bounded by `PRETRANSFER_TIME` because curl 8.23 counts a wait again each time the transfer is passed over), and `queueWaitMs = totalMs - wireMs` is everything before the wire: the generator's own queue and that slot wait.
The phases are measured after the slot wait too, so `firstByteMs` is the target's own.
A design send has no slot to wait for, so its `queueWaitMs` stays a sliver.
Over a followed redirect chain the phase fields accumulate: every hop's libcurl timers are summed (`add_phase_times`), so `firstByteMs` is then the sum of each hop's wait, not one server's, and `dnsMs`, `connectMs`, `tlsMs` and `downloadMs` are sums the same way.
The app's Timing tab says so when the response's `redirects` is non-empty.

**`timing.engineMs` is Vayu's own cost for the exchange** ([#2132](https://github.com/athrvk/vayu/issues/2132)), the ninth key and, with `scriptMs` below, one of two a buffered `/execute` alone carries.
It is the time from the handler receiving the request to the answer being assembled, less the transfer (`wireMs`), the pre- and post-request scripts (`pm.sendRequest` inside them included) and the time spent waiting on an OAuth 2.0 identity provider's token endpoint (a token fetched on first use, or refreshed because it expired; a cached token costs a lookup and stays in).
What it counts is request composition, the rest of auth resolution, the cookie jar, residual `{{token}}` resolution, the element pipeline other than the user's scripts (extractors, assertions, metrics) and building the response; `queueWaitMs`, the sliver between the engine's stopwatch and libcurl, is part of it.
A design send blocks on no timer, so there is no timer wait to leave out.
It does **not** count the wire, scripts, the token endpoint, the hop from the Electron shell to the engine, persisting the run row and trace, serialising the body, or the renderer drawing it: the figure is taken once, before the write, and that same value is both returned and stored on the trace as a flat `engineMs`, so a restored response shows what the live one did.
It is absent - not `0` - from a streaming send (the route answers `202` before any exchange finishes), from the auth-failure reply (no exchange ran), and from rows stored before this key existed.

**`timing.scriptMs` is the time the exchange's scripts took** ([#3676](https://github.com/athrvk/vayu/issues/3676)), the tenth key and the other half of what `engineMs` leaves out: the pre-request and test scripts together, `pm.sendRequest` inside them included, which is the `script_ms` the `engineMs` subtraction already used.
It is `0` for a send with no script, and it is **not** part of `totalMs`, `wireMs` or `engineMs`: the three are the transfer and Vayu's own work, and `scriptMs` is the user's code beside them.
Like `engineMs` it is taken once before the write, returned in the live body and stored flat on the trace as `scriptMs`, and it is absent - not `0` - from a streaming send, from the auth-failure reply and from rows stored before this key existed.
A collection run's step row stores the same flat `scriptMs` (absent for a step whose data row could not bind, where no exchange ran).

**Variables the scripts and extractors wrote are persisted, and only those.**
After the post-request elements run, the engine writes back the three variable scopes (the run's environment, globals, and the executed request's collection) - but only for a scope whose variables a script or an `extract.*` element actually changed, a name removed included (an unset, or an extractor's miss with no `default`, #3053).
A run that sets no variable writes nothing at all, so it does not move a collection's or environment's `updatedAt`.
Each variable round-trips whole, `createdAt` included; see [VariableValue shape](../db-schema.md#variablevalue-shape) for why that field must survive and who may stamp it.

**`persistVariables: false` keeps them within the send** (#1904).
Every script and extractor still runs, a value one sets is visible to the elements after it, and the response (or a stream's trace) reports their outcomes and `testResults` as usual; only the write-back above is skipped, on both the buffered and the streaming path, so no environment, collection or globals row changes.
Absent and `null` mean `true`, which is what the app's Send relies on; a present non-boolean is a **400** (`'persistVariables' must be a boolean`) before any run row exists, for the reason `transient`'s is.
It is independent of `transient`: that flag decides whether the *run* is recorded, this one whether the *variables* are.
MCP's `run_request` sends `false` whenever write access is off ([MCP](../mcp/safety.md#safety-model)).

**`includeParsedBody: false` leaves the parsed copy out** (#2544).
The answer's `body` is `null` and the engine skips the parse that would build it; `bodyRaw`, `bodyEncoding`, `bodySize`, the scripts' `pm.response`, the `validation` node and the stored trace are what they would have been.
It is for a client that reads `bodyRaw` only and should not pay for a second copy of every body.
Absent and `null` mean `true`; a present non-boolean is a **400** (`'includeParsedBody' must be a boolean`) before any run row exists, by the rule `transient`'s follows.
A body past 4 MiB is never parsed whatever this says (see the response section above).
A streaming send has no `body` in its `202` and ignores the flag.

**A run row the database cannot write is a `500`.**
A recorded send whose run row cannot be stored (a busy or locked database, a full disk, an I/O error) answers `500` `Couldn't create the run record` before anything is sent, the same as [`POST /runs`](load-runs.md#post-runs).
The app retries a `5xx` and treats a `4xx` as a verdict, so a momentary lock no longer reads as a refused request (#2353).
A `transient` send writes no row and is unaffected.

**A send that fails once its row exists is a `500` with a body, and a `failed` row** (#2458).
Anything that throws after the run row is written - building the answer, running the exchange, handing a stream to its worker - answers `500` `Execution failed: <reason>` in the usual `{"error": {"code", "message"}}` shape and marks the row `failed`, even when its result had already been recorded, so `GET /runs/:runId` never shows a send the caller got no answer for as `running` or `completed`.
A body the engine cannot hold as text is not such a failure: it is a `200` with `bodyEncoding: "base64"`, above.
