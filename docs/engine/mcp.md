# Vayu MCP Server

**Endpoint:** `http://127.0.0.1:9877/mcp` (Streamable HTTP) · **Also:** stdio CLI

Vayu exposes its engine to AI agents (Claude Code, Cursor, VS Code, Codex, Zed)
through a [Model Context Protocol](https://modelcontextprotocol.io) server. The
server is TypeScript, hosted in the Electron main process, built on the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk),
and proxies the engine's REST API on `:9876`. The **C++ engine is not modified** -
the MCP layer is Apache-2.0 like the rest of the app.

Once Vayu is running, any agent opts in with one command; if Vayu is down, the
agent gets a clean "start Vayu" error. Threat model and posture: [`SECURITY.md`](https://github.com/athrvk/vayu/blob/master/SECURITY.md).

## Overview

- **Hosted in the app.** MCP is a capability the running app exposes, not a
  separate process to manage. It is started and stopped alongside the engine
  sidecar by `app/electron/main.ts`, best-effort (a bind failure logs and the app
  continues without it).
- **Proxy, not a second source of truth.** Every tool maps to an existing engine
  endpoint via a thin `fetch` client (`engine-client.ts`). The main process
  cannot import the renderer's `@/services`, so this client is standalone.
- **Local-only.** Binds `127.0.0.1`, with Host-header (DNS-rebinding) validation
  on `/mcp`.
- **Configurable from Settings.** Server on/off, the allowlist, caps, the write
  toggle, and per-tool switches live in **Settings → MCP** and persist across
  restarts.

## Connecting

Ensure Vayu is running, then register the endpoint once per machine. In the app,
**Settings → MCP** offers a one-click **Connect** for Claude Code and VS Code
(shells out to their CLIs) and copyable snippets for the rest.

Connect resolves the client CLI before running it, because a GUI-launched app
often has a stripped PATH. On macOS and Linux that means the login shell
(`$SHELL -lc`, falling back to `/bin/sh -lc` for a shell that does not accept
`-lc`); on Windows it means `where`, preferring an `.exe` and then a `.cmd`
shim over the extensionless POSIX script VS Code also installs. A `.cmd`/`.bat`
shim is run through `cmd.exe`, which Node has required since 20.12. If the CLI
is not installed, or the run fails for any reason, Connect says so and the
snippet below it is the manual path.

```bash
# Claude Code (or click Connect in Settings → MCP)
claude mcp add --transport http vayu http://127.0.0.1:9877/mcp
```

```json
// Claude Code (.mcp.json) / Cursor (.cursor/mcp.json)
{
  "mcpServers": {
    "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" }
  }
}
```

```json
// VS Code (.vscode/mcp.json) - note the "servers" key
{
  "servers": { "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" } }
}
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.vayu]
url = "http://127.0.0.1:9877/mcp"
```

### Client compatibility

MCP defines three transports: **stdio**, **Streamable HTTP**, and the legacy
**HTTP+SSE** (deprecated; not built for). The fixed-port Streamable HTTP endpoint
covers most clients with a single URL; Zed (stdio-only) uses the CLI below.

| Client           | Streamable HTTP    | stdio | Config location                                 |
| ---------------- | ------------------ | ----- | ----------------------------------------------- |
| **Claude Code**  | ✅ (`http`)        | ✅    | `.mcp.json`, `~/.claude.json`, `claude mcp add` |
| **Cursor**       | ✅                 | ✅    | `.cursor/mcp.json`, `~/.cursor/mcp.json`        |
| **VS Code**      | ✅ (`servers` key) | ✅    | `.vscode/mcp.json`                              |
| **OpenAI Codex** | ✅                 | ✅    | `~/.codex/config.toml`                          |
| **Zed**          | ❌ not yet         | ✅    | `context_servers` (stdio CLI)                   |

## Transports

### Streamable HTTP (primary)

`http.ts` hosts the endpoint on `127.0.0.1:9877/mcp`. It is **stateless**: each
`POST /mcp` gets a fresh SDK server + transport (`sessionIdGenerator: undefined`,
`enableJsonResponse: true`); `GET`/`DELETE` return `405`; non-`/mcp` paths `404`.
DNS-rebinding protection is on (Host must be `127.0.0.1:9877` / `localhost:9877`).
A body that is not valid JSON is answered `400` with JSON-RPC `-32700` (parse
error), and one over the 4 MB cap `413` with `-32600` - past the cap the rest of
the upload is drained and discarded rather than the socket being closed under it,
since resetting the connection mid-upload loses the very response the status code
exists to deliver. The cap bounds what is held in memory, not what crosses the
wire. The body is read before the transport sees it, so these are answered
directly rather than by the SDK. Both messages are fixed strings - nothing
derived from the underlying error reaches the wire - and `-32603`
("Internal error") is left to mean a genuine handler failure, including a socket
error while reading.
The per-request rebuild means Settings changes (allowlist, caps, disabled tools)
take effect on the next request with no extra bookkeeping.

### stdio CLI (Zed / headless / CI)

`cli.ts` is a standalone stdio server that reuses the same server factory and
tool registry. It is for stdio-only clients (Zed) and headless/CI. Run:

```bash
node dist-electron/mcp/cli.js
```

Configuration comes from environment variables (see [Configuration](#configuration)),
since there is no Settings UI. It still requires a running engine.

### What is live on each transport

Elicitation (human confirmation) and `tools/list_changed` (live tool-set updates)
need a server→client channel, which exists on **stdio** but not on the stateless
HTTP host. On HTTP they degrade gracefully: load-run confirmation falls back to a
`confirmed: true` flag, and a tool toggle applies on the client's next
`tools/list`. Both are safe on HTTP, just not instantaneous. See
[Design notes](#design-notes).

## Tools

Every tool carries a `category` (surfaced in Settings for enable/disable), MCP
**annotations** (`readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint` + a display title), and a **Zod** input schema (arguments are
validated by the SDK). A few declare an `outputSchema` and return validated
`structuredContent` alongside the text rendering.

The four categories partition tools by what they can do - and thus which gate
applies: **read** (inspection, always safe), **execute** (has an effect outside
this process without touching saved data - allowlist when it sends real traffic
to a target, none when the effect is a loopback service the engine hosts, as for
the mock issuer), **write** (mutates saved data or engine config - write
toggle), **load** (starts/stops load tests - allowlist + caps + confirmation).

| Tool                   | Category | Maps to                                      | Gate                       |
| ---------------------- | -------- | -------------------------------------------- | -------------------------- |
| `get_engine_health`    | read     | `GET /health` (structured)                   | -                          |
| `list_collections`     | read     | `GET /collections`                           | -                          |
| `list_requests`        | read     | `GET /requests?collectionId=`                | -                          |
| `list_environments`    | read     | `GET /environments`                          | -                          |
| `list_runs`            | read     | `GET /runs?limit=100`                        | First page (100) of the `{data, pagination}` envelope; rows carry a compact summary |
| `get_run_report`       | read     | `GET /runs/:id/report`                       | -                          |
| `get_engine_config`    | read     | `GET /config`                                | -                          |
| `get_live_metrics`     | read     | SSE snapshot of last N ticks                 | `limit` must be a whole number ≥ 1 |
| `compare_runs`         | read     | 2× `GET /runs/:id/report` → diff (structured)| `baseRunId` optional - omitted, it resolves the target's pinned baseline |
| `run_request`          | execute  | `POST /compose` + `POST /execute` (+ `GET /runs/:id/events` when streaming) | allowlist                  |
| `run_collection_smoke` | execute  | `GET /requests?…` + `POST /compose` + `POST /execute` (×N) | allowlist per host |
| `create_collection`    | write    | `POST /collections`                          | write toggle               |
| `update_collection`    | write    | `PUT /collections/:id` (merge-patch)         | write toggle               |
| `delete_collection`    | write    | `GET /collections` + `GET /requests?…` (×N) + `DELETE /collections/:id` | write toggle + confirm |
| `create_request`       | write    | `POST /requests`                             | write toggle               |
| `update_request`       | write    | `PUT /requests/:id` (merge-patch)            | write toggle               |
| `delete_request`       | write    | `GET /requests/:id` + `DELETE /requests/:id` | write toggle + confirm     |
| `update_environment`   | write    | `GET /environments` (scan) + `PUT /environments/:id` (fetch-merge) | write toggle |
| `update_engine_config` | write    | `POST /config`                               | write toggle               |
| `start_load_run`       | load     | `POST /compose` + `POST /runs`               | allowlist + caps + confirm; optional `thresholds` budgets and `monitor` server-vitals block; `mode` accepts `constant_rps` \| `constant_concurrency` \| `ramp_up` \| `iterations` \| `capacity` |
| `stop_run`             | load     | `POST /runs/:id/stop`                        | -                          |
| `start_mock_issuer`    | execute  | `POST /mock-issuer/start`                    | - (loopback-only listener, so no allowlist entry applies); limits are the engine's - 31-day expiry, 60s `slowMs`, 32 clients, 8 concurrent issuers |
| `list_mock_issuers`    | read     | `GET /mock-issuer`                           | -                          |
| `stop_mock_issuer`     | execute  | `POST /mock-issuer/:id/stop`                 | - (unknown id is a `404`, surfaced as a tool error) |

Notes:

- **`start_load_run`** requires confirmation - via elicitation when the client
  supports it, otherwise a `confirmed: true` flag - and enforces the RPS /
  concurrency / duration caps. In `capacity` mode the concurrency cap bounds the
  search's *ceiling* (`concurrency`) and its starting level
  (`startConcurrency`), which is what stops an adaptive run from outgrowing it;
  `sloMs` and `stepDuration` are that mode's own two fields, and
  `get_run_report` returns the search's findings under `capacity`. The duration
  cap accounts for the mode's own engine-side default deadline (5 minutes, not
  the 60s other modes fall back to), so a cap between those two values still
  injects an explicit `duration` when the agent omits one. `get_live_metrics` is a **bounded snapshot** (SSE
  read with a time budget), not a stream - `tools/call` stays request/response.
- **`start_load_run`'s `stream` flag** consumes each response as a
  `text/event-stream` (issue #576), with `maxStreamDurationMs` and
  `maxStreamEvents` bounding one stream. Both caps are forwarded verbatim on the
  `thresholds` precedent - their ranges are the engine's, and re-deriving them
  here would be a second copy to keep in step - and the schema sends no `stream`
  key at all when the agent named none, because the engine refuses a cap without
  the flag and refuses the flag beside `transient`. Worth telling an agent
  explicitly: **reaching either cap completes the stream successfully**, so a
  streaming run's 0% error rate is not evidence the caps were never hit -
  `get_run_report`'s `stream.capped` is what answers that. The report's `stream`
  section also carries the per-completion event distribution and a derived
  `eventsPerSecond`.
- **`start_load_run`'s `monitor` block** scrapes the target's own metrics
  endpoint for the life of the run (`url`, optional `intervalMs` and `format`,
  and the `series` names to read), so an agent asked why a target slowed down
  can read its CPU on the same timeline as p99 - the report comes back with a
  `monitor` section carrying per-series min/max/avg plus the sample and
  failed-scrape counts. The block is forwarded verbatim: its value ranges are
  the engine's (`validate_run_config`), and `monitor.series`' ceiling is the
  `monitorMaxSeries` **setting**, so a second copy of those bounds in the tool
  schema would refuse blocks the engine accepts the moment a user raises it.
  **The monitor endpoint is a second host**, and it takes the allowlist
  decision described under [Safety](#safety-model) rather than the target's
  check by extension. The scrape needs no cap of its own: the monitor thread is
  joined when the run ends, so whatever bounds the run bounds it.
- **`compare_runs`** takes `baseRunId` optionally. Omitted, it resolves the run
  pinned as the **baseline** for whatever saved request the target ran -
  `GET /runs/:id` for the `requestId`, then
  `GET /runs?baseline=true&requestId=<id>&limit=1` - which is the same lookup
  the app's history view makes, so an agent and the UI never compare a run
  against different references. Nothing to resolve through (an ad-hoc run with
  no saved request), no pin for that request, or a target that *is* the pin:
  each is a refusal naming the fix, never a silent comparison against some
  other run. Every metric in the result carries a `direction` -
  `lower-is-better`, `higher-is-better` or `neutral` (total requests, which
  moves with how long a run was told to run) - so a reader can tell a
  regression from an improvement without knowing each metric's sense.
- **`update_engine_config`** reads the config back after applying and flags any
  changed key that needs an engine **restart** to take effect under
  `restartRequired` in its structured result (read from each entry's typed
  `requiresRestart` field, not from its label). Such values are saved, but the
  running engine keeps the old value until it is restarted, so the tool says so
  in its text output too.
- **The collection / request write verbs** are the CRUD an agent needs to work
  unattended: `create_collection` gives it a `collectionId` to file new requests
  under, and `update_request` / `delete_request` let it correct or remove a
  request it got wrong instead of leaving the cleanup to a human. The two
  updates are **merge-patches** - the tool sends only the fields the caller
  named, and `PUT /collections/:id` / `PUT /requests/:id` keep everything else
  stored, so a patch naming just `name` cannot blank a url, an auth block or a
  script. A patch naming nothing is refused rather than sent as a write that
  changes nothing, and `bodyType` without `body` is refused too (the blob and
  its denormalized column move together or the two disagree about what the
  request sends). `update_collection` renames and re-describes only: reparenting
  is `POST /reorder`'s job and is not exposed here.
- **`delete_collection` cascades**, so it reads the subtree first: `GET
  /collections` gives it every descendant through `parentId`, one `GET
  /requests?collectionId=` per collection in that subtree gives the request
  count, and those counts are what the confirmation states. An unreadable
  subtree - or an id no collection has - is a refusal, never a prompt carrying
  a number nobody verified. `delete_request` reads the row the same way, so the
  prompt names the request and its URL rather than an opaque id.
- **`update_environment`** fetches the environment and merges the supplied
  variables (`PUT /environments/:id` replaces the whole variables blob), so
  partial updates preserve untouched variables and the name. Overwriting an
  existing variable changes its value only - its `secret`, `type`, `createdAt`
  and enabled/disabled state are preserved, so a rotated secret stays masked and
  a disabled variable stays disabled. It is a `PUT`, not
  a `POST`: since #95 the engine's `POST /environments` is create-only, and since
  #97 it rejects a body carrying an `id` outright. `create_request` stays a
  `POST` for the same reason - it creates, and lets the engine assign the id.
  Neither tool sends an `id` in a body: on the `PUT` the path is the identity,
  and a body `id` disagreeing with it is a `400`.
- **`run_collection_smoke`** runs each saved request once and returns a structured
  pass/fail matrix (2xx–3xx status + all tests passing = pass). Each request is
  composed exactly as the app's **Send** would (see *Request composition* below).
  Requests whose host still can't be verified after resolution (e.g. a variable
  did not resolve and allow-all is off) are skipped, not sent.
  It **does not recurse**: `GET /requests?collectionId=` serves a collection's
  direct requests, while collections nest via `parentId`, so a run on a parent
  folder tests none of its descendants. The result appends a note naming the
  sub-collections it left out (and says so explicitly if the collection list
  could not be read), because a matrix whose `total` silently excludes nested
  folders reads as a whole-collection pass. Requests run serially, so a large
  collection takes as long as its requests do added together.
- **The mock-issuer tools** let an agent asked to "test this auth flow" mint its
  own tokens: `start_mock_issuer` stands up a
  [local OAuth 2.0 issuer](api-reference.md#local-mock-issuer) and returns its
  `issuerId`, `tokenUrl`, `authorizeUrl` and `signingKey`, so the agent can
  point a request's `oauth2` auth at the token URL, `run_request` it, and assert
  on what the target received - offline, with no real provider's 2FA prompts or
  rate limits in the loop. `expiresInSeconds` plus `issueRefreshTokens` is how
  the 401-then-refresh path is exercised, and `failureMode` is how retry
  handling is. **No allowlist entry is needed and none is checked**: the engine
  binds every issuer to `127.0.0.1` and takes no host for it, so an issuer is
  unreachable off the machine; the per-tool switch is what turns these off. The
  start body is forwarded verbatim under the engine's own key names, and the
  engine's limits (31-day expiry, 60s `slowMs`, 32 clients, 8 concurrent
  issuers) stay engine-side rather than being restated in the tool schema, for
  the same reason `monitor`'s ranges are - a second copy would refuse values the
  engine accepts the moment either side moves. The schema owns the *shape*: a
  claims object, an integer port, a `failureMode` from the closed set. Stopping
  an issuer frees its port; tokens it already minted stay valid until they
  expire, since nothing verifies them against a live issuer. These tools emit no
  `mcp:data-changed` event because no renderer surface reads issuers yet -
  #502's Services drawer is what adds one.
- **Cancellation:** the `AbortSignal` the SDK fires on `notifications/cancelled`
  is threaded into the engine `fetch` for every tool call, resource read,
  template list and prompt, so a client cancelling an in-flight call actually
  aborts it rather than leaving the engine request running detached. The one
  exception is the run-ID **completion** callback, which the SDK invokes as
  `(value, context?)` with no request context to carry a signal.
- **Timeouts:** engine-local calls are bounded at 35s, but `POST /execute` waits
  on a third-party server, so its budget is derived from the engine's own
  `defaultTimeout` setting (read per call from `GET /config`, up to its 300s
  ceiling) plus 10s of grace - the same rule the renderer uses for its proxied
  calls. That way the engine's own `TIMEOUT` error, with its error code and its
  run row, arrives before this client gives up. If the budget does expire, the
  tool says the call may still have completed and points at `list_runs`; it is
  never reported as an unreachable engine, because a retry could re-send a
  request that already went out.

### Request composition

The **engine** owns request composition (`POST /compose`, issue #226): it
resolves `{{variables}}` and walks the collection ancestor chain to resolve
`inherit` auth, then returns the execute-ready payload `POST /execute` /
`POST /runs` accept unchanged. Composition is pure - nothing is sent - which
is exactly what MCP's safety model needs: every execute/load tool composes
first, checks the **allowlist against the composed (resolved) URL**, and only
then executes the composed payload, byte-for-byte, so nothing is ever
interpolated twice.

Scripts: the by-id compose path builds the ordered part list
(`{ origin, id, name?, script }` - collection chain root→leaf, then the
request's own) engine-side from the stored rows. The renderer's inline path
still builds its own list from its editor state; MCP no longer builds any.
MCP's ad-hoc tools forward agent-supplied strings
(`preRequestScript`/`postRequestScript`) inside the inline request - scripts
ride through composition untouched, never interpolated.

**One validation script, one name.** The post-response script is one field in
the app - the request builder's **Tests** tab - and has historically reached the
engine under two key names: `postRequestScript` on `POST /execute`, `tests` on
`POST /runs`. Both endpoints now accept both names, so MCP declares
**`postRequestScript` on both `run_request` and `start_load_run`**, and a script
an agent writes for one carries to the other unchanged. It is still placed under
`tests` on a run payload (`tools.ts::readValidationScript` +
`composeLoadRunRequest`), because that is the name a run's own composed scripts
do *not* use - which is what lets an explicit script displace them rather than
sit beside them. `tests` stays accepted on both as the
engine's own spelling - a Zod object strips keys it does not declare, so
removing it would turn a script the agent believes is running into silence.
Passing both names is rejected with a `ToolArgError` rather than resolved by
precedence: they are one slot, and dropping either would report a run as
validated by assertions that never ran. Under load the script runs against
*sampled* responses (`max_response_samples` / `response_sample_rate`), not every
one.

How each tool uses `POST /compose` (`tools.ts::composeViaEngine`):

- **Variables** - the engine resolves URL, headers, and body with the app's
  precedence (environment > collection chain, leaf→root > globals; enabled
  only; unknown → empty string; dynamic variables like `{{$guid}}` generated
  per occurrence). MCP hands it raw strings and checks the allowlist against
  the **composed** host. `start_load_run` composes once, like the app, so a
  run repeats one generated value across its iterations; see
  [variable resolution](../app/variable-resolution.md#dynamic-variables).
- **Auth** - `run_collection_smoke` composes each saved request by id, so its
  stored auth applies (`inherit` resolved against the collection chain);
  `run_request` / `start_load_run` accept an explicit `auth` block and forward
  it raw inside the inline request - the engine resolves variables in it (and
  `inherit`, when a `collectionId` scopes the walk) and applies it at execute
  (oauth2 uses its token cache).
- **Scripts** - composing by id attaches the collection chain's + the
  request's own script parts engine-side, so a request's tests and setup
  actually execute. `run_request` takes an agent-written `preRequestScript` /
  `postRequestScript` instead, since an ad-hoc call has no chain to compose
  from; `start_load_run` takes the same `postRequestScript` for a URL-only run.
  Those two are supplied per call and are not stored - `create_request` and
  `update_request` take the same two names to write a script onto the saved
  request itself, which is what lets an agent-authored script outlive the call
  that wrote it (see *Storing a request's scripts* below).
- **Bodies** - `body` is a string and `bodyType` names the mode
  (`json` | `text` | `graphql` | `jsonrpc` | `xml` | `form-data` |
  `x-www-form-urlencoded`,
  default `text`). The two form modes carry their content as **fields**, not as
  a string, so `body` is written as `key=value&key=value` and split into the
  `fields` rows the engine reads - see
  [the `body` union](api-reference.md#the-request-body-union). A `graphql`
  `body` may be the bare query document: the engine envelopes it as
  `{"query": ...}` and sends `application/json`, and an envelope written out in
  full is sent unchanged - see
  [the `graphql` envelope](api-reference.md#the-graphql-envelope). A `jsonrpc`
  `body` may be the bare call object: the engine adds `"jsonrpc":"2.0"`, plus
  `"id":1` when the call names no id, and a frame that already declares a
  string `"jsonrpc"` is sent byte for byte - which is how an agent chooses its
  own id or sends a notification - see
  [the `jsonrpc` envelope](api-reference.md#the-jsonrpc-envelope). An `xml`
  `body` has no envelope at all: it is stored and sent byte for byte and carries
  `application/xml` unless the agent set a Content-Type of its own, which is how
  a SOAP 1.2 endpoint gets `application/soap+xml`.
  `create_request` stores the same shape. Every field an agent writes is a **text** part: a
  `form-data` [file part](api-reference.md#file-parts-form-data-only) names a
  path on the user's machine, which an agent cannot choose for them or verify,
  so the tools state the limit rather than inventing a shape for it. A stored
  file part is left alone unless `body` replaces the whole body.
- **What actually went out** - the engine adds headers an agent never wrote: the
  body-implied `Content-Type` (a `graphql` or `jsonrpc` body sends
  `application/json`, an `xml` one `application/xml`, an
  `x-www-form-urlencoded` one its own type), a
  default `User-Agent`, and
  the `Cookie` line the jar matched for the environment. So the request an agent
  composed is not the request that was sent, and asserting on the composed one
  is how a correct request gets reported as wrong. `requestHeaders` in the
  result is the sent record - composed plus those first two, minus a
  `form-data` `Content-Type` libcurl writes itself - and `rawRequest` is the
  full wire frame including the `Cookie` line and libcurl's own `Accept` /
  `Content-Length`. Both are passed through verbatim; read them rather than the
  request the call sent. A `postRequestScript` reads the same set as
  `pm.request.headers` (see
  [scripting.md](scripting.md#request-object-pmrequest)).
- **Streaming** - `run_request` takes `stream: true` for a `text/event-stream`
  endpoint (issue #575). `tools/call` is request/response, so the tool does not
  stream to the agent: it starts the run, reads the relay for at most
  `streamBudgetMs` (default 5000, maximum 60000) collecting at most
  `maxStreamEvents` (default 50), and returns those events with **which bound it
  stopped at** beside them - `completed`, `capReached` or `budgetExhausted`, plus
  `totalEvents` where the completion frame reported it. The three are separate
  because the follow-up differs: a completed stream is finished, a capped read
  wants a larger cap, and an exhausted budget means the run is still going and
  `stop_run` ends it. The flag is sent on **every** call, never elided and never
  inherited from a stored row - the two answers have different shapes, so the
  tool decides which one it is about to parse rather than a default deciding for
  it. The allowlist gate is unchanged: it runs on the composed URL before
  anything is sent.
- **Data rows** - `run_request` takes an optional `data` object: one row, which
  binds every `{{data.column}}` in the URL, headers and body and which both
  scripts read as `pm.iterationData` (`pm.info.iteration` is `0`, issue #601).
  It rides *beside* the composed payload rather than through `/compose`, because
  `{{data.*}}` survives composition by design - that is what leaves the tokens
  for the engine to bind. A column the row does not carry is an error naming the
  token and the row's columns, and **nothing is sent**. Auth credentials bind as
  well (issue #642) - before they are encoded, so basic auth base64s the row's
  values - with OAuth 2.0 the one mode no row can reach, refused by name because
  its token comes from the token endpoint rather than from the request. The
  allowlist gate reads the composed URL as always - a `{{data.*}}` in
  the *path* leaves the host knowable and is judged on that host, while a
  template in the authority is still "unknown host" and denied.
  `run_collection_smoke` stays out of it: it has no scenario path at all, so
  there is no row for it to bind.
- **Protocol** - `run_request` and `start_load_run` both take an optional
  `httpVersion` Zod-enum arg (`"auto" | "http1.1" | "http2"`, default `"auto"`),
  mirroring the request builder's Settings-tab picker. `run_collection_smoke`
  has no such arg: it replays each saved request exactly as-is, and `POST
  /compose` always emits a stored request's protocol. `start_load_run` with a
  `requestId` lays a stated `httpVersion` over the stored one through the
  compose body's `request` overlay, like any other agent-stated field. On a
  URL-only call there is no saved row behind the request, so `httpVersion` is
  forwarded only when the caller actually supplies it.
- **One post-request script, three names, all accepted everywhere.** It is
  stored as `postRequestScript` (on a request and on a collection), sent as
  `postRequestScripts` / `postRequestScript` to `POST /execute`, and as `tests`
  to `POST /runs`. Both routes read every spelling through
  `read_post_request_script`, so a payload composed for one endpoint starts the
  other kind of run unchanged - which is what lets `start_load_run` send a saved
  request's composed `postRequestScripts` to `/runs`. The names are tried in a
  fixed order and the first non-blank wins; they are never merged. MCP still
  shows the agent a single name (see *One validation script, one name* above) -
  that is now a courtesy rather than a translation the wire depends on.
- **Storing a request's scripts** - `create_request` and `update_request` both
  take `preRequestScript` and `postRequestScript` (strings, optional), written
  through to the engine's own field names on the request row, so the app's
  **Pre-request** and **Tests** tabs open on exactly what the agent wrote.
  `update_request` merge-patches them like every other field: **leave one out
  and the stored script is kept; pass an empty string and it is cleared.** The
  `tests` alias is deliberately absent here - it is the engine's spelling for an
  *ad-hoc run body*, and a stored field answering to two names is a second name
  to keep in step. Storing a script adds persistence, not execution capability:
  an agent could already run arbitrary scripts through `run_request`, and a
  stored one runs only when the request is later sent. Both tools already
  declare `invalidates: ["request"]`, so the renderer refetches the row and
  picks the scripts up without a further entity.
- **Load-testing a saved request** - `start_load_run` with a `requestId`
  composes it by id, exactly as `run_collection_smoke` and the app do:
  variables resolved, stored auth applied through the collection chain, and the
  chain's + its own test scripts attached. Any field stated explicitly (url,
  method, headers, body, auth, httpVersion) rides in the compose body's
  `request` overlay and replaces the stored one *before* resolution; an
  explicit `postRequestScript` *replaces* the composed script parts rather than
  joining them. Without a `requestId` the run is ad-hoc and `url` is required.
  A saved request's **pre-request** script cannot run under load - `POST /runs`
  has no such hook - so the composed `preRequestScripts` are stripped from the
  payload and the count of dropped scripts is reported in the tool's result
  rather than passing silently.
- **Scenario runs are out of scope** - `start_load_run` loads a *single* target
  (a URL, or one saved request). A scenario load run - a collection's ordered
  sequence of requests, driven as one run - is started from the app's **Run
  Collection** dialog only; no MCP tool starts one, and `collectionId` here
  scopes variable resolution rather than naming a sequence to run. The tool's
  own description says so, because a tool list that is silent about scenarios
  reads as "scenarios do not exist" rather than "not from here".
- **Request mutation** - a pre-request script's `pm.request` edits (url, method,
  headers, body) are applied to the request that is sent, so an agent can sign a
  request or override the engine-applied auth from `run_request`, and a saved
  request's stored pre-request script does the same under
  `run_collection_smoke`. The write-back is engine-side
  ([scripting.md](scripting.md#mutating-the-request-pre-request-scripts)), so
  both tools get it without composing anything extra. A rejected edit comes back
  as `preScriptError` in the response. `start_load_run` has no pre-request hook
  at all - `POST /runs` runs only the deferred `tests` script - so it does not
  offer the field rather than accepting one that would never run.

`run_request` / `start_load_run` take optional `environmentId` and
`collectionId` to scope resolution; both are forwarded to `POST /compose`.
An unknown `requestId` is the engine's definitive 404, surfaced as a readable
"no saved request with id" tool error.

**Cookies are shared with the app, per environment.** `run_request` and
`run_collection_smoke` go through `POST /execute`, which sends through the
engine's cookie jar (issue #301) - so a `Set-Cookie` an agent collects is sent
on its next call, and on the user's next Send in the same environment. That is
deliberate: the jar belongs to the environment, not to the caller, and giving
MCP a jar of its own would make the same saved request behave differently for
an agent than in the UI - a surprise in the harder direction to debug. The
state stays visible and resettable: Settings → General → Cookies lists every
jar and clears it, and `GET /cookies` reports the same. An agent that must not
inherit a session should run in an environment of its own. `start_load_run` is
unaffected - load runs never touch the jar.

> **History.** Until issue #226 MCP carried `resolve.ts` - a full main-process
> port of the renderer's composition pipeline - because the engine composed
> only partway. That copy (and its `dynamic-variables.ts` twin) is deleted;
> the engine path is the single implementation, and the renderer's remaining
> resolver is preview-only. Do not reintroduce client-side composition here -
> a new engine client should call `POST /compose`.

## Resources

Read-only Vayu data an agent can attach as context (`resources.ts`):

| URI                         | Contents                         |
| --------------------------- | -------------------------------- |
| `vayu://runs`               | The most recent 100 runs (first page), newest first; `pagination.total` / `hasMore` in the content carry the full count. |
| `vayu://collections`        | All request collections.         |
| `vayu://environments`       | All environments.                |
| `vayu://config`             | Engine configuration entries.    |
| `vayu://scripting/completions` | The script sandbox's full API surface (see below). |
| `vayu://run/{runId}/report` | A run's full report (templated). |

The templated report resource has a **list** callback (enumerates recent runs so
each shows in `resources/list`) and a **completion** callback (autocompletes run
IDs).

### The script sandbox surface

`preRequestScript` and `postRequestScript` run in the engine's QuickJS sandbox,
which is the same sandbox the app's editors target. There is exactly one
per-client capability gate - `pm.sendRequest`, below - and an agent can do
anything else a script in the app can. What an agent lacked was any way to
*know* that: until issue #233 the entire script surface it could see was the two
sentences in those fields' descriptions, so `pm.expect` chains,
`pm.response.to.*`, the variable scopes and `pm.crypto` were invisible and
simply never attempted.

#### `pm.sendRequest` is refused for MCP-started runs

The sandbox can send an auxiliary request (issue #302). That would be a hole in
the allowlist if it applied here, and the reason is structural rather than an
oversight: **the allowlist is checked in this server, against the composed URL,
before it calls the engine.** A request issued from inside a script never goes
through the MCP server at all, so it could never be checked - an agent that can
write a script would otherwise reach any host, defeating a control the user set
in Settings.

Three ways to close that were available, and this is which one and why:

- *Move the allowlist engine-side for script-issued requests.* Rejected. The
  allowlist lives in the app's config, and the engine has no channel to it; the
  engine would need a second implementation of host matching alongside
  `safety.ts`'s - two copies of a security check, which drift. It would also
  leave the engine enforcing an allowlist for one kind of request and not the
  others, which is harder to reason about than either extreme.
- *Gate the feature off by default behind a setting.* Rejected. It adds a knob
  whose safe position is the only correct one for MCP, and the hole reopens the
  moment anyone flips it for an unrelated reason.
- **Refuse script-issued requests unless the caller explicitly asks.** Chosen.
  The engine denies `pm.sendRequest` unless the execute/run payload carries
  `allowScriptRequests: true`. The app's own Send and load runs ask for it, each
  in the one service method that owns that call (`apiService.executeRequest` and
  `executeStreamRequest` - Send's two halves - plus `startLoadTest` /
  `startScenarioRun`); this server never does. The allowlist stays exactly where
  the user configured it, and the engine gains a capability bit rather than a
  policy copy.

Denying by **default** is the load-bearing half: a new tool here, or any future
engine client, gets a script that cannot send rather than unchecked egress.
An agent cannot set the field either - every tool builds its request from named
arguments, so an `allowScriptRequests` in the arguments is dropped before
composition, and Zod strips what a tool does not declare.

A script that calls `pm.sendRequest` under MCP throws a message saying why, so
an agent is told rather than left with a silently missing global. The
completion entry states the same thing, so the surface an agent reads and the
surface it gets agree.

`vayu://scripting/completions` closes that. It re-serves the engine's own
`GET /scripting/completions` - the single source of truth that also feeds Monaco,
generated from one table in `engine/src/http/routes/scripting.cpp` and
cross-checked against the runtime by `script_completions_test.cpp`. Notably it
carries `pm.crypto.sha256` / `.hmacSha256` and the `btoa` / `atob` globals, and
their documentation states they are **synchronous** (the sandbox has no event
loop, so nothing Promise-based would ever settle).

Each entry is trimmed to `label`, `detail` and `documentation`; Monaco's own
`insertText`, `insertTextRules`, `sortText`, `filterText` and `kind` are dropped,
since snippet placeholders and a `CompletionItemKind` enum mean nothing outside
an editor. The trim is the only transformation - **no list of `pm.*` names is
maintained app-side**, which is the point: a name the engine adds reaches agents
with no second edit, and `resources.test.ts` fails if the resource ever answers
from a local literal instead of the engine. The tool descriptions carry one
sentence pointing here, for an agent that never lists resources.

## Prompts

Server-provided starting points a user picks in their client (`prompts.ts`):

| Prompt                 | Arguments                | Produces                                                    |
| ---------------------- | ------------------------ | ----------------------------------------------------------- |
| `summarize_run`        | `runId`                  | The run report + a "summarize p50/p95/p99, errors, health". |
| `compare_runs`         | `baseRunId, targetRunId` | The computed delta + "did this regress?".                   |
| `diagnose_errors`      | `runId`                  | The report + an error-focused diagnosis prompt.             |
| `suggest_load_profile` | `url, goal?`             | Guidance to design a `start_load_run` (no engine data).     |

## Safety model

Enforced in the MCP layer (`safety.ts`, `config.ts`), with one exception noted
below: script-issued requests are refused engine-side, because this layer cannot
see them. Nothing here changes engine *behaviour* for other clients. All
configurable in **Settings → MCP** and persisted.

- **Target allowlist** (default empty ⇒ deny all). Network-touching tools refuse
  off-list hosts with an actionable error. An **"Allow all hosts"** opt-in
  bypasses the list (still rejects unresolved `{{variables}}`); off by default.
  Entries are hostnames, matched exactly: what you type in Settings is reduced to
  a host (`https://api.example.com:8080/v1` and `api.example.com` are the same
  entry), and the request URL is matched by its host whether or not it carries a
  scheme (`localhost:3000/api` matches the entry `localhost`). An IPv6 target is
  stored and shown in its canonical bracketed form - typing `::1` stores `[::1]`,
  which is what a URL parses to.
  A run's **`monitor.url` is a second host** and gets its own check, with one
  deliberate exemption: a **loopback or private-network** monitor endpoint
  (`localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `::1`, `fc00::/7`, `fe80::/10`) needs no allowlist entry, while a public one
  is checked exactly as the target URL is. The allowlist exists to stop an agent
  generating traffic against third parties it was never pointed at, and a
  private address is by definition the user's own network - which is also the
  feature's own case, since the endpoint a load run wants beside it is the
  target's own `localhost:9100`. The test is textual, like the allowlist itself:
  a DNS name that *resolves* to a private address still needs an entry, because
  resolving it here would make the answer depend on the network it was asked on.
  Because the check happens here, before the engine is called, a request sent
  from inside a script could not be checked at all - so `pm.sendRequest` is
  refused outright for runs this server starts. See
  [The script sandbox surface](#pmsendrequest-is-refused-for-mcp-started-runs).
- **Hard caps** - max RPS / concurrency / duration / iterations on
  `start_load_run`; over-cap requests are rejected. With the allowlist, these are
  the real limits on load, and they cover **every** field the tool forwards:
    - `concurrency` **and** `startConcurrency` are both held to the concurrency
      cap. A ramp is seeded with `startConcurrency` before its first duration
      check, so capping only the target would bound where a run ends and not
      where it starts.
    - An **iterations** run stops on a request count and never reads `duration`,
      so no duration cap can bound it. **Max iterations** is its own setting for
      that reason (10000 by default). An omitted `iterations` is compared as the
      engine's own default of 1000, and an unrecognised `mode` carrying an
      `iterations` field is capped the same way, because the engine runs that as
      an iterations run too.
    - An **omitted** `duration` is 60s engine-side, not "unbounded" and not
      "capped". When `maxDurationSeconds` is under 60, the tool sends the cap as
      an explicit duration so the run is actually bounded by it.
  `concurrency`, `startConcurrency`, `iterations` and `maxInFlight` are
  additionally constrained to positive integers by the tool's own schema, because
  "unlimited" is an obvious guess to spell `-1` or `0` and the engine reads them
  as an eager per-worker pre-allocation count, a ramp seed, a request budget, and
  an in-flight ceiling (see the accepted ranges under
  [POST /runs](api-reference.md#post-runs)). `maxInFlight` is the one that bounds
  work *downward*, so there is no separate cap setting for it - the enormous
  value is the one that removes the backpressure the caller asked for; its
  schema additionally carries the engine's own ceiling of `1000000`, so a value
  this tool accepts is one `POST /runs` accepts.
  `duration` / `rampUpDuration` are also rejected when they are not durations at
  all (`ms`/`s`/`m`/`h`, or a bare number of seconds - the same grammar the
  engine parses), since the engine now fails such a run rather than quietly
  substituting 60s; a zero `duration` is rejected here for the same reason the
  engine `400`s it, while a zero `rampUpDuration` stays legal (an instant ramp).
- **Confirmation** - anti-accident, not anti-adversary: it stops a stray tool
  call from starting load or destroying saved work, but on HTTP it is agent-side
  (the caps/allowlist are the enforcement). Elicitation upgrades it to a human
  prompt where supported. Three tools carry it - `start_load_run`,
  `delete_collection` and `delete_request` - through one implementation, so the
  elicitation path cannot drift between them. A preview is a *successful* result
  that deliberately did nothing, so it emits no `mcp:data-changed` event either.
- **Write toggle** (`allowWrites`, default off) - gates every tool in the
  **write** category: `create_collection`, `update_collection`,
  `delete_collection`, `create_request`, `update_request`, `delete_request`,
  `update_environment`, `update_engine_config`. Does not gate `run_request` /
  `run_collection_smoke` / load runs (allowlist + caps). The two deletes need
  the toggle **and** confirmation: the toggle is a single session-wide switch a
  user flips once to let an agent save a request, which is not consent to
  destroy a subtree.
- **Loopback services carry no gate of their own** - `start_mock_issuer` and
  `stop_mock_issuer` are `execute` tools that neither the allowlist nor the
  write toggle governs. The allowlist exists to stop an agent generating traffic
  against third parties it was never pointed at, and a mock issuer is bound to
  `127.0.0.1` by the engine with no host to configure; the write toggle gates
  saved data, which an ephemeral listener is not. Nor would a gate here withhold
  anything: an agent with `localhost` allowlisted can already reach
  `POST /mock-issuer/start` through `run_request`, for the same reason the
  endpoint needs no auth token. The bounds that do apply are the engine's own -
  at most 8 issuers at once - and the per-tool switch below.
- **Per-tool control** - any tool or whole read/execute/write/load category can be
  switched off; a disabled tool is omitted from `tools/list` **and** rejected by
  `tools/call`. This and the write toggle are **independent**, and a write tool
  needs both: switching the write category on here does nothing while
  `allowWrites` is off, and turning `allowWrites` on re-enables no tool that is
  in `disabledTools`. Settings states this on both cards, because a user who
  flips one switch and sees no change has nothing else to go on.
- **Server on/off** - the whole server can be disabled; while off the endpoint
  does not accept connections. Persists across restarts.
- **Transport hardening** - loopback bind, Host-header (DNS-rebinding) validation,
  `POST`-only, 4 MB body cap.

**Why no auth token on the endpoint:** any local process could already reach the
engine's REST API on `:9876`; the MCP endpoint proxies the same capability behind
_more_ guards and adds DNS-rebinding protection. It grants no capability a local
process did not already have.

### Safety config

`McpSafetyConfig` (defaults in parentheses):

| Field                | Default | Ceiling     | Meaning                                                    |
| -------------------- | ------- | ----------- | ---------------------------------------------------------- |
| `allowlist`          | `[]`    | -           | Permitted hostnames (empty = deny all).                    |
| `allowAll`           | `false` | -           | Bypass the allowlist for any resolvable host.              |
| `maxRps`             | `1000`  | `1000000`   | Cap on `targetRps`, which only `constant_rps` carries.     |
| `maxConcurrency`     | `200`   | `10000`     | Cap on `concurrency` and `startConcurrency` (closed-loop). |
| `maxDurationSeconds` | `300`   | `86400`     | Cap on load-run duration.                                  |
| `maxIterations`      | `10000` | `100000000` | Cap on `iterations` (iterations mode).                     |
| `allowWrites`        | `false` | -           | Enable the data-mutating tools.                            |
| `disabledTools`      | `[]`    | -           | Tool names to hide/reject.                                 |

The renderer never sets these directly: `main.ts` sanitizes every change
(`sanitizeSafetyInput` - normalizes/de-dupes hosts, holds each cap to a whole
number between 1 and its ceiling, trims and de-dupes `disabledTools`) before
applying it live and writing it to disk. The same sanitizer runs over the
persisted file on load and over the CLI's `VAYU_MCP_*` variables, so no path
reaches the guards with a cap outside that range.

The **ceilings** are `MCP_CAP_CEILINGS`, mirroring the renderer's
`LOAD_TEST_CEILING_BOUNDS` maxima - the engine's own guards where it has one
(`concurrency` at 10x `event_loop::MAX_CONCURRENT`, `durationSeconds` at the
per-transfer timeout guard). A cap set above its ceiling is held there rather
than stored: the value it would admit is one the engine refuses or one no Vayu
surface will compose, so storing it shows a guardrail that does not exist. The
copy is tied to the renderer constant by `config.test.ts`, the way
`MAX_IN_FLIGHT_BOUND` is - `electron/` may not import `src/`.

`maxRps` and `maxConcurrency` bound **different runs**, which is why neither is a
general "load cap": `targetRps` exists only in `constant_rps`, so `maxRps` is
inert against a closed-loop run, and `maxConcurrency` bounds the concurrency a
closed-loop run holds (or a ramp starts from, or a capacity search climbs to) -
not the in-flight requests of a rate-paced run, which `maxInFlight` governs.

## Architecture

Everything lives under `app/electron/mcp/` and is managed by `main.ts` alongside
`EngineSidecar`.

| File               | Responsibility                                                              |
| ------------------ | ---------------------------------------------------------------------------- |
| `config.ts`        | `McpSafetyConfig`, safe defaults, input sanitizer, host normalizer.          |
| `safety.ts`        | Pure guards: allowlist, load caps, duration parsing.                        |
| `engine-client.ts` | Thin `fetch` client to the engine REST API + SSE metrics snapshot.          |
| `compare.ts`       | Pure two-report diff for `compare_runs`. Mirrored by the renderer's `src/lib/run-compare.ts` (neither process can import the other's source); `compare.conformance.test.ts` fails on any divergence. Reads the status mix in **both** wire shapes: the renderer's transformed record and the engine's own array of `[code, count]` pairs (`std::map<int, size_t>` cannot serialize as a JSON object), which is what this path gets from a raw `GET /runs/:id/report`. |
| `http-versions.ts` | The `httpVersion` value list the Zod schemas enumerate.                     |
| `tools.ts`         | Tool registry (schemas, annotations, handlers) + `dispatchTool`, the one dispatch path `server.ts` and the tests share. |
| `resources.ts`     | Static + templated resource definitions.                                    |
| `prompts.ts`       | Prompt definitions (build messages from engine data).                       |
| `server.ts`        | Builds the SDK `McpServer`; registers tools/resources/prompts.              |
| `http.ts`          | Stateless Streamable HTTP host (DNS-rebinding on).                          |
| `cli.ts`           | Standalone stdio server (env-configured).                                   |
| `connect.ts`       | One-click connect: resolves and runs the `claude` / `code` CLIs.            |
| `store.ts`         | Persist safety config + enabled preference (`electron-store`).              |
| `index.ts`         | `VayuMcpService` facade consumed by `main.ts`.                              |

### Lifecycle & IPC

`main.ts` starts the server in `app.whenReady()` (skipped if disabled), stops it
on quit, and exposes IPC the Settings panel uses:

| IPC handler         | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `mcp:status`        | `{ running, url, enabled }`.                                |
| `mcp:getSafety`     | Live `McpSafetyConfig`, or the persisted one when off.      |
| `mcp:updateSafety`  | Sanitize, apply live, persist; returns the resolved config. |
| `mcp:setEnabled`    | Start/stop the server, persist the preference.              |
| `mcp:getTools`      | IPC-safe tool catalog (name/description/category).           |
| `mcp:connectClient` | Run a client's add-CLI (`claude` / `code`).                 |

One channel runs the other way, main → renderer:

| Channel            | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `mcp:data-changed` | A successful call changed engine data; invalidate its queries. |

**The UI reflects MCP writes live.** An MCP call mutates the engine from the
main process, which no renderer query can observe (`refetchOnWindowFocus` is off
app-wide), so a request an agent created used to stay invisible in the
collection tree until some unrelated mutation happened to refetch the lists.
Each tool declares the data families it changes (`invalidates` in `tools.ts`)
and `dispatchTool` - the single dispatch path - sends one `mcp:data-changed` per
family after a call that did **not** return an error. The event names a family
(`request`, `environment`, `run`, `cookie`, `config`) plus the `collectionId` /
`requestId` the call itself named; it carries no engine data, so the renderer
still reads every row through its query layer. The renderer side, including
which query keys each family maps to, is in
[`docs/app/state-management.md`](../app/state-management.md).

Declaring the families per tool rather than deriving them from `category` is
deliberate: an `execute` tool writes a run row and refills the cookie jar
without being a "write", and the field is required, so a new tool cannot ship
silently invisible to the UI.

The panel (`app/src/modules/settings/main/panels/McpSettingsPanel.tsx`) is a
registered app-settings panel; it talks to `window.electronAPI` directly since
MCP config is app-level, not engine-level.

`mcp:getSafety` answers from the persisted config whenever the server is not
running (switched off, or a failed port bind) rather than from the defaults, and
the panel shows an error with a Retry instead of substituting defaults when a
call fails. Both exist for the same reason: each control commits a whole field
computed from what is displayed - adding a host persists the displayed allowlist
plus the new entry - so a placeholder shown here would be written over the real
config by the very next edit.

## Configuration

The Electron-hosted server reads config from Settings. The **stdio CLI** reads it
from environment variables:

| Variable                        | Default                 | Meaning                                |
| ------------------------------- | ----------------------- | -------------------------------------- |
| `VAYU_ENGINE_URL`               | `http://127.0.0.1:9876` | Engine base URL.                       |
| `VAYU_VERSION`                  | `0.0.0`                 | Version reported to clients.           |
| `VAYU_MCP_ALLOWLIST`            | (empty)                 | Comma-separated hostnames.             |
| `VAYU_MCP_ALLOW_ALL`            | `false`                 | `true` bypasses the allowlist.         |
| `VAYU_MCP_MAX_RPS`              | `1000`                  | RPS cap.                               |
| `VAYU_MCP_MAX_CONCURRENCY`      | `200`                   | Concurrency cap.                       |
| `VAYU_MCP_MAX_DURATION_SECONDS` | `300`                   | Duration cap.                          |
| `VAYU_MCP_MAX_ITERATIONS`       | `10000`                 | Iterations cap (iterations mode).      |
| `VAYU_MCP_ALLOW_WRITES`         | `false`                 | `true` enables the data-write tools.   |
| `VAYU_MCP_DISABLED_TOOLS`       | (empty)                 | Comma-separated tool names to disable. |

Both entry points sanitize their input through the same function
(`sanitizeSafetyInput` in `electron/mcp/config.ts`), so the environment is held to
exactly the rules Settings is held to:

- **A malformed cap falls back to its default, never to "no cap".**
  `VAYU_MCP_MAX_RPS="1,000"` is not a number, so the `1000` default applies and
  still refuses an over-cap run. The CLI names what it dropped on stderr:
  `[vayu-mcp] ignoring malformed VAYU_MCP_MAX_RPS="1,000" (using default 1000)`.
  Non-positive values (`0`, `-5`) are treated the same way; fractional values are
  floored.
- **A cap above its ceiling is named too, through its own channel.** It did not
  fall back - it is in force, held at the ceiling - so the CLI says which value
  actually applies rather than which default did:
  `[vayu-mcp] VAYU_MCP_MAX_CONCURRENCY="50000" is above the maximum of 10000; running with 10000`.
  Without it the operator believes the policy is 50000 and learns otherwise from
  a refused run. Flooring alone is not reported: `999.7` becomes `999` and names
  no maximum, because it came near none.
- **Allowlist entries are reduced to a bare hostname**, so
  `https://api.example.com` and `api.example.com:8080` both match the
  `api.example.com` the guard compares against. Entries are de-duplicated.
- The two opt-in booleans stay off for any value other than the exact string
  `true`.

## Design notes

Rationale behind the load-bearing decisions.

### TypeScript sidecar over in-engine C++

MCP could have been hosted inside the C++ engine (zero hop, single binary). The
deciding factor: **there is no official C++ SDK**, so in-engine would mean owning
the protocol in C++ or betting on a pre-1.0 community lib - right as the spec
churns (the
[2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
removed the GET stream endpoint and protocol-level sessions). The official TS SDK
absorbs that churn, Node is already the Electron runtime, and the engine stays
untouched (keeping it AGPL-clean). The accepted tradeoff: MCP is up when the
**app** is open, not engine-only - covered later by the stdio CLI for headless use.

### Stateless HTTP, and the server→client push gap

The HTTP host is stateless (fresh server per request), which keeps Settings
changes live for free and aligns with the spec RC that removed protocol sessions
and the GET stream. The cost is that `tools/list_changed` and elicitation can't be
**pushed** over HTTP (no held-open stream), so they fall back as described in
[Transports](#what-is-live-on-each-transport). Making them live would require a
stateful server (real `sessionIdGenerator`, SSE responses, a GET stream per
session, persistent per-session servers mutated on toggle) - deferred, since it
builds on the mechanism the spec is deprecating and the payoff is client-dependent.

## Deferred

- **MCP-originated run tagging** - tag runs started via MCP so History shows
  provenance.
- **`vayu mcp` bin** - package the stdio CLI as a first-class command (backlog M1).
- **Live push over HTTP** - stateful sessions (see Design notes).
- **Hosted MCP for Vayu Cloud** - OAuth-gated, remote.

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) ·
  [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- Client docs: [Claude Code](https://code.claude.com/docs/en/mcp) ·
  [Codex](https://developers.openai.com/codex/mcp) ·
  [Cursor](https://cursor.com/docs/mcp)
- Engine API surface: [`api-reference.md`](./api-reference.md) · Threat model:
  [`SECURITY.md`](https://github.com/athrvk/vayu/blob/master/SECURITY.md)
