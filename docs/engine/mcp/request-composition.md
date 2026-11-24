---
description: >-
  How an MCP-sent request is composed by the engine: stored requests, scripts an agent supplies, scenarios and what each gate sees.
---

# MCP request composition

### Request composition

The **engine** owns request composition (`POST /compose`, issue #226): it resolves `{{variables}}` and walks the collection ancestor chain to resolve `inherit` auth, then returns the execute-ready payload `POST /execute` / `POST /runs` accept unchanged.
Composition is pure - nothing is sent - which is exactly what MCP's safety model needs: every execute/load tool composes first, checks the **allowlist against the composed (resolved) URL**, and only then executes the composed payload - which carries the same allowlist to the engine as `targetPolicy`, for the URL it is about to send (below).

Four tools compose a stored request by id: `run_collection_smoke` and `run_collection` for every request of a collection, `start_load_run` with a `requestId`, and `run_request` with a `requestId` and **no `url`** (issue #2435), which is the single-request replay:
the compose body is `{ requestId, environmentId?, collectionId? }`, so the send carries the stored and inherited auth, the collection chain's and the request's own elements, and the stored settings (redirects, protocol, `verifySSL`, cookies), exactly as the app's Send does.
A field the call states beside the id (`method`, `headers`, `body`, `bodyType`, `auth`, `httpVersion`) goes in the compose body's `request` overlay and replaces the stored field for that send only.
With a `url`, `run_request` is ad hoc: `requestId` links the run in History and is never sent to `/compose`, nothing stored is applied but the collection scope its scripts read (the linked request's collection wins over `collectionId` at `/execute`, issue #3461),
and the result carries a caveat saying so, because an agent passing both usually means the saved request and would otherwise read a default-auth response as the stored one.
A call with neither is refused.
Ad hoc, `collectionId` scopes composition, and the composed answer's `collectionId` (passed on unchanged by `asMcpSend`) carries the same scope to `/execute`, so a script the call adds reads that chain and the names composition deferred past it resolve against it (issue #3461).
The by-id branch keeps the ad-hoc gates of the other: the `verifySSL: false` refusal and the agent-script refusal run first, and the allowlist is checked on the composed URL, not the stored one.

A pre-request script can still change where the request goes after that gate has run: it can assign `pm.request.url`, and since #2521 a request a pre-request script runs before is composed with its `{{names}}` written (`deferredVariables`), so a deferred `{{host}}` resolves from whatever the script set.
The gate on the composed URL cannot see either, so the allowlist also travels with the send:

- **`targetPolicy` on every send.**
  `asMcpSend` stamps the session's `allowAll` and allowlist, as `{allowAll, allowedHosts}`, beside `origin` on every `POST /execute` and `POST /runs` this server makes (`run_request`, streaming or not, each `run_collection_smoke` row, `run_collection`, `start_load_run` in both shapes and `get_graphql_schema`).
  The engine judges the URL it is about to send, after the pre-request scripts and the residual pass, by the same rule `safety.ts` applies (exact host, case-insensitive; an empty or still-templated host is refused even under allow-all), and the host of every OAuth 2.0 `accessTokenUrl` / `refreshTokenUrl` the request's auth would post to, before any token is fetched.
  See [`targetPolicy`](../api-reference/execute.md#post-execute).
  A test drives every sending tool by name, and a scan fails on an `executeRequest` or `startRun` call that does not go through the helper.
- **A monitored run's policy lists its exempt monitor host.**
  The engine judges a load run's `monitor.url` against the same `targetPolicy` (#3121) and exempts nothing, so when `start_load_run` carries a `monitor` block whose host the monitor gate passes without an entry (loopback or private, link-local and metadata addresses aside; see [Safety](safety.md#safety-model)),
  `asMcpSend` adds that host to `allowedHosts` (`exemptMonitorHost` in `safety.ts`, the gate's own predicate).
  Nothing the gate refuses is ever added.
  The entry also admits the run's own requests to that host if a pre-request script steers them there, which is the one place the engine's list is wider than the gate on each composed target.
- **The early gate stays, for the unscripted case.**
  `checkComposedTarget` refuses off-list hosts before any traffic, exactly as before.
  The one difference: a URL whose authority holds templates that are *all* listed in the composed payload's `deferredVariables` has no host yet - the script chooses it - so it is passed to the engine instead of denied, and is refused here only when the allowlist is empty and allow-all is off.
  A template composition could not answer is still an unknown host, denied as before; when that host is a whole `{{token}}` the refusal names the first such variable and the tools that define it (`update_collection` variables or an environment, `resolve_variables` to see what is undefined) rather than the generic "may contain unresolved variables" (#2450).
- **The engine's refusal reads as the early one.**
  A buffered answer's `refusalCode` (or a stream's `400` body, or the smoke row's skip reason) of `target_not_allowed` becomes the allowlist remedy `settingRemedy` gives the early refusal; `target_host_unknown` asks for a resolved URL.
  The text says the allowlist is applied after the pre-request script and to an OAuth 2.0 token endpoint.
- `deferredVariables` describes the composition and is stripped from the payload before it is sent.

What `targetPolicy` does not cover: a redirect hop a server answers with, and a script's `pm.sendRequest`, which is refused for MCP-started runs instead ([why](resources-and-prompts.md#pmsendrequest-is-refused-for-mcp-started-runs)).
A tool call that forwards a `preRequestScript` is still not sending the composed bytes untouched, but it can no longer reach a host the allowlist did not list, bar the exempt monitor host above, which a script can also steer the run's own requests to.

Scripts: the by-id compose path attaches the collection chain's, then the request's own, `script.pre` / `script.post` elements under `elements` (`compose_elements`, issue #1514 - the ordered `{ origin, id, name?, script }` part list `compose_script_parts` built is retired).
The renderer's inline path still builds its own `ScriptPart[]` from its editor state, a different concern (that composer runs client-side against unsaved state, not this server).
`run_request`'s ad-hoc `preRequestScript` / `postRequestScript` no longer ride inside the inline `request` object (issue #1517):
`/execute` refuses those two names outright now that `elements` is the only script source, so the tool reads them, folds each into an ad-hoc `script.pre` / `script.post` element, and adds both after the stored ones - alongside any ad-hoc `elements` argument the agent gave directly - so they run in addition to whatever the composed request already carried, never replacing it.
On the by-id branch that takes two compositions: the engine's inline overlay replaces a whole key, so the first, by id, reads the collection chain's and the request's own list, and the second composes again with that list plus the ad-hoc entries as the inline `elements`.
Composition decides from the elements it sees whether a pre-request script runs before the send (#2521), so a name an ad-hoc `preRequestScript` sets is left for it rather than resolved to the stored value first.
A call with nothing ad hoc composes once.
`start_load_run`'s ad-hoc `postRequestScript` / `tests` folds the same way now (issue #1594):
`POST /runs` reads a single target's step-level elements under `requestElements`, a key distinct from `elements` there (see below), so the composed chain rides under that key too - `composeLoadRunRequest` renames the compose response's `elements` onto `requestElements` rather than folding it into a flat `tests` string.

**Scripts an agent supplies are refused while reveal is off** (#1834).
A script reads every variable the request resolves against, secret ones included, so one the agent wrote could copy a secret into its own output, a variable not flagged `secret` or the request it sends.
With Reveal secrets to agents off, `run_request` refuses `preRequestScript`, `postRequestScript`, `tests` and any `elements` entry of a script kind (`script.pre`, `script.post`, `script.setup`, `script.teardown`, matched case- and whitespace-insensitively),
and `start_load_run` refuses `postRequestScript` and `tests` (it has no pre-request script; its run-level `elements` object carries no script text).
The refusal is a `ToolArgError` from `tools/compose.ts::refuseAgentScripts`, raised before the call is composed or sent, and names every offending argument and the setting.
Nothing else changes: a blank script (empty or whitespace-only) is not refused, because the engine composes and compiles none (`is_blank_script_element`); extractors, assertions and timers in `elements` pass (with write access off, what an extractor or a revealed script sets is not stored - see [the write toggle](safety.md#safety-model));
`run_request` with a `url` is an ad-hoc send, where `requestId` only links History and composes nothing stored, so it carries no script; without a `url` it sends the saved request by id, and the scripts stored on it and its collections run as stored, which is the same residual as below; and with reveal on every call is as it was.
Scripts stored on a request or collection are not affected (see [the write toggle](safety.md#safety-model)).

**One validation script, one name - except where the engine still keeps two.**
The post-response script is one field in the app - the request builder's **Tests** tab - and MCP declares it identically on `run_request` and `start_load_run` (`postRequestScript`, with `tests` accepted as an alias) so a script an agent writes for one reads the same on the other.
Both tools now fold it the same way too (issue #1594 caught `start_load_run` up to #1517's `run_request` shape): an ad-hoc `script.post` element, appended to `requestElements`.
`start_load_run` **replaces** rather than joins - the composed chain's own `script.post` elements are filtered out first (`tools/compose.ts::composeLoadRunRequest`), because with no way to know which assertions the agent meant, running both would add ones they never asked for.
`tests` stays accepted on both as the engine's own spelling for the run tool - a tool's schema refuses a key it does not declare, so removing it would refuse a script written in that spelling.
Passing both names is rejected with a `ToolArgError` rather than resolved by precedence: they are one slot, and dropping either would report a run as validated by assertions that never ran.
Under load the script runs against *sampled* responses (`max_response_samples` / `response_sample_rate`), not every one.

How each tool uses `POST /compose` (`tools/compose.ts::composeViaEngine`):

- **Variables** - the engine resolves URL, headers, and body with the app's precedence (environment > collection chain, leaf→root > globals; enabled only; an unknown name keeps its braces, issue #1009; dynamic variables like `{{$guid}}` generated per occurrence).
  MCP hands it raw strings and checks the allowlist against the **composed** host (and the engine again against the sent one, #2521).
  `start_load_run` composes for a *run*, like the app, so the `{{$guid}}` family is deferred and the engine generates a fresh value per iteration rather than repeating one across them (issue #995); see [variable resolution](../../app/variable-resolution.md#dynamic-variables).
- **Auth** - `run_collection_smoke` and `run_request` with a `requestId` and no `url` compose each saved request by id, so its stored auth applies (`inherit` resolved against the collection chain);
  `run_request` / `start_load_run` accept an explicit `auth` block and forward it raw inside the inline request - the engine resolves variables in it (and `inherit`, when a `collectionId` scopes the walk) and applies it at execute (oauth2 uses its token cache).
- **Scripts** - composing by id attaches the collection chain's + the request's own `script.pre` / `script.post` elements engine-side (issue #1514), so a saved request's assertions execute in the design send, the sequential collection run,
  and now `start_load_run`'s single-target path too (issue #1594 - the composed `elements` become the run's own `requestElements`, a step-level pipeline `POST /runs` now runs per submission), and so does `run_request` with a `requestId` and no `url`.
  `start_load_run` does not forward a collection's or folder's `script.setup` / `script.teardown` that `/compose` emits: `requestElements` is validated as a request's own and refuses them, and they belong to the collection's own run (#3070).
  An ad-hoc `run_request` (a `url`) takes a `preRequestScript` / `postRequestScript` instead (folded into elements, above), since an ad-hoc call has no chain to compose from, and they are composed after the stored ones when it sends a saved request; `start_load_run` takes the same `postRequestScript` for a URL-only run, folded into `requestElements` the same way, as described above.
  Those two are supplied per call, are refused while reveal is off (above), and are not stored - `create_request` and `update_request` take the same two names as sugar for a `script.pre` / `script.post` element stored on the request itself, which is what lets an agent-authored script outlive the call that wrote it (see *Storing a request's elements* below).
- **Bodies** - `body` is a string and `bodyType` names the mode (`json` | `text` | `graphql` | `jsonrpc` | `mcp` | `xml` | `form-data` | `x-www-form-urlencoded` | `binary`, default `text`).
  The two form modes carry their content as **fields**, not as a string, so `body` is written as `key=value&key=value` and split into the `fields` rows the engine reads - see [the `body` union](../api-reference/request-body.md#the-request-body-union).
  A `graphql` `body` may be the bare query document: the engine envelopes it as `{"query": ...}` and sends `application/json`, and an envelope written out in full is sent unchanged - on `POST`.
  With `method` `GET` the same fields travel as `query` / `operationName` / `variables` / `extensions` query parameters instead, with no body and no Content-Type, so a mutation needs `POST` rather than the `GET` a new request defaults to - see [the `graphql` envelope](../api-reference/request-body.md#the-graphql-envelope).
  A `jsonrpc` `body` may be the bare call object: the engine adds `"jsonrpc":"2.0"`, plus `"id":1` when the call names no id, and a frame that already declares a string `"jsonrpc"` is sent byte for byte - which is how an agent chooses its own id or sends a notification - see [the `jsonrpc` envelope](../api-reference/request-body.md#the-jsonrpc-envelope).
  An `mcp` `body` is one call to a Model Context Protocol server (`tools/call`, `tools/list` and the rest) in the same bare-call form: the engine adds `params._meta` and every header the revision asks for (`Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`), so the agent sets none by hand - see [the `mcp` body](../api-reference/request-body.md#the-mcp-body).
  `mcpTool`, the stored tool whose `x-mcp-header` annotations the engine mirrors into `Mcp-Param-*` headers, is not an argument of `create_request` or `update_request`: it is set in the app, because stating its schema in the tool list costs a kilobyte of every session's `tools/list`.
  `update_request` therefore carries the stored tool into an `mcp` body it writes (a write of `body` replaces the body object whole, which would clear it) and says so in its result, and an agent-authored `mcp` request sends no `Mcp-Param-*` header.
  `run_request` and `start_load_run` take `bodyType: "mcp"` too, with the same limit; their descriptions do not list it, for the same budget.
  An `mcp` request's tool result is held to a JSON Schema by the engine's `assert.jsonschema` [element](../elements.md) with `source: "jsonpath"` and `path: "$.result.structuredContent"`:
  the elements read the final JSON-RPC response, the check is draft-07 (a 2020-12 keyword in the tool's `outputSchema` fails the assertion naming it rather than passing unread), and it runs on a Send, a collection run and a load run alike.
  The surface a server advertises is held the same way by `assert.snapshot` on a `tools/list`, `resources/list` or `prompts/list` request: it fails naming the tool and the JSON Pointer that changed, and passes when the server only reorders its list.
  An `xml` `body` has no envelope at all: it is stored and sent byte for byte and carries `application/xml` unless the agent set a Content-Type of its own, which is how a SOAP 1.2 endpoint gets `application/soap+xml`.
  `create_request` stores the same shape.
  Every form field an agent writes is a **text** part: a `form-data` [file part](../api-reference/request-body.md#file-references-binary-bodies-and-file-parts) has no spelling in a `key=value` string, and a stored one is left alone unless `body` replaces the whole body.

  **GraphQL schema.**
  Before writing a `graphql` body, an agent reads the endpoint's schema with `get_graphql_schema`: given a saved request's `requestId` it composes that request exactly as a send would (the same `POST /compose`, so the same variables and the same auth, `inherit` walked), or given a `url` it composes that endpoint inline.
  It then sends the standard introspection query as a transient `POST /execute`, so no run row is filed, and answers the schema as SDL.
  The schema is the request's own, the one the app's editor introspects, rather than a copy the agent was handed.
  It is fetched live on every call.
- **File bodies** - `create_request` and `update_request` store a `binary` body, one file sent as the whole body: `file: {src, contentType?, fileName?}` in place of `body` (a lone `file` implies `bodyType: "binary"`).
  The engine sends a stored path only once the user picks the file in the request editor or it lives under a folder they allowed in Settings > Files, whatever the arguments or the body say (#2356): an agent can name a path, never choose one for the user.
  The tools that send an ad-hoc request (`run_request`, `start_load_run`) refuse a body that names a file (`bodyType: "binary"` or any `file` argument) before composing anything, and say to run the saved request by id instead - `run_request` with `requestId` and no `url`, `start_load_run` with `requestId`, or `run_collection` / `run_collection_smoke` over its collection.
  Both declare `file` only so this refusal, which names that route, is the answer rather than the schema's bare `Unrecognized key`.
- **Headers as lines** (issue #2466) - `headers` on `run_request`, `start_load_run` and `get_graphql_schema` is an array of `{name, value}` lines or a string map.
  Each line is sent as its own header line, in the order given and in the spelling written, so `Link`, `Forwarded` or `X-Dup` beside `x-dup` are repeated rather than collapsed (`Cookie` rows are the exception: they go out as one `; `-joined line with the jar's cookies, issue #2788); a map holds one value per name and cannot repeat one.
  Both go to `POST /compose` as given, which answers lines either way, and a line that is not an object with a string `name` is refused by its position.
  The same payload that composes is the one sent: nothing is folded between the two.
  `create_request`, `update_request` and the saved-example tools take `{key, value, enabled?}` rows instead, for the reason given under [the examples bullet](saved-data.md) (#3422, #3550).
- **What actually went out** - the engine adds headers an agent never wrote:
  the body-implied `Content-Type` (a `json` body, a `graphql` body on `POST`, or a `jsonrpc` or `mcp` body, sends `application/json`, and an `mcp` body adds its `Accept`, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` too; a `graphql` body on `GET` has no body, so the engine adds no Content-Type for it at all - a `text` one `text/plain`, an `xml` one `application/xml`, an `x-www-form-urlencoded` one its own type, and a bodyless `POST` none),
  the [default headers](../api-reference/health-config.md#default-request-headers) a send adds -
  a default `User-Agent`, a negotiated `Accept-Encoding`, and a correlation id where one is switched on - and the `Cookie` line the jar matched for the environment (merged with any `Cookie` the call typed).
  A header the call wrote itself always wins over the default of that name, and `disabledDefaultHeaders` on the payload refuses one outright.
  `run_request` and `start_load_run` take that list as an argument (issue [#1337](https://github.com/athrvk/vayu/issues/1337)), which is how an agent sends a request with no `User-Agent` at all rather than one carrying a value it chose; it rides beside the composed payload, because the names say which of the engine's own defaults this send declines and composition neither reads nor rewrites them.
  `run_collection_smoke` does not take it - it replays each saved request exactly as stored - and a scenario load run refuses it by name, as it does every other single-target field, because its steps are each composed from their own saved request.
  So the request an agent composed is not the request that was sent, and asserting on the composed one is how a correct request gets reported as wrong.
  `requestHeaders` in the result is the sent record - composed plus everything but the `Cookie` line, minus a `form-data` `Content-Type` libcurl writes itself and minus a blank `Content-Type` or `Cookie` row, which is not sent (any other blank header is sent empty and recorded as `""`, issue #3220) - folded to one value per name (a repeat joined with `", "`, `Cookie` with `"; "`);
  `requestHeaderLines` is the same set unfolded, one `{name, value}` per line in wire order, a repeated name repeated in the spelling written (issue #2466), and the one to read when a header was sent more than once; and `rawRequest` is the full wire frame including the `Cookie` line and libcurl's own `Accept` / `Content-Length`.
  Both keep their shape and every non-credential value as the engine recorded them; read them rather than the request the call sent.
  Unless the user has turned on reveal, a credential-bearing header's value and every secret value in either reads `<redacted>` (see [Secret values](secrets.md#secret-values));
  so do the response's `headerLines`, the `{name, value}` rows as received, where each `Set-Cookie` is a row of its own (issue #2460), and so does each hop's `headerLines` on `redirects`, the `{status, statusText, headerLines, url, schemeDowngrade}` of every 3xx the send followed (always present on the answer, `[]` when none; `headers` and `headerLines` hold the final response only, issue #2461).
  A hop's `Set-Cookie` is what the server sent, not what the cookie jar kept.
  A hop's `url` is the request it answered, masked as the result's own `url` is (issue #2949, [Secret values](secrets.md#secret-values)), and `schemeDowngrade` is true when that request went over `https` and the next over `http`: libcurl drops `Authorization` and `Cookie` there, an API key sent as a header travels.
  `requestHeaderLines` (and a stored trace's `sentHeaderLines`) is masked the same way, every repeated credential line on its own.
  A `postRequestScript` reads the same set as `pm.request.headers` (see [scripting.md](../scripting.md#request-object-pmrequest)).
- **Transport fields** - `httpVersion` rides the inline overlay for both tools, and `start_load_run` adds `followRedirects` / `maxRedirects` (issue #760).
  They belong here rather than beside the load shape because they describe the *request*: `POST /compose` emits all three on a stored request under the never-elided rule, so an agent's value has to be laid over the composed payload the same way a URL override is.
  A URL-only run has no stored row behind it, which makes this the only way its redirect policy gets stated at all.
  `verifySSL` is the one transport field that deliberately does **not** ride the overlay: `run_request` refuses `verifySSL: false` and `start_load_run` takes no such argument, because a certificate check skipped for one call is recorded nowhere afterwards.
  It is written onto the saved request instead (issue #795), and every by-id compose then carries it, a `run_request` by `requestId` included.
- **Streaming** - `run_request` takes `stream: true` for a `text/event-stream` endpoint (issue #575).
  `tools/call` is request/response, so the tool does not stream to the agent:
  it starts the run, reads the relay for at most `streamBudgetMs` (default 5000, maximum 60000) collecting at most `maxStreamEvents` (default 50), and returns those events with **which bound it stopped at** beside them - `completed`, `capReached` or `budgetExhausted`, plus `totalEvents` where the completion frame reported it.
  The three are separate because the follow-up differs: a completed stream is finished, a capped read wants a larger cap, and an exhausted budget means the run is still going, `get_run` says whether it has finished, and `stop_run` ends it.
  The flag is sent on **every** call, never elided - the two answers have different shapes, so the tool decides which one it is about to parse rather than an engine default deciding for it.
  An explicit `stream` decides; without one, a send by `requestId` follows the saved request's Event stream setting, which every by-id compose carries (#3561), as the app's Send does, and an ad-hoc send buffers.
  The allowlist gate is unchanged: it runs on the composed URL before anything is sent.
  **A request that declares a `streamTextPath` (#3773) answers with `text`**, the `text` each relayed event carries joined in order.
  It is the reply of the events *this read collected*: under `capReached` or `budgetExhausted` it is the reply so far, and `get_run_report` holds the stored trace's `streamText`, the whole reply, once the run has ended.
  The key is absent, not `""`, when the request declares no path; a declared path that has read nothing yet is `""`.
  `events: false` returns the result without the rows (`eventCount`, `totalEvents` and the stop flags stay), which is how a reply of some forty tokens comes back in under 1 KB.
  A path rides beside `stream: true` only, so a call that does not stream drops it from the payload (`setStreamFlag`, shared with `start_load_run` and `run_collection_smoke`), and `text` is masked as the rows are, after the events are joined, so a secret split across two of them is still caught.
  A saved request's path is stored with `create_request` / `update_request` and a by-id send reads it from there.
  An ad-hoc send (`url`) states its own as `run_request`'s `streamTextPath` (#3818), which `/compose` copies onto the payload like any other inline field; a by-id send ignores that argument, and so does a send that does not stream.
- **Data rows** - `run_request` takes an optional `data` object: one row, which binds every `{{data.column}}` in the URL, headers and body and which both scripts read as `pm.iterationData` (`pm.info.iteration` is `0`, issue #601).
  It rides *beside* the composed payload rather than through `/compose`, because `{{data.*}}` survives composition by design - that is what leaves the tokens for the engine to bind.
  A column the row does not carry is an error naming the token and the row's columns, and **nothing is sent**.
  Auth credentials bind as well (issue #642) - before they are encoded, so basic auth base64s the row's values - with OAuth 2.0 the one mode no row can reach, refused by name because its token comes from the token endpoint rather than from the request.
  The allowlist gate reads the composed URL as always - a `{{data.*}}` in the *path* leaves the host knowable and is judged on that host, while a template in the authority is still "unknown host" and denied.
  `run_collection_smoke` stays out of it: it runs each request on its own, with no sequence to iterate, so there is no row for it to bind.
  A whole *data set* is a run's argument instead: `scenario.data` on `run_collection` and on `start_load_run`'s scenario shape (below), or `start_load_run`'s **top-level `data`** for a single target (issue #993) - the same rows, the same refusals, bound one per request the run sends off a cursor that wraps rather than one per iteration of a sequence.
  A single target's rows also name their columns to `POST /compose` (`dataColumns`, the union of every row's keys), so a bare `{{column}}` stays written for the bind and wins over a same-named environment variable, as it does in the app (issue #2956).
  The two fields are mutually exclusive: `data` beside a `scenario` block is refused by name rather than dropped, and so are a top-level `dataFileName` / `dataFileHash` / `dataFileCastNumbers` there - a sequence names its rows' file inside the block.
- **Protocol** - `run_request` and `start_load_run` both take an optional `httpVersion` Zod-enum arg (`"auto" | "http1.1" | "http2"`, default `"auto"`), mirroring the request builder's Settings-tab picker.
  `run_collection_smoke` has no such arg: it replays each saved request exactly as-is, and `POST /compose` always emits a stored request's protocol.
  `start_load_run` with a `requestId` lays a stated `httpVersion` over the stored one through the compose body's `request` overlay, like any other agent-stated field.
  On a URL-only call there is no saved row behind the request, so `httpVersion` is forwarded only when the caller actually supplies it.
- **One post-response script, one name on the wire, not three.**
  Before issue #1514 it was stored as `postRequestScript` (on a request and on a collection), sent as `postRequestScripts` / `postRequestScript` to `POST /execute`, and as `tests` to `POST /runs` - three spellings `read_post_request_script` read on both routes.
  The cut-over ended all three: it is stored as a `script.post` element now (`create_request` / `update_request` / `create_collection` / `update_collection`'s `preRequestScript` / `postRequestScript` sugar folds a string into one, issue #1517),
  and both `POST /execute` and `POST /runs` refuse `postRequestScripts` / `postRequestScript` / `tests` outright since issue #1594 gave the single-target load path the same element pipeline the design send already had -
  `elements` (`run_request`) / `requestElements` (`start_load_run`) is each route's only script source now, and `read_post_request_script` itself is retired.
  MCP still shows the agent a single argument name, `postRequestScript` with `tests` accepted as an alias (see *One validation script, one name* above), and folds it into an ad-hoc element client-side before either route ever sees a legacy field.
- **Storing a request's elements** - `create_request` and `update_request` take `elements` (the whole list) plus `preRequestScript` / `postRequestScript` sugar (strings, optional) that fold a script into a `script.pre` / `script.post` entry rather than being written to the engine under those two names, which `POST /requests` / `PUT /requests/:id` refuse outright since issue #1514.
  `update_request` merge-patches `elements` like every other field when the caller sends it directly: **leave it out and the stored list is kept.**
  The script sugar merges at the entry level instead - passing a script alone reads the request's current elements first (`GET /requests/:id`), replaces or removes just that one kind, and writes the whole list back, so a script written this way never drops the request's other elements; **an empty string clears the kind.**
  `elements` and the script sugar cannot both be given on one call - a caller who states the whole list has already said what belongs in it.
  The `tests` alias is deliberately absent here - it is the engine's spelling for an *ad-hoc run body*, and a stored field answering to two names is a second name to keep in step.
  Storing an element adds persistence, not execution capability: an agent could already run arbitrary scripts through `run_request`, and a stored one runs only when the request is later sent.
  Both tools already declare `invalidates: ["request"]`, so the renderer refetches the row and picks the elements up without a further entity.
  A collection's own elements
  - the ones that run around *every* request below it - are `create_collection` / `update_collection`'s `elements` field and the same two script names (issue #759), and carry the same merge and clearing rules.
- **Load-testing a saved request** - `start_load_run` with a `requestId` composes it by id, exactly as `run_collection_smoke` and the app do:
  variables resolved, stored auth applied through the collection chain, and the chain's + its own elements attached under `elements`, which the tool renames onto `requestElements` - `POST /runs` runs an element pipeline per submission on a single target too now (issue #1594), and reads its step-level elements under that key, distinct from the run-level `elements` override below.
  Any field stated explicitly (url, method, headers, body, auth, httpVersion) rides in the compose body's `request` overlay and replaces the stored one *before* resolution;
  an explicit `postRequestScript` / `tests` *replaces* the composed chain's `script.post` elements in `requestElements` rather than joining them - with no way to know which assertions the agent meant, running both would add ones they never asked for.
  Without a `requestId` the run is ad-hoc and `url` is required.
  A saved request's **pre-request** script runs only when marked inline (`config.inline`) or this run's own `elements.scripts` override is `"allInline"` - left `asMarked` with no per-element mark, it still never runs, since there is no pre-request replay to defer it to the way `script.post` gets one.
  The count of `script.pre` elements that will *not* run is reported in the tool's result rather than passing silently, unless the override already covers them.
- **Scenario runs - a collection as the unit of work** (issue #754, reversing #454's deferral).
  A collection's ordered sequence of requests can be run from MCP in both of the engine's modes, over the one `POST /runs` route that takes a `scenario` block:
  - `run_collection` posts the block with **no** `mode`, which is what selects the design-mode runner: steps execute one at a time, share the environment's cookie jar, honour `pm.execution` flow control, run their stored **pre-request** scripts, and repeat once per `data` row with `{{data.column}}` bound and `pm.iterationData` set.
    It returns the run id immediately - the run continues engine-side - along with the plan's step count and a note on reading `get_run_report`: its `results` carries every stored step row (`stepsStored`; `resultsStored` / `resultsCap` say the same of any run).
    Each of those rows carries that step's request and response bodies inline, under `trace` (`build_result_trace`, the same node a single design-mode send stores) - not behind `GET /runs/:id/samples`, which is the load-run capture route - so a long plan against large responses makes for a large report.
    That is what the 96 KB total trace budget ([runs and reports](runs-and-reports.md)) bounds: past it a step row keeps its scalars and carries `traceOmitted` instead of its bodies, non-passing steps last to lose them, and `read_body` reads those bodies by the row's `id`.
  - `start_load_run` takes the same block as an optional `scenario` argument and posts it **with** a mode, which hands the plan to the load executor: `concurrency` is the number of virtual users, each walking the whole plan with its own cookies.
    Only `constant_concurrency` (the default), `ramp_up` and `iterations` can drive a sequence - `capacity` and `constant_rps` are refused with the engine's own reasoning (a knee measured against which step's p99? an arrival-rate executor Vayu does not implement), as is any non-zero `targetRps`: a scenario run is closed loop by design, whatever the declared mode.
  - The collection tree **is** the sequence: there is no step list to send, and `recursive: true` walks sub-collections in the sidebar's order: at each level the sub-collections and requests are one sibling list, a request runs where it sits and a sub-collection's whole subtree where the sub-collection sits, mirroring `collect_requests`.
    The pre-flight allowlist walk is the same walk (`scenarioStepRows`), pinned to the engine's by `recursive-run-order-conformance.json`, so the step a refusal names is the first one the run would have reached.
  - **Rows are inline** - the engine never opens a file - and its `maxScenarioDataRows` / `maxScenarioDataBytes` refusals, and the depth refusal (a cell nested deeper than 100 levels, `400` `invalid_run_config` or `invalid_scenario`), are surfaced verbatim rather than re-derived in the schema.
    `dataFileName` and `dataFileHash` (issue #2051) name the file the rows came from - a display name and the SHA-256 of its bytes as 64 lowercase hex, which the schema checks, refusing a name holding a `/` or `\` as a path - and are forwarded as given; the engine refuses either one sent without rows, by name.
    `dataFileCastNumbers` (issue #2540), a boolean, says the agent read the file's unquoted numeric cells as numbers; Vayu never converts the rows, it only records the reading, and it is forwarded and refused without rows on the same terms.
    See [Data files](saved-data.md#data-files).
  - A stored `mcp` request is bound per row like any other: `{{data.column}}` in its `body.content` is escaped as a JSON string, and the wire body and the `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` headers are derived from the bound call, so each row sends headers that agree with its own body (`tests/scenario_runner_data_test.cpp`, #3808).
    `Mcp-Param-*` needs the stored `mcpTool` (see above); a row whose `params.name` differs from `mcpTool.name` sends none.
  - `scenario.iterations` is offered on `run_collection` only.
    A load run reads the **top-level** `iterations` (total passes across all virtual users); the in-block count is the design runner's and the load executor never reads it, so offering it there would be an argument written and never read.
  - **`failOnSchemaError` makes the bound contract a gate** (issue #766), on `run_collection` only, matching the Run Collection dialog's checkbox.
    It is **run-scoped and top-level**, beside the `scenario` block rather than inside it, and is **sent only when asked for**: the engine defaults it to false, so a run snapshot carries the key exactly when it changed what "failed" meant.
    With it on, a step whose response does not match the schema its collection's bound document declares fails - but only a step that passed everything else; one already failing keeps the error that named it.
    Off, the verdict still rides every step and the report's `schemaValidation` totals.
    Note the default is the opposite of `run_collection_smoke`'s, for the reason recorded there.
    `start_load_run` **refuses** the flag on either of its paths, naming the executor: a load run validates sampled responses once the run has drained and never demotes a step, so the gate would decide nothing.
    It is declared on that tool for the refusal's sake - an argument the tool's schema does not name is refused as an unrecognized key, which says nothing of the surface that honours it.
  - **`stopOnError` ends an iteration at every errored step** (issue #2526), on `run_collection` only, matching the Run Collection dialog's switch.
    Top-level beside `scenario` and **sent only when true**, like `failOnSchemaError`.
    Left off, the engine's default, an errored step (a script that threw, a request that got no response, an unbindable data row) stays `errored` with its message and the iteration moves on to the next request, as in Postman and Newman; the runner's own refusals end the iteration either way.
    What an error that ended one cost is counted: `scenario.stepsNotRun` in `get_run_report`, and `stepsNotRun` on the step row that ended it, in its `trace` - the tool's description and the `nextStep` it returns both say so.
    `start_load_run` **refuses** it on either path for the reason it refuses `failOnSchemaError` (declared so the refusal that names `run_collection` is what an agent reads): no load path reads it.
  - **`elements: {timers, scripts}` overrides a run's stored timer/script behaviour without editing the collection** (issue #1559, exposing the block issue #1495 defines on `POST /runs`, `validate_elements_run_override`).
    `timers: "off"` silences every `timer.*` wait for the run; `scripts: "allInline"` / `"allDeferred"` forces every `script.pre`/ `script.post` element's inline-vs-deferred execution regardless of its own marking; `"asConfigured"` / `"asMarked"` (the defaults) leave each element's own configuration in effect.
    It is **top-level, beside `scenario`** rather than inside it, on both tools that read it - the same place `RunCollectionDialog`'s load-test section sends it.
    `run_collection` offers `elements: {timers}` only, since `scripts` has no reader on the design-mode path it drives.
    `start_load_run` offers both keys, on **either** shape it can start: `timers` fires on the scenario branch's `execute_scenario_run` (`RunContext::timers_override` wired into the same `ExchangeInputs` a scenario load run does) and, since issue #1594, on a single target's own submission pipeline too (`load_strategy.cpp`'s per-step hooks);
    `scripts` reaches the scenario load path's post-run replay and, since #1594, a single target's own inline-vs-deferred dispatch (`RunContext::script_element_runs_inline`) - the mechanism that makes `"allInline"` the thing that gets a single target's `script.pre` to actually run under load (see *Load-testing a saved request* above).
    This mirrors `RunCollectionDialog`'s own load-test controls, not the engine's full contract:
    `timers` also accepts a `{fixedMs}` / `{minMs, maxMs}` override (issue #1498) replacing every timer's own span, and the block also takes `includeScriptTime` and `seed`, but no control anywhere in the product - app or MCP - sends any of the three today, so these schemas only name the two enum values `"asConfigured"`/`"off"` and `"asMarked"`/`"allInline"`/`"allDeferred"`.
  - **The allowlist gate is all-or-nothing here**, unlike the smoke matrix's per-request skip: every step is composed by id and gated before the run is created, and one step the allowlist does not cover refuses the whole run with nothing sent, naming the step the way the engine names it (`step 1 (request 'checkout', id 'r2')`).
    The refusal names the host and withholds the composed URL, which is secret-resolved and so can carry a secret variable's value or a literal credential in its query or userinfo (#1892).
    A step that will not compose refuses it too - the engine resolves the same plan before creating the run row and would refuse it for the same reason.
    The engine holds the run to the same list as well (`targetPolicy`): a step's OAuth 2.0 token endpoint is judged when the plan is resolved, a `400` with no run row.
  - Every argument that describes a *single* target (`url`, `requestId`, `method`, `headers`, `body`, `auth`, `httpVersion`, `postRequestScript`, `collectionId`) is **refused by name** beside a `scenario`,
    as are `maxInFlight` (in-flight is bounded by the virtual-user count), `sloMs`/`stepDuration` (capacity's own fields) and `stream` (a collection's steps stream by each saved request's own Event stream setting, which a run cannot change).
    Each would otherwise be an argument an agent believes shaped the run that nothing on this path reads.
  - `maxStreamDurationMs` and `maxStreamEvents` are **accepted** beside a `scenario` (#3235), without `stream`: they are forwarded top-level and bound each step whose saved request streams, falling back to the `sseMax*` settings cap by cap, while a step that does not stream ignores them.
    `run_collection` takes the same two arguments for a design-mode run.
    Neither tool ever sends `stream` for a collection - the engine answers it with a `400` there.
- **Request mutation** - a pre-request script's `pm.request` edits (url, method, headers, body, auth) are applied to the request that is sent, so an agent can sign a request or override the engine-applied auth from `run_request` (with reveal on; the script itself is refused while it is off), and a saved request's stored pre-request script does the same under `run_collection_smoke`.
  The write-back is engine-side ([scripting.md](../scripting.md#mutating-the-request-pre-request-scripts)), so both tools get it without composing anything extra.
  A rejected edit comes back as `preScriptError` in the response.
  `start_load_run` did not offer the field at all before issue #1594 - `POST /runs` ran no pre-request hook on its single-target path.
  It still does not accept an ad-hoc `preRequestScript` argument (a saved request's own `script.pre` element is the only source), and a composed one only mutates the request when it is marked to run inline or this run's own `elements.scripts` override forces it - see *Load-testing a saved request* above.

`run_request` / `start_load_run` take optional `environmentId` and `collectionId` to scope resolution; both are forwarded to `POST /compose`.
Every tool that composes with an environment - those two (`start_load_run`'s `scenario` branch included), `run_collection`, `run_collection_smoke` and `get_graphql_schema` - picks it by the rule `resolve_variables` follows, in one helper (`resolveEnvironmentId`, issue #2480): an omitted `environmentId` is the **active** environment, as the app's Send does;
`"none"` is no environment; and an id no environment has is refused with the unknown-id sentence ([Error results](conventions.md#error-results)) before anything is composed or sent, where `POST /compose` alone would degrade it to an empty scope and send every environment token literally.
The environment picked is also the one the send's cookie jar, its History row and, with write access on, its scripts' environment writes belong to, so a call that names none lands in the active environment's jar and row exactly as the user's own Send does.
`clear_cookies` keeps its own contract: omitted there means every jar.
An unknown `requestId` is the engine's definitive 404, surfaced as a readable "no saved request with id" tool error.

**Cookies are shared with the app, per environment.**
`run_request` and `run_collection_smoke` go through `POST /execute`, which sends through the engine's cookie jar (issue #301) - so a `Set-Cookie` an agent collects is sent on its next call, and on the user's next Send in the same environment.
That is deliberate: the jar belongs to the environment, not to the caller, and giving MCP a jar of its own would make the same saved request behave differently for an agent than in the UI - a surprise in the harder direction to debug.
The state stays visible and resettable from either side: Settings → General → Cookies lists every jar and clears it, and `get_cookies` / `clear_cookies` (issue #758) read and clear the same jars over MCP - so an agent can see the session it inherited and drop it rather than only being told it exists.
An agent that must not inherit one at all should run in an environment of its own.
`run_collection` shares the jar too - the design-mode runner is the one executor handed it, which is what lets a login step authenticate the steps after it.
`start_load_run` is unaffected either way: a single-target load run never touches the jar, and a scenario load run gives each virtual user cookies of its own.

> **History.** Until issue #226 MCP carried `resolve.ts` - a full main-process
> port of the renderer's composition pipeline - because the engine composed
> only partway. That copy (and its `dynamic-variables.ts` twin) is deleted;
> the engine path is the single implementation, and the renderer's remaining
> resolver is preview-only. Do not reintroduce client-side composition here -
> a new engine client should call `POST /compose`.
