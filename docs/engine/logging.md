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

One outcome record per send the engine makes for a person or a script
(issue #3677), because the request line records the call *into* the engine and
nothing recorded what the engine's own sends did. A failed one is a `warn`, so
the default `info` floor keeps it; one that completed is a `debug` line:

| Send | `cat` | Written by | Fields |
|------|-------|------------|--------|
| A design Send (`POST /execute`) | `http` | `record_design_result`, once per Send whichever way it ends: the exchange, a failed build (an OAuth 2.0 token not acquired) and a stream's worker when it finishes, and for a transient Send too | `method`, `url`, `ms`, `status`, `errorCode`, `error`, `runId` |
| `pm.sendRequest` | `script` | `js_pm_send_request`, whatever `scriptEnableConsole` says | the same, with no `runId` (the script context does not carry one) |

`msg` is the fixed sentence `Send failed`, `Send completed` or `Send cancelled`
(`pm.sendRequest ...` for a script), never `POST /path` text. `status` is
absent when no answer came back; `errorCode` is the `err.code` a script's
callback reads (`CONNECTION_FAILED`, `TIMEOUT`, ...) and `error` the
transport's own message, bounded like a script's text
([below](#text-a-script-authored)); `url` is stripped to scheme, host and path
like any `url` field, so `?api_key=...` never lands. A 4xx or 5xx answer is an
answer, not a failure, so it is a `debug` line with its `status`. A send that
was cancelled (the caller hung up, a Stop, the enclosing exchange ending) is a
`debug` line too, naming `CANCELLED`. A request refused before anything was sent
(a 400 from `POST /execute`) has no outcome record; its request line says it.
`runId` is present only for a recorded Send and is simply absent for a
transient one. `vayu::http::describe_send_outcome` (`http/send_log.hpp`) builds
both records, so the two cannot drift.

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
  `authentication-info`, `token`, `access_token`, `refresh_token`, `id_token`,
  `client_secret`, `password`, `passphrase`, `apikey`, `api_key`, `x-api-key`,
  `x-auth-token`, `x-csrf-token`, `code`, `code_verifier`, `private_key`,
  `secret_access_key`, `secretaccesskey` or `session_token`
  (case-insensitive) becomes `"<redacted>"` wholesale.
- A field whose name ends in `url` or `Url` goes through `strip_url_secrets`:
  userinfo, the query string and the fragment removed, scheme/host/path kept
  (`https://u:p@h/x?y=1` becomes `https://h/x`). Userinfo is everything before
  the last `@` of the authority, with or without a scheme, so a scheme-less
  proxy `user:pw@proxy:8080` and a password containing `@`
  (`http://u:p@ss@h`) leave nothing behind.

The app's `log.ts` ports both rules, and
`engine/tests/fixtures/log-redaction-conformance.json` pins the field list and
the URL cases for the two languages. Its `sensitiveHeaderNames` is the header
subset the app's code snippets mask by name (`app/src/lib/sensitive-headers.ts`,
#1806); each must also be a secret field name here. Its
`challengeHeaderNames` are secret field names the logger still redacts but that
a script-request record and the app's session Console show
(`app/src/lib/secret-header-name.ts`, #3672). Its `sensitiveParamNames`
is the query-parameter and Params-row set the engine blanks in an export
(`is_secret_param_name` in `vayu_extensions.cpp`: the secret field names less `code`, plus
`EXTRA_SECRET_PARAM_NAMES`), which the MCP server's `SENSITIVE_PARAM_NAMES`
(`app/electron/mcp/withhold.ts`, #1837) must equal.

A curl verbose exchange (`vayu-engine --verbose 2`, or a run with its own
`verbose` override) is one `cat=client` record per transfer rather than one
line per frame: `lines[]` holds each physical line of the outgoing and
incoming header blocks, each redacted the same way `debug_redact.hpp` always
has (`Authorization: <redacted>`) - the same field list, plus the header the
request's own API-key auth names - plus the request line's query string
through the same URL rule. curl's own `*` text lines are scrubbed for every
URL they quote (`Issue another request to this URL: '...'`).

### Text a script authored

Redaction is by field *name* and only for `fields`; `msg` is never scanned, so
nothing in the engine can tell a credential inside a sentence from the
sentence. A script chooses what it throws (`throw new Error (token)`), so that
text is never part of `msg`: the message is fixed (`<Kind> script failed`
for `execute_script`'s `Pre-request`, `Post-request`, `Setup` and so on,
`script.setup failed`, `Scenario run error`) and the text rides in one field,
`scriptError` (`error` for `Scenario run error`, which also reports non-script
failures; `stepError` on the "iteration ended at step" line, whose cause may be
a transport failure as well as a script).

The field is bounded: `vayu::utils::bounded_log_text` (`utils/log_text.hpp`)
keeps at most `kLoggedTextMaxBytes` (512) bytes, cut on a UTF-8 character
boundary, and appends `...[truncated]` where it cut. Only the copy the logger
is handed is bounded; the failing step's stored error, the run's trace and the
`POST /execute` response keep the whole text.

What this does and does not do: it keeps script text out of `msg`, caps its
size, and puts it where a name-based rule can apply. It does **not** redact the
value - `scriptError`, `error` and `stepError` are not in the secret set, so a
credential a script threw is still readable in the first 512 bytes of that
field, in the file and on the console. A script that must not leak a secret
must not throw it.

## Files, rotation and retention

`<data-dir>/logs/engine_<stamp>.log` (the daemon) and
`<data-dir>/logs/cli_<stamp>.log` (`vayu-cli`, its own default data directory
when `--data-dir` names none). One file per process start; `logLevel`
(Settings, Observability, restart-required) is the daemon's floor, defaulting
to `info`: a 2xx request line, every database write and a send that
completed (a design Send or a `pm.sendRequest`) are `debug`, so a long
session would otherwise fill the file with them; a send that failed is a
`warn` and is kept. Set `logLevel` to `debug` for a bug report. The lines
startup writes before the database opens, and an unparsable `logLevel`, take
the same default; `vayu-cli` reads no config and
always writes at it. `maxLogFileBytes` rotates the open file once to `.1`
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

The app creates `logs/` `0700` and each file `0600` on Linux and macOS (the
engine's own rule, `SECURITY.md`, "Data at rest"), subject to the process
`umask` and applied when the directory or file is created. Windows ignores the
mode, so a new file inherits the directory's ACL.

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
`<data-dir>/logs/` in the OS file manager, and so does the one in the Logs tab
(below), which reads the same files without leaving the app.

The renderer chooses nothing about a line's size or ownership, so `log-ipc.ts`
bounds what it sends. `msg` is cut at 2000 characters; `err` is kept only as an
object with a string `name` and `message` (and an optional string `stack`), cut
at 200, 2000 and 8000; `fields` is kept only as a plain object (an array or a
string is dropped), at most 20 keys, each string value cut at 500, and a
`fields` that still serialises past 4000 characters becomes `{"truncated":
true}`. Every cut appends `...[truncated]`. The renderer's `ts`, `level`,
`src`, `cat`, `msg` and `tid` fields are discarded so they cannot overwrite
the record's own, and control characters in `msg` become spaces so a newline
cannot forge a second console line. Unlike the engine, which never scans text,
the URLs inside `msg`, `err.message`, `err.stack` and each string field value
go through the same URL rule as a `url` field (userinfo, query and fragment
dropped) before they are cut - the renderer is where a page's own errors quote
the URL they failed on. This applies at that boundary only; a record the main
process logs itself is redacted by field name alone, as above.

## Reading the files in the app

The Logs tab reads `<data-dir>/logs/` through the main process, never through a
path the renderer names (#3635). `log-reader.ts` lists the files, reads a page
merged across them by `ts` (backwards, or forwards from a jump), and follows
them with a 500 ms poll;
`log-reader-ipc.ts` puts it on five channels, `electronAPI.logs` in the
renderer:

| Channel | Direction | Carries |
|---------|-----------|---------|
| `logs:list` | invoke | the log files: name, source, size, modified time |
| `logs:read` | invoke | `{ before?, around?, after?, filter, limit }` in, at most one of the three anchors; `{ records, cursor, more, scannedTo, newer? }` out, where `cursor`, `more` and `scannedTo` point the way the read went (newer for `after`) and an `around` read's `newer` is where `after` starts |
| `logs:tail-start` | invoke | a filter; starts this window's tail, replacing one running |
| `logs:tail-stop` | invoke | nothing; ends this window's tail |
| `logs:records` | main to renderer, one-way | `{ records, dropped }`, one batch per poll that found matches |

Every handler answers only the app window's main frame (`ipc-sender.ts`) and
rejects any other sender. A payload is shape-checked before the reader sees it,
and a cursor names files by the reader's own log-file pattern, so no path
crosses the wire. A window's tail ends on `logs:tail-stop`, when the window is
destroyed or its main frame navigates, and when the app quits. Nothing in the
MCP server reaches these files: no tool, resource or prompt names a log, and
`mcp/log-reader.guard.test.ts` holds that.

**The Logs tab** (#3635) is the bottom panel's second tab, beside the session
Console (#3634): the Dock's Console button, the palette's "Show or hide the
console" row and Ctrl+J / ⌘J open the panel, on the tab it was last left on. It
reads the newest lines, then follows the files, and draws one row per line:
the time in your zone (UTC and the zone on hover), the level, `src`, `cat`, the
message and the record's remaining fields as `key=value`, the text rendering's
shape above. A row opens to the whole record as formatted JSON, and a line that
is not a record (a crash's stack, a half-written line) is shown raw with an
"unparsed" marker. Above the table: level, source and component filters, a
search box (free text, or `field:value`, where a quoted value is exact and a
bare one a substring: `cat:oauth`, `status:"500"`; a bare `field:value` also
matches a line whose text holds it as typed, so `localhost:47813` finds the
lines a free-text search for it would), **Follow** (on by default,
off when you scroll up, on again by its switch or by scrolling to the end), a
**Jump to time** control (the platform's own date-time input, landing on the
lines either side of it, with a rule between them naming the time, scrolled to
the middle of the table), **Export** (the lines held in the table, as JSON
lines, through the save dialog, with the count it wrote) and the logs folder
button; a line's **Copy line** is in its opened row. Copy and Export write the
line as the file holds it, not the record re-serialised (`1.0` stays `1.0`):
the reader attaches each record's own line under the `$raw` key, which the
schema's `propertyNames` refuses, so no field shares it, and the table, the
opened row's JSON and free-text search all leave it out. For a record over
256 KiB the line is cut at that bound, as the record's largest fields are:
Copy line copies the cut line, and Export writes the cut record re-serialised
instead, so every line of the export is still one JSON value. Every line the
reader delivers, by a read or the tail and an unparsed one too, also carries
its place in its file under the `$pos` key (#3652): `{ name, id, start, end }`,
the file's name and identity as a cursor names them, the offset of the line's
first byte, and the offset just past its newline (the file's end for a last
line without one). The table, the opened row's JSON, Copy line, Export and
free-text search leave it out, as they leave out `$raw`; the 16 MiB bound
counts it. The filters are
evaluated in the main process: a change restarts the tail and reads again,
replacing what the table held.

The tab holds at most 10,000 lines or 16 MiB, whichever comes first, and
mounts at most 600 of them at a time, whatever it holds: the rows you are
reading stay put while lines arrive below, and those mount as you scroll to
them. Scrolling up through the lines held mounts a step more at a time without
moving the line you are reading (#3675), so a steady scroll reaches the oldest
line held; the bar below the header (**Search older**, "Searched back to ...",
or "Reached the start of the logs.") is drawn there, above that line, and
nowhere else. Following drops the oldest. **Search older** pages back through the files, says how far
it has looked ("Searched back to ..."), turns Follow off and drops the newest;
having dropped any, the tab stops appending the tail (it would sit after a
gap), and Follow reads the newest lines again. A jump is detached the same
way: it shows the lines at and before the time and, read at once after them,
the next hundred; **Search newer** below the last line pages on ("Searched
forward to ...") and drops the oldest, and the page that reaches the end of
the logs appends the tail again, which it restarted before reading, so the
table follows once you scroll to the end. When the bound drops the oldest
lines, by following, by Search newer or from a read over the 16 MiB, Search
older is still offered and reads the dropped lines and those before them, each
file from where its own held lines begin (by `$pos`) or past a dropped line
that sorted ahead of one it kept (a poll's batch is in time order, not file
order), leaving out a line the table already holds, so none is skipped or
shown twice. A Search older that a trim overtakes reads again from there, so
one click is enough. A burst past the tail's
500 lines per poll shows as "N lines skipped in a burst": the lines are in the
files, and Search older reads them once the bound has dropped the lines before
them. The
footer names the engine's `logLevel` and says requests answered 2xx and
database writes are written at `debug`, which a default install does not keep,
with a link to Settings › Observability, where the level changes and applies
after a restart. While a saved `logLevel` awaits that restart the footer says
the saved level applies after it and the running engine keeps its current one,
since the files are still written at the level the engine started with. Outside Electron (the renderer under plain vite) the tab says
the logs are available in the desktop app.

## Reading the files

```bash
jq -r 'select(.cat=="http") | .status' logs/engine_*.log
jq -s 'sort_by(.ts) | .[] | "\(.ts) \(.src) \(.level) \(.cat) \(.msg)"' logs/*.log
```

The second line is the merge across every file in the directory - `engine_*`,
`cli_*`, `app_*` and, when it exists, `mcp_*` - every record from every
source, interleaved by timestamp.

The app's Logs tab does the same merge, by `ts`, without leaving the window
([Reading the files in the app](#reading-the-files-in-the-app)).
