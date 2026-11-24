---
description: >-
  How the Vayu MCP server is reached - Streamable HTTP in the running app, the stdio CLI for Zed and CI - and what each transport supports.
---

# MCP transports

## Transports

### Streamable HTTP (primary)

`listener.ts` binds `127.0.0.1:9877` by default at launch and answers what needs no SDK (`gates.ts`: non-`/mcp` paths `404`, `GET`/`DELETE` `405`); `http.ts` serves each `POST /mcp` once the first one has loaded it, through the SDK's `createMcpHandler`.
Every request gets a fresh server, in both protocol eras:

- A **2026-07-28** client (the revision with no `initialize` handshake and an envelope on every request) is served per request by the protocol's own design.
  It is answered with a JSON body, or an event stream when the reply needs one.
- A **2025-era** client (an `initialize` handshake) is served **statelessly** by the same factory, on an event stream that carries the one answer.
  There is no session: `GET` and `DELETE` are `405`.

The handler checks no headers of its own, so `http.ts` checks them in front of it: the Host must be a loopback name (`127.0.0.1`, `localhost` or `[::1]`), and an `Origin`, when a browser sends one, must be a loopback origin too; anything else is `403`.
That is the DNS-rebinding protection, and it also turns away a page on another site that posts to the port.
The handler itself answers `415` to a `POST` whose `Content-Type` is not `application/json`, and a 2025-era request `406` when its `Accept` does not take both `application/json` and `text/event-stream`, as the transport specification requires; an SDK client always sends both.
A body that is not valid JSON is answered `400` with JSON-RPC `-32700` (parse error), and one over the 4 MB cap `413` with `-32600` - past the cap the rest of the upload is drained and discarded rather than the socket being closed under it, since resetting the connection mid-upload loses the very response the status code exists to deliver.
The cap bounds what is held in memory, not what crosses the wire.
The body is read before the handler sees it, so these are answered directly rather than by the SDK.
Both messages are fixed strings - nothing derived from the underlying error reaches the wire - and `-32603` ("Internal error") is left to mean a genuine handler failure, including a socket error while reading.
That message is a fixed string too: the thrown error goes to the MCP log (`src: "mcp"`, with the request path), not to the client.
The handler answers a failure to build the server the same way (500, `-32603`, its own fixed "Internal server error"), and `http.ts` logs the cause at `error`.
Stopping the server (MCP switched off in Settings, or the app quitting) first ends every exchange the socket's close would otherwise wait on, on both legs.
What a 2026-07-28 client holds open is ended by the SDK: a `subscriptions/listen` stream lasts as long as the client likes and is closed with its own final answer, and a call in flight is cut.
Every 2025-era exchange in flight is cut by the host (#3575), whether or not the cancel registry below holds it, and the engine request behind it is aborted as a cancel would abort it.
What the client is sent depends on how far its answer got (#3598).
Before any of the response is out, a 2025-era call has its connection dropped and an SDK client's call fails at once with a connection error; a 2026-07-28 call is answered with a bare `499`, which fails it as fast.
Once a progress event or a keep-alive comment (every 15 s) is out, the client is reading a stream, and an SDK client acts on nothing but a JSON-RPC response for its request id: a stream that just ended would hold the call until the client's own request timeout (60 s by default).
So a call of either era cut there ends with a JSON-RPC error for each request id the stream has not answered (`-32000`, "Vayu stopped the MCP server."), written as the SDK writes a message (`held-exchange.ts`), and the client's call rejects with it at once.
Then the socket closes gracefully, so a request still arriving is answered rather than cut off.
A connection still answering at that moment is closed once its answer is flushed, rather than held for its keep-alive timeout; one whose request is itself still arriving (an oversized upload drained for its `413`) is only half-closed, and the stop waits for the client to close its side.
The port is free when the stop resolves.
One owner, `lifecycle.ts`, orders starts and stops (#3337): a stop that lands while the port is still binding waits for the bind and closes it, a re-enable binds only once the previous close has finished, and a service whose lazy load outlives its listener is never built.
The per-request rebuild means Settings changes (allowlist, caps, disabled tools) take effect on the next request with no extra bookkeeping.
Two things are carried from one request to the next, both for a 2025-era client and both under an `Mcp-Session-Id` the host issues:
the client's name from its handshake (see [How History names the client](#how-history-names-the-client)), and an abort handle for each of its requests still in flight, so a cancel it sends reaches the call it names (see [What is live on each transport](#what-is-live-on-each-transport)).

### stdio CLI (Zed / headless / CI)

`cli.ts` is a standalone stdio server that reuses the same server factory and tool registry, through the SDK's `serveStdio`: one server per connection, for whichever era the client opens with.
It is for stdio-only clients (Zed) and headless/CI.
Run:

```bash
node dist-electron/mcp/cli.js
```

Configuration comes from environment variables (see [Configuration](configuration.md#configuration)), since there is no Settings UI.
It still requires a running engine.

**An open Vayu window sees a stdio session's writes.**
The CLI runs in its own process, so it has no `mcp:data-changed` channel to the renderer (see [Lifecycle & IPC](internals.md#lifecycle--ipc)).
It does not need one for the rows the UI edits: the engine publishes every committed write of a collection, a request, an example, an environment, the globals or a trash entry on its change feed (`GET /changes`, issue #3420), whoever made it, and the app follows that feed.
A request a Zed session edits therefore shows in the tab that has it open, and a field the user was editing there is kept and flagged as a conflict rather than overwritten.
What the feed does not carry - runs, cookies, engine config, local services, the OAuth token cache - reaches an open window on its own polls, or on the next read.

The CLI sets `host: "cli"` on its tool context (the app sets `"app"`), and every sentence that sends the user somewhere to lift a refusal reads it, so a guard in a stdio session names the variable that lifts it and never a Settings screen or the app (#2439):
an allowlist refusal names `VAYU_MCP_ALLOWLIST`, a refused write `VAYU_MCP_ALLOW_WRITES`, an unreachable engine `vayu-engine` and `VAYU_ENGINE_URL`.
The full pairing is under [Configuration](configuration.md#configuration); the wording lives in `remedy.ts` and nowhere else.

**Logging** (#1558): stdout is the JSON-RPC channel, so every diagnostic goes to stderr as text, unconditionally - never gated by `VAYU_LOG_CONSOLE` the way the Electron-hosted host's console rendering is.
Set `VAYU_LOG_DIR` to also write a JSON-lines `mcp_<stamp>.log` there (unset: console only) - its own prefix, since this process shares no file or data directory with the Electron main process.
A call served through this transport and one served through the Electron-hosted transport each leave a `src: "mcp"` record; see [Engine Logging](../logging.md).

The log files are not readable over MCP: the server has no tools, resources or prompts for them, because they hold what the app logged about your work, including text a script threw, and the Logs tab reads them only for the person at the window (`mcp/log-reader.guard.test.ts` holds that, #3635).

### What is live on each transport

Two things need the person or the client to hear from the server mid-session: a confirmation question before a destructive tool runs (elicitation), and word that `tools/list` changed when a Settings change alters it.
That is any change to what the list answers, not only to which tools it names: the Reveal secrets toggle lists the same tools and rewrites their descriptions (a tool's withholding pointer is dropped with it, #2441), so it fires the notice too.

| Client | Confirmation question | `tools/list` changed | Cancellation |
| ------ | --------------------- | -------------------- | ------------ |
| 2026-07-28, HTTP | ✅ asked in-band, the call retried with the answer | ✅ on a `subscriptions/listen` stream | ✅ the SDK aborts the call when the client cancels |
| 2026-07-28, stdio | ✅ asked in-band | - (the CLI's config cannot change) | ✅ `notifications/cancelled`, read by the SDK |
| 2025-era, stdio | ✅ the SDK puts the question to the client | - (as above) | ✅ `notifications/cancelled`, read by the SDK |
| 2025-era, HTTP | `confirmed: true` flag | on the client's next `tools/list` | ✅ `notifications/cancelled`, matched by the host |

Only a client that declared elicitation is asked; any other client gets the `confirmed: true` flag instead, because asking one that cannot answer is a protocol error the tool cannot recover from.
A 2025-era client over HTTP gets the flag even when it declared elicitation: the server that would ask is gone when its request ends, so there is no one to carry the answer back to.
Neither fallback is unsafe, only less direct.
`tools.listChanged` is advertised only to the clients with a ✅ under `tools/list` changed, so no client waits for a notice that never comes.
See [Design notes](internals.md#design-notes).

A cancel ends the call on every leg, with the same effect: the call's `AbortSignal` fires and the engine request behind it is aborted (the Cancellation bullet under [Tools](collection-runs-and-mocks.md)).
On 2025-era HTTP the cancel is its own `POST`, and the fresh server it reaches never saw the call, so the SDK alone would answer `202` and drop it.
The host keeps an abort handle for each 2025-era request it is serving instead (`in-flight-calls.ts`, #3574), under the `Mcp-Session-Id` it issued and the JSON-RPC request id, and a `notifications/cancelled` naming both ends that request's exchange, which aborts the signal; the cancel still gets its `202`.
Once a progress event or a keep-alive comment is out, the exchange ends as a stop's does (above), with a JSON-RPC error for the request id (`-32000`, "The call was cancelled.", #3598); with nothing of the response out, its stream ends empty.
An SDK client that cancels by aborting its own call has rejected it already; a client that sends the cancel and keeps reading the stream gets the error as its answer.
A cancel with no session id, or another session's, reaches nothing: every client counts its request ids from 0, so the id alone names no one call.
The handle is dropped when the exchange ends however it ends - an answer, a cancel, the client disconnecting, a stop - and at most 256 are held, the oldest dropped first (its call keeps running, no longer cancellable).
A stop does not need the handle: it cuts every 2025-era exchange, held or not.
The issued session id is the whole binding: a loopback caller that presents it and a request id can abort that call.

The other way round, a collection's remembered data-file path (`dataFile`) is answered on **HTTP only**: the stdio CLI runs without the app, whose renderer publishes it to the HTTP server.
See [Data files](saved-data.md#data-files).
`get_app_focus` is the same shape: the open tab and environment are renderer state, so it answers an error saying the window is not connected on stdio.

### How History names the client

Every run an MCP tool starts is sent with `origin: {"kind": "mcp", "client": "<name>"}` (#1817; the field is described under [`POST /execute`](../api-reference.md#post-execute)): `run_request`, streaming or not, every request `run_collection_smoke` sends, `run_collection`, and both shapes of `start_load_run`.
The name is the `clientInfo.name` the client gave - in its `initialize` handshake, or for a 2026-07-28 client on each request - forwarded as given: the engine trims it and caps it at 128 characters, and the renderer turns a known identifier into a product name through `app/src/lib/mcp-client-names.ts`.
When no name is known the run carries `{"kind": "mcp"}` alone, and History shows it as an unnamed MCP client.
The origin is set after every argument has been folded into the payload, so no tool argument can claim another one.
It is metadata the client asserts, not identity.

How the name reaches the tool differs by era and transport:

- **2026-07-28, either transport** - every request carries it in its own envelope, so the server serving it reads it there.
- **2025-era stdio** - one server serves the whole connection and reads the handshake itself.
- **2025-era Streamable HTTP** - every request gets a fresh server, so the one that read the handshake is gone before the first `tools/call`.
  The host answers each `initialize` with an `Mcp-Session-Id` header and records the handshake's name under it, read from the request (the SDK's own schema check of the handshake decides that it is one); a Streamable HTTP client echoes that id on every later request, and the host looks the name up for that request's server (`client-sessions.ts`).
  The record is bounded: 256 sessions of at most 128 characters of name each, the least recently used evicted first, and one idle for 24 hours forgotten.
  The transport still validates no session, so a request with no id, or one the host does not know (a restart of the app clears the record), is served as before and starts an unnamed MCP run.
