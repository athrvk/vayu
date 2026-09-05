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
- **Electron 44**: Desktop app framework
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

For the length of that stream - a load run or a collection run - the Manager can
hold a system wake lock (`electron/power-save.ts`, `prevent-app-suspension`), so
an OS sleep timer cannot suspend the machine under a test the user walked away
from and leave the report with a gap it cannot explain. The lock is ref-counted
and token-based: the renderer's run services take one each over `power:hold` and
hand it back on every terminal path, the main process drops a renderer's holds
when it goes away or reloads, and the blocker stops with the last holder. A run
that stops being watched without ending hands its lock back too: the two
services share one SSE client, so starting a collection run takes the socket
from a streaming load run, and the client tells the displaced service rather
than closing on it in silence, which used to leave that key held for the rest of
the session (issue #1417). The screen may still dim and lock; only suspension is
refused.

**It is off by default, because the machine's power settings are the user's.**
Two things turn it on. The standing preference (Settings > Load testing > Keep
the machine awake during runs, `keepAwakeDuringRuns` in `client-settings-store`)
is read when a run starts, and with it on every run holds. With it off, a load
run that declares ten minutes or more asks once when it starts
(`KeepAwakePrompt`), and an answer of "keep awake" takes the lock for that run
only. A collection run is never asked about: it declares no duration, so nothing
in the app can tell a two-second sequence from a two-hour one.

The lock is a request to the OS, not a guarantee. When the host suspends anyway
(a closed lid, a critical battery), main reports the interval to the renderer as
`power:suspended` / `power:resumed`, and the app records it against the run and
marks it on the charts and in the run's Events tab. The engine cannot carry that
record: it was suspended too.

**System notifications for a run's end are opt-in and off by default.** The
renderer decides *what* is worth saying - it is the only side that knows a run
reached a terminal state, and the only side that can read the opt-in, which
lives in a localStorage-backed store main cannot see - over `notify:show`
(`services/notify.ts`); `electron/notify.ts` decides *whether and how*, from the
window's focus and the platform's support, and answers `notify:availability`
for the settings row. Nothing is posted while the window is focused - the toast
already said it. Windows shows nothing at all unless `app.setAppUserModelId`
matches the shortcut's id; macOS authorizes per bundle and refuses one whose
code signature does not bind its own `Info.plist`. Ad-hoc signing satisfies it,
and `install.sh` re-signs what it installs, so an installed build notifies - but
the dev `Electron.app` and a bundle dragged straight out of the DMG do not, so
system notifications cannot be exercised by `pnpm electron:dev` on macOS. That
refusal is caught, latched, and reported in Settings, with the toast standing in
as the fallback.

One event carries a second opt-in of its own: an inbox capturing a request
(issue #1388). Every other kind is terminal and rare - a run ends once, an
update lands once - and a webhook source can deliver hundreds a minute, so a
capture notifies only when the global opt-in is on **and** that inbox's own
toggle is, which sits in the inbox's header rather than in Settings and is off
by default. The captures of one window are coalesced into a single notification
naming how many arrived, rather than posted one by one, and the window is a
property of what a notification is for rather than a setting the user tunes.
The stream that hears those captures is held app-wide, for every running inbox
whose toggle is on, rather than by the inbox tab: one tab's surface is mounted
at a time, so a view-owned stream was silenced by the click onto another tab
that ordinarily precedes leaving the window (issue #1400).

Because that answer only exists once something has been posted, Settings can ask
for one: the Preview beside the toggle posts a real notification over
`notify:test`, the single path that ignores both the focus check and the opt-in -
the user is looking at the panel when they press it, and previewing is how they
decide whether to turn the setting on. It waits for the OS rather than reporting
what was attempted, so a refusal turns the row unavailable there and then instead
of on the first run that ends.

**A run's progress is also mirrored onto the OS chrome**, over `runs:progress`
(`services/run-progress.ts` to `electron/run-progress.ts`), so a user in another
application can see how far along a test is without switching back. The renderer
says what the fraction is - it is the only side that holds a run's denominator -
and main says what each platform makes of it: a fill on the Windows taskbar
button, a bar on the macOS Dock icon, and nothing on Linux, where Electron 44
removed Unity launcher support. A run with no denominator (an open-ended load
test, or a collection run whose plan frame - the size the engine publishes on
its stream as the run opens, issue #1398 - never reached the client) shows
indeterminate on Windows and nothing on macOS; a failed run flashes the Windows
error state; the bar clears on every terminal path, and main clears it itself
when the renderer that asked for it is destroyed or reloads. One indicator is
all the OS gives an application, and one run is all the renderer watches: the
SSE client is a singleton, so starting a second run closes the first one's
stream - and tells its service so, which is what gives up the displaced run's
bar and its wake lock rather than leaving both standing (issue #1417). The
superseded run is not stopped and says nothing to the user: it is still running
in the engine, and its row reaches a terminal status on the next list read
rather than through a notification for a run nobody is watching. The indicator
follows the run being watched: a run claims it by id when
the renderer starts watching it, and a run that no longer holds that claim is
ignored whether it reports, fails or stops - including a run of the same kind as
the one that took over, and one whose last batched flush lands after it was
superseded, neither of which a claim by kind could tell apart from the live run.

**The icon itself carries what the window is not showing**, over `icon:signal`
(`services/os-icon.ts` to `electron/os-icon.ts`), on the same split as the bar
above: the renderer reports that a capture landed, that the Inbox is on screen,
that a run failed, and which collections the user has been in, and main decides
whether any of it is worth painting and what this platform can paint. Whether
turns on the window's focus, which is main's question for the reason `notify.ts`
gives - a capture the user watched arrive is not unread, and a run that failed
in front of them needs no mark. What each platform can show is the other half:
macOS takes a count on the Dock icon (`app.setBadgeCount`) and a single critical
bounce for a failure, Windows draws both onto the one taskbar overlay it gives
an application, and Linux gets neither, since Electron 44 removed Unity launcher
support. Windows having one overlay and two things to say through it is settled
in favour of the failure while it stands, with the count coming back underneath
it when focus takes the failure off. That focus does not clear the count: those
captures are still unread, and opening the Inbox is what says otherwise. The
overlay images are drawn rather than shipped (`electron/os-icon-overlay.ts`),
which is what lets a test read a count back instead of a person looking at a
taskbar.

**One of those cues does reach Linux, and it is the one that is conditional.**
A run reaching a terminal state the user did not ask for flashes the taskbar
button on Windows and Linux (`flashFrame`) and bounces the macOS Dock once
(`bounce("informational")`), and it does so **only when the system
notifications are off** - it is the quieter substitute for the toast the user
declined, not a second cue beside it. The condition is the renderer's, because
the opt-in lives in a store main cannot see, so nothing is sent at all when the
setting is on. macOS takes a bounce rather than a flash on purpose: there
`flashFrame` bounces until something turns it off, which is the weight a
*failed* run already gets from `bounce("critical")`, while the informational
bounce ends by itself and so is the one cue here that needs no clearing. The
flash is cleared by the window's focus, alongside the failed mark.

**The icon offers a way in as well as a state**, and everything arriving that
way is one kind of thing: an intent, over `intent:open`
(`electron/open-intent.ts`). Three doors lead to it. The macOS Dock menu and the
Windows Jump List both list New Request and the three most recently opened
collections, and a click on either is the same request - the Dock menu calls
into main directly, while a Jump List task is a shortcut to the executable and
arrives as a command line, on a cold start as `process.argv` and on a warm one
as `second-instance`. A document dropped on the icon is the third: macOS raises
`open-file`, the other two put the path on that same command line. Intents are
buffered until the renderer reports `did-finish-load`, because the earliest of
them arrives before there is a window at all, and a dropped document that
vanished into a cold start would look like the app ignoring the double-click.
Main carries the path and never reads the file; the renderer reads it back
through the gated `specFile:read` channel the import batch already uses, so
nothing here becomes a second door onto the file system, and the document lands
in the Import dialog's ledger exactly as a picked file does.

See [Engine API Reference](engine/api-reference.md) for complete endpoint documentation.

## Sidecar Pattern

The Engine runs as a separate process managed by the Electron main process:

1. **Engine Startup**: Electron spawns the `vayu-engine` binary on app launch,
   alongside creating the window rather than before it - first paint does not
   wait on the engine
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
- **Local services are window-scoped, and the close says so.** Everything the
  Services drawer starts - webhook inboxes, mock servers, mock issuers - runs
  inside the engine, so quitting stops all of it. On Windows and Linux closing
  the last window quits; on macOS it hides the window and the app keeps serving
  until Quit. Neither one takes a listening service silently: a close or quit
  that would stop something names it - "Close Vayu and stop the 2 services it is
  running?", with the inbox's port and the mock server's collection - and Cancel
  leaves everything up. macOS's window-close asks nothing, having stopped
  nothing. The one quit that never asks is a signal: `install.sh` replaces a
  running AppImage that way, and a dialog would hold the upgrade open waiting for
  an answer nobody is there to give (issue #1363).
- **A taken port is a loud failure, not a silent one.** The engine binds 9876
  before it serves, so anything already holding the port makes it print
  `Could not bind 127.0.0.1:9876 - ...` to stderr and exit **1** rather than
  report itself listening. It never falls back to another port: the app and CLI
  both address the engine at a fixed one, so an engine on a different port would
  be a quieter failure than no engine at all.
- **A startup that cannot succeed fails immediately; one that is merely slow
  does not.** The readiness poll spends a 45-second budget watching the spawned
  child as well as the port: an engine that exits first - a missing shared
  library, a lock it could not acquire - fails the launch at once, naming the
  exit code or signal and the engine's last stderr lines. An engine still alive
  when that budget runs out is not killed for it: the launch path logs
  `EngineNotReadyError` and leaves it to the renderer's health poll, which
  adopts it the moment it answers. Quitting there used to end launches that
  were seconds from succeeding.
- **The window is created alongside the engine, not after it.** First paint must
  not wait on a process whose own startup housekeeping is allowed to run for 45
  seconds - `db.init()` does orphan reconciliation, inbox cleanup and a
  page-reclaim rewrite before the engine listens at all, and that whole window
  used to be blank screen. Nothing is lost by overlapping them: the renderer
  tolerates an absent engine by design, polling `/health` itself and rendering
  the starting state until one answers. MCP still starts after the window,
  for its own reason - it reads a config file, and a corrupt one must not cost
  the user a window.
- **MCP is *loaded* after the window too, not merely started there.** Placing the
  start call late does nothing about the import: the main process is unbundled,
  so Node's ESM loader walks `main.ts`'s static import graph and evaluates every
  module in it before `app.whenReady` fires at all. Reaching through the
  `mcp/index.js` barrel for anything therefore evaluated the MCP SDK, zod and a
  7,300-line tool registry - ~250-300 ms ahead of the window on every launch,
  including the ones where MCP is switched off, since the barrel also carried the
  preference that decides. `main.ts` now imports the three self-contained modules
  it needs at startup (`mcp/config`, `mcp/store`, `mcp/connect`) and pulls the
  barrel through a cached dynamic `import()` inside `startMcp()`, behind the
  enabled check. `startup-import-graph.test.ts` holds the graph to that.

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
stream, an OAuth token fetch, a spec import by URL, a monitor scrape, a script's
own `pm.sendRequest` - leaves through one transport policy, resolved from
Settings > Network & connectivity at the point of use and applied by a single
function (`detail::apply_transport_policy`). There is one hop between the engine and the
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
- **No spellchecker**: every window the app opens - the shell and the OAuth
  sign-in window - is created with `spellcheck: false`, so Chromium checks
  nothing the user types and never fetches Hunspell dictionaries, which it
  otherwise downloads from a Google CDN at first use on Windows and Linux.
  Monaco's editors are unaffected either way; they own their own text area.
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
- **Data Directory** (`app.getPath("userData")`, named after `app/package.json`'s
  `name` rather than the product name):
  - macOS: `~/Library/Application Support/vayu-client/`
  - Windows: `%APPDATA%/vayu-client/`
  - Linux: `~/.config/vayu-client/`

---

*See: [Engine Architecture](engine/architecture.md) | [App Architecture](app/architecture.md) | [Engine API Reference](engine/api-reference.md)*
