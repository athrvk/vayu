---
description: >-
  The Vayu log record - one JSON-lines shape across engine, CLI and app files, one text rendering on the console, categories, redaction by key, file names and retention.
---

# Engine Logging

Every line `vayu-engine`, `vayu-cli` and the Electron app write under
`<data-dir>/logs/` is one JSON object (issue #1557 for the engine, #1558 for
the app, both under the wider #1556). The console gets a text rendering of
the same record; the two are never a choice a config entry makes, since a
second switch is exactly what #1510 retired.

## The record

```json
{"ts":"2026-09-07T13:57:19.123Z","level":"debug","src":"engine","cat":"http","msg":"GET /inbox 200 1.3ms 412B","pid":4242,"tid":"139812","method":"GET","path":"/inbox","status":200,"ms":1.3,"bytes":412}
```

Required on every record: `ts` (RFC 3339, UTC, milliseconds, trailing `Z` -
never local time, so an engine and a CLI record from the same machine sort
together with no ambiguous hour), `level` (`debug` | `info` | `warn` |
`error`), `src` (`engine` | `cli` | `app` | `mcp` | `renderer` - the last
three are the app side's, #1558), `cat` (one lowercase token from the closed
list below), `msg` (one human sentence - never `key=value` text, which is a
field now), `pid`. Almost always present: `tid` (the app side omits it - see
below). Free typed fields follow, named in lowercase ASCII with no dots
(`docs/engine/log-record.schema.json`'s `propertyNames` rule).

The schema is [`log-record.schema.json`](log-record.schema.json), JSON Schema
draft 7. Both the engine and the app validate every record they write against
it in tests, so a category added on one side and not the schema reds a test
rather than silently drifting.

## Console rendering

```
13:57:19.123 DEBUG http     GET /inbox 200 1.3ms 412B
```

`HH:MM:SS.mmm LEVEL cat<padding>msg key=value ...` - the uppercase level name
(unchanged from before #1557), the category left-justified, then the message
and any extra fields as `key=value` pairs. `vayu-engine`'s `-v 0|1|2` still
governs which levels reach the console; the file's own floor is the separate
`logLevel` setting below.

One request line per HTTP call (issue #1510), at the level its own status
calls for rather than one fixed level for every call: a 2xx is `debug`, a
3xx or 4xx is `info`, and a 5xx is `warn`, because an engine failure is not
something a quiet run should hide. `install_request_logger`
(`http/request_log.cpp`) is the one place this decision is made, for both
the management server and an inbox listener.

## Categories

Engine: `startup`, `config`, `http`, `db`, `run`, `script`, `inbox`, `mock`,
`oauth`, `client`, `shutdown`. CLI: the same set plus `cli`. Adding one is one
line in `docs/engine/log-record.schema.json`'s `cat` enum and one in
`tests/log_category_scan_test.cpp`'s allow-list - the source scan that pins
every `log_debug`/`log_info`/`log_warning`/`log_error` call to a real category
(`rg 'log_(debug|info|warning|error) \("' engine/src`).

App and MCP (`src: "app"` and `src: "mcp"` share one list, since both write
`app_<stamp>.log`): `main`, `sidecar`, `window`, `updater`, `ipc`, `mcp`,
`power`, `notify`. Renderer (`src: "renderer"`): `renderer`, `boundary`. See
"The app's log" below.

## Redaction by key

Before either renderer sees a record, `Logger::write` walks `fields` at every
depth (`vayu::utils::redact_fields`, `utils/log_redact.hpp`):

- A field named `authorization`, `proxy-authorization`, `cookie`,
  `set-cookie`, `www-authenticate`, `proxy-authenticate`,
  `authentication-info`, `token`, `access_token`, `refresh_token`,
  `client_secret`, `password`, `apikey` or `x-api-key` (case-insensitive)
  becomes `"<redacted>"` wholesale.
- A field whose name ends in `url` or `Url` goes through `strip_url_secrets`:
  userinfo and the query string removed, scheme/host/path kept
  (`https://u:p@h/x?y=1` becomes `https://h/x`).

A curl verbose exchange (`vayu-engine --verbose 2`, or a run with its own
`verbose` override) is one `cat=client` record per transfer rather than one
line per frame: `lines[]` holds each physical line of the outgoing and
incoming header blocks, each redacted the same way `debug_redact.hpp` always
has (`Authorization: <redacted>`), plus the request line's query string
through the same URL rule.

## Files, rotation and retention

`<data-dir>/logs/engine_<stamp>.log` (the daemon) and
`<data-dir>/logs/cli_<stamp>.log` (`vayu-cli`, its own default data directory
when `--data-dir` names none). One file per process start; `logLevel`
(Settings, Observability, restart-required) is the floor both write at,
defaulting to `debug`. `maxLogFileBytes` rotates the open file once to `.1`
when it would cross the cap (0 = unlimited); the newest 10 per-prefix files
survive a start, oldest deleted first along with their `.1`.

## The app's log

`electron/log.ts` (#1558) is a from-scratch TypeScript port of the record
above and of `log_redact.hpp`'s redaction rule - same required keys, same
`"<redacted>"` and URL-stripping behaviour, same JSON-lines file, same text
console shape - so a reader (`jq`, a human) treats every file under one
`logs/` directory the same way regardless of which binary wrote it.

`<data-dir>/logs/app_<stamp>.log` carries every `src: "app"` record (the
Electron main process: `main.ts`, `sidecar.ts`, `power-save.ts`, `notify.ts`
and the rest) **and** every `src: "mcp"` record from the Electron-hosted MCP
transport (`mcp/http.ts`) - one file, since both live in the same process and
share the same buffer and floor. The standalone stdio MCP server
(`mcp/cli.ts`, `node dist-electron/mcp/cli.js`) is a separate OS process with
no Electron `app` module to derive a data directory from, so it writes its
own `<dir>/mcp_<stamp>.log` when launched with `VAYU_LOG_DIR` set (unset:
console only) - its rotation, retention and redaction are otherwise the same
port. Neither app-side file sets `tid`: the main process has no per-connection
worker threads the way the engine does, so the field would name nothing a
reader could use.

**One floor for both files.** The engine's `logLevel` config entry governs
`app_<stamp>.log` too - the app introduces no setting of its own. `log.ts`
buffers every record in memory until the sidecar answers `GET /config` once
after `startEngine()` resolves (or, if the engine never answers, at `debug` -
a launch that failed is exactly the one whose every record is wanted), then
applies that floor to the whole buffer and to everything logged after.
`electron/app-log.ts` exposes the two Electron-coupled singletons every
main-process module shares, `appLogger()` and `mcpLogger()`; `mcp/cli.ts`
calls `log.ts`'s `createLogger` directly, since it has no `app` module to
couple to.

In dev (`!app.isPackaged`) and under `VAYU_LOG_CONSOLE=1`, the same text
renderer as the engine's also prints: `error` to stderr, everything else to
stdout - except the stdio MCP server, which prints everything to stderr
unconditionally, since its stdout is the JSON-RPC channel.

A renderer error reaches the same file through one more hop: `error-logger.ts`
sends `{level, cat, msg, err, fields}` over the one-way `log:record` IPC
channel (mirroring `runs:progress`'s shape), and `log-ipc.ts` validates it,
stamps `src: "renderer"` and the sender's OS process id, and caps the channel
at 20 records per second per window - the 21st in a window is dropped with one
`warn`, and every later drop in the same window silently, so a render loop
cannot fill the disk with either the records or the warnings about them.
Settings,
General's **Open logs folder** button (`app:openLogsFolder`) opens
`<data-dir>/logs/` in the OS file manager.

## Reading the files

```bash
jq -r 'select(.cat=="http") | .status' logs/engine_*.log
jq -s 'sort_by(.ts) | .[] | "\(.ts) \(.src) \(.level) \(.cat) \(.msg)"' logs/*.log
```

The second line is the merge across every file in the directory - `engine_*`,
`cli_*`, `app_*` and, when it exists, `mcp_*` - every record from every
source, interleaved by timestamp.
