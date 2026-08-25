---
description: >-
  How Vayu works: an Electron UI and a C++23 engine as a local sidecar over HTTP, the process lifecycle, and why the split exists.
---

# Vayu System Architecture

Vayu uses a **Sidecar Architecture** that decouples the user interface from the execution engine. This separation allows each component to be optimized for its specific purpose:

- **The Manager** (Electron/React): Optimized for user experience
- **The Engine** (C++): Optimized for raw performance

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Vayu Application                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────┐      ┌─────────────────────────────┐  │
│  │     THE MANAGER         │      │        THE ENGINE           │  │
│  │   (Electron + React)    │      │          (C++)              │  │
│  │                         │      │                             │  │
│  │  ┌───────────────────┐  │      │  ┌───────────────────────┐  │
│  │  │   Request Builder │  │      │  │    HTTP Server         │  │
│  │  │   Response Viewer │  │ HTTP │  │    (cpp-httplib)        │  │
│  │  │   Dashboard       │◄─┼──────┼─►│    Port: 9876           │  │
│  │  │   Collections     │  │      │  └───────────────────────┘  │  │
│  │  └───────────────────┘  │      │             │               │  │
│  │           │             │      │             ▼               │  │
│  │           │             │      │  ┌───────────────────────┐  │
│  │           ▼             │      │  │    Thread Pool        │  │
│  │  ┌───────────────────┐  │      │  │  ┌─────┐ ┌─────┐     │  │
│  │  │   Sidecar Manager │  │      │  │  │ W1  │ │ W2  │ ... │  │
│  │  │   (spawn/kill)    │  │      │  │  └──┬──┘ └──┬──┘     │  │
│  │  └───────────────────┘  │      │  └─────┼──────┼─────────┘  │
│  │                         │      │        │      │            │
│  └─────────────────────────┘      │        ▼      ▼            │
│                                   │  ┌───────────────────────┐  │
│                                   │  │  Event Loop          │  │
│                                   │  │  (curl_multi)        │  │
│                                   │  └───────────────────────┘  │
│                                   │             │               │
│                                   │             ▼               │
│                                   │  ┌───────────────────────┐  │
│                                   │  │  Script Engine        │  │
│                                   │  │  (QuickJS)            │  │
│                                   │  └───────────────────────┘  │
│                                   │             │               │
│                                   │             ▼               │
│                                   │  ┌───────────────────────┐  │
│                                   │  │  SQLite Database      │  │
│                                   │  │  (Collections, Runs)  │  │
│                                   │  └───────────────────────┘  │
│                                   │                             │
│                                   └─────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## The Manager (Electron + React)

The Manager is the "face" of Vayu-a standard Electron application that provides the graphical interface.

**Key Responsibilities:**
- Request building and editing
- Collection management
- Environment variable management
- Real-time load test dashboard
- Run history viewing

**Technology Stack:**
- **Electron 28**: Desktop app framework
- **React 19**: UI framework
- **TypeScript**: Type safety - 5.9 compiles and lints, 7 runs the `pnpm type-check` gate (see [app building](app/building.md#two-compilers-one-on-purpose))
- **Zustand**: UI state management
- **TanStack Query**: Server state and caching
- **Radix UI**: Accessible component primitives
- **Tailwind CSS**: Styling

See [App Architecture](app/architecture.md) for detailed information.

## The Engine (C++)

The Engine is the "muscle"-a headless daemon optimized for maximum I/O throughput.

**Key Responsibilities:**
- HTTP request execution (libcurl)
- Load test orchestration
- Script execution (QuickJS)
- Metrics collection
- Data persistence (SQLite)

**Technology Stack:**
- **C++23**: Core language
- **cpp-httplib**: HTTP server
- **libcurl**: HTTP client (HTTP/1.1, HTTP/2 via nghttp2 - HTTP/3 is not supported)
- **QuickJS**: JavaScript engine for scripts
- **SQLite**: Embedded database
- **sqlite_orm**: C++ ORM

See [Engine Architecture](engine/architecture.md) for detailed information.

## Communication Protocol

The Manager communicates with the Engine via a localhost HTTP API on port 9876.

### Request/Response Flow

```
Manager                              Engine
   │                                    │
   │  POST /execute                     │
   │  {method, url, headers, body}      │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK                            │
   │  {status, headers, body, timing}   │
   │◄───────────────────────────────────┤
```

### Load Test Flow

```
Manager                              Engine
   │                                    │
   │  POST /runs                        │
   │  {request, mode, duration, ...}   │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK {runId}                    │
   │◄───────────────────────────────────┤
   │                                    │
   │  GET /runs/{runId}/live (SSE)      │
   ├───────────────────────────────────►│
   │                                    │
   │  event: metrics                    │
   │  data: {rps, latency, ...}         │
   │◄───────────────────────────────────┤
   │                          (repeated) │
   │  event: complete                   │
   │◄───────────────────────────────────┤
   │                                    │
   │  GET /runs/{runId}/report          │
   ├───────────────────────────────────►│
   │                                    │
   │  200 OK {summary, latency, ...}    │
   │◄───────────────────────────────────┤
```

See [Engine API Reference](engine/api-reference.md) for complete endpoint documentation.

## Sidecar Pattern

The Engine runs as a separate process managed by the Electron main process:

1. **Engine Startup**: Electron spawns the `vayu-engine` binary on app launch
2. **Health Monitoring**: Manager polls `/health` endpoint to verify connectivity
3. **Graceful Shutdown**: Engine is stopped when Electron app quits

### Ownership model

The engine binds one fixed port (9876) and owns one SQLite database, so exactly
one app instance may drive it:

- **One instance.** The app takes `app.requestSingleInstanceLock()` before it
  starts anything. A second launch focuses the running window and exits - it
  never gets its own engine, and never attaches to the first instance's.
- **Spawned or adopted, the running instance owns the engine.** Normally the app
  spawns it. If an engine is already answering on the port at startup - an
  orphan left by a crashed session, or in development one started by hand - the
  app *adopts* it: it is tracked by the PID in the lock file (`vayu.lock` in the
  data directory), reported as running, restarted for real when Settings asks,
  and shut down on quit like any engine the app spawned itself.
- **Quit leaves nothing behind.** Shutdown is `POST /shutdown` first, then a
  wait for the process to go, then a name-verified kill by PID if it outstays
  the grace period. The name check is what keeps a recycled PID from being
  killed in the engine's place.
- **A quit during a restart wins.** Once the app is quitting, the sidecar
  refuses to start an engine, and a restart already in flight is waited out
  rather than raced - otherwise a freshly spawned engine outlives the process
  that was supposed to kill it.
- **A startup that cannot succeed fails immediately.** The readiness poll allows
  45 seconds, but it watches the spawned child as well as the port: an engine
  that exits first - a missing shared library, a lock it could not acquire -
  fails the launch at once, naming the exit code or signal and the engine's last
  stderr lines. The window is created after startup, so the ceiling would
  otherwise be 45 seconds of an empty screen.

**Development vs Production:**
- **Development**: Engine binary at `engine/build/vayu-engine`
- **Production**: Engine binary packaged in `Vayu.app/Contents/Resources/bin/vayu-engine`

See [App Architecture - Sidecar](app/architecture.md#engine-sidecar-electronsidecarts) for implementation details.

## Data Flow

### Single Request Execution

1. User builds request in RequestBuilder
2. Variables resolved in frontend (`{{baseUrl}}` → `https://api.example.com`)
3. Manager sends `POST /execute` to Engine
4. Engine executes HTTP request via libcurl
5. Engine runs pre-request script (if provided)
6. Engine runs test script (if provided)
7. Engine returns response with timing and test results
8. Manager displays response in ResponseViewer

### Load Test Execution

1. User configures load test (mode, duration, concurrency)
2. Manager sends `POST /runs` to Engine
3. Engine starts load test and returns `runId`
4. Manager connects to SSE stream (`/runs/{runId}/live`)
5. Engine streams real-time metrics (RPS, latency, errors)
6. Manager updates dashboard in real-time
7. When test completes, Manager fetches final report (`/runs/{runId}/report`)

### Outbound Transport

Every request the engine puts on the wire - a design send, a load run, an SSE
stream, an OAuth token fetch, a spec import by URL, a monitor scrape - leaves
through one transport policy, resolved from Settings > Network & connectivity
at the point of use and applied by a single function
(`detail::apply_transport_policy`). There is one hop between the engine and the
target and it is either absent or a proxy:

```
Engine (libcurl) ──▶ [proxy, when configured] ──▶ Target API
```

`proxyMode` decides which:

- `environment` (default) - libcurl's own `http_proxy` / `https_proxy` /
  `no_proxy` pickup. This is the behaviour a terminal-launched engine already
  had; a desktop launch usually inherits none of those variables.
- `system` - the proxy this computer is configured with. **The engine cannot
  resolve that itself**, which is the whole reason this mode has a mechanism
  rather than a rule: the two networking stacks are disjoint. Chromium resolves
  the operating system's proxy (and its PAC script) for the Electron shell and
  reads it on its own; libcurl, which carries every request the user sends, sees
  none of it. So the main process - the only place both are visible - resolves
  and writes the answer into the `proxySystemUrl` setting, where this mode reads
  it, at startup, when the machine wakes, and when the renderer sees the network
  change. Two limitations follow and are stated where the mode is chosen: a **PAC
  script is resolved once**, against a probe URL, and the one answer applies
  engine-wide (per-URL PAC needs `manual`); and a **headless engine** has no app
  to push it a value, so an empty `proxySystemUrl` falls back to `environment`
  rather than to `off`.
- `manual` - the configured `proxyUrl`, written the way curl takes it
  (`scheme://user:password@host:port`, which covers SOCKS and basic proxy
  auth).
- `off` - no proxy at all, environment variables included.

`proxyBypass` (curl's `NOPROXY` semantics) exempts hosts from the proxy in
any proxying mode. A failure of the hop itself - an unresolvable proxy host,
a refused CONNECT - is reported as its own `PROXY_ERROR`, never as the target's
`CONNECTION_FAILED`. Cookies are unaffected: libcurl matches them on the origin
host, never on the proxy.

The same policy carries **who the engine trusts**. `customCaCertificates` holds
pasted PEM anchors, materialized as a bundle beside the database and added to
the platform's own trust rather than replacing it, so a TLS-inspecting proxy or
an internal authority is verifiable on every one of those paths at once. All
three platforms verify with **one TLS backend** - OpenSSL, pinned in
`engine/vcpkg.json` and asserted per CI leg - so *additive* means one of two
things depending on where the platform keeps its anchors: Linux and macOS read
their bundle from disk and the materialized file is that plus the paste, while
Windows keeps its in the certificate store and the engine loads it with
`CURLSSLOPT_NATIVE_CA` beside the bundle. Per request, the Settings tab's
*Verify TLS certificate* row turns verification off for one endpoint - stored,
sent on every send and load test, and painted as a warning while it is off. See
[TLS trust settings](engine/api-reference.md#tls-trust-settings) for the
per-platform detail, including what the Windows store does not supply.

It also carries **what the engine proves it is**. An mTLS endpoint asks the
client for a certificate, and a certificate belongs to the host being called
rather than to one request - the transfer that needs it is as often a token
fetch, a redirect or a script's `pm.sendRequest`. So the engine keeps a
registry of host to certificate (Settings > Network & connectivity), matches an
entry per transfer by host and optional port - an exact name, or `*.example.com`
for every subdomain of it but never the domain itself - and presents it on every
one of the paths above without any request naming it. Only the file *paths* are
stored, so the private key stays where the user's own tooling put it; a
cert-authenticated exchange reports which entry it used, live and from History
alike. See [Client
certificates](engine/api-reference.md#client-certificates).

Because all three of those - the hop, the trust and the certificate - fail at
the *first real request* and libcurl names the endpoint when they do, the same
Settings screen carries a **connection test**: one policy-honouring send
(`POST /diagnostics/connection`) whose answer says which hop refused, so a
wrong proxy URL or a missing corporate CA is caught where it was configured.
It returns an outcome and never the response body. The other half of the same
honesty rule is on the way in: pasting a curl command imports what it can and
**names what it could not** - `-x`, `--cert`, `--cacert` and the rest - with a
pointer to the setting that owns each intent, rather than silently dropping
them.

### Variable Resolution

Variables are resolved with priority: **Environment > Collection > Global**

1. Manager fetches globals, collections, and environments
2. Builds flat map with resolution priority
3. Replaces `{{variableName}}` patterns in URL, headers, body
4. Resolved request sent to Engine

## Security

- **Script Sandboxing**: QuickJS contexts are isolated with no filesystem or network access
- **Local-Only Communication**: Control API only binds to `127.0.0.1:9876`
- **Context Isolation**: Electron renderer runs in isolated context (no Node.js access)
- **No Cloud Sync**: All data stored locally in SQLite database
- **Proxy credentials**: stored in the `proxyUrl` setting as plaintext in
  SQLite, the same way every other stored credential is. libcurl derives the
  `Proxy-Authorization` header from the URL, and that header is on the
  redaction list, so credentials never reach a stored trace or a debug log.
- **Client-certificate keys**: never stored. The `client_certificates` table
  holds the *paths* of the certificate and key files - one path where the
  certificate is a PKCS#12 bundle carrying both - and the engine opens them
  at send time. The key's passphrase is the one part that is stored, plaintext,
  on the same precedent as every other credential above - and the API never
  echoes it back, answering `hasPassphrase` instead.

## Performance Characteristics

- **Engine**: Tens of thousands of requests per second (target/hardware dependent; ~45k req/s
  tuned on loopback in internal testing)
- **Lock-Free Design**: High-performance metrics collection with minimal contention
- **Async I/O**: Uses `curl_multi` for concurrent request handling
- **Load models**: `constant_rps` is open-loop (dispatch at a fixed rate); `constant_concurrency`,
  `ramp_up`, `iterations` and `capacity` are closed-loop (hold a target in-flight count).
  `capacity` is the one whose target adapts to what the run measured, stepping up until latency
  breaks its budget. See [Engine Architecture](engine/architecture.md#load-test-strategies).
- **Efficient Caching**: TanStack Query caches server responses in Manager

## File Locations

### Development

- **Engine Binary**: `engine/build/vayu-engine`
- **Engine Data**: `engine/data/` (database, logs)
- **App Source**: `app/src/`
- **App Build**: `app/dist/`

### Production

- **macOS**: `Vayu.app/Contents/Resources/bin/vayu-engine`
- **Windows**: `resources/bin/vayu-engine.exe`
- **Linux**: `resources/bin/vayu-engine`
- **Data Directory**:
  - macOS: `~/Library/Application Support/vayu/`
  - Windows: `%APPDATA%/vayu/`
  - Linux: `~/.config/vayu/`

---

*See: [Engine Architecture](engine/architecture.md) | [App Architecture](app/architecture.md) | [Engine API Reference](engine/api-reference.md)*
