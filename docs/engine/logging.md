---
description: >-
  The engine's log record: one JSON-lines shape in the file, one text rendering on the console, categories, redaction by key, file names and retention.
---

# Engine Logging

Every line `vayu-engine` and `vayu-cli` write under `<data-dir>/logs/` is one
JSON object (issue #1557, part of the wider #1556 that also covers the app).
The console gets a text rendering of the same record; the two are never a
choice a config entry makes, since a second switch is exactly what #1510
retired.

## The record

```json
{"ts":"2026-09-07T13:57:19.123Z","level":"debug","src":"engine","cat":"http","msg":"GET /inbox 200 1.3ms 412B","pid":4242,"tid":"139812","method":"GET","path":"/inbox","status":200,"ms":1.3,"bytes":412}
```

Required on every record: `ts` (RFC 3339, UTC, milliseconds, trailing `Z` -
never local time, so an engine and a CLI record from the same machine sort
together with no ambiguous hour), `level` (`debug` | `info` | `warn` |
`error`), `src` (`engine` | `cli`; `app` | `mcp` | `renderer` are the app
side's, landing with #1558), `cat` (one lowercase token from the closed list
below), `msg` (one human sentence - never `key=value` text, which is a field
now), `pid`. Almost always present: `tid`. Free typed fields follow, named in
lowercase ASCII with no dots (`docs/engine/log-record.schema.json`'s
`propertyNames` rule).

The schema is [`log-record.schema.json`](log-record.schema.json), JSON Schema
draft 7. Both the engine and (once #1558 lands) the app validate every record
they write against it in tests, so a category added on one side and not the
schema reds a test rather than silently drifting.

## Console rendering

```
13:57:19.123 DEBUG http     GET /inbox 200 1.3ms 412B
```

`HH:MM:SS.mmm LEVEL cat<padding>msg key=value ...` - the uppercase level name
(unchanged from before #1557), the category left-justified, then the message
and any extra fields as `key=value` pairs. `vayu-engine`'s `-v 0|1|2` still
governs which levels reach the console; the file's own floor is the separate
`logLevel` setting below.

## Categories

Engine: `startup`, `config`, `http`, `db`, `run`, `script`, `inbox`, `mock`,
`oauth`, `client`, `shutdown`. CLI: the same set plus `cli`. Adding one is one
line in `docs/engine/log-record.schema.json`'s `cat` enum and one in
`tests/log_category_scan_test.cpp`'s allow-list - the source scan that pins
every `log_debug`/`log_info`/`log_warning`/`log_error` call to a real category
(`rg 'log_(debug|info|warning|error) \("' engine/src`).

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

## Reading the files

```bash
jq -r 'select(.cat=="http") | .status' logs/engine_*.log
jq -s 'sort_by(.ts) | .[] | "\(.ts) \(.src) \(.level) \(.cat) \(.msg)"' logs/*.log
```

The second line is the merge across `engine_*.log` and `cli_*.log` (and, once
#1558 lands, `app_*.log`): every record from every source, interleaved by
timestamp.
