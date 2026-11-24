---
description: >-
  The engine's health, shutdown, configuration and request-default routes, and the workspace backup route.
---

# Health, configuration and workspace

## Health & Configuration

### GET /health

Check engine status and version.

**Response:**
```json
{
  "status": "ok",
  "version": "0.3.0",
  "workers": 8,
  "dataDir": "/home/someone/.config/Vayu"
}
```

`workers` is the `workers` setting's effective value: the configured count when it is set, otherwise the detected core count - the same value the next run's `EventLoop` will use, not the machine's raw core count regardless of configuration.
It is never `0`: a host whose core count cannot be detected reports `4`, the fallback the event loop applies too.

`dataDir` (issue #3328) is the data directory this engine keeps its database, logs and lock file in, the `--data-dir` it was started with, so a client can tell an engine serving its own data from one serving another's.
It is resolved once at startup and always present:

- absolute: a relative `--data-dir` (or the default `./data`) is resolved against the directory the engine was started in;
- lexically normalised: `.` and `..` segments and a trailing separator are removed, and on Windows every separator is `\`;
- not canonical: a symlink is reported as written, not resolved, so the value compares equal to the path a client passed;
- UTF-8.
  A name that is not valid UTF-8 (a POSIX directory name is bytes) has the offending bytes replaced with U+FFFD rather than failing the response.

**`recovery` (optional, issue #922)** - present only when this engine startup had to recover the database, and **absent** on a clean start rather than `null`:

```json
{
  "status": "ok",
  "version": "0.3.0",
  "workers": 8,
  "dataDir": "/home/someone/.config/Vayu",
  "recovery": {
    "outcome": "started_fresh_quarantined",
    "at": 1755870000000,
    "databasePath": "/home/someone/.config/Vayu/db/vayu.db",
    "quarantinedPath": "/home/someone/.config/Vayu/db/vayu.db.corrupt-1755870000000"
  }
}
```

| Field | Meaning |
|-------|---------|
| `outcome` | `restored_from_backup` - `<db>.bak` passed the same validation and was restored over the corrupt database. `started_fresh_quarantined` - no backup restored it, so the engine moved it aside and created a fresh one. `backup_also_corrupt` - a backup existed, failed the same validation, and was left untouched rather than restored. `deleted_corrupt` - it was **deleted**, which happens only when the quarantine rename fails (issue #984) |
| `at` | When that happened, epoch milliseconds |
| `databasePath` | The database file it happened to |
| `quarantinedPath` | Where the engine moved the unopenable database, readable with `sqlite3 <path> .recover`. **Optional** - absent for `deleted_corrupt` and for markers written before #984, so test for it rather than deriving it from `outcome` |

The node is read from a marker file beside the database and stands until a later recovery overwrites it, so a client that has already told the user about an event should key off `at` rather than expecting the node to disappear.
See [db-schema/startup-and-recovery.md](../db-schema/startup-and-recovery.md#the-recovery-marker).

### POST /shutdown

Gracefully shut down the engine.
This is the shutdown path the Electron app uses on quit (it is more reliable than a signal on Windows, where `SIGTERM` does not behave as expected).

The response is sent **before** shutdown begins, so the client always receives the `200`.
The handler sets the body and then calls the shutdown callback inline, which only wakes the daemon's main loop; the teardown cannot overtake the response, because stopping the server joins the worker that is writing it.
The daemon then stops the server (and with it every mock server, inbox, mock issuer and OAuth callback listener, a paced answer going out at once and a callback's token exchange cancelled), ends and joins every streaming design run (the run ends `stopped` and its trace's `endReason` is `shutdown`, never a user's `stopped`, #3342),
stops and joins active runs (a run still sending ends `stopped`; one in its natural-end drain has the drain cut short, its in-flight transfers counted as `cancelled`, and keeps its own end, as for [a Stop](runs.md#post-runsrunidstop), issue #3341), refreshes the recovery backup `<db>.bak` if the session wrote anything (bounded at 2 s and by what is left of the app's 5 s window;
on a timeout the previous backup stands, see [db-schema/startup-and-recovery.md](../db-schema/startup-and-recovery.md#startup-validation-backup-and-recovery)), closes the database, releases the lock file, flushes the logs and exits.

**Response:** `200`
```json
{
  "status": "ok",
  "message": "Shutdown initiated"
}
```

### GET /config

Get global configuration settings.
Backed by the `config_entries` table.
The response is an `entries` array; each entry carries its value plus the UI metadata the Settings panel renders (label, description, category, default, and optional min/max/options):

```json
{
  "entries": [
    {
      "key": "workers",
      "value": "8",
      "type": "integer",
      "label": "Worker threads",
      "description": "Number of background worker threads. Higher values improve throughput on multi-core systems but increase RAM usage. Default equals CPU core count.",
      "category": "general_engine",
      "default": "8",
      "min": "1",
      "max": "128",
      "requiresRestart": false,
      "advanced": false,
      "keywords": ["cores", "parallelism"],
      "updatedAt": 1234567890
    },
    {
      "key": "defaultHttpVersion",
      "value": "auto",
      "type": "enum",
      "label": "Default HTTP version",
      "description": "Protocol a newly created request starts with...",
      "category": "network_performance",
      "default": "auto",
      "options": [
        { "value": "auto", "label": "Auto" },
        { "value": "http1.1", "label": "HTTP/1.x" },
        { "value": "http2", "label": "HTTP/2" }
      ],
      "requiresRestart": false,
      "advanced": false,
      "keywords": ["h2", "alpn"],
      "updatedAt": 1234567890
    },
    {
      "key": "dbCacheSize",
      "value": "67108864",
      "type": "integer",
      "label": "Database cache size",
      "description": "Memory SQLite keeps per connection for recently used database pages...",
      "category": "general_engine",
      "default": "67108864",
      "min": "1048576",
      "max": "1073741824",
      "unit": "bytes",
      "requiresRestart": true,
      "advanced": false,
      "keywords": ["ram"],
      "updatedAt": 1234567890
    }
  ]
}
```

**Only entries this engine's own build declares are listed** (issue #1492): a row a *newer* engine wrote to the same workspace, then left behind for an older one to reopen, is never in `entries` - this engine has no label, validator or bounds for it, so serving it would describe a setting it cannot actually explain.
`POST /config` applies the same rule to writes: a key outside this build's catalogue is refused as `"Unknown config key"`, the same message a key with no stored row at all gets.

`min` and `max` are present only for entries that declare them (numeric types).
`options` is present only for `type: "enum"` entries - a JSON array of `{value, label}`, so the renderer can draw a picker without a second, hand-maintained value-to-label map.
`value` and `default` are always strings; `type` is one of `integer`, `number`, `boolean`, `string`, or `enum`.

**`dependsOn`** (issue #1610) is present only on an entry that means nothing until a boolean sibling in the same category is on - `correlationIdHeader` carries `"dependsOn": "correlationIdEnabled"`.
It is a catalogue fact the seed asserts is internally consistent (a value naming an unknown, cross-category or non-boolean key fails engine startup); `POST /config` never reads it back.
The Settings screen nests the dependent's card immediately beneath its parent's, indented and disabled with a "Turn on \<parent label\> to use this" hint while the parent reads `"false"`.

`requiresRestart` and `advanced` are booleans, always present:

- **`requiresRestart`** - the running engine keeps the old value until it is restarted; anything else takes effect on the next run, inbox or request that reads it.
  It is the only statement of that fact: labels and descriptions no longer spell it out, and the app renders one chip from this field (a pending signal in the Dock too, once such a setting has been saved).
  Consumers must read the field rather than parse the label - the old `(Requires Restart)` suffix drifted out of step with the mechanism and misinformed the settings screen and the MCP `update_config` result at the same time.
  Exactly three entries carry it - `dbCacheSize`, `dbBusyTimeout` and `dbSynchronous`, all read when the database is opened.
  `workers` carried it too until [#873](https://github.com/athrvk/vayu/issues/873), which is the same drift in the field's own terms: the engine reads it at the start of every run, so the restart it asked for was never needed.
  `config_route_test.cpp` pins the set.
- **`advanced`** - an internal with no everyday user story (`dbBusyTimeout`, the four `oauth2Refresh*` watchdog knobs, `inboxLivePollIntervalMs`, `sseIdleTimeoutMs`, `maxStepsPerIteration`, `monitorScrapeTimeoutMs`, `liveMaxRetainedTicks`, `scriptStackSize` - eleven entries).
  Still live and still settable; the app renders these collapsed under an "Advanced" section at the bottom of their category.
  The membership rule is citable: if an entry's own description has to say "only if" or "only for", the entry has declared itself advanced.

`keywords` is an array of strings, **always present** and empty for the entries that declare none - a client never has to tell "declares none" from "this engine does not send the field".
They are extra terms the app's settings search matches on: what a user types that this entry's key, label and description never say ("ram" for `dbCacheSize`, "deadline" for `defaultTimeout`, "fsync" for `dbSynchronous`).
They are match terms only and are never displayed, and a seeded keyword never repeats a word the entry already carries - search reaches the other three fields first and ranks them higher, so a duplicate would only push the entry above better matches.
A test over the seeded catalogue enforces both halves of that.

`unit` says what a numeric entry's value **measures** - `ms`, `sec`, `days` or `bytes` today - and is **omitted** when the entry measures nothing, the same shape as `min` / `max` / `options` above rather than a null.
Absent means the number is a count (worker threads, retained runs, stored steps); a suffix reading "items" would be noise, so counts declare none.
Non-numeric entries never declare one.

The app renders it as the suffix inside the input, which is where a unit is stated **once** - so a seeded description never spells the same unit out as an "in milliseconds" clause, and a label never carries a `(ms)` suffix; a test over the catalogue enforces both.
Labels are sentence case ("Default request timeout", "Correlation ID"), enforced by a second catalogue test.
`bytes` additionally selects human-readable formatting for the value, the range hint and the default line (`104857600` reads as `100.0 MB`), which the app reads from the entry rather than from a hardcoded key list, so a byte-valued entry added engine-side is formatted without a TypeScript change.
A client that meets a unit it does not know should show it verbatim rather than drop it.

Three entries are seeded as `enum` today.
`defaultHttpVersion` is the protocol a **newly created** request starts with (see [POST /requests](requests.md#post-requests)).
It is a write-time seed only - changing it never alters a request that already exists, and it is never consulted at execution time.
`dbSynchronous` is SQLite's durability level, whose three values (`"0"` Off, `"1"` Normal, `"2"` Full) are an enumeration rather than a range; it is stored as an `enum` so the panel draws a picker instead of an integer box the description has to explain.
Its default is Normal (`"1"`).
After a power cut or an operating-system crash, Off can corrupt the whole workspace file, Normal cannot corrupt it but may lose the last few seconds of writes, and Full keeps every committed write.
`proxyMode` is the third - see [Proxy settings](#proxy-settings) below.

The Settings panel renders entries dynamically, so new keys appear without app changes.
The entries below span three categories: the `data_retention` keys govern how much of a run is kept on disk; `maxResponseBodyBytes` is `limits`, because it fails an oversized read in flight and stores nothing; and `phaseHistograms` joins the three `monitor*` keys in `observability`, which governs what a run measures rather than what it keeps:

| Key                 | Default   | Range        | Effect |
|---------------------|-----------|--------------|--------|
| `maxTraceBodyBytes` | `5242880` | 1024–104857600 | Largest request/response body stored in a design run's `trace_data`. Bigger bodies are truncated with `bodyTruncated`/`bodyBytes` (see `GET /runs/:id`). |
| `maxResponseBodyBytes` | `33554432` | 1024–1073741824 | Largest response body a **load-test** transfer reads into memory, and what a `pm.sendRequest` from any of that run's scripts (inline step scripts, `script.setup` / `script.teardown`, the deferred `tests` script) may read. A bigger response fails that request (see `POST /runs`). Not a storage cap and unrelated to `maxTraceBodyBytes`, which truncates what a *completed* design request writes to the database. |
| `maxDesignResponseBodyBytes` | `33554432` | 1024–1073741824 | Largest response body a **design-mode** send - `POST /execute`, and each step of a collection run - reads into memory, and what a `pm.sendRequest` from that send's scripts (a collection run's setup and teardown scripts included) may read. A bigger response is read up to this point and answered with `bodyCapped: true` (see `POST /execute`) rather than failing, because someone is watching for it - a script's own fetch is the exception and refuses, having no way to tell the script its body was cut (see [scripting](../scripting.md#sending-a-request-from-a-script-pmsendrequest)). Separate from `maxResponseBodyBytes` above, which is the load path's and refuses in every case. |
| `maxElementBodyBytes` | `1048576` | 1024–1073741824 | Largest response body an `extract.json`, `assert.jsonpath`, `assert.jsonschema` or `assert.snapshot` [element](../elements.md) will parse as JSON, in a design send, a collection run and a scenario load run alike. A bigger response is not parsed at all, instead of paying for - or failing on - a parse of an oversized body, and the step does not pass on it: an `assert.jsonpath`, `assert.jsonschema` or `assert.snapshot` fails and a `required` `extract.json` fails the step, both with the reason, while an optional `extract.json` reports `skipped` with it. A body that parses but nests deeper than 100 levels is unreadable the same way, whatever its size, as is one that is not JSON; that depth is fixed, not a setting. The one shared parse per step is reused by every such element, so this is a per-step cost, not a per-element one. |
| `maxSampleBodyBytes` | `32768`  | 0–104857600  | Largest response body kept for a single captured **load-run** sample. Bigger bodies are stored truncated and marked. Deliberately far below `maxTraceBodyBytes`: a design run stores one exchange the user asked for, a load run stores tens nobody asked for individually. `0` keeps headers and metadata and no body. |
| `maxSampleBytes`    | `2097152` | 0–1073741824 | Total captured body bytes one load run may store. Once spent, samples keep their headers and metadata and only their bodies are dropped; the report counts them as `sampling.sampleBodiesDropped`. |
| `maxResponseSampleBytes` | `268435456` | 0–1073741824 | Total response-body bytes one load run may hold for its post-run test scripts and schema checks. Two orders of magnitude above `maxSampleBytes` because these bodies are kept **whole** - a truncated one would fail a check the target passed - so past the budget whole samples are dropped instead, counted as `sampling.responseSamplesDropped`. `0` retains no sample that has a body. |
| `phaseHistograms`   | `true`    | boolean      | Record DNS/connect/TLS/first-byte/download times for **every** load-test completion into five HdrHistograms, so the report can carry `timingBreakdown.phases` percentiles and averages over every completion instead of over the retained trace sample, and the live stream's gate frames can carry `cumulativePhases`. Costs five atomic histogram writes per completion; see [benchmarks](../benchmarks.md). |
| `maxRunsRetained`   | `200`     | 0–100000     | Keep at most this many most-recent **load and collection** runs; older ones (and their metrics/results, **including captured response bodies**) are pruned at startup and after each run finishes. Design Sends are counted under `maxDesignRunsRetained` instead and never evict these. `0` = unlimited. Captured data is stored verbatim, so this doubles as its expiry. |
| `maxDesignRunsRetained` | `100` | 0–100000     | Keep at most this many most-recent **design Sends** (`POST /execute` runs); older ones and their stored exchange are pruned at startup and after each Send. Counted apart from `maxRunsRetained`, so Sends never evict a load or collection run (#2429). `0` = unlimited. |
| `runRetentionDays`  | `30`      | 0–3650       | Delete runs older than this many days. `0` = unlimited. |
| `trashRetentionDays` | `30`     | 0–3650       | Destroy collections, requests, environments, saved examples and client certificates deleted more than this many days ago, swept at startup. Until then they are restorable - see [Trash](trash.md#trash). `0` keeps the trash forever. |
| `monitorIntervalMs` | `1000`    | 250–60000    | Scrape cadence for a [`monitor` block](load-runs.md#the-monitor-block-server-vitals) that names no `intervalMs` of its own. Read per run, so a change applies to the next run started. The *bounds* on a block's own `intervalMs` are fixed at 250–60000 either way - they exist to stop a cadence that measures the scraper rather than the target. |
| `monitorMaxSeries`  | `8`       | 1–64         | How many metric names one run may chart from its monitored endpoint. A longer `series` list is a `400`. Raising it past 4 repeats chart colours (the categorical palette has four line-legible hues). |
| `monitorScrapeTimeoutMs` | `0`  | 0–60000      | How long one scrape may take before it counts as a gap. `0` derives it from the cadence in force for that run - three quarters of the interval. Set it explicitly for an exposition that is slow to render: one taking longer than three quarters of the interval fails *every* scrape otherwise, and the only other way out is a slower cadence, which also thins the data. A value longer than the interval a run scrapes at is shortened to it (logged once per run), because a scrape that outlives its own cadence puts the loop behind itself. |

#### Proxy settings

Four `network_performance` entries decide how **every** outbound request leaves the machine - design sends, load runs, SSE streams, OAuth token acquisition, `POST /import/fetch` (which spec re-fetch and `$ref` bundling ride) and the monitor scrape alike.
They are read at the point of use, so a change applies to the next transfer with no restart; a load run and a collection run read the policy **once at run start** and hold it for the run, because libcurl reuses a pooled connection only when its proxy configuration matches.

| Key | Default | Values | Effect |
|-----|---------|--------|--------|
| `proxyMode` | `environment` | `environment`, `system`, `manual`, `off` | Where the proxy comes from. `environment` is libcurl's own `http_proxy` / `https_proxy` pickup - what a terminal-launched engine already got, and what a desktop launch usually inherits nothing of. `system` uses `proxySystemUrl`, which the app resolves from the operating system. `manual` uses `proxyUrl`. `off` sends direct and **also** disables the environment pickup. |
| `proxyUrl` | `""` | curl-shaped URL | The proxy for `manual` mode: `scheme://user:password@host:port`. The scheme selects the kind (`http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`, `socks5t`); a scheme-less `host:port` means `http://`. Credentials in the URL become basic proxy authentication; write an `@` in the password as `%40` (libcurl ends the userinfo at the first `@`, so a URL with a second one before the host is a `400`). An `https` proxy is verified against the same trust as the target (the platform's anchors plus `customCaCertificates`) and the request's `verifySSL` - see [TLS trust settings](#tls-trust-settings). |
| `proxySystemUrl` | `""` | curl-shaped URL | The proxy for `system` mode, **written by the app, not typed by the user**. The Electron main process resolves the OS proxy through Chromium and stores the answer here at startup, when the machine wakes, and when the renderer sees the network change. Empty means nothing resolved - see the fallback below. Validated exactly as `proxyUrl` is, under every mode. |
| `proxyBypass` | `""` | hosts separated by commas, spaces or tabs | Hosts that skip the proxy, passed to curl's `NOPROXY`. Each entry is an exact host (`localhost`), `.suffix` (a domain and everything under it), a bare suffix, an IPv4 or IPv6 address written bare (`::1`), `ip/N` CIDR (`10.0.0.0/8`), or a single `*` that bypasses everything. A `400` refuses the shapes libcurl would take as a hostname no transfer dials, so the exemption would silently never apply: a `:port`, a `*` inside an entry (`*.example.com`, `local*`), a bracketed IPv6, a scheme, a path, or a whitespace or control character other than the comma, space and tab separators (a newline). Hostname characters beyond that are not validated. An entry already stored in one of those shapes (a hand-edited row) is left out of what reaches libcurl, with a warning naming it; the other entries stay. |

**`proxyBypass` and an inherited `no_proxy` interact by mode, deliberately.** libcurl consults the process's `no_proxy` variable whenever `CURLOPT_NOPROXY` is unset, so:

- Under **`manual`**, this list is the entire rule and is always written, empty or not.
  An empty list exempts nothing, and an inherited `no_proxy` is ignored.
  Anything else means a user who named a proxy in Settings has their traffic silently exempted from it by an ambient variable - which is the same invisible failure the mode exists to fix, and not hypothetical: a container exporting `no_proxy=...,127.0.0.1,...` bypasses a configured proxy for every local target and says nothing.
- Under **`environment`**, an empty list defers to `no_proxy` - "do what the environment says" includes the exemptions it names - and a non-empty one overrides it.
- Under **`system`** it follows whichever of those two the mode resolved to: the `manual` rule once a proxy is in force, the `environment` rule when nothing resolved.
- Under **`off`** there is no proxy for a bypass list to modify.

**`system` mode has two limitations, and both are disclosed rather than hidden.**
The engine cannot resolve an OS proxy itself - that answer lives behind Chromium's network stack, which libcurl sees none of - so the resolution is the app's and this setting is the channel:

- **PAC is resolved once, not per request.**
  A PAC script answers per URL and the engine cannot call back into Chromium for every transfer, so the app resolves against one probe URL and that answer applies engine-wide.
  A configuration returning different proxies for different URLs needs `manual`.
- **A headless engine falls back to `environment`.**
  With no app running, `proxySystemUrl` is empty and `system` behaves as `environment` does - not as `off`, because the environment pickup is the closest thing to "what this machine would do" that a daemon on its own has.
  An unusable stored value falls back the same way, with the reason logged.

`POST /config` enforces one cross-field rule these three have and the per-key validation cannot express: **`proxyMode: "manual"` requires a usable `proxyUrl`**, judged against the state the update would leave rather than against the keys in the body, so setting the mode alone is a `400` and so is clearing the URL while the mode is already `manual`.
A malformed URL is rejected under any mode; a *valid* URL stored while the mode is `off` is kept untouched, which is how a proxy is switched off temporarily without losing it.

A failure of the proxy hop is reported as its own error code, `PROXY_ERROR`, rather than as the target's:

- an unresolvable proxy hostname (not `CONNECTION_FAILED`, which would send people debugging an endpoint that was never reached);
- a proxy that is down, so connecting to *it* is refused (#3257).
  The refused socket is the proxy's whatever the target is, and the target was never dialled.
  This holds in every mode, `environment` included, because the decision reads libcurl's own record that a proxy was in the path (`CURLINFO_USED_PROXY`) and not the configured URL; the same refusal with no proxy in the path stays the target's `CONNECTION_FAILED`;
- a SOCKS handshake failure;
- a `4xx` answered to a `CONNECT`, which an `https://` target makes the proxy see - including the `407` a proxy demanding authentication returns, which curl reports as a generic receive error that would otherwise surface as `INTERNAL_ERROR`;
- a forwarding proxy's `407` on a plain `http://` request (#3257), which needs no `CONNECT` and so comes back as an ordinary response that read as the server's own answer.
  `POST /execute` (and the other single-request sends: the connection test, `pm.sendRequest`, the OAuth token fetch, the import fetch) reports it as `PROXY_ERROR` with status `0` and the message "The proxy answered 407 Proxy Authentication Required: check the proxy's credentials".
  A `407` is the proxy's only when a proxy carried the transfer and no tunnel stands between the engine and the server: a `407` a server sends directly, or through an established `CONNECT` tunnel, stays a response with its status.

**A load run keeps counting a proxy's `407` as a status**, as it does any other status the proxy returns on a forwarded `http://` request: the load path does not reinterpret completed transfers, so the run's status distribution shows the `407`s and its error counts do not.
A proxy that is down is `PROXY_ERROR` there too, since that mapping reads the failed transfer.

The code is **appended** to the error enumeration, so the numeric values stored in existing traces are unchanged.

Two more failures of the *target's answer* have their own codes (issue #2462): `TOO_MANY_REDIRECTS`, when the server redirected past the request's `maxRedirects` (usually a loop), and `BAD_CONTENT_ENCODING`, when the response declares a `Content-Encoding` that its bytes are not in or that this libcurl has no decoder for.
Neither is `CONNECTION_FAILED`, which would send people looking for a network fault when every hop had been answered.
`errorMessage` opens with a plain statement - `Too many redirects: the server redirected more than N times (see Maximum redirects). Maximum (N) redirects followed`, which is the engine's own text and ends there (the engine follows redirects itself), or `The response could not be decoded: the server sent Content-Encoding X.`, which is followed by libcurl's own text.
The codes are **appended** to the enumeration like `PROXY_ERROR`, so stored numeric values are unchanged, but a script that tested `err.code === 'CONNECTION_FAILED'` (`pm.sendRequest`) or `pm.response.errorCode === 'CONNECTION_FAILED'` for these two failures now sees the new spelling.
A load run records them under the error types `too_many_redirects` and `bad_content_encoding`.

A target that answers in something other than HTTP/1.x is `PROTOCOL_MISMATCH` (issue #3306), error type `protocol_mismatch`.
The usual case is an `h2c` server (HTTP/2 over cleartext) sent a request over `http://`: Vayu speaks HTTP/1.1 there whatever `httpVersion` says (the Protocol paragraph under [POST /execute](execute.md#post-execute)), and the server answers with its binary HTTP/2 preface, which libcurl reports as `Received HTTP/0.9 when not allowed`.
It is not `INVALID_URL`, which would send people to a URL that was fine.
`errorMessage` opens with `The server answered in a protocol other than HTTP/1.x:` followed by libcurl's text, and when the request asked for `http2` and the hop that failed was `http://` (after any redirect) it adds `HTTP/2 is only negotiated over https://; this server may speak h2c, which Vayu does not send`.
A scheme the transfer refuses, a redirect onto `ftp://` included, is still `INVALID_URL`.
The code is appended like the others, and a script sees it as `err.code` (`pm.sendRequest`) or `pm.response.errorCode`.

A file the request names that cannot be sent is `UNSENDABLE_FILE` (issue #3693), error type `unsendable_file`: every refusal of the file rule listed under [File references](request-body.md#file-references-binary-bodies-and-file-parts) (no file chosen, an unresolved `{{variable}}` in the path, an unreadable file, one outside the allowed folders).
The request is at fault and nothing was sent, so it is not `INTERNAL_ERROR`; the streaming and `POST /runs` answers keep their `unsendable_file` rule code.
The code is appended like the others, so stored numeric values are unchanged and a trace written before it still reads `INTERNAL_ERROR`.

A send still in flight when the engine shuts down is cancelled rather than waited on (issue #2683), and so is a `pm.sendRequest` one of its scripts is making: the send answers, and its trace records, `CANCELLED` with `errorMessage` `Request cancelled`, about a second after the shutdown began.

A buffered send whose caller hangs up before the answer is cancelled the same way (issue #3383), together with an OAuth 2.0 token it is fetching and a `pm.sendRequest` one of its scripts is making: the engine reads the connection every 100ms and the transfer ends at its next progress tick, about a second later.
The run is recorded **`stopped`**, never `completed`; its result row holds what the exchange reached, `CANCELLED` for a transfer that was cut.
A transient send records nothing, as always.
"Hangs up" is the connection reading end-of-stream, and TCP cannot tell that from a caller that only shut down its sending side, so a client that half-closes after its request is treated as gone: keep the connection open until the answer is read.
A streaming send (`stream: true`) is not watched: it is handed off at its `202` and outlives the call that started it, and [`POST /runs/:runId/stop`](runs.md#post-runsrunidstop) is what ends it.

Cookies are unaffected by any of this: libcurl owns the wire cookies and matches them on the **origin** host, never the proxy hop.

#### Default request headers

Five `network_performance` entries decide what Vayu adds to a request nobody wrote it into (issue #1229, and #2468 for the Expect header).
They are read at the top of a request or a run, so a change applies to the next send; a load run reads them once at run start, as it does the proxy policy.

| Key | Default | Values | Effect |
|-----|---------|--------|--------|
| `negotiateCompression` | `true` | boolean | Ask for a compressed response on a Send, a collection or scenario run, and a script's own `pm.sendRequest`. The value advertised is what *this* libcurl can decode, read off `curl_version_info` - `gzip, deflate` plus `br` and `zstd` where the build has them - and libcurl decodes the response before the engine sees it. Off sends no `Accept-Encoding` at all. |
| `loadNegotiateCompression` | `true` | boolean | The same decision for a load run, separate because compression is part of what a load test measures: off measures a server's uncompressed ceiling, on measures what its clients actually get. |
| `sendExpectContinue` | `false` | boolean | Let libcurl send `Expect: 100-continue` on a large body. libcurl adds that header on its own to an HTTP/1.1 body over 1 MiB (1048577 bytes and up) and then waits about a second for an interim reply a server that ignores the header never sends, so with this off the engine removes it with libcurl's `Expect:` removal line and the transfer sends the body at once. One key for a Send, a collection run and a load run alike. The removal line is not a sent header, so it is not in `requestHeaders`. |
| `correlationIdEnabled` | `false` | boolean | Send a header carrying a fresh identifier with every request, so one send - or one iteration of a load run - can be found in a server's log. Off by default: it is a header the target did not ask for. |
| `correlationIdHeader` | `X-Vayu-Request-Id` | header name | Which name that identifier goes out under. Vendor-namespaced by default so it collides with nothing a gateway defines; set it to `X-Request-ID` or `X-Correlation-ID` for infrastructure that reads one of those. `POST /config` refuses a value that is not a header name (RFC 9110 token), because a broken name would otherwise put a broken line on every request afterwards, and a name the engine derives itself (`User-Agent`, `Accept-Encoding`, `Content-Type`, and an `mcp` body's `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`), which would go out twice. |

Three rules hold for all of them, and for the `User-Agent` the engine has always added:

- **A header the request carries wins.**
  Nothing here overwrites a name the request already names, so a browser's `User-Agent`, a hand-typed correlation id, or an `Accept-Encoding: identity` is sent exactly as written.
  A request that names `Accept-Encoding` itself also gets no decoding: libcurl hands back what arrives, which is what typing that header asks for.
- **Any of them can be refused per send**, with `disabledDefaultHeaders` on [POST /execute](execute.md#post-execute) or [POST /runs](load-runs.md#post-runs).
- **None of them is stored.**
  They are applied at send time, so a saved request cannot carry a stale one.
  A request saved before this change is stripped of the rows an older app wrote into it, once, at startup: `X-Vayu-Version` always, an `X-Request-ID` whose value is a bare UUID, and a `User-Agent` whose value is a `Vayu/...`.
  A correlation id or a `User-Agent` someone typed is left alone.

The correlation id is generated **per transfer**, not per composition, so every iteration of a load run carries its own.

**`Expect` is the one default the engine takes away rather than adds.**
With `sendExpectContinue` off, a request that names no `Expect` gets libcurl's removal line, whatever its size or verb.
A typed `Expect: 100-continue` is the way to send one on purpose: it goes out as typed with the key off, and is recorded in `requestHeaders`.
A typed `Expect` with a blank value is sent empty, like any blank row (see [`requestHeaders`](execute.md#post-execute)), and recorded with the value `""`; libcurl adds no `100-continue` of its own beside it, so the body goes out without the wait and without a removal line.
With the key on nothing is appended, so libcurl decides (over 1 MiB, on HTTP/1.1), and the `Expect` row `GET /request-defaults` declares is the one a send refuses with `disabledDefaultHeaders`, which removes libcurl's line again.
With the key off that refusal changes nothing: the line is already removed.

**Every size the API reports is the bytes Vayu holds** - `bodySize`, a stored trace's `bodyBytes`, a load sample's `body_bytes`.
With negotiation on those are the *decoded* bytes, because libcurl decodes before the engine counts; with it off they are the identity response, which is the same number.
What crossed the network compressed is not measured, and `rawRequest` is where the negotiated `Accept-Encoding` line itself can be read back.

#### TLS trust settings

One more `network_performance` entry decides *who* the engine trusts, and it reaches the same six outbound paths the proxy settings do.

| Key | Default | Values | Effect |
|-----|---------|--------|--------|
| `customCaCertificates` | `""` | PEM text (`text` entry) | Certificate authorities to trust **in addition** to the ones this platform already trusts. Pasted content, not a path: a path breaks when the file moves and cannot be shown back in Settings. `POST /config` refuses text that holds no `-----BEGIN CERTIFICATE-----` block, and names a pasted private key for what it is. It then parses every certificate block with OpenSSL and answers `400` naming the first one that does not, counted from 1 (`certificate 2 of 3 does not parse`); only the parse is asked, never validity or expiry. |

The engine materializes the bundle as `ca-bundle.pem` beside its database and points `CURLOPT_CAINFO` at it, rewriting the file only when the setting's content changes.
A block that does not parse in a value stored before that check is left out of the file and logged (a warning naming the setting and the block's position), because OpenSSL abandons a bundle file at its first bad block and the platform's anchors would go with it.
**Native trust is preserved** - the mechanism differs by TLS backend, and each is stated rather than assumed:

| Platform | Backend | What the bundle does |
|----------|---------|----------------------|
| Linux | OpenSSL (default paths + `CURL_CA_FALLBACK`) | `CURLOPT_CAINFO` **replaces** the default bundle, so the materialized file is the platform's own anchors **concatenated with** the pasted ones. The system bundle is located the way curl locates it: `CURL_CA_BUNDLE` / `SSL_CERT_FILE`, then libcurl's compiled-in `cainfo`, then the standard distribution paths. |
| macOS | OpenSSL | Same as Linux, and the anchors are read from `/etc/ssl/cert.pem` and merged into the materialized file. `CURLSSLOPT_NATIVE_CA` is also set on **every** macOS handle, pasted CA or not: when a certificate does not verify against the file, the Keychain is asked, so a root or an admin-installed CA the Keychain trusts verifies with nothing pasted. |
| Windows | OpenSSL, selected explicitly (issue #851; Schannel before it) | The anchors live in the certificate store and Windows ships no PEM bundle to merge with, so the materialized file holds the pasted certificates alone and `CURLSSLOPT_NATIVE_CA` - set on **every** Windows handle, pasted CA or not - loads the store beside it. A machine that exports `CURL_CA_BUNDLE` puts a file back in reach and the merge runs there as it does on Linux. |

Three things make that table checkable rather than a claim.
The backend column itself is asserted on each CI platform - both its *name* and that this process **selected** it rather than inheriting whatever libcurl chose - so it is read off the build rather than out of a port file, the mistake that left the macOS row wrong until issue #818.
The selection is not a formality on Windows: the `curl` port's `http2` feature depends on `curl[ssl]`, which resolves to Schannel there, so that libcurl carries both backends and picks between them by reading `CURL_SSL_BACKEND` from the environment.
The engine names OpenSSL before curl initializes, which is what stops a stray environment variable from moving every request onto a backend where client certificates do not work at all.
Issue #858 tracks getting Schannel out of the build entirely.
`CURLOPT_CAINFO` is the one transport option a backend can refuse outright, so the engine checks the return code and logs an error naming the backend if it ever does - and the test suite asserts on every CI platform that this build's backend accepts it.
And where the anchors come from a file, the suite asserts they were actually found; where they come from the store, that the build accepts the flag that loads it.
Either way a merge with nothing to merge would narrow trust to the pasted certificate alone while this page still promised the opposite, so `NativeStoreVerificationTest` closes it on a wire: a public certificate has to verify with nothing pasted, and go on verifying once an unrelated CA is.

`CURLSSLOPT_NATIVE_CA` asks the backend to keep consulting the OS store.
It is set unconditionally on Windows, where it is the anchor source, and on macOS, where the Keychain backs the file; on Linux it is set whenever a bundle is in force, and the merge above is what carries the guarantee.
Apple's SecTrust, which the macOS Keychain check uses, refuses a `CURLOPT_CRLFILE`, so the engine never sets one: it would break every macOS send.

**What the Windows certificate store does not give you.**
OpenSSL reads it through the Windows crypto API rather than being the OS verifier, so three things Schannel did on its own do not happen:

- **Root certificates only.**
  Intermediates cached in the store are not supplied to the chain builder (curl 12155), so a server that does not send its full chain can fail on Windows where it verified before.
  Pasting the intermediate into `customCaCertificates` fixes it.
- **No on-demand root fetch.**
  Windows can download a missing trusted root when Schannel asks for one; nothing here asks, so only roots already in the store count.
- **No revocation through the store.**
  Schannel passed `CERT_CHAIN_REVOCATION_CHECK_CHAIN`; OpenSSL does not revocation-check the chain unless told to, and the engine does not tell it to on any platform - so Windows behaves like Linux and macOS here rather than being the strict one.

A certificate that still fails to verify fails at handshake time with libcurl's own `SSL_ERROR` - the validation on the way in is about the *shape* of the paste, deliberately, so a chain curl would accept is never refused by a parser of ours.

**A TLS connection that never answers is an `SSL_ERROR` too**, whatever code libcurl put on it.
The mapping needs that rule because the interesting refusals do not arrive as TLS errors: under TLS 1.3 the server's verdict about the *client* - a certificate it will not accept, or one it demanded and did not get - reaches us after our own handshake has finished, so libcurl reports the generic receive error of a connection that went away, carrying the alert in its message.
A key the stored passphrase does not open arrives as a generic argument error in the same way.
All three are `SSL_ERROR` rather than `INTERNAL_ERROR`, which would say the failure was ours.
The rule applies only where the mapping has no answer of its own, and only to an `https` transfer that produced no response line at all - so a `4xx`, a timeout, a refused connection and a proxy failure all keep the code they had (issue #802).

Per-request, `verifySSL: false` turns verification off for one endpoint entirely (see [POST /execute](execute.md#post-execute)); trusting the authority here is the answer that keeps verification on everywhere else.

**An `https://` proxy is a second TLS handshake with the same trust.** libcurl decides the proxy's certificate with options of its own (`CURLOPT_PROXY_CAINFO`, `CURLOPT_PROXY_SSL_OPTIONS`, `CURLOPT_PROXY_SSL_VERIFYPEER` / `_VERIFYHOST`) that do not inherit what the target's handshake was given, so the engine writes each of them from the same values as its target-side twin:
a proxy whose certificate a pasted authority signed verifies, and `verifySSL: false` covers the proxy leg as well as the target.
No client certificate from the registry is ever offered to a proxy - an entry names a host the user trusts with that identity, and a proxy is not it.
A proxy certificate that is refused is an `SSL_ERROR` whose message says the *proxy's* certificate was not accepted, so the target's is not blamed.

In-progress (`running`/`pending`) runs are never pruned, and neither are runs pinned as baselines (see [PUT /runs/:runId/baseline](runs.md#put-runsrunidbaseline)); neither kind counts toward `maxRunsRetained` or `maxDesignRunsRetained`.
Each cap counts only its own kind: load and collection runs under `maxRunsRetained`, design Sends under `maxDesignRunsRetained`; `runRetentionDays` applies to every kind.

### GET /request-defaults

What the engine will add to a request that names none of it - the set a client renders beside the request's own headers instead of re-deriving it from the config entries above.

```json
{
  "headers": [
    { "name": "User-Agent", "value": "Vayu/0.25.0", "generated": false },
    { "name": "Accept-Encoding", "value": "gzip, deflate", "configKey": "negotiateCompression", "generated": false },
    { "name": "X-Vayu-Request-Id", "generated": true, "configKey": "correlationIdEnabled" },
    { "name": "Expect", "value": "100-continue", "configKey": "sendExpectContinue", "generated": false }
  ]
}
```

The `Expect` row appears only while `sendExpectContinue` is on, under both scopes, and describes what libcurl may send above 1 MiB rather than a header on every request.

A default that is switched off is **absent** rather than listed as disabled.
`generated: true` means the value is made per send, so the row carries no `value` at all - an empty string would be a value a client would print.
`configKey` names the setting that governs the row, and is absent for the `User-Agent`, which is always added.

**`?scope=design|load` names the send the answer describes**, and defaults to `design`.
Compression is the one default the two resolve differently: a design send (a Send, a collection run, a script's own request) reads `negotiateCompression` and a load run reads `loadNegotiateCompression`, so with the two disagreeing the `Accept-Encoding` row is present under one scope and absent under the other.
A scope that is neither is refused with `400` and code `invalid_scope` rather than served the design answer, which would describe a run the caller is not asking about; an empty `?scope=` is absent rather than a scope of `""`, and answers for `design`.

### POST /config

Update one or more configuration entries.
Two body shapes are accepted:

**Batch** - update several keys at once:
```json
{ "entries": { "workers": "16", "defaultTimeout": "30000" } }
```

**Single** - update one key:
```json
{ "key": "workers", "value": "16" }
```

In both shapes, non-string values (numbers, booleans) are coerced to strings.
Each key is validated against its registered `type` and, for `integer` / `number` entries, its `min`/`max` range; `boolean` entries must be `"true"` or `"false"`; `enum` entries (e.g. `defaultHttpVersion`) must equal one of that entry's stored `options` values.
"Unknown" means outside this engine's own catalogue (see [GET /config](#get-config)) - a stored row from a different engine's build does not make a key known to this one.
Validation is all-or-nothing: if any key is unknown or out of range, nothing is applied and the response is `400` with the specific reason(s):

```json
{ "error": { "code": "invalid_config", "message": "'workers' must be at most 128 (got 9999)" } }
```

A body that does not parse, or nests deeper than 128 levels (see [Request bodies](index.md#request-bodies)), is a `400` with the same code.

**Success response:** `200` - the full updated entries array (same shape as `GET /config`) plus `"success": true`.

**The validation and the write are one lock scope, and the write is one transaction** (issue #1453):
a reader (`GET /config`, or an internal reader like the proxy policy resolver that reads `proxyMode` and `proxyUrl` as two separate calls) can never observe some of a batch's keys applied and the rest still stale, and a failure partway through the write leaves every row unchanged rather than the ones written before it.

## Workspace

### POST /workspace/backup

Write one compacted snapshot of the workspace database into `backups/` beside it, then prune older snapshots to `maxBackupsRetained` (issue #987).
Takes no body.

```json
{
  "path": "/home/someone/.local/share/vayu/db/backups/vayu-20260827-124932-118.db",
  "sizeBytes": 2097152,
  "createdAt": 1787745600000,
  "pruned": 1
}
```

| Field | Meaning |
|-------|---------|
| `path` | The snapshot written. The whole point of the response: restoring is a file copy you perform yourself |
| `sizeBytes` | Its size on disk. A compacted copy, so smaller than the live database |
| `createdAt` | When it was taken, epoch milliseconds - the stamp its file name carries |
| `pruned` | How many older snapshots retention removed in the same call |

**It runs SQLite's `VACUUM INTO`, which is why it is safe while the engine is working.**
Copying `vayu.db` by hand is not: the `-wal` beside it holds committed transactions the main file does not, so a hand copy is a database missing its most recent writes.
`VACUUM INTO` reads one consistent snapshot and writes a defragmented database complete on its own, and is read-only with respect to the workspace.

**A second backup while one is running is a `409`.**
Two concurrent copies would each write a whole second database - unbounded disk for a button someone double-clicked - and the second would race the first's retention pass.
Anything else that goes wrong is a `500` naming what SQLite or the filesystem refused; there is no success response with an empty path.

**Retention only removes files Vayu wrote**: this endpoint's `vayu-<stamp>.db`, and the `vayu-<stamp>-pre-v<N>.db` an update saves before it migrates the workspace, which counts toward the same `maxBackupsRetained` ([db-schema/startup-and-recovery.md](../db-schema/startup-and-recovery.md#the-copy-before-a-migration)).
A copy you put in that directory yourself is left where it is.
`0` keeps every snapshot.

**There is deliberately no restore endpoint.**
A running engine overwriting the database file it holds open is the failure this feature exists to prevent.
Restore by hand with the engine stopped - see [architecture.md](../architecture.md#restoring).
