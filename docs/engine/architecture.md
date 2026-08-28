---
description: >-
  Inside the Vayu C++ engine: the multi-worker event loop, thread pool, engine-side auth resolution, persistence and metrics.
---

# Vayu Engine Architecture

**Version:** 0.3.0  
**Last Updated:** June 2026

## Overview

The Vayu Engine is a high-performance C++ daemon that executes HTTP requests and load tests. It uses a sidecar architecture pattern, running as a separate process from the Electron UI and communicating via HTTP on `localhost:9876` (configurable).

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Vayu Engine (C++)                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐      ┌─────────────────────────────┐  │
│  │  HTTP Server     │      │      Event Loop             │  │
│  │ (cpp-httplib)    │      │    (curl_multi)             │  │
│  │  Port: 9876      │      │  • Multi-worker              │  │
│  │                  │      │  • Lock-free SPSC queues     │  │
│  └────────┬─────────┘      │  • Rate limiting             │  │
│           │                └──────────┬──────────────────┘  │
│           │                           │                      │
│           ▼                           ▼                      │
│  ┌──────────────────┐      ┌─────────────────────────────┐  │
│  │  Route Handlers  │      │    Metrics Collector        │  │
│  │  • Collections   │      │  • In-memory aggregation     │  │
│  │  • Requests      │      │  • Batch DB writes           │  │
│  │  • Environments  │      │  • Real-time stats           │  │
│  │  • Execution     │      └──────────┬──────────────────┘  │
│  │  • Metrics       │                 │                      │
│  └────────┬─────────┘                 ▼                      │
│           │                ┌─────────────────────────────┐  │
│           ▼                │   Script Engine (QuickJS)   │  │
│  ┌──────────────────┐      │  • Pre-request scripts      │  │
│  │  Run Manager     │      │  • Test scripts             │  │
│  │  • Active runs   │      │  • Postman-compatible API   │  │
│  │  • Lifecycle     │      └─────────────────────────────┘  │
│  └────────┬─────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           SQLite Database (sqlite_orm)                 │ │
│  │  • Collections  • Requests  • Environments            │ │
│  │  • Runs         • Metrics   • Results                 │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### HTTP Server (`cpp-httplib`)

The HTTP server handles all API requests from the Electron UI. It runs on `127.0.0.1:9876` by default (configurable via `--port`).

**Key Features:**
- RESTful API endpoints for collections, requests, environments, and runs
- Server-Sent Events (SSE) for real-time metrics streaming
- Single-threaded request handling (non-blocking I/O)

#### How a route says no

Three shapes, and the difference between them is the point:

- A **testable core** - `create_collection_response`, `import_apply_response` -
  returns `std::pair<int, nlohmann::json>`. Success and failure are both
  something to send, so the pair is the *response*, and the handler around it
  only writes it to the wire. `error_response (status, message)` builds the
  failing one.
- A **field applier or guard** - `apply_json_field`, `reject_client_supplied_id`,
  `apply_request_fields` - returns `RouteResult`, which is
  `std::expected<void, RouteError>`: nothing on success, and on failure the
  `{status, body}` the caller should answer with. `route_error (status, message)`
  builds the refusal; `as_response` turns one into the pair a core returns.
- A **payload parser** - `parse_mock_start`, `parse_inbox_start`,
  `parse_inbox_response_update`, `parse_live_resume_point` - returns
  `std::expected<Parsed, ParseError>`, where `Parsed` is the validated request
  itself. The value *is* the return, never an out-parameter: a half-filled
  request a caller forgot to check for is then unreachable rather than merely
  unlikely (issues #926, #954).

These used to be `std::optional<std::pair<int, nlohmann::json>>`, where an
*empty* optional meant success (issue #901). That reads backwards at every call
site - `if (err)` is the failure path, `return std::nullopt` means "fine" - and
a dropped return value silently means "no error", which is why the two most
dangerous of them carried `[[nodiscard]]` by hand. `std::expected` puts the
direction in the type: `if (auto outcome = f (...); !outcome) return outcome;`
propagates, and the response is reachable only through `.error ()`.

All error bodies, either way, come from `error_body` - one shape,
`{"error": {"code", "message"}}`, which the app's http-client reads.

### Listeners

This is the engine's whole listener inventory. The management API is the only long-lived one;
four more are opened on demand, and the rule that separates them is where each may bind.

| Listener | Bind | Opened by | Serves |
|----------|------|-----------|--------|
| Management API | `127.0.0.1:9876` (configurable port) | Daemon startup | Every route in [api-reference.md](api-reference.md) |
| OAuth 2.0 loopback callback | `127.0.0.1`, ephemeral port | `POST /oauth2/authorize/start` in loopback mode | One `/callback` path, for the length of one authorization attempt (5-minute TTL) |
| [Mock OAuth 2.0 issuer](api-reference.md#local-mock-issuer) | `127.0.0.1`, ephemeral port | `POST /mock-issuer/start` (at most 8) | `/token` and `/authorize`, until stopped |
| [Webhook inbox](api-reference.md#webhook-inbox) | `127.0.0.1` by default; wider only on explicit confirmation | `POST /inbox/start` | Records any method on any path, answers a canned response |
| [Collection mock server](api-reference.md#mock-server) | `127.0.0.1`, ephemeral port unless one is named | `POST /mock/start` (at most 8) | A collection's saved example responses, on the paths its requests describe, until stopped |

**The inbox is the only one that may bind beyond loopback**, and the two reasons the others may not
are different reasons:

- The **management API** has no route authentication and answers `Access-Control-Allow-Origin: *`
  (`server.cpp`), so anything that can reach it can read every stored request, every credential the
  database holds, and start runs against arbitrary targets.
- A **mock issuer** hands out bearer tokens, and the **OAuth callback** carries an authorization
  code; publishing either would publish a credential.
- An **inbox** serves none of that - it accepts a request, stores it, and replies with what the user
  configured - so exposing it to a LAN exposes capture-and-echo and nothing more. A webhook source
  on another host is a real case; a management API on another host is not one worth the blast
  radius.
- A **mock server** re-serves stored response bodies verbatim, and a recorded response carries
  whatever the real one carried - a session cookie, a token, a customer record. That is closer to
  publishing the request store than to publishing an echo, so it has no `bind` field at all rather
  than a confirmation gate.

Even so, wide is never the default: `bind` outside 127.0.0.0/8 and `::1` is refused unless the
caller sends `"confirmNonLoopback": true`, and the inbox then reports `loopback: false` on every
read so the UI can badge it. A capture is stored in plaintext like the rest of the request store -
a webhook payload can carry a signature or a token, and nothing here treats it as credential-grade.

### Streaming consumers

A **streaming request** (`POST /execute` with `"stream": true`, issue #573) is the one worker in
the engine that owns a curl transfer without being a run in `RunManager`. `SseStreamManager`
(`engine/include/vayu/http/sse_stream.hpp`) holds one thread per live stream: the thread performs
the transfer, parses SSE frames into a bounded per-run ring, and calls back into the route's
`record_design_result` when it terminates. `GET /runs/:runId/events` relays the ring; a finished
stream stays readable for `liveRetentionMs` and is then swept, its thread joined.

It runs the *listener* lifecycle discipline even though it owns no listener, and for the same
reason: its workers write run rows through `Database` and read the design-mode cookie jar, both of
which must outlive them. So the manager is a member of `Server` declared before `server_`, and its
destructor signals every worker to stop and then joins them all - signal first, join second, so
teardown costs one stream's stop latency rather than the sum.

Each on-demand listener is owned by a manager that is a **member of `Server`, declared before
`server_`** (`engine/include/vayu/http/server.hpp`). Members are destroyed in reverse order, so the
route lambdas holding references to a manager are gone before its destructor stops and joins the
listener threads - and the `Database` those threads write to, being external to `Server`, is still
alive at that point. All four managers run that lifecycle - bind, wait for the accept loop, stop,
join, release - through one shared `ManagedListener`
(`engine/include/vayu/http/managed_listener.hpp`), so a fix to it reaches every listener rather than
one of four copies; what stays per-manager is the route registration, the error each bind failure
answers with, and the OAuth attempt TTL sweep. The mock server is the one built on the helper rather
than ported to it: #505 extracted it before this listener existed, which was the whole point of
extracting it when the third one landed.

That shared listener is also what keeps two of them off one port. Every live listener claims its
address:port there, and an **explicitly requested** port a live listener already holds is refused
before the bind, naming the holder. The bind cannot report it: cpp-httplib sets `SO_REUSEPORT`, so
on Linux a second bind on the same `127.0.0.1:port` succeeds and the kernel load-balances arriving
connections across both accept loops - two inboxes on one port, each capturing a random half of the
webhooks and neither list showing the rest. An ephemeral request needs no check, since the kernel
does not hand out a port it is already using.

The management API answers that same `SO_REUSEPORT` problem the other way round, because it is the
one listener whose port is a *contract* rather than a detail: it clears the option (Windows, which
has no `SO_REUSEPORT` and lets `SO_REUSEADDR` step over a live listener, gets `SO_EXCLUSIVEADDRUSE`
instead), so a port anything else holds fails the bind rather than splitting the engine's own
traffic. `Server::start()` binds before it serves and returns that outcome, and the daemon prints
the reason to stderr and exits **1** (#983). It was `listen()` before, which folds the bind into the
serve loop and reports failure only through a `return false` on a detached thread - so a taken port
printed the listening banner, unwound through the graceful-shutdown path and exited 0.

### Event Loop (`curl_multi`)

The event loop manages concurrent HTTP request execution using libcurl's multi interface.

**Architecture:**
- **Multi-worker design**: One event loop per CPU core (auto-detected)
- **SPSC queues**: Lock-free single-producer single-consumer queues for request submission
- **Rate limiting**: Token bucket algorithm for precise RPS control. `targetRps` is an
  **aggregate** budget: each worker owns a private bucket and submissions are sharded
  round-robin, so the rate and burst are split N ways when the loop is built (with a
  one-token burst floor, since a sub-token bucket could never start a transfer)
- **Connection pooling**: Reuses connections with keep-alive
- **DNS caching**: 5-minute cache to avoid resolver saturation

**DNS pre-resolution.** Hostnames are resolved once and pinned onto each
transfer with `CURLOPT_RESOLVE`, which keeps a high-RPS run from saturating the
system resolver. Three rules make that safe:

- **Entries expire** after `dnsCacheTimeout` (default 300s). curl treats a
  pinned address as authoritative, so an entry that never expired would survive
  a DNS change - a blue/green deploy of the target - and fail every request for
  the rest of the daemon's life. The cache is a process-wide static shared by
  every worker and every run, which is what made that permanent.
- **Failed lookups are remembered** for 5s. Resolution is a blocking
  `getaddrinfo` on the worker thread, so it stalls every in-flight transfer
  that worker owns; without a negative entry an unresolvable host paid that
  cost on every single request. Moving resolution off the IO thread entirely is
  the deeper fix and is not done.
- **IP-literal URLs are never pinned** - `http://127.0.0.1/`,
  `http://[::1]:8080/` - since there is nothing to resolve. Parsing an
  authority also handles userinfo (`http://user:pass@host/`), whose colon is
  not a port separator.

**Configuration:**
- Max concurrent requests per worker: 1000 (configurable)
- Max connections per host: 100
- Poll timeout: 1ms (kept short because a submission interrupts the poll via
  `curl_multi_wakeup`)
- TCP keep-alive: 60s idle, 30s probe interval
- Max response body per transfer: 32MB (`maxResponseBodyBytes`); a larger
  response fails that request rather than being buffered, since every in-flight
  request holds its own body

### Run Manager

Manages the lifecycle of load test runs:

- **Run registration**: Tracks active runs by ID
- **Run context**: Stores configuration, event loop, metrics collector, and an in-memory
  **tick topic** (ring of wire-ready metric snapshots) per run
- **Retained finished runs**: Completed/failed/stopped runs are moved to a separate retained
  map rather than unregistered immediately, so a late SSE client still receives the full metric
  series. A TTL sweep evicts them after `liveRetentionMs` (default 60s).
- **Stop discards, completion drains (with a deadline)**: a stopped run throws away its queued
  backlog and cancels in-flight transfers, so a stop is not paced by the upstream; a run that
  reaches the end of its duration waits for genuine in-flight requests, but no longer than
  `timeout` + 2s. Cancelled requests are recorded as errors, so a run's submitted and recorded
  counts still agree.
- **The move to the retained map is the "worker is finished" signal**: it happens after the
  final metrics flush and status update, which is what `DELETE /runs/:id` waits on before
  removing rows (see the API reference). It is *not* the "worker thread has exited" signal -
  the move is the worker's last statement, and the thread is still unwinding after it.
- **Graceful shutdown drains, then joins**: `RunManager::shutdown()` sets `should_stop` on
  every active run, waits up to 5s (`RUN_SHUTDOWN_GRACE_MS`) for them to reach a terminal
  status, and then **joins** every worker thread. The manager owns those thread handles -
  a worker holds a `shared_ptr` to its own `RunContext`, so a context that owned its thread
  could end up joining itself. The wait is bounded; the join is not, because abandoning a
  worker leaves it writing through references to a `Database` that `main` is about to
  destroy. A run started while the drain is in progress is refused with a `503`.
- **Finished workers are reaped on the next `start_run`**: a thread cannot join itself, so
  its handle outlives it until another thread collects it.
- **Per-run auxiliary threads**: a load run has a metrics thread
  (`collect_metrics`) and, when its auth is a header-placed expiring oauth2
  token, an auth-refresh watchdog (`run_auth_refresh`, see below). Both watch
  `is_running` and are joined together through `RunContext::join_aux_threads` -
  the worker has four exit paths, and a thread joined at only some of them
  outlives the `Database` it writes through.
- **Two kinds of worker, one lifecycle**: `start_run` spawns the load executor
  plus its auxiliary threads, `start_scenario_run` spawns the sequential
  collection runner. Both go through the same `spawn_run` registration - the
  shutting-down check, the reap and the handle insert all happen under one lock,
  and a copy of that reasoning per run kind is exactly how a worker outlives a
  drain that already declared its state safe to destroy.

### Metrics Collector

High-performance in-memory metrics collection optimized for 60k+ RPS:

- **Pre-allocated storage**: Avoids reallocation during tests
- **Lock-free atomics + HdrHistogram**: Zero-contention counter updates; latency recorded in an
  HdrHistogram (µs resolution). Every event-loop worker records on its own thread, so both the
  cumulative histogram and the rolling interval recorder are written through the library's
  **atomic** entry points (`hdr_record_value_atomic` / `hdr_interval_recorder_record_value_atomic`).
  The plain variants are a non-atomic `counts[i] += 1; total_count += 1` and lose samples under
  concurrency - silently, since the run still reports percentiles, just computed from fewer
  samples than it served. The interval recorder's phaser orders the once-per-tick reader against
  writers; it is not mutual exclusion *between* writers, so it does not make the plain write safe.
- **Per-phase histogram bank**: five more HdrHistograms (DNS, connect, TLS, first-byte, download),
  fed by every successful completion and read once after the drain, behind the report's
  `timingBreakdown.phases`. Deliberately **not** gated on the trace-retention decision: the
  averages beside them are computed over the ~1% of completions a trace is stored for, and
  escaping that biased sample is the whole point. Off - `phaseHistograms`, or a run's own
  `phase_histograms` - leaves the bank unallocated, so the cost on the completion path is one null
  check. Written through `hdr_record_value_atomic` for the same reason the two above are.
- **Perceived latency**: Latency is measured as `completion − submitted_at` (the full time a
  request spent inside the engine), not just libcurl's wire time. Wire time and the
  generator-internal `queue_wait` are tracked separately.
- **Rich counters**: bytes sent/received, dropped requests (backpressure), queue-wait average,
  peak in-flight, and a full per-status-code distribution
- **Batch DB writes**: Per-request results written after test completion; the metrics thread
  persists one wide `metric_ticks` row per second during the run (the complete tick object,
  built once at write time), and the whole-run `runs.summary` is written once at completion
- **Bounded error storage**: Error *counts* and the status-code distribution are exact, but only
  the first `maxStoredErrors` (default 10,000) individual records are kept; the rest are counted by
  `errors_dropped()` and logged once. A fully-failing target produces errors at close to the
  completion rate, each carrying a message and a trace blob, so an unlimited store grows for the
  whole run and then flushes as one enormous transaction. Success results are sampled.
  Because the final report's per-type error breakdown is built by walking those stored
  records, a run with more errors than the cap gets a breakdown that does not sum to its
  (exact) total - raise `maxStoredErrors` to keep it complete, or set `0` for unlimited.
- **Response sampling**: Stores samples for deferred script validation

### Script Engine (`QuickJS`)

JavaScript execution engine for pre-request and test scripts:

- **Postman-compatible API**: `pm.test()`, `pm.expect()`, `pm.response`, etc.
- **Mutable request**: a pre-request script's `pm.request` writes are applied to the
  request before it is sent (see `docs/engine/scripting.md`)
- **Signing**: `pm.crypto.sha256` / `.hmacSha256` plus the `btoa` / `atob` globals, so
  a pre-request script can sign the request it just rewrote. Backed by **libsodium**
  through `utils/sha256.hpp` (shared with PKCE) and `utils/encoding.hpp` - the engine
  hand-maintains no hash, HMAC or alphabet table, and OpenSSL is still not linked.
  Synchronous, because the sandbox has no event loop to settle a Promise on
- **Memory limit**: 64MB per script execution
- **Timeout**: 5 seconds per script
- **Sandboxed**: No filesystem or network access

**Platform Support:** one engine everywhere - **QuickJS-NG** (the actively
maintained fork), vendored in `engine/vendor/quickjs-ng` and built via its own
CMake on all three platforms. Until #226's review, Linux/macOS ran Bellard's
original QuickJS while Windows ran NG (the original does not compile under
MSVC) - two interpreters behind one `pm.*` surface, so an engine-level
behaviour difference was a Windows-vs-Unix script divergence. The original
copy is deleted.

### Cookie Jar

`http::CookieJar` (`include/vayu/http/cookie_jar.hpp`), owned by `http::Server`
and reached by route handlers through `RouteContext::cookie_jar`. It is what
makes a session survive from one design-mode request to the next.

- **Scope: one jar per environment**, plus one for requests sent with no
  environment selected. The environment is the axis that separates staging from
  production, and cookies ignore port and scheme - so two local services on
  different ports would otherwise share a session cookie.
- **Lifetime: the process.** In memory only; a stored jar is credential-grade
  material and would need the treatment auth tokens already have rather than a
  new path beside the request store. `GET /cookies` shows it, `DELETE /cookies`
  empties it, and the app surfaces both in Settings → General → Cookies.
- **Storage: libcurl's own lines.** The jar holds what `CURLINFO_COOKIELIST`
  exports and hands it back through `CURLOPT_COOKIELIST`, so domain matching,
  path matching, `Secure` and expiry stay inside libcurl's cookie engine. The
  parser and matcher in `cookie_jar.cpp` serve the *read* views (`pm.cookies`,
  `pm.cookies.jar().get`, `GET /cookies`), which need an answer without a
  transfer, and the URL-scoped removal `jar().unset` performs. They never
  decide what goes on the wire.
- **Not on the load path.** `EventLoop` never touches the *jar*: a shared jar
  across workers is either a lock on the hot path or per-worker jars that do not
  actually share. A scenario load run does carry cookies - it has to, since its
  whole point is a sequence where step 2 uses what step 1 established - but each
  virtual user owns a private list seeded onto its own transfer and cleared at
  each iteration boundary, and the environment jar is untouched (see "Scenario
  load runs" under Load Test Strategies). One session shared between 1,000
  virtual users is not the thing being measured.
- **Threading:** one mutex around the scope map; every accessor copies out, so
  no reference into the storage escapes to a caller.
- **Shown as sent.** Because libcurl attaches the matching cookies itself, the
  composed header map never sees them - so the raw-request view is built from
  the transfer's last `CURLINFO_HEADER_OUT` frame (`client.cpp`) rather than
  from `request_headers`, and shows the `Cookie` line the wire carried, value
  plain. The verbose transfer log keeps its redaction (`debug_redact.hpp`): a
  log gets exported and shared, the raw view is read on the machine whose
  Settings already display the same value. A script-written cookie is on that
  frame too, since it goes out on the same transfer.
- **History keeps that frame too, cookies included.** The jar itself is never
  persisted, but a design or scenario run stores the message its transfer sent
  as `trace_data.request.rawRequest` (`build_result_trace`), so reopening the
  run shows the same `Cookie` line the live view did instead of a session-less
  request rebuilt from the composed headers (issue #348). That is a deliberate
  write of credential-grade material, into the node that already stores the
  resolved `Authorization` header beside it - see [Security](#security) for
  where the line between this and `runs.config_snapshot` falls. It is bounded
  by run retention, not by the process: `DELETE /cookies` empties the jar and
  does not touch stored runs.
- **Script writes are staged, not applied in place** (`pm.cookies.jar()`, issue
  #337). `capture_jar_cookies` *replaces* a scope's contents with what the
  finishing handle held, so a write dropped into the map beside an in-flight
  transfer would be discarded by it. Instead a write becomes a `CookieWrite`
  that the execution's next transfer applies on top of the stored lines when it
  seeds its handle (`ClientConfig::cookie_writes`) - the request carries it, and
  that transfer's own capture is what persists it. A write with no transfer left
  to ride, a post-request script's, is applied by the route through
  `CookieJar::apply`. Either path applies it exactly once.

`pm.sendRequest` shares the jar of the execute it runs inside, so a pre-request
script can log in and leave the session where the real request will find it; it
also carries any write staged before it.

### Auth Resolution & OAuth 2.0

The engine resolves request auth server-side - the persisted `auth` object is
applied to the outgoing request rather than being left to the UI. This lives in
`vayu_core` (so both the design and load paths share it):

- **`request_builder`** (`build_request`) - the single request-construction
  pipeline: deserialize the payload, apply the resolved timeout, then resolve
  auth. Both `POST /execute` and `POST /runs` go through it.
- **`auth_resolver`** (`apply_auth` / `preflight_auth` / `plan_auth_refresh`) - a
  typed `Auth` variant with an exhaustive per-mode handler: bearer/basic/api-key
  are injected inline; `oauth2` delegates to the token client. A user-supplied
  `Authorization` header always wins. Credentials carrying a `{{data.*}}` or a
  `{{$vu}}` / `{{$iteration}}` token are the one case auth is *not* resolved
  into the plan: the value has to be bound before the credential is encoded, so
  the step keeps its typed `Auth` and applies it per iteration
  (`bind_step_auth`, see [Scenario runs](api-reference.md#scenario-runs)).
  **What is deferred is decided by the credentials, not by the run's shape**
  (issue #1055): a build defers because these credentials carry a token, so a
  run with no data set at all still binds `user-{{$vu}}`. An OAuth 2.0 config
  carrying either kind is refused by name instead - its token is acquired once,
  before any iteration exists, so no bind can reach it.
  `plan_auth_refresh` decides afterwards
  whether the credential a *load* run just resolved can be kept current past its
  expiry - see the run lifecycle below.
- **`oauth_client`** (`acquire_token`) - grant handling (client_credentials,
  password, authorization_code), the [`oauth_tokens`](db-schema.md#oauth_tokens)
  cache (45s expiry skew, refresh-token rotation), and RFC 6749 client auth. It
  never logs token bodies/headers.
- **`oauth_authorize`** - the interactive Authorization Code manager: an
  engine-hosted `127.0.0.1` loopback listener + PKCE (S256) and `state`, so the
  entire flow (including the code exchange) stays in-process; the app only opens
  the browser. Owned by the `Server` for a clean shutdown.
- **`mock_issuer`** - the local OAuth 2.0 issuer (`routes/mock_issuer.cpp`):
  `POST /mock-issuer/start` binds another `127.0.0.1` listener serving `/token`
  and `/authorize`, so auth flows are exercisable offline with no real identity
  provider. It mints HS256 JWTs with a random per-issuer key (libsodium again),
  auto-approves `/authorize` with PKCE S256 verification, rotates refresh
  tokens, and can be flipped between healthy and `slow` / `server_error` /
  `invalid_client` while running. In-memory only and owned by the `Server`, on
  the same reverse-member-order rule as the authorize manager.

**Listener inventory.** Both auth listeners are spawned, loopback-bound and
short-lived - the interactive-auth callback (one per attempt, 5-minute TTL) and
mock issuers (at most 8, until stopped) - and neither may ever bind wider than
`127.0.0.1`, because one carries an authorization code and the other hands out
bearer tokens. The full inventory, including the one listener that *may* bind
wider and why, is [above](#listeners).

PKCE hashing uses **libsodium** (`crypto_hash_sha256`, and `sodium_bin2base64`'s
URL-safe unpadded variant for the challenge itself; no OpenSSL). See
the [API reference](api-reference.md#authentication) for the `/oauth2/*` routes.

### Request composition boundary (engine-owned via POST /compose)

The engine owns request composition since issue #226.
`POST /compose` (`routes/compose.cpp` → `compose_request_core` in
`src/http/request_composer.cpp`) takes a `requestId` (a saved request) and/or
an inline unresolved `request`, plus `collectionId` / `environmentId` scope
ids, and returns the execute-ready payload that `POST /execute` and `POST
/runs` accept unchanged. Composition:

- builds the effective variable map (globals < collection chain root→leaf <
  environment, enabled definitions only) and interpolates `{{variables}}` into
  the URL, header keys/values, body content/fields, and the auth block -
  single-pass, raw stored strings, unknown plain names to `""`, unknown
  `$names` kept braced, dynamic variables (`{{$guid}}`, …) generated per
  occurrence - unless the caller asked for them to be deferred
  (`deferDynamicVariables`), which a composition made for a *run* does, so the
  run generates a fresh value per iteration instead of repeating one (issue
  #995);
- resolves `inherit` auth by walking the collection ancestor chain leaf→root
  (an explicit `noauth` terminates the walk, `none` is stepped over), and
  resolves variables inside the winning block **before** any OAuth 2.0 cache
  key can be derived from it;
- for a `requestId`, assembles the whole payload from the stored row: flattened
  enabled headers, body, execution options, and the ordered script-part lists
  from the chain plus the request's own. An inline `request` given alongside a
  `requestId` lays over the stored fields before resolution (how MCP's
  `start_load_run` overrides work).

Composition is **pure** - nothing is sent, no run row is created - and it is
still the only place a payload is *composed*: an execution endpoint never
composes one, so a payload that skipped composition is sent as supplied.
Interpolation still happens strictly *before* the pre-request script runs
(#226's decision D1 stands - composition was not moved to after the script the
way Postman orders it).

What #1008 added is narrower than a second composition: a name composition
could **not** answer keeps its braces (#1009) rather than becoming `""`, and
`resolve_residual_tokens` resolves those - and only those - once more, after
the pre-request script and before the send, so `pm.environment.set("token", …)`
does reach `{{token}}` in the same send. A value composition substituted is
finished text and is never revisited, which is what keeps "resolved once" true
of every value that had an answer. The one thing this costs: an ad-hoc payload
posted straight to `/execute` with a literal `{{...}}` in it is no longer
inert - if the run's scopes define that name, the send now carries its value.
A name nothing defines still goes out written as it stands, and the load path
does not run this pass at all. The one thing the pass can *refuse* is a
resolved header name landing on a name the request already carries (#1051):
the map holds one value per name, so the send would go out a header short, and
it is stopped instead - in composition's words, as a `statusCode: 0` response
carrying the reason (a `400` on the streaming path, which has not answered
yet). An unresolved `{"mode":"inherit"}` reaching an execution endpoint
is treated as no auth and logged as a **warning** - it means a client skipped
composition.

Clients: the renderer sends its editor state through the inline shape (Send,
load test, and History's replay - editor state can be unsaved or a detached
copy, which is why compose-by-id alone would not do); MCP composes saved
requests by id and gates its allowlist on the *composed* URL. The renderer
keeps a preview-only copy of the substitution rules
(`app/src/lib/variable-resolution.ts`) for tab titles, previews and the
unresolved-token painting; the shared conformance fixture
(`engine/tests/fixtures/variable-resolution-conformance.json`) holds it to the
engine's behaviour.

Script composition: clients on the inline path send an ordered list of parts
(`{ origin: "collection" | "request", id?, name?, script }` -
`preRequestScripts` / `postRequestScripts` on `POST /execute`, `tests` on
`POST /runs`; the legacy single-string field still works) built by walking the
collection chain root-to-leaf then appending the request's own (`scriptParts`
in `app/src/modules/request-builder/utils/script-parts.ts`); the by-id path
builds the same list engine-side. The engine joins the parts with `"\n\n"`,
dropping any whose script is empty or only whitespace, and runs the result once
(`engine/src/http/script_parts.cpp::read_script`). Script text is **never**
interpolated - a `{{...}}` inside a script is user JavaScript, not a template.

### Database (`SQLite`)

Persistent storage using sqlite_orm:

**Schema:**
- `collections`: Folder hierarchy for organizing requests
- `requests`: Saved HTTP requests with headers, body, scripts
- `environments`: Variable sets for different environments
- `globals`: Singleton global variables
- `runs`: Test execution records (design mode or load test)
- `metrics`: Time-series metrics (RPS, latency percentiles, bytes, dropped, status codes, …)
- `results`: Individual request results (errors + sampled successes)
- `oauth_tokens`: Cached OAuth 2.0 access/refresh tokens (keyed by config identity)
- `config_entries`: Engine configuration registry (read/written via `/config`)

See [Database Schema](db-schema.md) for the full column list.

**Startup housekeeping** (`Database::init()`, before the sweeper and HTTP server start):

1. **Reconciliation**: runs still `running`/`pending` were abandoned by a previous
   process (a crash or a kill - a graceful shutdown stops and joins every worker, so
   it writes a terminal status) - nothing else would ever move them off those
   statuses, so `GET /runs` reported them as running forever. They are marked
   `failed`; `end_time` is left as recorded, since when the process died is
   unknowable at restart.
2. **Pruning**: run history is trimmed per `maxRunsRetained` / `runRetentionDays`.
   Reconciliation runs first so an orphan is terminal, and therefore prunable, in the
   same startup.
3. **Trash retention**: collections and requests deleted more than
   `trashRetentionDays` ago are destroyed for good (issue #988) - the subtree,
   its requests and their examples. Until then a delete is only a stamp, and
   `POST /trash/:id/restore` puts it back.

All three passes are best-effort: a failure is logged and never blocks startup.

## Request Flow

### Design Mode (Single Request)

```
1. POST /execute
   ↓
2. Build request: parse JSON + apply timeout + resolve auth (bearer/basic/
   apikey/oauth2). Auth is resolved BEFORE the script so pm.request is accurate
   ↓
3. Create Run record (type: Design)
   ↓
4. Execute pre-request script (if provided). Its pm.request edits - method, url,
   headers, body - are written back into the request, so they override the auth
   resolved in step 2
   ↓
5. Send HTTP request via libcurl, through the environment's cookie jar - stored
   cookies go out, Set-Cookie comes back in (see Cookie Jar below)
   ↓
6. Execute test script (if provided)
   ↓
7. Save result to database
   ↓
8. Return response with test results
```

### Scenario Mode (Collection Run)

A third `runs.type`, `scenario`: an ordered sequence rather than a single
request. `POST /runs` with a `scenario` block resolves the collection into an
immutable, fully composed plan **before the run row exists**, then answers
`202 {runId}` and runs it on a worker thread.

```
1. POST /runs  (with a "scenario" block)
   ↓
2. Resolve the collection into an ordered ScenarioPlan - every step composed
   through the POST /compose path, once, before anything is sent. Any failure
   here is a 400 and leaves no run row behind
   ↓
3. Create Run record (type: Scenario). config_snapshot carries the step
   manifest, never the composed plan (see db-schema.md)
   ↓
4. Start worker thread (execute_scenario_run). No event loop, no metrics thread
   ↓
5. Load the variable scopes once; build one script engine for the run
   ↓
6. Per iteration, per step: the design-mode exchange (pre-request script → send
   through the environment cookie jar → test script), then a step result and a
   `step` SSE event on the same retained tick topic a load run publishes into
   ↓
7. On completion: persist script-set variables once, batch-write the bounded
   step results, write the scenario summary, reach a terminal status, retain
```

**The plan is shared with the load path; the executor is not.** Steps go through
`http::Client`, not the event loop, because design-mode fidelity needs the
cookie jar and inline per-step scripts and the event loop deliberately has
neither. Step 6 is literally the `POST /execute` handler's body - both call
`execute_exchange` (`http/request_exchange.cpp`) - so a step and a Send of the
same request cannot drift apart.

**What the sequence carries between steps:**

- **Variables** mutate in memory across every step and iteration, and are
  written back **once, at run end**, through the same diff-based persist a Send
  uses. Per-step persistence would be N x M diff-and-write cycles against the DB
  mutex for a value only this run's later steps read.
- **Cookies** are the environment's jar, unchanged - which is what makes "log in
  on step 1, reuse the session on step 2" free.
- **Nothing else.** There is no scenario-scoped variable bag: a fourth scope
  would need precedence rules, a persistence story and a UI, to hold what the
  environment scope already holds for the run's lifetime.

Because the plan is composed once, a `{{variable}}` a script sets mid-run does
**not** appear in a later step's URL - it reaches later steps through
`pm.environment.get` in a script. Resolving once is what keeps a collection
edited mid-run from changing the sequence underneath itself, and it is what will
make the load-mode executor (a per-VU state machine) possible without SQLite on
its hot path.

**Data rows bind per iteration.** A `scenario.data` array - rows the app parsed
from a CSV or JSON file, sent inline, because the sandbox has no filesystem and a
user-supplied path would be a new trust boundary - binds row `i % rows` to
iteration `i`, read by the run's scripts as `pm.iterationData`. The rows ride the
`ScenarioExecution` the worker holds and are never persisted: the snapshot keeps
`dataRowCount`, and every step's stored row and `step` event keeps
`dataRowIndex`, so which row a wrapped pass re-used stays answerable without
storing the row itself.

A step's outcome is `passed`, `failed`, `skipped` or `errored`, counted
separately everywhere - a skipped step counted as a pass is the false-pass class
this project has already spent an issue eliminating. An `errored` step ends its
iteration; the next iteration still runs, and the run still reaches
`completed`. A stop is honoured **between steps**.

**Flow control is design-mode only.** A script returns an intent -
`pm.execution.setNextRequest(name)`, `setNextRequest(null)`,
`skipRequest()` - and the runner decides; the script never jumps. An unknown or
ambiguous target fails the step by name rather than guessing, and
`maxStepsPerIteration` bounds a cycle. `pm.execution` throws wherever there is
no live sequence to redirect - a single Send, and every load run, including a
scenario one, whose scripts are deferred and run against responses that already
came back.

#### Non-goals, so none of them arrives sideways

Recorded here rather than left to be re-derived: **JMeter's logic-controller
zoo** (if / while / switch / loop / interleave - `setNextRequest` covers the
workflows people actually build); **k6's open-model and arrival-rate executors
for scenarios**; **distributed load**; **the engine reading data files from
disk** (the sandbox has no filesystem, and a user-supplied path would be a new
trust boundary); **parallel steps within an iteration** (an iteration is
ordered - that is the whole primitive); **a scenario-level test script**
asserting across steps; **replacing `run_collection_smoke`** (an unordered,
share-nothing, agent-facing matrix is a different tool and stays); and
**inline scripts on the load path**. The escape hatch for that last one, if it
is ever wanted, is a bounded pool of QuickJS contexts per worker evaluated only
for iterations the sampler already selected - its own issue, and its own
benchmark.

Two things were deliberately left open: whether a **stored scenario entity**
ever lands (the seam exists; the demand does not), and **retry /
continue-on-failure policy** beyond "an errored step ends its iteration".

### Load Test Mode

```
1. POST /runs
   ↓
2. Parse config + pre-flight auth (oauth2 tokens acquired & cache warmed;
   409 up front if interactive sign-in is required)
   ↓
3. Create Run record (type: Load)
   ↓
4. Create RunContext (the worker builds, starts and *publishes* the
   EventLoop itself, inside execute_load_test)
   ↓
5. Start worker thread (execute_load_test)
   ↓
6. Start metrics thread (collect_metrics), and - for a run whose auth is a
   refreshable oauth2 token - the auth-refresh watchdog (run_auth_refresh)
   ↓
7. Strategy submits requests via SPSC queue → event loop
   ↓
8. Metrics collector aggregates results in-memory; metrics thread
   writes per-tick snapshots into the retained tick topic + DB
   ↓
9. Client streams ticks via SSE (/runs/:runId/live), replayed
   from the oldest retained tick then tailed to the `complete` event
   ↓
10. On completion: batch-write results to DB; run retained (TTL) so
    late clients still get the full series
```

The metrics thread's exit is gated on `is_running`, not on `should_stop`. A stop
request only asks the worker to stop; the worker then blocks in `event_loop->stop`
- cancelling on a user stop, draining to a deadline at the natural end - and
clears `is_running` afterwards. Exiting on `should_stop` emitted the final tick
and set `closed` while requests were still settling, so the live view froze at
the stop click while the stored report - written after the worker returned -
counted everything that landed in between.

The metrics thread also starts *before* the worker has built the event loop, so
the loop's pointer crosses threads: the worker constructs and starts it, then
hands it over through `RunContext::publish_event_loop`, and the metrics thread
reads it only through `active_transfer_count()` - a null check plus the
`active_count()` call inside the same small mutex, answering zero before
publication. The lock is what orders the reader against the constructor's
writes; a bare null check tests a value and orders nothing (#956). The strategy
thread and the event-loop workers deliberately read the pointer without that
lock - their reads are ordered by program order on the publishing thread and by
the submit queue's hand-off, and a lock there would sit on the hot submission
path.

**Auth outlives its token.** A run resolves auth once, before the strategy
starts, so a run longer than its OAuth 2.0 access token used to turn into a 401
storm the report never explained. The watchdog closes that: it sleeps until
`oauth2RefreshLeadMs` (default 60s) before the token expires, re-acquires it with
a forced refresh, and publishes the new `Authorization` value on the run's
`AuthRefreshState`. Its five `oauth2Refresh*` settings are read once, when the
run arms it (`read_auth_refresh_tuning`), so a run's schedule cannot change
under it half way through. The *submitting* thread - the strategy, which is the
event loop's sole producer - copies it onto its own `Request` when the cell's
generation moves, and `EventLoop::submit` copies that request wholesale into
each transfer. So the swap needs no lock on the submission path and cannot race
a transfer already queued. Runs it deliberately leaves alone (query-placed
tokens, `autoRefreshToken: false`, `authorization_code` with no refresh token,
non-expiring tokens, scenario runs) behave exactly as they did before it
existed - see `plan_auth_refresh`. A refresh that fails is retried with a
backoff and recorded in the report's `auth` section; it never fails the run.

The tick topic itself is a bounded ring. Run duration is user-controlled with no
upper bound, so an append-only buffer is a slow OOM on an overnight soak. The
bound is expressed as a **duration** - `liveReplayWindowMs` (default 5 min, `0`
= full run) - and `live_ring_size()` converts it to a tick count against the
run's cadence, `liveTickIntervalMs`, clamping to `liveMaxRetainedTicks`
(default 50,000, matching the renderer's own ceiling - it reads the same key). That same entry *is* the
app's live-chart window - the dashboard's picker reads and writes it through
`/config` - so the retained span and the displayed span are one number, not two
that have to be kept aligned. A fixed count would be the wrong unit:
the cadence spans 10–1000ms, so 3000 ticks is 30 seconds at one end and 50
minutes at the other, and the dashboard's live-window setting the ring has to
serve is itself a duration. `collect_metrics` reads the pair once, before tick
0; a mid-run change would leave ids the dashboard already holds pointing into a
differently-sized window. `published_count` keeps counting past an eviction, so
SSE event ids stay monotonic and a `Last-Event-ID` resume from before the window
is fast-forwarded to the oldest retained tick rather than replaying from 0.

## Load Test Strategies

Five load test modes are supported (`LoadTestType` in `types.hpp`). Four are **closed-loop** -
the engine holds in-flight requests at a target and issues a new request as each completes, so
throughput is a *result* (`concurrency ÷ latency`), not an input. One is **open-loop**.

### 1. `constant_rps` (open-loop)

Dispatches at a fixed `targetRps` regardless of how fast responses return. `maxInFlight` caps how
many requests may be outstanding before new ones are dropped (and counted as `dropped_requests`).

```json
{ "mode": "constant_rps", "targetRps": 1000, "duration": "60s", "maxInFlight": 10000 }
```

### 2. `constant_concurrency` (closed-loop)

Holds a constant number of in-flight requests for the duration via the shared
`maintain_concurrency` controller.

```json
{ "mode": "constant_concurrency", "concurrency": 100, "duration": "60s" }
```

### 3. `ramp_up` (closed-loop)

Interpolates the concurrency target from `startConcurrency` to `concurrency` over
`rampUpDuration`, then holds for the remainder of `duration` (which is **total** test time).

```json
{ "mode": "ramp_up", "startConcurrency": 1, "concurrency": 100,
  "rampUpDuration": "10s", "duration": "60s" }
```

### 4. `iterations` (closed-loop, bounded)

Issues a fixed total number of requests at the target concurrency, then stops - exact count at
run end.

```json
{ "mode": "iterations", "concurrency": 10, "iterations": 1000 }
```

### 5. `capacity` (closed-loop, adaptive)

Steps the concurrency target up while latency holds, and stops itself at the
knee. It answers "what can this service sustain" without a human bisecting
concurrency by hand.

```json
{ "mode": "capacity", "startConcurrency": 1, "concurrency": 512,
  "sloMs": 200, "stepDuration": "5s", "duration": "5m" }
```

Each level is held for `stepDuration`, then judged on the mean of that window's
windowed p99 and throughput. Healthy levels step up 25% (at least +1); a single
breaching window **holds** the level and re-measures rather than ending the
search. The stop reasons are `slo_exceeded` (two consecutive breaching windows),
`plateau` (two step-ups bought under 5% more throughput), `cap_reached`,
`deadline` and `stopped`, and the report's `capacity` section names which fired.

### Bounded streams under load

A load run may consume `text/event-stream` responses (`POST /runs` with
`"stream": true`, issue #576), and the design principle is one line:
**under load, every SSE stream is bounded by construction.**

That follows from the refill loop below rather than from taste. The loop is
completion-driven - `in_flight = requests_sent − completed`, refilled per
completion - so a transfer that never completes does not merely skew a number:
it leaks its concurrency slot for the rest of the run, and a run of *N* endless
streams stops sending anything at all once *N* reaches the target. So a
streaming request carries `Request::stream_bounds`, and both caps are always
set - the payload's, or the `sseMaxStreamDurationMs` / `sseMaxStreamEvents`
settings - with no zero-means-unbounded spelling for either.

The two caps are enforced in the two places that can see them:

- **Events** in the curl write callback, by `SseFrameCounter`
  (`http/sse_frame_counter.hpp`) - a nine-byte state machine that counts frames
  without assembling one. It agrees with `SseParser` about what an event is (a
  frame carrying no `data` field is not one), so a load run and a design run
  report the same count for the same stream; `sse_frame_counter_test.cpp` drives
  both over one table and asserts they match.
- **Duration** in the progress callback, which libcurl runs at least once a
  second whether or not bytes arrive - which is the only place a stream that has
  gone *quiet* can be ended. The whole-transfer timeout is moved to a grace
  period past the duration cap, so it backstops the callback rather than racing
  it.

Either cap ends the transfer through libcurl's documented abort, and the
completion path turns that back into a **success** carrying the response's real
status code. That is the point of the cap - it is the stream's intended end -
and it is what keeps `handle_result`-exactly-once and the refill loop untouched.
`maxResponseBodyBytes` is unchanged and still an error: it is a refusal to
buffer, not an ending, and the event cap bounds how many events arrive rather
than how large one is.

The design path is deliberately not affected. `POST /execute` with `stream` is
still `SseStreamManager`'s one-thread-per-stream model with no whole-transfer
deadline; only the flag's spelling is shared, through `read_stream_flag`.

### Closed-loop controller

`constant_concurrency`, `ramp_up`, `iterations` and `capacity` share a `maintain_concurrency`
loop driven by a pure `compute_refill_deficit` primitive: each tick, refill exactly
`target − in_flight` new requests (where `in_flight = requests_sent − completed`). On stop the
controller is notified for prompt cancellation rather than waiting for in-flight requests to drain.

**The `target_fn` invariant, restated.** Every mode but `capacity` passes a
`target_fn` that is a pure function of `elapsed_ms` and constants fixed when the
run started - which is what makes a ramp reproducible and a constant run flat.
`capacity` is the deliberate exception: its target is a function of what the run
has *measured*, so the invariant is now "the target depends only on elapsed time
**and the published metric tick**", and nothing else.

That feedback path has exactly one shape, and it matters which. The strategy
must **not** call `MetricsCollector::sample_window_percentiles()`: that call is
single-reader and *resets* the rolling window on read, and the metrics thread
already consumes it once per tick in `emit_live_tick`. A second consumer would
silently halve both readers' sample counts, and neither the live chart nor the
search would look wrong. So the metrics thread publishes what it already
computed - `RunContext::publish_live_tick()`, one writer - and the strategy
copies it out through `latest_live_tick()`. The controller therefore steers by
exactly the numbers the dashboard is drawing. A guard in
`capacity_controller_test.cpp` pins the single production caller, because the
wrong version still runs; it just measures less.

The tick carries a `latency_samples` count for the same reason: an idle window's
percentiles are zeros, and averaging those in with real ones would read "nothing
completed" as "answered instantly" and climb straight past the limit the search
exists to find. The controller's policy itself lives in
`core/capacity_controller.hpp` as pure functions over a level history - no clock,
no collector, no run context - so it is unit-tested without a server.

### Scenario load runs - the virtual-user state machine

A `POST /runs` payload carrying **both** a `scenario` block and a load `mode` runs
that collection as a load test (`core/scenario_load.cpp`). The plan is the same
object the design-mode sequential runner consumes - resolved once, before the run
row exists - and the executor is the only thing that differs.

- **`concurrency` is the number of virtual users**, which is what k6 and JMeter
  mean by it. A VU is a small value, not a thread: a cursor into the shared plan
  plus its own cookies. On each completion the callback advances that VU's state
  machine, and `maintain_concurrency`'s refill issues "the next step of VU *k*"
  in place of "another copy of the one request". The controller, the SPSC
  submission path and the single-producer discipline are unchanged.
- **Cookie state is per-VU, never the shared jar** - see the Cookie Jar section's
  "Not on the load path" bullet, which this strengthens rather than contradicts.
  Each VU's list is seeded onto its own transfer and read back from it
  (`Request::track_cookies`), and emptied at every iteration boundary: a new
  iteration is a new user, not the same one logging in twice.
- **Closed-loop only.** `constant_rps` with a `scenario` is a `400`, as is a
  non-zero `rps`/`targetRps` on any mode - an open-loop arrival rate over a
  multi-step sequence is an arrival-rate executor, a named non-goal. `maxInFlight`
  is *moot*: in-flight is bounded by the VU count by construction, so setting it
  logs a warning and does nothing.
- **An errored step ends its iteration**, and the VU starts the next one. A VU
  stranded on a failing step would permanently shrink effective concurrency for
  the rest of the run.
- **Per-step latency histograms**, one per plan step, allocated once from the
  plan's step count - which is what `maxScenarioSteps` bounds. They reach the
  report as `summary.scenario.steps`; a scenario load run stores no per-step
  `results` rows, so that breakdown is the only per-step record it keeps.
- **Data rows bind per iteration, from one shared cursor.** A run sent with
  `scenario.data` claims a row per virtual-user iteration off a single run-wide
  cursor, wrapping when the rows run out, and every step of that iteration binds
  the same row - a checkout that used a different row than its login is not a
  user. Shared rather than per-VU is what makes distinct credentials per user
  work: two VUs must not both be handed row 0. It is k6's `iterationInTest` /
  JMeter's "All threads" parity, and it costs one increment per *iteration* on
  the producer thread, which is the only thread that claims.
  Each step's `{{data.column}}` tokens are **split once, at plan resolution**
  (`ScenarioStep::data_template`) and only joined per row afterwards, so a plan
  carrying no data tokens does no per-iteration work at all. A token naming a
  column its bound row does not carry **fails that step loudly** - nothing is
  sent, the step's `errors` count moves, and the run's error list carries the
  sentence naming the token, the row and the row's columns
  (`DATA_BINDING_FAILED`). Every retained result carries its `dataRowIndex`,
  which is what makes a failure attributable to a row when no per-step `results`
  rows exist.
- **A single-request load run binds rows too** (issue #993). Its rows ride the
  payload's top-level `data` rather than a scenario block, and one is claimed per
  *submission* off the same kind of run-wide cursor, wrapping the same way - a
  single request has no sequence for an iteration to span, so the unit of a claim
  is the request. The templates are split once, when the run's one request is
  built (`RunContext::load_template`), the credentials defer exactly as a step's do,
  and every retained result carries its `dataRowIndex`. The credential half is
  split onto `RunContext::load_auth` rather than onto the row set (issue #1055),
  for the reason the request's template is: a credential carrying `{{$vu}}`
  defers on a run that has no rows, so a set that exists only where rows do is
  the wrong place to keep it. **A run without rows carries no set at all**, which
  is the throughput guard stated structurally: the strategies test one pointer
  and two empty templates, and otherwise submit the shared request they always
  did. The validation, the binder and the escaping are the scenario path's own
  functions rather than copies - `read_data_rows` and `bind_iteration`.
- **The iteration's identity binds beside its row** (issue #994). `{{$vu}}` and
  `{{$iteration}}` are a second reserved namespace, and they are bound at the
  same point, out of the same template: a field carrying one of each is one
  string, so the split keeps both and the join resolves each where its value
  lives - the identity from the iteration, everything else from the row. On the
  scenario path the values are the virtual user's own number (1-based) and its
  iteration; on the single-request path they are `1` and the submission index,
  which is the same counter the row cursor claims from, so the two cannot
  disagree about which submission this was. A design-mode collection run is user
  1 walking its passes, and a single send is a run of one.
  This is **template substitution, not a script hook**: two integers written into
  fields a compose-time scan already located, which is why it sits here rather
  than reopening the recorded non-goal above (inline scripts on the load path).
  A request that spells neither token has an empty template and is walked for
  nothing - the executor tests `empty()` and submits the shared request it
  always did. What every run does now pay is one unsynchronised increment per
  submission on the producer thread, which is what lets any load run tell a
  deferred script the iteration and the user a sampled response was sent as
  (`pm.info.iteration` / `pm.info.vu`).
- **Scripts stay deferred, keyed per step.** Nothing runs inline; after the run
  drains, each step's own `post_script` is replayed against the responses *that
  step* produced, and the tallies land on that step's entry in the breakdown
  (`scenario.steps[].tests`). Sampling is per step index for the same reason -
  one flat run-wide reservoir lets the hot first step swamp the budget and never
  samples the last step of a long plan. The run's `max_response_samples` budget
  is split evenly across the steps that carry a script (not across every step),
  floored at one apiece; a step with no script is never sampled and never
  counted as a thinned sample. A `pre_script` runs nowhere: it would have to run
  before a send this mode never pauses for. `pm.execution` still throws in a
  load run for the reason the flow-control section gives, and there is
  deliberately no inline-script path on the load hot path.
- The run's `runs.type` is **`load`**, not `scenario`: it publishes metric ticks
  and reports RPS and percentiles like any load run, and `scenario` is what the
  app reads to render a step list instead of the dashboard.

```json
{ "mode": "constant_concurrency", "concurrency": 50, "duration": "60s",
  "scenario": { "source": "collection", "collectionId": "col_1" } }
```

## Thread Model

- **Main Thread**: HTTP server, request routing
- **Worker Threads**: One per active load test (executes load strategy)
- **Metrics Thread**: One per active load test (aggregates and streams metrics)
- **Monitor Thread**: One per load test that declared a `monitor` block - it
  scrapes the target's metrics endpoint on its own interval. Separate from the
  metrics thread because that one is a fixed-cadence sampler with no deadline
  compensation: a blocking HTTP call inside it would delay every subsequent tick
  by the scrape's latency, and a hanging endpoint would end live metrics for the
  whole run.
- **Event Loop Threads**: One per CPU core (handles curl_multi I/O)

- **Stream Consumer Threads**: One per live streaming request (`POST /execute`
  with `"stream": true`), owned by `SseStreamManager`.

Shutdown unwinds that in a fixed order, because every one of these threads
holds references to state `main` owns: HTTP server stopped **and its stream
consumers drained** (`Server::stop()` calls `SseStreamManager::shutdown()`,
which signals every stream and joins its worker) → run workers signalled and
joined (each joins its own metrics and monitor threads and stops its event loop
first) → `curl_global_cleanup` → `Database` / `RunManager` destroyed at scope
exit. Nothing is detached.

The stream drain belongs to `stop()` rather than to `~Server` because
`curl_global_cleanup` runs *between* the two: a consumer joined only by the
member destructor would still be inside a curl transfer while curl's global
state was torn down, and still writing its run row through a `Database` that is
about to be destroyed - the #125 defect in the one worker `RunManager` does not
own (#646). Any other owner of an `SseStreamManager` owes the same order: drain
before the `Database` and `CookieJar` its workers reach through go away.

## Performance Characteristics

- **Throughput**: 60,000+ requests per second (on capable hardware)
- **Latency**: P99 < 50ms overhead
- **Memory**: Pre-allocated buffers minimize allocations during tests
- **Database**: Batch writes avoid contention during high-RPS tests

## Configuration

Default configuration values (from `constants.hpp`):

| Setting | Default | Description |
|---------|---------|-------------|
| Port | 9876 | HTTP server port |
| Max Concurrent | 1000 | Per worker event loop |
| Max Per Host | 100 | Connections per hostname |
| Poll Timeout | 10ms | Event loop poll interval |
| DNS Cache | 300s | DNS cache timeout (curl's cache and the pre-resolution pin cache) |
| Max Response Body | 32MB | Per load-test transfer; larger fails the request |
| Script Memory | 64MB | QuickJS memory limit |
| Script Timeout | 5s | Script execution timeout |
| Stats Interval | 100ms | Metrics collection interval |

## Data Directory Structure

```
data/
├── db/
│   ├── vayu.db          # SQLite database
│   ├── vayu.db.bak      # Rewritten on every clean start - crash recovery, not a user backup
│   └── backups/
│       └── vayu-<stamp>.db  # On-demand snapshots (UTC, %Y%m%d-%H%M%S-mmm)
├── logs/
│   ├── vayu_<stamp>.log # One file per process start (local time, %Y%m%d_%H%M%S)
│   └── vayu_<stamp>.log.1  # The rotated half of a file that reached the size cap
└── vayu.lock            # Single-instance lock file
```

### Workspace backups

`vayu.db` holds everything a person has built - collections, environments,
stored credentials and run history - and until issue #987 there was no copy of
it the user controlled. The `.bak` beside it is **not** one: it is rewritten on
every clean start, so it exists to give a corrupt file something to restore
from, not to let anyone go back to last week.

`POST /workspace/backup` (or `vayu-cli backup`) writes one snapshot into
`db/backups/`. It runs SQLite's `VACUUM INTO`, which is why it is safe while
the engine is working: copying `vayu.db` by hand is not, because the `-wal`
beside it holds committed transactions the main file does not, so the copy is a
database missing its most recent writes. `VACUUM INTO` reads one consistent
snapshot and writes a defragmented database that is complete on its own.

Names are UTC and fixed-width so they sort chronologically as text. After each
backup the newest `maxBackupsRetained` snapshots are kept (default 5, `0` =
unlimited) and older ones removed - **only files matching `vayu-<stamp>.db`**,
so a copy you put in that directory yourself is left alone. A second backup
requested while one is running is refused with `409` rather than queued.

#### Restoring

There is deliberately no restore endpoint: a running engine overwriting the
database file it holds open is the failure this feature exists to spare you.
Restore by hand, with the engine stopped.

1. Quit Vayu (or stop `vayu-engine`).
2. Copy the snapshot over `db/vayu.db`.
3. Delete `db/vayu.db-wal` and `db/vayu.db-shm` if they are present - they
   belong to the database you just replaced, and leaving them behind reapplies
   its writes on top of the snapshot.
4. Start Vayu again.

### Log retention, level and size

Three bounds, all applied by the engine itself (issue #985):

- **Retention.** A start opens its own file and then deletes every
  `vayu_*.log` beyond the newest 10, taking each pruned file's `.1` with it.
  Newest is decided by the timestamp in the name, which is what makes those
  names sortable. Nothing else in the directory is a candidate.
- **Level.** The `logLevel` config entry (`debug` | `info` | `warn` | `error`,
  default `debug`) is the lowest severity the **file** takes. The console is
  separate and still follows the daemon's `-v` flag. The value is read once,
  when the database opens, so the few lines a start writes before that always
  land and a change needs a restart.
- **Size.** `maxLogFileBytes` (default 64 MiB, `0` = unlimited) caps one file.
  On reaching it the file is renamed to `<name>.1` - overwriting whatever that
  held - and writing continues in a fresh one. One rotation generation is
  enough because history is the per-start files, which retention already
  bounds.

## Security

- **Local-only binding**: the management API only listens on `127.0.0.1`. A
  [webhook inbox](#listeners) is the single listener that may bind wider, and only when the
  caller confirms it explicitly; it serves no engine route.
- **Script sandboxing**: QuickJS contexts have no filesystem/network access
- **Single instance**: File lock prevents multiple daemon instances
- **Secret handling (v1 posture)**: auth credentials and cached OAuth 2.0 tokens
  are stored in **plaintext** in SQLite; `runs.config_snapshot` redacts its
  `auth` object to `{mode}` before persistence; and curl verbose logs redact the
  values of sensitive headers (`Authorization`, cookies, etc.). Token request
  bodies/responses are never logged. On-disk encryption (`safeStorage`) is
  still deferred, and so is OS-keychain storage (out of scope for the transport
  epic, #704 decision 6; the app runs Chromium with `use-mock-keychain`).
  Mid-run token refresh
  is **not** deferred: the [refresh watchdog](#load-test-mode) ships, and
  re-acquires a load run's OAuth 2.0 token before it expires.
- **Where the redaction line falls, and why it is not one line.** Two columns of
  a run row answer two different questions, and the split is deliberate:
  `runs.config_snapshot` records the request **as authored**, so
  `sanitize_config_snapshot` keeps `auth` down to `{mode}` and a scenario run
  stores the uncomposed URL - a composed plan carries resolved `Authorization`
  headers and an `apikey` in the query string, and persisting one would route
  around that allowlist. `results.trace_data` records what was **sent**, which
  is the only thing it is for: it stores the resolved request headers - both as
  composed and, since issue #664, as the transfer issued them
  (`request.sentHeaders`) - and since issue #348 the wire message itself
  (`request.rawRequest`, the `Cookie` line included). Both are credential-grade, both are plaintext under the v1 posture
  above, and a trace that hid what went out would have no reason to exist. What
  bounds their lifetime is run retention (`maxRuns` / the prune pass), not the
  process - so clearing the cookie jar does not clear the runs that recorded it.

## Dependencies

- **libcurl**: HTTP client library
- **cpp-httplib**: HTTP server library
- **nlohmann-json**: JSON parsing/serialization
- **sqlite3**: Embedded database
- **sqlite-orm**: C++ ORM for SQLite
- **QuickJS**: JavaScript engine (vendored)
- **libsodium**: SHA-256, HMAC-SHA256, base64 and hex (ISC)
