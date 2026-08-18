---
description: >-
  Vayu's built-in MCP server: the tools, resources and prompts it exposes to coding agents, how to register it, and the safety gates.
---

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
| `list_runs`            | read     | `GET /runs?limit=&offset=&type=&status=&requestId=&collectionId=&q=&baseline=` | Page of the `{data, pagination}` envelope, newest first; 100 rows by default, 500 max (refused above, not clamped); rows carry a compact summary |
| `get_run_report`       | read     | `GET /runs/:id/report`                       | Stored trace bodies capped at 32 KB per node, and 96 KB across the report |
| `get_run_samples`      | read     | `GET /runs/:id/samples?limit=&offset=`       | 25 samples per call by default, 500 max |
| `get_run_timeseries`   | read     | `GET /runs/:id/metrics?limit=&offset=`       | 100 ticks per call by default, 1000 max - the engine's own cap is 50000 |
| `get_run_monitor`      | read     | `GET /runs/:id/monitor?limit=&offset=`       | Same bounds as `get_run_timeseries`     |
| `get_engine_config`    | read     | `GET /config`                                | -                          |
| `get_live_metrics`     | read     | SSE snapshot of last N ticks                 | `limit` must be a whole number ≥ 1 |
| `compare_runs`         | read     | 2× `GET /runs/:id/report` → diff (structured)| `baseRunId` optional - omitted, it resolves the target's pinned baseline |
| `run_request`          | execute  | `POST /compose` + `POST /execute` (+ `GET /runs/:id/events` when streaming) | allowlist; response body capped at 32 KB |
| `run_collection_smoke` | execute  | `GET /requests?…` + `POST /compose` + `POST /execute` (×N) | allowlist per host |
| `run_collection`       | execute  | `GET /requests?…` (+ `GET /collections` when recursive) + `POST /compose` (×N) + `POST /runs` | allowlist on **every** step - one step off it refuses the whole run |
| `create_collection`    | write    | `POST /collections`                          | write toggle; takes `variables`, `auth` and both collection scripts |
| `update_collection`    | write    | `GET /collections` (scan, only when variables change) + `PUT /collections/:id` (merge-patch) | write toggle; `variables` merges like `update_environment`'s, `removeVariables` deletes names |
| `delete_collection`    | write    | `GET /collections` + `GET /requests?…` (×N) + `DELETE /collections/:id` | write toggle + confirm |
| `create_request`       | write    | `POST /requests`                             | write toggle; takes the builder's whole surface - auth, `followRedirects` / `maxRedirects` / `httpVersion` / `stream`, both scripts - minus file body parts |
| `update_request`       | write    | `PUT /requests/:id` (merge-patch)            | write toggle; same fields, and only the ones named are written |
| `delete_request`       | write    | `GET /requests/:id` + `DELETE /requests/:id` | write toggle + confirm     |
| `list_request_examples`| read     | `GET /requests/:id/examples`                 | - (bodies capped at 32 KB each, 96 KB across the list) |
| `create_request_example`| write   | `POST /requests/:id/examples`                | write toggle; always stored as `origin: "user"` - an agent cannot claim an import |
| `update_request_example`| write   | `PUT /requests/:id/examples/:exampleId` (merge-patch) | write toggle; `origin` is not writable |
| `delete_request_example`| write   | `GET /requests/:id/examples` + `DELETE /requests/:id/examples/:exampleId` | write toggle + confirm (the prompt names the example and the mock consequence) |
| `move_item`            | write    | `GET /collections` or `GET /requests?…` + `POST /reorder` | write toggle; `first` / `last` only, and a collection into its own subtree is refused before the engine sees it |
| `create_environment`   | write    | `POST /environments`                         | write toggle (the engine assigns the id; created inactive) |
| `update_environment`   | write    | `GET /environments` (scan) + `PUT /environments/:id` (fetch-merge) | write toggle; `variables` takes a string or `{value, secret, type, enabled}`, `removeVariables` deletes names |
| `activate_environment` | write    | `PUT /environments/:id` (`isActive`), + `GET /environments` for `"none"` | write toggle; one PUT - the engine deactivates the previous row in the same transaction |
| `delete_environment`   | write    | `GET /environments` (scan) + `DELETE /environments/:id` | write toggle + confirm (the prompt names the variable count) |
| `get_globals`          | read     | `GET /globals`                               | - (answers an empty set, never a 404) |
| `update_globals`       | write    | `GET /globals` + `POST /globals` (fetch-merge) | write toggle; `POST` replaces the blob, so the read is what makes it a merge |
| `get_cookies`          | read     | `GET /cookies`                               | - (values included, as the Settings card shows them) |
| `clear_cookies`        | write    | `DELETE /cookies[?environmentId=]`           | write toggle; omitted clears every jar, `null` the no-environment jar, an id that environment's |
| `set_run_baseline`     | write    | `PUT /runs/:id/baseline`                     | write toggle               |
| `delete_run`           | write    | `GET /runs/:id` + `DELETE /runs/:id`         | write toggle + confirm     |
| `update_engine_config` | write    | `POST /config`                               | write toggle               |
| `start_load_run`       | load     | `POST /compose` + `POST /runs`, or (with `scenario`) `GET /requests?…` + `POST /compose` (×N) + `POST /runs` | allowlist + caps + confirm; optional `thresholds` budgets and `monitor` server-vitals block; `mode` accepts `constant_rps` \| `constant_concurrency` \| `ramp_up` \| `iterations` \| `capacity`, narrowed to the middle three for a scenario; the recording knobs and `comment` below apply to both shapes, the redirect policy to a single target only |
| `stop_run`             | load     | `POST /runs/:id/stop`                        | -                          |
| `fetch_oauth2_token`   | execute  | `POST /oauth2/token`                         | allowlist, on `accessTokenUrl` **and** `refreshTokenUrl`; `authorization_code` refused before the call; the access token is never returned |
| `get_oauth2_token_status` | read  | `GET /oauth2/token?key=`                     | - (an absent entry is `found: false`, not a 404); the access token is never returned |
| `clear_oauth2_token`   | write    | `DELETE /oauth2/token?key=`                  | write toggle; idempotent - `deleted: false` when nothing was cached |
| `start_mock_issuer`    | execute  | `POST /mock-issuer/start`                    | - (loopback-only listener, so no allowlist entry applies); limits are the engine's - 31-day expiry, 60s `slowMs`, 32 clients, 8 concurrent issuers |
| `list_mock_issuers`    | read     | `GET /mock-issuer`                           | -                          |
| `stop_mock_issuer`     | execute  | `POST /mock-issuer/:id/stop`                 | - (unknown id is a `404`, surfaced as a tool error) |
| `update_mock_issuer`   | execute  | `PUT /mock-issuer/:id` (merge-patch)         | - (live edit of `failureMode` / `slowMs`; an empty patch is refused before the engine sees it) |
| `start_mock_server`    | execute  | `POST /mock/start`                           | - (loopback-only listener, so no allowlist entry applies); the `latencyMs` ceiling is the engine's |
| `list_mock_servers`    | read     | `GET /mock`                                  | - (running mocks only - a stopped one has no record) |
| `get_mock_routes`      | read     | `GET /mock/:id/routes`                       | - (a start-time snapshot, constant under a running mock) |
| `stop_mock_server`     | execute  | `POST /mock/:id/stop`                        | - (unknown id is a `404`, surfaced as a tool error) |
| `start_webhook_inbox`  | execute  | `POST /inbox/start`                          | - (loopback-only listener; `bind` / `confirmNonLoopback` are never sent) |
| `list_webhook_inboxes` | read     | `GET /inbox`                                 | -                          |
| `stop_webhook_inbox`   | execute  | `POST /inbox/:id/stop`                       | - (frees the port, keeps the record and its captures) |
| `delete_webhook_inbox` | write    | `GET /inbox` + `DELETE /inbox/:id`           | write toggle + confirm (the prompt names the capture count) |
| `get_inbox_captures`   | read     | `GET /inbox/:id/requests?limit=&offset=`     | 25 captures per call by default, 100 max; each body capped at 32 KB |
| `clear_inbox_captures` | write    | `DELETE /inbox/:id/requests`                 | write toggle               |
| `update_inbox_response`| execute  | `PUT /inbox/:id` (merge-patch)               | - (live edit of the canned reply) |

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
- **What a load run *keeps* is settable too** (issue #760), which is what the
  MCP surface was missing rather than any part of the load shape:
  `successSamplePeriod` (the engine's `success_sample_rate` - a **period**, keep
  1 in N, not a percentage; the argument is named for what the value means and
  the payload key stays the engine's), `slowRequestThresholdMs`,
  `saveTimingBreakdown` and `comment`. All four reach a **scenario** run too:
  both executors read them off the one `RunContext`, and `comment` is lifted
  into the run summary and the report's `metadata.configuration` whichever
  produced the run. Bounds mirror `validate_run_config`, so a value the schema
  accepts is one `POST /runs` accepts, and an absent knob stays absent - each has
  an engine default a stated value would overwrite.
  The **redirect policy** (`followRedirects` / `maxRedirects`) belongs to the
  request half instead: it rides through `POST /compose` beside the method and
  the body, overriding a saved request's stored policy or supplying the only one
  an ad-hoc target has. A scenario run refuses both by name, as it does every
  other single-target field - each step keeps the policy stored on it.
  `maxRedirects` is bounded 0-100 here because `POST /runs` has no guard of its
  own and the value reaches `CURLOPT_MAXREDIRS`, where a negative means
  *unlimited*.
  **There is no per-run timeout, and that is not an omission**: the engine has
  no such field - every transfer is bounded by the `defaultTimeout` setting
  (`resolve_request_timeout_ms`), which `update_engine_config` changes. Recorded
  here so it is not re-derived as a gap each time the schema is read.
- **`get_run_report` carries contract coverage** for a run of a collection bound
  to an OpenAPI document (issue #629): which of the contract's operations the run
  exercised, which of their declared responses it saw, and any statuses the
  document never declared, under `coverage`. Passed through verbatim - the tool
  adds nothing. Absent, never zeros, for a run that was not measured against a
  contract, so an agent must branch on the key's presence rather than reading a
  zero as full non-coverage.
- **Bodies are bounded before they reach an agent** (issue #767). `run_request`
  and `get_run_report` were raw passthroughs, and neither engine cap covers this
  case: `maxResponseBodyBytes` bounds load runs only ("Design-mode sends are not
  affected") and `maxTraceBodyBytes` is 5 MB, sized for the database and a human
  reading one full trace. So a single ordinary page fetch answered with 1.3 M
  characters and blew the tool-result token limit outright. Both tools now cap a
  body at **32 KB** - `maxSampleBodyBytes`, the engine's own answer to how much
  of a body an automated reader gets, rather than a new number. What a cut looks
  like, in the engine's existing vocabulary (`cap_node_body`,
  `run_samples_response`): `bodyTruncated: true` beside the full size, in
  `bodySize` on a `run_request` response and `bodyBytes` on a stored trace node,
  and `rawRequestTruncated` / `rawRequestBytes` for a cut wire message - whose
  headers are always kept whole, since the `Cookie` line libcurl attached
  appears nowhere else. A cut `bodyRaw` comes back with its parsed `body` as
  `null`, because the two carry the same payload and an intact `body` would
  return in full exactly what was just dropped. A trace the engine had already
  truncated keeps the original size the engine recorded. Under the bound,
  nothing is added and nothing is changed. Load-run reports are unaffected: a
  load run's results never go through `build_result_trace`, so they carry no
  trace node at all, and its captured bodies live behind
  `GET /runs/:id/samples`, which has always truncated and disclosed this way.
- **The traces are bounded as a set, not only one at a time** (issue #769).
  Capping each node does not cap the report: `/runs/:id/report` returns up to
  100 rows and each may keep 32 KB on each of three nodes, so a 100-step
  scenario measured **3.3 M characters** with every node honestly flagged as
  truncated - 2.5x the size that failed in #767. At that row count truncation is
  no longer the binding constraint: 100 steps of an 8 KB body, under the
  per-node cap and so never touched, still totalled 845 K. So `get_run_report`
  also holds the traces to **96 KB in total** - `MAX_INLINE_BODY_BYTES * 3`, the
  largest single row the per-node bound can produce, rather than a new number
  beside it. Rows past the budget keep every scalar (id, status, latency, step
  identity) and carry `traceOmitted: true` in place of their trace, with
  `tracesOmitted` and `traceBudgetBytes` on the report. **Non-passing steps
  spend the budget first**, matching `ScenarioStepStore::add`'s own rule for
  `stepsStored`, so the two do not disagree about which steps matter - and the
  rows come back in run order regardless, since the budget decides what a row
  carries, never where it sits. The first trace is always embedded whatever it
  costs, so a design run's single-row report never comes back empty. The rows
  themselves are not capped further: at ~200 bytes of scalars each they are
  noise beside one body, and the run's shape is the answer even when the
  payloads cannot come along. Bounded sizes for the fixtures above: 33 K
  characters for the single 1 MB row, 76 K for 100 steps x 1 MB, 120 K for
  200 rows with all three nodes populated (24.7 M unbounded).
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
- **Run housekeeping** (issue #755) is the History surface an agent could
  otherwise only page through: `list_runs` takes the engine's own filters
  (`type`, `status`, `requestId`, `collectionId`, `q` over the stored config,
  `baseline`) plus `limit`/`offset`, so finding one run is a query rather than a
  scan of 100-row blobs. Order is fixed newest-first - `GET /runs` takes no sort
  parameter, and the app's oldest-first view sorts client-side. `collectionId`
  matches a **collection run** only, since a design or load run stores none. The
  filters are Zod enums rather than passthrough strings because the engine
  *ignores* a `type` or `status` it cannot parse: forwarded raw, a typo would
  answer the unfiltered page and read as "nothing matched anywhere".
  `set_run_baseline` writes the pin `compare_runs` already resolved but nothing
  could set (the write half #472 never shipped), and `delete_run` deletes a run
  and everything recorded against it behind the same write toggle + confirmation
  `delete_request` uses. A run still executing is stopped engine-side and
  deleted only once its worker settles; a worker that does not settle in time is
  a **409 with the run intact**, surfaced as "not deleted, retry once it reports
  a terminal status" rather than as a generic engine error.
- **The stored-series reads are bounded on this side of the boundary.**
  `get_run_samples`, `get_run_timeseries` and `get_run_monitor` default to 25 /
  100 / 100 rows against engine defaults of 50 / 5000 / 5000: those defaults are
  sized for the dashboard's charts, which draw every point for a human, and an
  agent reads the same rows as JSON through a context window. The ceilings are
  500 (the engine's own page cap, shared with `GET /runs`) and 1000 for the two
  series, well under the engine's 50000. A `limit` past a ceiling is **refused,
  not clamped** - the #319 precedent - because a short page silently substituted
  for the one asked for reads as the whole answer. A page with more behind it
  says so in words beside the JSON, with the `offset` to read next.
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
  request sends). `update_collection` carries a collection's own state - name,
  description, variables, auth, both scripts - and never its position:
  re-parenting is `move_item`'s job (below), because `POST /reorder` is the only
  write path that is atomic against a concurrent one.
- **`delete_collection` cascades**, so it reads the subtree first: `GET
  /collections` gives it every descendant through `parentId`, one `GET
  /requests?collectionId=` per collection in that subtree gives the request
  count, and those counts are what the confirmation states. An unreadable
  subtree - or an id no collection has - is a refusal, never a prompt carrying
  a number nobody verified. `delete_request` reads the row the same way, so the
  prompt names the request and its URL rather than an opaque id.
- **A saved request an agent writes is the one the builder writes** (issue
  #759). `create_request` / `update_request` carry the request's `auth` block and
  the four **Settings** tab fields (`followRedirects`, `maxRedirects`,
  `httpVersion`, `stream`) as well as its url, headers, body and both scripts, so
  an agent that can send an authenticated request can now save one. The `auth`
  input is the *same schema* `run_request` takes rather than a copy of it - one
  definition, four descriptions - which is what lets an agent read a request's
  `auth` over `list_requests` and write it back verbatim. Both the auth block and
  each setting follow the merge-patch rule the strings already did: named is
  written, absent is left alone, so an update that mentions only `maxRedirects`
  cannot hand a stored `followRedirects: false` back to the engine's default. The
  two exclusions are deliberate: **file body parts**, which name a path on the
  user's machine an agent cannot choose for them, and **`verifySSL`** (issue
  #706), which belongs to the transport epic's own CRUD pass - see #795.
- **Examples are writable, and where one came from is not** (issue #759).
  `list_request_examples` reads what a request has saved beside it - what a mock
  server for its collection answers with - and the three write tools author it,
  so an agent that can start a mock (`start_mock_server`) can now author what it
  serves. The `origin` column is the one field no tool accepts: it says whether a
  row came from an importer (`import`) or from a person (`user`), and an OpenAPI
  sync replaces the first kind while leaving the second alone (#588, #655). An
  agent that could claim `import` would hand its own example to the next sync to
  overwrite, and one that could claim `user` could pin a stale imported row
  against the document it came from - neither is the agent's call, so
  `create_request_example` always stores `user` and the update tool cannot
  restate it. Bodies are bounded on the way out for the reason
  `get_run_report`'s traces are (#767, #769): an example body is capped
  engine-side at 1 MB and a request may hold 100 of them. One over 32 KB comes
  back cut, flagged `bodyClipped` with its stored size in `bodyBytes`; once the
  list has spent 96 KB the remaining bodies are dropped with `bodyOmitted` and
  counted in `bodiesOmitted`, every row's scalars kept. `bodyClipped` is not the
  engine's `bodyTruncated`, which says the response was already cut when it was
  *captured* - two different facts, so two different names.
- **Collection-level state is writable, and merges the way an environment's
  does** (issue #759). `create_collection` / `update_collection` take the
  `variables`, `auth` and pre/post-request scripts that shape every request
  below them - the same three the composer walks (`compose_script_parts` runs the
  chain's scripts before the request's own). `variables` uses
  `update_environment`'s input and its rules unchanged, including
  `removeVariables` and the "a new variable carries a value" refusal, because it
  is the same blob shape and a second dialect would be a second thing to learn.
  The read that makes it a merge is only done when variables are actually
  changing: a rename sends one `PUT` and nothing else. A collection is the root
  of an auth chain and never inherits, which the engine enforces - `{mode:
  "none"}` is how a collection stops being an auth source.
- **`move_item` is a bounded move, not a reorder** (issue #759). It maps to
  `POST /reorder`, whose batch validates and commits under one acquisition of the
  engine's DB mutex (#386) - which is why re-parenting goes here rather than
  through `PUT /collections/:id`'s own `parentId`, where two concurrent moves can
  each pass an acyclicity check neither one's commit was visible to. What the
  tool offers is the row menu's "Move to...": a destination, and `first` or
  `last` among its new siblings. Positions in between stay a UI gesture on
  purpose - naming one means reproducing the app's ordering arithmetic
  (`modules/collections/reorder-math.ts`) from outside it, and getting it wrong
  is a folder that visibly reshuffles. The batch states the destination block's
  whole arrangement rather than leaning on the engine's `normalize` pass, because
  normalization runs *before* the moves and would leave a row moved to the end of
  a block it is already in tied with the sibling it displaced; only the rows whose
  stored `order` actually changes get an entry. A collection may move to the top
  level (`parentId: null`) and a request always belongs to a collection. Moving a
  collection into itself or into its own subtree is refused here, walking the
  same tree the app's "Move to..." dialog walks, so the answer names the problem -
  the engine refuses the same batch under its lock, and that check stays the
  authority.
- **`update_environment`** fetches the environment and merges the supplied
  variables (`PUT /environments/:id` replaces the whole variables blob), so
  partial updates preserve untouched variables and the name. Overwriting an
  existing variable changes its value only - its `secret`, `type`, `createdAt`
  and enabled/disabled state are preserved, so a rotated secret stays masked and
  a disabled variable stays disabled. It is a `PUT`, not
  a `POST`: since #95 the engine's `POST /environments` is create-only, and since
  #97 it rejects a body carrying an `id` outright. `create_request` and
  `create_environment` stay `POST`s for the same reason - they create, and let
  the engine assign the id. No tool here sends an `id` in a body: on the `PUT`
  the path is the identity, a body `id` disagreeing with it is a `400`, and on
  the `POST` any `id` at all is one.
- **The variables an agent writes are the flags it did not state** (issue #758).
  `update_environment` and `update_globals` take each variable either as a
  string - set the value, keep every flag - or as an object
  `{value, secret, type, enabled}` whose *omitted* fields keep their stored
  setting, which is what makes `secret` and `enabled` reachable at all without
  a read-modify-write dance on the agent's side. Two rules make that safe rather
  than merely convenient: a variable the blob does not already hold (or holds
  malformed) must carry a `value`, so `{secret: true}` against a mistyped name
  is an error instead of a new empty secret variable; and a name in both
  `variables` and `removeVariables` is refused, because "set it and delete it"
  has no correct order and guessing one would apply half the call and report
  success. `removeVariables` is the delete a blank value cannot express - `""`
  leaves the name resolving to an empty string - and a name that was not there
  comes back as a note on the result rather than an error, so a retried call
  does not fail on its own success. `secret` is app-side masking only: MCP reads
  (`list_environments`, `vayu://environments`) still return every value in full,
  which is a recorded pre-1.0 security item, not something these tools changed.
- **Activation is one write, and `"none"` is the other direction.**
  `activate_environment` sends `isActive: true` and nothing else: the DB layer
  clears the previously active row in the same transaction
  (`deactivate_other_environments_locked`), so a companion deactivate would be a
  second definition of the same rule. There is no "no environment" row to write
  `true` to, so `"none"` reads the list to find the row holding the flag and
  writes `isActive: false` to it - and when nothing is active it writes nothing,
  says so, and emits no data-changed event. The app follows either direction:
  `useActiveEnvironmentRestore` adopts whatever the engine reports, including a
  clear it has seen the engine hold a selection before.
- **`update_globals` has to read first.** Globals is the one resource with no
  create/update split - one row, one id - so `POST /globals` saves the blob
  whole and an absent `variables` means `{}`, not "keep". The tool reads
  `GET /globals` and posts the merged result, which is the same read-merge-write
  `update_environment` does for the same blob-replacement reason.
- **`clear_cookies` has three scopes, not two.** Omitting `environmentId`
  clears every jar, passing an id clears that environment's, and passing `null`
  clears the jar used when no environment is selected - the engine reads an
  absent query parameter and a present-but-empty one differently, so omitting
  and passing null are genuinely different calls (the renderer's
  `apiService.clearCookies` sends the same three). No confirmation gate: nothing
  saved is lost, only session state a re-login restores - which is why it is a
  `write` tool for the toggle and not one of the confirm-gated deletes.
- **`run_collection_smoke`** runs each saved request once and returns a structured
  pass/fail matrix (2xx–3xx status + all tests passing = pass). Each request is
  composed exactly as the app's **Send** would (see *Request composition* below).
  A request whose scripts asserted anything carries a `tests` node - `total`,
  `failed`, and the failing `name: message` lines (issue #733) - so a row that
  fails on its tests says which, rather than leaving an agent with `ok: false`
  beside a `200`. The list is cut at ten, the number the engine caps a schema
  verdict's failures at, while `failed` stays the true count. A response that
  ran no assertions carries no `tests` node: none ran is not all passed.
  For a collection **bound to an OpenAPI document** each row also carries a
  `schema` verdict (issue #681) and folds it into `ok` the way `testResults`
  folds: a response the document declares a schema for and that does not match
  it fails the request, with the failing JSON Pointers listed so an agent need
  not re-run to learn where. `failOnSchemaError: false` unfolds it (issue #720):
  the verdict still rides every row, it just stops deciding `ok` - useful
  against a document known to lag its API. It defaults to **true** here, where
  the same-named flag on `POST /runs` defaults to false, because this tool has
  folded since #681 and an agent reading its matrix would otherwise start seeing
  contract failures pass. `run_collection` offers the same flag with the
  engine's default (issue #766, *Scenario runs* below); one schema fragment
  words both, so the two can differ only in the unit they judge and the way they
  default. Only a *checked* verdict can fail a row -
  `checked: false` (no declared schema for the status or content type, a body
  that is not JSON) is reported and never counted against the run, and a
  collection bound to nothing carries no `schema` field at all.
  Requests whose host still can't be verified after resolution (e.g. a variable
  did not resolve and allow-all is off) are skipped, not sent.
  It **does not recurse**: `GET /requests?collectionId=` serves a collection's
  direct requests, while collections nest via `parentId`, so a run on a parent
  folder tests none of its descendants. The result appends a note naming the
  sub-collections it left out (and says so explicitly if the collection list
  could not be read), because a matrix whose `total` silently excludes nested
  folders reads as a whole-collection pass. Requests run serially, so a large
  collection takes as long as its requests do added together.
- **The OAuth 2.0 token tools** (issue #760) are how an agent gets a token
  problem named instead of discovering it as a wall of 401s inside a run:
  `fetch_oauth2_token` acquires (or force-refreshes) a token for a config and
  caches it engine-side, `get_oauth2_token_status` says whether an entry exists
  and whether it has expired, and `clear_oauth2_token` drops one. The config is
  the same block a saved request's `auth` carries, so it can be copied out of
  `list_requests` verbatim; the **cache key is the engine's**
  (`accessTokenUrl` + `clientId` + `credentialsId` + username), so configs
  differing only in scope share an entry and a distinct `credentialsId` is what
  separates them.
  Two rules here are security decisions rather than plumbing, and both are
  stated in the tool descriptions so an agent reads them before it reads a
  refusal. **No tool returns access-token bytes.** The engine is what applies a
  token to a request, so the bytes buy an agent nothing it can use through Vayu,
  while handing them over would turn a credential the *user* acquired into
  something an agent can carry off the machine; what comes back is the entry's
  shape - key, type, scope, expiry, whether a refresh token came with it - plus
  an explicit `accessTokenWithheld`, because an agent that finds no token and is
  not told why concludes the acquisition half-failed. And **the
  `authorization_code` grant is refused before the engine is called**, not
  merely because the browser exchange is one MCP cannot drive: `acquire_token`
  answers a cache hit *before* it looks at the grant, so a call naming a config
  that happened to match an entry the user authorized interactively would
  otherwise reach into it. The refusal names the app's Auth tab as the place to
  authorize, and the entry that lands there is the one these tools then read.
  The allowlist gate covers `refreshTokenUrl` as well as `accessTokenUrl` - a
  gate that read one of two URLs is a gate a config can walk around.
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
  expire, since nothing verifies them against a live issuer. **A running issuer
  is edited, not recreated**: `update_mock_issuer` merge-patches `failureMode`
  and `slowMs` live (issue #757), so an agent can mint a token against a healthy
  issuer, flip it to `server_error` to watch the client retry, and flip it back
  without the token URL under test moving or the signing key changing. Those two
  are the only settings a bound listener will take - the engine refuses `port`,
  `clients`, `claims` and `issueRefreshTokens` with "stop it and start a new
  one", so the tool does not offer them at all rather than offering a call that
  always fails. `expiresInSeconds` is mutable engine-side and is also left out:
  a token's lifetime is fixed when it is minted, so changing it says nothing
  about the tokens an agent already holds. An empty patch is refused here rather
  than forwarded, because the engine accepts one and answers `200` - which would
  report a change that did not happen (the `update_inbox_response` precedent).
- **The mock-server tools** are how an agent stands up the API a client under
  test expects, out of the collection's own saved examples (issue #757, over the
  engine's [mock server](api-reference.md#mock-server) from #481):
  `start_mock_server` binds a listener that answers each request's example -
  status, headers, body - and returns its `mockId` and base URL,
  `get_mock_routes` lists what it will serve, and `stop_mock_server` frees the
  port. `latencyMs` and `errorRatePct` are how a client's timeout and retry
  handling get exercised; `0` and `100` percent are exact by construction, in
  between it is a per-request roll. **A started mock is not necessarily a usable
  one**, which is why the result carries a caveat rather than leaving the counts
  in the JSON: a route whose request has no saved example answers `501`, a path
  matching nothing answers `404`, and a collection with no mappable requests
  serves nothing at all. **Loopback-only** for the same engine-side reason as an
  issuer - `mock_server.cpp` starts every listener on `127.0.0.1` with no host
  to configure - so no allowlist entry is needed or checked. **A stop is a
  delete here**, unlike an inbox: a mock records nothing, so its record dies
  with its listener and it simply leaves `list_mock_servers`. The route table is
  a snapshot taken at start and cannot change under a running mock (editing the
  collection means restarting), which is why the renderer holds it at
  `staleTime: Infinity` and a `stop_mock_server` event carries the `mockId` so
  that cache entry is *dropped* rather than refetched into a `404`.
- **The webhook-inbox tools** are the assertion half an agent testing a webhook
  needs (issue #756): `start_webhook_inbox` stands up a
  [local inbox](api-reference.md#webhook-inbox) and returns its URL,
  `get_inbox_captures` reads back what arrived - method, path, query, headers,
  body, caller address - and `update_inbox_response` changes what the sender
  sees, live, so one inbox can answer `200` for the first trigger and `503` for
  the next. **Loopback-only, and not by policy alone**: the engine's
  `bind` / `confirmNonLoopback` pair is never emitted by
  `inboxStartPayload`, whatever arguments a call carries, so an inbox MCP
  started cannot be reached off this machine - a stated non-goal of epic #753,
  guarded in the one function that builds the body and mutation-checked in
  `tools.test.ts`. **A stop is not a delete**: `stop_webhook_inbox` frees the
  port and leaves every capture readable, while `delete_webhook_inbox` destroys
  them and therefore takes the write toggle *and* a confirmation whose prompt
  names how many captures go with it (read from `GET /inbox` first, the way
  `delete_run` reads the run). `clear_inbox_captures` is the middle case -
  recorded data destroyed, listener kept - so it takes the toggle without the
  confirmation. **No live stream**: `GET /inbox/:id/live` is single-watcher
  (a second is a `409`) and the app's own inbox tab may hold it, so MCP polls
  `get_inbox_captures` instead - the same bounded-snapshot posture
  `get_live_metrics` takes. Capture bodies are cut to 32 KB for the result with
  the engine's own `bodyTruncated` / `bodyBytes` disclosure kept intact, since
  `inboxMaxBodyBytes` reaches 8 MB and a webhook payload is whatever the sender
  sent.
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
  `form-data` `Content-Type` libcurl writes itself and minus any header whose
  value is empty, which libcurl reads as a removal rather than sending - and
  `rawRequest` is the
  full wire frame including the `Cookie` line and libcurl's own `Accept` /
  `Content-Length`. Both are passed through verbatim; read them rather than the
  request the call sent. A `postRequestScript` reads the same set as
  `pm.request.headers` (see
  [scripting.md](scripting.md#request-object-pmrequest)).
- **Transport fields** - `httpVersion` rides the inline overlay for both tools,
  and `start_load_run` adds `followRedirects` / `maxRedirects` (issue #760).
  They belong here rather than beside the load shape because they describe the
  *request*: `POST /compose` emits all three on a stored request under the
  never-elided rule, so an agent's value has to be laid over the composed
  payload the same way a URL override is. A URL-only run has no stored row
  behind it, which makes this the only way its redirect policy gets stated at
  all. `verifySSL` is the one transport field neither tool writes yet -
  [#795](https://github.com/athrvk/vayu/issues/795).
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
  `run_collection_smoke` stays out of it: it runs each request on its own, with
  no sequence to iterate, so there is no row for it to bind. A whole *data set*
  - many rows, one pass each - is the scenario tools' argument instead
  (`run_collection` and `start_load_run`'s `scenario.data`, below).
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
  picks the scripts up without a further entity. A collection's own scripts -
  the ones that run around *every* request below it - are
  `create_collection` / `update_collection`'s fields of the same two names
  (issue #759), and carry the same clearing rule.
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
- **Scenario runs - a collection as the unit of work** (issue #754, reversing
  #454's deferral). A collection's ordered sequence of requests can be run from
  MCP in both of the engine's modes, over the one `POST /runs` route that takes
  a `scenario` block:
  - `run_collection` posts the block with **no** `mode`, which is what selects
    the design-mode runner: steps execute one at a time, share the environment's
    cookie jar, honour `pm.execution` flow control, run their stored
    **pre-request** scripts, and repeat once per `data` row with
    `{{data.column}}` bound and `pm.iterationData` set. It returns the run id
    immediately - the run continues engine-side - along with the plan's step
    count and the note that `get_run_report`'s `results` carries **at most 100**
    step rows. Each of those rows carries that step's request and response
    bodies inline, under `trace` (`build_result_trace`, the same node a
    single design-mode send stores) - not behind `GET /runs/:id/samples`, which
    is the load-run capture route - so a long plan against large responses
    makes for a large report. That is what the 96 KB total trace budget above
    bounds: past it a step row keeps its scalars and carries `traceOmitted`
    instead of its bodies, non-passing steps last to lose them.
  - `start_load_run` takes the same block as an optional `scenario` argument
    and posts it **with** a mode, which hands the plan to the load executor:
    `concurrency` is the number of virtual users, each walking the whole plan
    with its own cookies. Only `constant_concurrency` (the default), `ramp_up`
    and `iterations` can drive a sequence - `capacity` and `constant_rps` are
    refused with the engine's own reasoning (a knee measured against which
    step's p99? an arrival-rate executor Vayu does not implement), as is any
    non-zero `targetRps`, which selects that path whatever the declared mode.
  - The collection tree **is** the sequence: there is no step list to send, and
    `recursive: true` walks sub-collections in the sidebar's order (each
    subtree before that level's own requests, mirroring `collect_requests`).
  - **Rows are inline** - the engine never opens a file - and its
    `maxScenarioDataRows` / `maxScenarioDataBytes` refusals are surfaced
    verbatim rather than re-derived in the schema.
  - `scenario.iterations` is offered on `run_collection` only. A load run reads
    the **top-level** `iterations` (total passes across all virtual users); the
    in-block count is the design runner's and the load executor never reads it,
    so offering it there would be an argument written and never read.
  - **`failOnSchemaError` makes the bound contract a gate** (issue #766), on
    `run_collection` only, matching the Run Collection dialog's checkbox. It is
    **run-scoped and top-level**, beside the `scenario` block rather than inside
    it, and is **sent only when asked for**: the engine defaults it to false, so
    a run snapshot carries the key exactly when it changed what "failed" meant.
    With it on, a step whose response does not match the schema its collection's
    bound document declares fails - but only a step that passed everything else;
    one already failing keeps the error that named it. Off, the verdict still
    rides every step and the report's `schemaValidation` totals. Note the
    default is the opposite of `run_collection_smoke`'s, for the reason recorded
    there. `start_load_run` **refuses** the flag on either of its paths, naming
    the executor: a load run validates sampled responses once the run has
    drained and never demotes a step, so the gate would decide nothing. It is
    declared on that tool for the refusal's sake - an argument the tool's schema
    does not name is stripped before the handler sees it, which would drop the
    flag in silence.
  - **The allowlist gate is all-or-nothing here**, unlike the smoke matrix's
    per-request skip: every step is composed by id and gated before the run is
    created, and one step the allowlist does not cover refuses the whole run
    with nothing sent, naming the step the way the engine names it
    (`step 1 (request 'checkout', id 'r2')`). A step that will not compose
    refuses it too - the engine resolves the same plan before creating the run
    row and would refuse it for the same reason.
  - Every argument that describes a *single* target (`url`, `requestId`,
    `method`, `headers`, `body`, `auth`, `httpVersion`, `postRequestScript`,
    `collectionId`) is **refused by name** beside a `scenario`, as are
    `maxInFlight` (in-flight is bounded by the virtual-user count),
    `sloMs`/`stepDuration` (capacity's own fields) and `stream` and its two caps
    (run-level stream bounds are attached to a single-target run's request
    only). Each would otherwise be an argument an agent believes shaped the run
    that nothing on this path reads.
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
state stays visible and resettable from either side: Settings → General →
Cookies lists every jar and clears it, and `get_cookies` / `clear_cookies`
(issue #758) read and clear the same jars over MCP - so an agent can see the
session it inherited and drop it rather than only being told it exists. An agent
that must not inherit one at all should run in an environment of its own. `run_collection`
shares the jar too - the design-mode runner is the one executor handed it, which
is what lets a login step authenticate the steps after it. `start_load_run` is
unaffected either way: a single-target load run never touches the jar, and a
scenario load run gives each virtual user cookies of its own.

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
| `vayu://runs`               | The most recent 100 runs (first page), newest first; `pagination.total` / `hasMore` in the content carry the full count. A resource takes no arguments, so filtering and paging beyond this page is the `list_runs` tool's job. |
| `vayu://collections`        | All request collections.         |
| `vayu://environments`       | All environments.                |
| `vayu://config`             | Engine configuration entries.    |
| `vayu://scripting/completions` | The script sandbox's full API surface (see below). |
| `vayu://scripting/types`    | The same surface as TypeScript declarations - the `.d.ts` the app's editor loads, so a call's parameters and return type are the running engine's. |
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

Two resources, because a name and a signature are different questions.
`vayu://scripting/completions` re-serves `GET /scripting/completions` (Monaco's
own fields projected away) and answers *what exists*;
`vayu://scripting/types` re-serves `GET /scripting/types`, the `.d.ts` the
engine generates from the same table, and answers *what it takes and returns*
(issue #760). Both throw rather than serve a partial surface - an agent reading
a truncated API list concludes the sandbox cannot do what it can - and neither
holds a copy of the surface here, which is the whole point: the app's own
quick-reference panel had gone stale before #233 and this is what replaced it.

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
| `compare_runs`         | `baseRunId?, targetRunId` | The computed delta + "did this regress?". An omitted `baseRunId` resolves the target's pinned baseline through the same `resolveBaseline` the tool uses - the prompt demanded an id Vayu already knew (#760). |
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
  prompt where supported. Seven tools carry it - `start_load_run`,
  `delete_collection`, `delete_request`, `delete_request_example`,
  `delete_run`, `delete_environment` and `delete_webhook_inbox` - through one
  implementation, so the elicitation path cannot drift between them. A preview is a *successful* result
  that deliberately did nothing, so it emits no `mcp:data-changed` event either.
- **Write toggle** (`allowWrites`, default off) - gates every tool in the
  **write** category: `create_collection`, `update_collection`,
  `delete_collection`, `create_request`, `update_request`, `delete_request`,
  `create_request_example`, `update_request_example`,
  `delete_request_example`, `move_item`,
  `create_environment`, `update_environment`, `activate_environment`,
  `delete_environment`, `update_globals`, `clear_cookies`,
  `update_engine_config`, `set_run_baseline`,
  `delete_run`, `delete_webhook_inbox`, `clear_inbox_captures`. Does not gate
  `run_request` / `run_collection_smoke` / load runs
  (allowlist + caps). The six deletes need the toggle **and** confirmation:
  the toggle is a single session-wide switch a user flips once to let an agent
  save a request, which is not consent to destroy a subtree or a run's stored
  history. `clear_cookies` takes the toggle without a confirmation, because
  what it ends is a session rather than anything saved.
- **Loopback services carry no gate of their own** - `start_mock_issuer`,
  `stop_mock_issuer`, `update_mock_issuer`, `start_mock_server`,
  `stop_mock_server`, `start_webhook_inbox`, `stop_webhook_inbox` and
  `update_inbox_response` are `execute` tools that neither the allowlist nor the
  write toggle governs. (The two that destroy recorded data,
  `delete_webhook_inbox` and `clear_inbox_captures`, are `write` tools and do
  take the toggle - what they end is not the listener but the captures.) The allowlist exists to stop an agent generating traffic
  against third parties it was never pointed at, and a mock issuer is bound to
  `127.0.0.1` by the engine with no host to configure - as is a mock server, and
  as is an inbox, whose
  `bind` these tools never send; the write toggle gates saved data, which an
  ephemeral listener is not (a mock server only *reads* the examples it serves).
  Nor would a gate here withhold
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
(`collection`, `request`, `environment`, `run`, `cookie`, `config`, `service`,
`oauth`)
plus the `collectionId` / `requestId` / `runId` / `inboxId` / `mockId` the call
itself named; it carries no engine data, so the
renderer still reads every row through its query layer. The five hints are read
off the call's own arguments at the dispatch chokepoint, which is what keeps a
new write tool from having to remember an emit of its own - every tool in the
registry spells them the same way. They are hints, not identity: `requestId` on
a `run` event is the saved request a design run was linked to, while `runId` is
the run itself, and only the tools that rewrite or remove an **existing** run
(`stop_run`, `set_run_baseline`, `delete_run`) name one - a runner's new run has
no per-run cache to drop yet. `inboxId` and `mockId` are the same shape for the
`service` family: the tools that act on an existing listener name one, and
`start_webhook_inbox` / `start_mock_server` cannot, since the engine assigns the
id. Both exist because their per-id cache has to be **dropped** rather than
refetched - a cleared capture list would union its destroyed rows straight back,
and a stopped mock's route table has no live id left to refetch from. `service`
is deliberately one family covering inboxes, mock servers and issuers, because
the surfaces that read them - the Services drawer and the Dock's
running-services count - ask "what is listening" rather than "which kind".
`oauth` (issue #760) carries **no** hint of its own even though a cache key
exists: an agent names the key it clears, but the key a `fetch_oauth2_token`
writes under is derived engine-side and appears only in the answer, so a hint
would be present for one tool and absent for the other - the shape that leaves
a stale row exactly when it matters. The family is invalidated at its prefix
instead. The renderer side, including
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
- **`vayu mcp` bin** - package the stdio CLI as a first-class command
  ([#693](https://github.com/athrvk/vayu/issues/693)).
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
