---
description: >-
  The tables a run writes as it goes: metric ticks, monitor samples, results, stored bodies and the webhook inbox.
---

# Run samples, results and the inbox

## `metric_ticks`

The time series for a load test: **one wide row per persisted tick** (~1/s), written by the metrics producer thread.
Struct is `db::MetricTick`.
Auto-created by `sync_schema()`.

| Column      | Type       | Notes                                          |
|-------------|------------|------------------------------------------------|
| `id`        | INTEGER PK | Autoincrement                                  |
| `run_id`    | TEXT       | FK → `runs.id`                                 |
| `timestamp` | INTEGER    | Unix ms - the tick's single wall-clock sample  |
| `payload`   | TEXT       | JSON: the complete tick object (below)         |

`payload` **is** one `data[]` entry of `GET /runs/:runId/metrics` - the app's snake_case `LoadTestMetrics` shape, built once at write time by `vayu::core::build_metric_tick_payload` instead of being reassembled per request:

```json
{
  "timestamp": 1730000001000, "elapsed_seconds": 1.0,
  "requests_completed": 120, "requests_failed": 2,
  "http_errors": 0, "no_response": 2, "cancelled": 0,
  "current_rps": 118.4, "current_send_rate": 120.2, "window_avg_in_flight": 1.1,
  "window_avg_latency_ms": 8.9, "window_avg_queue_wait_ms": 0.2,
  "current_concurrency": 10, "send_rate": 120.0,
  "throughput": 118.4, "backpressure": 3, "error_rate": 1.66,
  "dropped_requests": 0, "skipped_requests": 0, "stalled_ms": 0.0,
  "bytes_sent": 4096, "bytes_received": 65536,
  "status_codes": { "200": 118, "0": 2 },
  "status_seconds": [ { "second": 0, "span": 1, "counts": [118, 0, 0, 0, 2] } ],
  "latency_p50_ms": 8.1, "latency_p95_ms": 20.4, "latency_p99_ms": 31.9
}
```

`requests_failed`, `http_errors` and `no_response` count errors by the one definition ([What counts as an error](../api-reference/metrics.md#what-counts-as-an-error)); the breakdown pair is absent from a tick an engine older than issue #2124 stored, whose `requests_failed` counted no-response failures only.
`cancelled` is the requests a user stop has cancelled so far, which none of the three counts (issue #2136); absent from a tick stored before that issue.

`current_rps`, `current_send_rate`, `window_avg_latency_ms` and `window_avg_queue_wait_ms` read the **trailing window** of the row's tick (`vayu::core::TrailingWindow`, issue #2393): at least the last second, divided by its actual span, from the differences of the run's cumulative counters across it.
They are the same values the live frame of that tick carries, so a chart drawn live and one drawn from these rows agree.
The two means are `null` for a window in which nothing completed.
The three keys besides `current_rps` are absent from a tick stored before that issue, whose `current_rps` was the completions since the previous row over the time since it.
No schema version marks the change: they are keys inside `payload`, which `sync_schema()` never reads.

`window_avg_in_flight` (issue #2821) is the same window's mean requests in flight: the time requests spent in flight during the window over its span (issue #3567), so a request open across the window counts whether or not anything completed.
Always a number, `0` for a window with nothing in flight.
A tick stored before issue #3567 holds the latency its window's completions carried over its span under the same key, which read `0` while a request longer than the window was open.
`current_concurrency` and `backpressure` beside it are instantaneous gauges (curl transfers active at the tick, and `RunContext::in_flight`), which a virtual user in a timer wait does not hold, so a run whose users wait in step aliases them between 0 and the user count.
Absent from a tick stored before the issue; like the keys above, no schema version marks it.

`status_seconds` (issue #2866) is the seconds the row's gate closed, each with the responses that **completed** in it by class (`vayu::core::StatusSecondCounter`):
`[{second, span, counts}]`, `second` counted from load start, the clock `elapsed_seconds` counts from since #2881, `span` `1`, and `counts` `[2xx, 3xx, 4xx, 5xx, error]`, where `error` is code `0` (no response) and any code outside 200-599, the classes the app's status chart draws.
A second is closed 250 ms after it ends, so a row usually holds one second, two when its gate's ~1 s cadence crosses two second ends, and `[]` when none closed since the last gate (always before the first second closes); across a run's rows the seconds run on from `0`, and a second nothing completed in is an entry of zeros.
The live gate frame of the same tick carries the same entries as `statusSeconds`.
The second still open when the run ends is stored nowhere, like its percentiles, and the seconds that close after the last row ride the final live frame only, so a run opened from History ends a point or two before the live chart did.
Absent from a tick stored before the issue, whose status chart keeps diffing `status_codes` between rows; like the keys above, no schema version marks it.
`status_codes` itself is unchanged, still the cumulative map.

Two consequences of the row being the tick:

- **Pagination is tick-aligned.**
  `GET /runs/:runId/metrics` pages rows, and a row is a whole tick, so a page boundary can no longer hand back a half-populated bucket (which row-paginating the retired EAV `metrics` table did every ~277 ticks).
- **`elapsed_seconds` is written with the row**, so it keeps counting across page boundaries instead of restarting at 0 on each page.

`elapsed_seconds` is the seconds since **load start**, the instant the report's `test_duration` is measured from, after the request is built and any `script.setup` has run (issue #2395).
It is the live stream's origin: a row's `elapsed_seconds` is the `elapsedSeconds` of the gate frame of the same tick (issue #2881).
The first row reads between `0` and about `1.0`: the 1 Hz gate counts from the metrics thread's start, so after a setup script the first stored gate can land anywhere up to one interval after load start.
No row is stored before load start: a gate that closes while setup is still running sends its live frame and writes nothing.
The cumulative rates in the same row, `send_rate` and `throughput`, are requests sent and completed since load start, divided by the same `elapsed_seconds`.
Rows an engine older than issue #2881 stored count from the run's first stored row instead, which reads `0` and sits about one second behind the live clock; nothing rewrites them, and such a run may also hold rows written during setup.
Ticks an engine older than issue #2395 stored divided their rates by the time since the run was registered, so a run with a slow setup understated both in its early rows.

Latency percentiles in a tick (`latency_p50_ms`, `latency_p95_ms`, `latency_p99_ms`) cover the **row's second**: every 100 ms window the `hdr_interval_recorder` handed back since the previous row, merged as histograms before the percentile is read (issue #2385).
The row stores no sample count; a second with no completion stores **none of the three keys** (issue #2386), absent rather than `null` because the run export types them as numbers.
Rows an engine older than issue #2386 stored keep `0` for such a second: nothing rewrites them, so a reader of an older run still meets a `0` that means "no completion", not "answered in 0 ms".
The whole-run cumulative percentiles live in [`runs.summary`](runs.md#runs), never here.
The partial second between the last row and the end of the run is stored nowhere: it reaches only the final live frame.
Rows an engine older than issue #2385 stored hold the **last 100 ms window** of their second instead, about a tenth of its completions.

---

## `monitor_samples`

The **server vitals** a run scraped from a target endpoint it was configured to watch (`monitor` on `POST /runs`): one row per successful scrape, written by the run's own scrape thread.
Struct is `db::MonitorSample`.
Auto-created by `sync_schema()`.

| Column      | Type       | Notes                                          |
|-------------|------------|------------------------------------------------|
| `id`        | INTEGER PK | Autoincrement                                  |
| `run_id`    | TEXT       | FK → `runs.id`                                 |
| `timestamp` | INTEGER    | Unix ms - when the engine scraped              |
| `payload`   | TEXT       | JSON: the sample object (below)                |

`payload` **is** one `data[]` entry of `GET /runs/:runId/monitor`, and the `data:` of a live `monitor` SSE frame - one shape for both, built by `vayu::core::build_monitor_sample_payload`:

```json
{
  "timestamp": 1730000001000,
  "series": { "node_cpu_seconds_total": 3.75, "process_resident_memory_bytes": 1048576 }
}
```

**Its own table rather than wider `metric_ticks` rows.**
That payload's key set is the `GET /runs/:runId/metrics` contract, pinned by `stats_route_test.cpp`; and a scrape lands on the user's own cadence (250-60000ms), which does not line up row for row with the 1/s tick.
A scrape that read nothing writes no row at all - a stored sample with no readings would draw a line through a hole in the data - so gaps are counted in the run summary instead, under `monitor.failures` (no 2xx answer) or `monitor.noMatchScrapes` (a 2xx answer carrying none of the requested names).

Deleted with the run by the same cascade (`remove_run_cascade_locked`).

---

**The EAV `metrics` table this replaced is gone.**
It stored one row per (`run_id`, `name`, `timestamp`) sample, ~20 rows per second of a run, and was kept read-only after the switch so runs recorded by an older engine still rendered.
Retention deletes those runs within `runRetentionDays`, so its read path outlived its data and is gone (#177), with the `MetricName` enum and `db::Metric`.
`sync_schema()` only syncs the tables the storage still declares - it never drops one the storage stopped declaring - so `Database::init()` issues an explicit `DROP TABLE IF EXISTS metrics`, and an upgraded database sheds the table and its rows on first start.
The freed pages return to SQLite's freelist for reuse; the file itself shrinks only when the guarded reclamation at the end of `Database::init()` decides they are worth a rewrite - see [Reclaiming freed pages](startup-and-recovery.md#reclaiming-freed-pages).

---

## `results`

Individual request outcomes - all errors plus sampled successes (sampling is configurable in `MetricsCollector`).
Struct is `db::Result`.

| Column        | Type       | Notes                                                        |
|---------------|------------|--------------------------------------------------------------|
| `id`          | INTEGER PK | Autoincrement                                                |
| `run_id`      | TEXT       | FK → `runs.id`                                               |
| `timestamp`   | INTEGER    | Unix ms                                                      |
| `status_code` | INTEGER    | HTTP status, or **0 for transport errors** (so totals reconcile) |
| `status_text` | TEXT       | Wire reason phrase or canonical IANA text                    |
| `latency_ms`  | REAL       | **Perceived** latency (`completion − submitted_at`), not wire time. [Details](#latency_ms-in-full) |
| `error`       | TEXT       | Error message for failures; empty on success                 |
| `trace_data`  | TEXT       | JSON (headers/body/timing breakdown) - design mode + errors + slow samples |

A load run's captured response headers and bodies are **not** here - they live in [`result_bodies`](#result_bodies) / [`body_blobs`](#body_blobs).
That split is load-bearing: `Database::get_results` loads every row for a run with no limit and `calculate_detailed_report` JSON-parses each `trace_data` on every report fetch of a finished run.
At ~200 bytes per trace that is free; with bodies inline it would be megabytes read and parsed per fetch, to compute aggregates that never look at a body.
The report of a load run that is not terminal yet reads none of these rows (#2659): it is polled while the run is in flight, and takes its counts from the run's in-memory collector until the status turns terminal.

**Written in chunks.**
A load run's results, with their [`result_bodies`](#result_bodies) rows and the [`body_blobs`](#body_blobs) those introduce, are written by `Database::add_results_batch` in chunks of `RESULTS_WRITE_CHUNK_ROWS` (250) results, one transaction each, staying off the DB mutex for 1 ms between chunks (#2548):
the mutex is not fair, and a writer that re-locks at once wins it back from the reader it just woke.
A reader that lands during the flush waits for one chunk (about 7 ms in a Release build, 21-35 ms for the one whose commit runs the automatic WAL checkpoint) rather than the whole write, and one that reads this table may see the run's results part-written.
A report poll waits for neither: its one read, the run row, takes no DB mutex ([`runs`](runs.md#runs), #2679).
A body row always commits with its result; a failure part-way keeps the chunks already committed.
Blob dedup spans the whole flush, not one chunk.

`trace_data` timing keys are all in ms and carry the `Ms` suffix: `totalMs`, `wireMs`, `queueWaitMs`, `dnsMs`, `connectMs`, `tlsMs`, `firstByteMs`, `downloadMs`.
`totalMs` is perceived latency; `wireMs` is libcurl's `CURLINFO_TOTAL_TIME` less its wait for a connection slot (#2394); `queueWaitMs = totalMs − wireMs` is time spent queued before the wire, inside the generator or in libcurl (see [the split](../api-reference/execute.md#post-execute)).
A buffered design send adds a ninth, **`engineMs`** (#2132):
Vayu's own cost for that exchange, the handler's elapsed time less `wireMs`, script time and an OAuth 2.0 token fetch, taken before the write (see [One timing convention](../api-reference/execute.md#post-execute)), and a tenth, **`scriptMs`** (#3676): the script time `engineMs` leaves out (pre-request, test and `pm.sendRequest`, `0` with no script), not part of `totalMs`.
Only the design writer and the scenario step writer store `scriptMs`, and only the design writer stores `engineMs`.

**The writers store different subsets, at different nesting**, so read the one you need rather than assuming all eight are there and flat (`engineMs` and `scriptMs` aside, above):

| Writer | What lands in `trace_data` |
|--------|----------------------------|
| Load run, success sample (`load_strategy.cpp`) | timing only, flat, all eight keys. Written for a completion the 1-in-`success_sample_rate` sampler selects (only while `save_timing_breakdown` is on)... [Details](#load-run-success-sample-in-full) |
| Load run, error (`load_strategy.cpp`) | an error envelope (`error_type`, `message`, `request_number`) with the eight keys **nested under `timing`**, present whenever `totalMs > 0`... [Details](#load-run-error-in-full) |
| Design mode (`record_design_result` in `execution.cpp`) | all eight keys flat, unconditionally - the same set the live `/execute` response carries... [Details](#design-mode-trace-in-full) |
| Load run, script validation (`store_validation_failures` in `run_manager.cpp`) | not a captured request: the one synthetic row the post-run replay of the un-inlined `script.post` elements leaves when an assertion failed... [Details](#load-run-script-validation-in-full) |

| Scenario run, one row per step execution (`core/scenario_runner.cpp`) | the design-mode writer's trace exactly - it *is* `build_result_trace` - plus five keys naming the step... [Details](#scenario-run-one-row-per-step-execution-in-full) |

A **streaming** design run (`POST /execute` with `"stream": true`, issue #573) stores the stream's bytes once, as `response.body` (issue #3770, up to `maxDesignResponseBodyBytes` and then `maxTraceBodyBytes`, with `bodyCapped` / `bodyTruncated` saying which cut a prefix), and adds one node the others never carry:
**`events`**, a sidecar holding only what the bytes cannot say - `totalEvents` (every event received, whatever was kept), `endReason`, `maxEventBytes` (the per-event cap the live parser ran under) and `receivedAt`, an array of one arrival time (epoch milliseconds) per event, for the first `sseMaxStoredEvents` events, plus **`startedAt`** (#3805):
when the transfer began, in epoch milliseconds on the clock `receivedAt` reads, stamped before the first redirect hop.
It is absent for a stream refused before its transfer began and for a row stored before the key, never written as `0`.
The list is not stored (#657): every route that serves a stored trace parses it back from `response.body` with the same `SseParser` (`expand_stored_stream_events`) and serves `events` as `items` (each `event` / `data` / optional `sourceId` / `receivedAt`, and `dataTruncated` + `dataBytes` on one that hit the per-event cap, at most one per `receivedAt` and never past `totalEvents`),
`totalEvents`, `eventsTruncated` (true when the list is shorter than `totalEvents` or the body is a prefix), `endReason` and `startedAt` when the row has one.
An item's `isError` (#3996) is derived from the body on the same read and never stored; [POST /execute](../api-reference/execute.md#post-execute) states the rule.
A row stored before #3770 holds an empty body and the `items` list itself, and is served as stored.

A design send or a scenario step whose scripts called `pm.sendRequest` carries **`scripts.scriptRequests`** (issue #3633): one record per call in execution order, each in the design-mode trace shape above (`request`, `response`, `error_type` / `error_message`, the eight timing keys) plus `source`, `scope`, `startedAt`, `status` and `statusText`, and without `rawRequest`.
Unlike the trace around them these records are **masked when written** -
a credential header's value is `"<redacted>"` (the challenge headers `WWW-Authenticate`, `Proxy-Authenticate` and `Authentication-Info` excepted),
a URL's credentials read `<redacted>` rather than a blank (see [POST /execute](../api-reference/execute.md#post-execute)) - and their bodies share one `maxTraceBodyBytes` between them, applied when the `scripts` node is built, because the live answer is the same object; `cap_trace_bodies` does not reach them here either.
A sequential scenario run's `runs.summary.lifecycle` rows carry the same records for its setup and teardown scripts.
A load run stores none, and a row stored before the field has no key.

The `request` node also carries **`rawRequest`** - the message the transfer actually put on the wire, the same string the live [`POST /execute`](../api-reference/execute.md#post-execute) response returns (issue #348).
It is what a restored raw-request view reads, because it is the only copy that carries what libcurl added on our own behalf: the [cookie jar](../architecture.md#cookie-jar)'s `Cookie` line, `Accept`, the real `Content-Length`.
Values in it are **not redacted**, matching the live field's contract - it lands in the same node that already stores the resolved `Authorization` header among `request.headers` (see [Security](../architecture.md#security) for why this column and `runs.config_snapshot` answer differently).
The key is **absent** on a step that sent nothing (a `pm.execution.skipRequest()`) and on every row written before #348, so a reader falls back to rebuilding the view from `method`/`url`/`headers`/`body` - `restore-response.ts`'s `sentSide` is that reader.

The `request` node carries a second header map, **`sentHeaders`** - the record of what the transfer issued, the same map the live [`POST /execute`](../api-reference/execute.md#post-execute) response returns as `requestHeaders` (issue #664).
It is `headers` minus the entries the transfer suppresses (a `form-data` `Content-Type`, which libcurl writes itself with the boundary) and a blank `Content-Type` or `Cookie` row, which is not sent (any other blank row is sent empty and recorded as `""`, issue #3220), plus what the engine derives at send time:
the body-implied `Content-Type` and the [default headers](../api-reference/health-config.md#default-request-headers) this send added - the `User-Agent`, a negotiated `Accept-Encoding`, a correlation id where one is switched on.
None of those is written into the request row itself (issue #1229): they are applied per send, so a stored request cannot carry a stale one.
Both maps are stored because both are read, and they answer different questions - `sentHeaders` is what the response pane's sent-headers disclosure means, while `headers` is the request as *composed*, which is what a pre-request script saw and what `design-run-seed.ts` reseeds a request tab from.
Both are one value per name: a name the request carries on more than one line (issue #2466) is stored with its values joined by `", "` (a `Cookie`'s by `"; "`), under the first line's spelling.
Beside them, **`sentHeaderLines`** is the sent record unfolded - one `{name, value}` entry per line in wire order, the live response's `requestHeaderLines` - written whenever `sentHeaders` is.
Values are **not redacted**, same contract as `rawRequest` beside it.
Both sent keys are **absent** on a step that sent nothing, `sentHeaders` on every row written before #664 and `sentHeaderLines` on every row written before #2466, so a reader falls back to `sentHeaders` and then to `headers`.
The load-run writers store no sent record at all - the load driver passes `nullptr` for it, to keep an allocation off the hot path - so a sampled capture's replay reads the composed map either way.

The `request` node also names what auth wrote (#1835): **`authQueryParam`** (string), the raw unencoded name of the query parameter `apply_auth` appended to `url` for an API key with `in: "query"` or an OAuth 2.0 token placed in the query, and **`authHeaders`** (array of strings), the header names an API-key block filled.
They exist because the URL and `rawRequest` cannot say which query parameter is a credential, so a reader that masks one (the MCP server) has nothing to go on without them.
Each is **absent**, never empty, when auth wrote none of that kind and on every row written before #1835; the stored `url` and `rawRequest` stay raw beside them.
The live `POST /execute` answer carries the same two keys at its top level (#1845), written by the same function.
That function also writes **`authNotice`** (string, #2474) when the request's auth mode is one Vayu stores but does not execute (`digest`, `aws`, `ntlm`, `hawk`, `oauth1`, `edgegrid`, `jwt`): the request went out without authentication and the notice says so, naming the mode.
It says so too for a bearer token or API key name that is empty, which writes nothing (#3203).
It is also written when an OAuth 2.0 token placed in the header yielded to the request's own `Authorization` header and was not fetched (#3202).
Absent when empty, on the same rule.

The design-mode `request.body` and `response.body` are **capped at `maxTraceBodyBytes`** (config, `data_retention`, default 5 MiB) before storage, so downloading one 50 MB response does not live in SQLite forever.
`request.rawRequest` ends with that same body and is capped to the same limit, **body half only** - its header block is never cut, being the reason the field is stored at all.
When a body is cut, its node gains two keys:

| Key on `request` / `response` | Type | Meaning |
|-------------------------------|------|---------|
| `bodyTruncated`               | bool | Present and `true` only when the stored `body` is a prefix, not the whole body |
| `bodyBytes`                   | int  | The **original** body length in bytes; the stored `body` is at most the first `maxTraceBodyBytes` of it (see below for where the cut lands) |

`response` carries `bodyBytes` cut or not (#3423), written by `build_result_trace` before the cap, which keeps it; a `request` carries it only when cut.
On every response it is a byte count, which a reader cannot recount from `body` (a JSON string's length is not its UTF-8 size):
the length the engine held, which for a `bodyCapped` response is the prefix the read cap kept, and for a streaming run the bytes the server delivered (#3238), which can exceed what `body` holds (at most `maxDesignResponseBodyBytes`, a `text/event-stream` reply's bytes included since #3770; a row stored before #3770 holds none for one).
A row stored before #3423 carries it on `response` only when cut or streamed.

A `response.body` that is not text (not valid UTF-8 over its whole length, or carrying a NUL) is stored as its base64, and only then does `response` carry **`bodyEncoding: "base64"`** (#2458):
the same decision and spelling the live `POST /execute` answer makes for `bodyRaw`, including that a body the read cap cut (`bodyCapped`) is judged, and stored as text, without an incomplete last UTF-8 character.
Absent means the stored `body` is the text itself, which every row written before the key holds.
Such a body is capped by its decoded bytes, cut at a multiple of three so the stored slice still decodes, and its `bodyBytes` counts decoded bytes.

A text body's cut is on a character boundary (#3423): an incomplete last UTF-8 character the byte count would leave is dropped (`without_incomplete_utf8_tail`), so the stored `body` can be up to three bytes shorter than the cap, and a reopened body never ends in a U+FFFD the server did not send.
`rawRequest`'s body half is cut the same way.
A header value off the wire can still carry a byte that is not UTF-8, so `record_design_result` dumps the trace with `error_handler_t::replace`, turning it into U+FFFD rather than throwing.
The cap is applied by `vayu::json::cap_trace_bodies` (`utils/json.cpp`) to the trace `build_result_trace` (`http/request_exchange.cpp`) produces.
It applies to the design-mode writer and to the scenario runner, which shares that trace builder - the load-run writers store timing/error envelopes, not bodies.

That design-mode subset is what rebuilds the request builder's response pane (Timing tab included) after a restart - see `app/src/modules/request-builder/utils/restore-response.ts`, which surfaces `bodyTruncated`/`bodyBytes` as a "body truncated for storage" notice, and restores a failed exchange that kept its `response` node as the failed exchange with the server's headers beside its error.

A design run has exactly one `results` row.
`GET /runs/:runId` serves it (as `result`) alongside the run itself, in addition to `GET /runs/:runId/report`'s `results` array - the same row, read by two routes for two different callers.

### `latency_ms` in full

On a load run's error row, the time until the transfer gave up (#2412); `0` for a request with no duration, which a real `0` reading cannot be told apart from (see [Latency population](../api-reference/metrics.md#latency-population))

### Load run, success sample in full

...**or** one that crossed `slow_threshold_ms` (which also adds `isSlow` / `thresholdMs`, and is stored whether or not the breakdown toggle is on).
The two have separate retention budgets - `max_success_results` and `max_slow_results` - and an outlier never consumes a sampling slot.
A **scenario** load run started with `scenario.data` adds **`dataRowIndex`**, the row that iteration bound - the only per-result record of it, since a scenario load run stores no per-step rows.

### Load run, error in full

...plus **`dataRowIndex`** for a scenario load run given `scenario.data`.
A `data_binding_failed` error is written for a request that was never sent at all - a `{{data.column}}` naming a column its row does not carry - so it has no timing.

### Design mode trace in full

...so a restored response shows exactly what the live one did (a skipped phase is stored as `0`) - plus flat **`engineMs`** and **`scriptMs`** for a buffered send, the one value each the live `timing.engineMs` / `timing.scriptMs` returned; both absent for a streaming send, an auth-failure row and any row stored before #2132 (`scriptMs`: before #3676).
Written on **every** single request, alongside a nested `request` object plus `error_type` / `error_message` when the exchange failed and `response` when it did not.
The two can coexist (#3423): every driver reports a failure at status 0 (`mark_failed`, the stream's `settle_end_reason`), and one that came after a header block arrived (an undecodable body, a timeout mid-body, a redirect limit, a proxy's refusal) keeps its whole `response` node beside the error, as the live answer shows it, so `response` is not a success flag.
A failure that received no header block (a refused connection, an unresolved host, a failed handshake) has no `response` node; a proxy's answer counts as one, so headers a proxy sent on its tunnel are kept too.
The `response` node carries `headers` (the folded, lower-cased map), `headerLines` (#2460: the lossless `{name, value}` list in wire order with `Set-Cookie` per line, written only when non-empty - absent on a load sample and on any row stored before the field, so a reader falls back to `headers`),
`redirects` (#2461: the followed 3xx hops as `{status, statusText, headerLines, url, schemeDowngrade}` - `url` the request that hop answered with its credential query values written as `<redacted>`, `schemeDowngrade` true when it went over `https` and the next hop over `http` (#2949) -
written only when non-empty - absent when nothing was followed and on any row stored before the field; a hop stored before #2949 lacks `url` and `schemeDowngrade`), `body`, `httpVersion` -
the negotiated protocol, `""` when nothing was negotiated, same convention as the live `/execute` response (see [POST /execute](../api-reference/execute.md#post-execute)) - and `httpVersionDowngraded`, true when the request asked for HTTP/2 and got something older; a row written before either field existed simply has no such key, so `restore-response.ts` must default both.
Rows written by older engines omitted zero-valued phases and all of `totalMs`/`wireMs`/`queueWaitMs`, so readers must default missing keys (perceived total also lives in the `latency_ms` column).

### Load run, script validation in full

...(`status_code` 0, `error` `Script validation failures`; none is written for a run that failed nothing).
`trace_data` is `{failures, failureCounts, failuresDistinct, totalFailed, totalPassed}`.
`failures` holds each **distinct** failure message once, in first-seen order, at most 10 (`MAX_FAILURE_MESSAGES`); a scenario step's name prefixes it (`step name: assertion: message`) and is part of its identity.
`failureCounts` is parallel to `failures`: how many times each failed across the sampled responses.
`failuresDistinct` is every distinct message the replay saw, kept or not, so `failuresDistinct - len(failures)` were turned away.
`totalFailed` / `totalPassed` count assertions, each occurrence once, so the counts sum to `totalFailed` unless messages were turned away.
`failureCounts` and `failuresDistinct` are absent on a row stored before #3127, which also repeated a message once per sample; a reader falls back to a count of 1 each.
The number of responses replayed is the report's `testValidation.samplesTested`, not stored here.
`trace.failures` is the only field that tells the row from a captured sample.

### Scenario run, one row per step execution in full

...`iteration` (0-based), `stepIndex`, `stepName`, `requestId` and `outcome` (`passed` / `failed` / `skipped` / `errored` / `stopped`, the last a step a Stop or shutdown cut short, #3397),
a flat **`scriptMs`** (#3676: the step's pre-request and test script time, `pm.sendRequest` included, `0` for a step with no script, absent for a row that could not bind and on a row stored before the key), and **`dataRowIndex`**, present only for a run given `scenario.data` - the row that iteration bound, which is the only record of *which* row a wrapped pass re-used.
The rows themselves are never stored; the snapshot keeps the row count (`dataRowCount`) plus the file's name and content hash (`dataFileName`, `dataFileHash`), never its path or rows.
A `skipped` row - a pre-request script called `pm.execution.skipRequest()` - carries the `request` node and **no `response`**, because nothing was sent; `restore-response.ts` already answers `null` for that shape rather than building a hollow 0-byte response.
Bodies are capped the same way.
The row count is bounded by **`maxScenarioStoredSteps`** (config, `data_retention`, default 5000; `0` = unlimited), biased so that every step that failed, errored or was skipped is kept and successes, with `stopped` steps, fill the remainder - what was thinned is reported in `runs.summary`, never silently.

---

## `result_bodies`

The response captured for one sampled **load-run** result, one-to-one with a `results` row.
Struct is `db::ResultBody`.
Read only by [`GET /runs/:runId/samples`](../api-reference/runs.md#get-runsrunidsamples); nothing on the report path touches it.

| Column         | Type       | Notes                                                              |
|----------------|------------|--------------------------------------------------------------------|
| `result_id`    | INTEGER PK | The `results.id` this exchange belongs to (not autoincrement)      |
| `run_id`       | TEXT       | FK → `runs.id`; what the run cascade and the endpoint filter on    |
| `headers`      | TEXT       | JSON object of the response headers, as received                   |
| `blob_id`      | INTEGER    | FK → `body_blobs.id`, or **0** when no body was stored             |
| `body_bytes`   | INTEGER    | Size of the body **as received**, before any truncation            |
| `truncated`    | INTEGER    | 1 when the stored bytes are a prefix (`maxSampleBodyBytes`)        |
| `binary`       | INTEGER    | 1 when the body was stored as a descriptor rather than as text     |
| `content_type` | TEXT       | The response's `Content-Type`, `""` when it sent none              |
| `stream_events` | INTEGER   | Events the transfer delivered when it was a **stream** (its reply announced `text/event-stream`, #3771); NULL otherwise, and NULL on every row written before 0.17.2 |
| `stream_text_path` | TEXT   | The `streamTextPath` the streamed sample's request declared... [Details](#stream_text_path-in-full) |

**Which completions get a row.**
Not a uniform sample - a uniform slice of a 30M-request run is a thousand identical 200s.
Three buckets, all decided before anything is copied:

| Bucket | Bound |
|--------|-------|
| Every error | `maxStoredErrors` (the error store's own cap) |
| Slow outliers | `max_slow_results`, the existing slow-request reservoir |
| The first `EXEMPLARS_PER_STATUS` (3) of each distinct status code | `max_exemplar_results` (64), and unlike its neighbours **not** a reservoir - an exemplar that gets displaced is not an exemplar |

The buckets overlap, and the overlap resolves toward the *other* store: an outlier that is also one of its status code's first three stays charged to the slow budget, and a sampled completion stays charged to the sampling budget.
The exemplar store holds only what no other budget wanted.
Claiming an exemplar is what decides that a **body** is captured, separately from which budget pays - so a completion that is both sampled and an exemplar is stored as a sample and still keeps its body.

**`stream_events` is a count, not a list.**
The stored body of a streaming sample already *is* the `text/event-stream` bytes, so [`GET /runs/:runId/samples`](../api-reference/runs.md#get-runsrunidsamples) parses the events back out of it with the same `SseParser` the live path feeds rather than storing a second copy that could disagree with the first.
What a reader cannot recover from those bytes is how many events the transfer actually delivered - the body may be a prefix - so that one number is stored beside them.
NULL means "this was not a stream" (a 429 in JSON answering a streaming request is not one), which is why the column is nullable rather than defaulted to 0.
A streamed design Send holds to the same rule in its trace (#3770): its `events` sidecar's `totalEvents` plays this column's part beside the stored body, with the arrival times only a live consumer has.

A uniformly sampled success (`success_sample_rate`) is deliberately body-less.

**Budgets.**
`maxSampleBodyBytes` (config, `data_retention`, default 32 KiB) caps a single body; `maxSampleBytes` (default 2 MiB) is the whole-run budget.
Once the run budget is spent, samples keep their headers and metadata and lose only their bodies - the row then has `blob_id = 0` with `body_bytes > 0`, and `runs.summary`'s `sampling.sample_bodies_dropped` counts them, so the UI can say the set is incomplete rather than presenting a biased subset as the whole story.
Both defaults are far below design mode's `maxTraceBodyBytes` (5 MiB): a design run stores one exchange the user asked for, a load run stores tens nobody asked for individually.

**Binary bodies.**
Since issue #1229 the engine negotiates compression by default and libcurl decodes what it negotiated, so a gzip response is stored decoded - but a request carrying its own `Accept-Encoding`, or a run with `loadNegotiateCompression` off against a server that compresses anyway, still yields compressed bytes; images and protobuf arrive that way regardless.
Those are stored as a descriptor (`binary = 1`, `blob_id = 0`, with `body_bytes` and `content_type`), never as text - `error_handler_t::replace` would keep `dump()` from throwing and hand the reader a mojibake that reads like a real response.
The rule is `vayu::core::looks_binary` (`core/sample_capture.cpp`): a content type that is not text-shaped, or a bounded prefix that is not valid UTF-8 / contains a NUL.

**No redaction.**
Captured data is stored verbatim, consistently with design-mode traces, which already store request headers as sent.
A response `Set-Cookie` is captured along with everything else.
The mitigation is the run's own marker - `sampling.response_bodies_captured` in `runs.summary` - which the Samples tab reads to warn, plus the run cascade below, which makes `maxRunsRetained` (the load and collection run cap) the expiry for anything credential-shaped a capture picked up.

**Per-run request.**
There is deliberately no per-sample request copy: a load run's request is constant across iterations and already lives in `runs.config_snapshot`, and the event-loop path never populates `Response::request_headers` at all (only the synchronous `client.cpp` does).

### `stream_text_path` in full

...so the served list derives each event's `text` and the joined `streamText` from the stored bytes; NULL for none, and on every row written before schema version 11 (issue #3773).
Per row because a collection run's steps each declare their own and a sample names no step

---

## `body_blobs`

One row per **distinct** captured body within a run - the dedup table.
Struct is `db::BodyBlob`.

| Column    | Type       | Notes                                                            |
|-----------|------------|------------------------------------------------------------------|
| `id`      | INTEGER PK | Autoincrement; `result_bodies.blob_id` points here               |
| `run_id`  | TEXT       | FK → `runs.id`; scopes dedup to one run                          |
| `hash`    | TEXT       | Lowercase hex SHA-256 of `content` (`vayu::core::body_digest`)   |
| `content` | TEXT       | The stored bytes, already truncated to `maxSampleBodyBytes`      |

**`content` is read back whole.**
Capture classes a body as text from its first 1024 bytes alone, so a body with a zero byte further in is stored here as text, with all its bytes, and reads back with all of them through the same `db::BodyBytes` mapping `inbox_requests.body` uses (#3159).
The column is still `TEXT` and the write always bound the full length, so rows stored before the mapping read whole too.
`GET /runs/:id/samples` lists such a body as base64 ([`bodyEncoding`](../api-reference/runs.md#get-runsrunidsamples)).

Load-test responses are overwhelmingly identical, so 1000 samples of one 2 KiB body store 2 KiB, not 2 MB.
The digest is taken over the **stored** (already truncated) bytes: two bodies that differ only past the truncation point are byte-identical as stored, and storing them twice would be storing the same row twice.

Dedup is scoped per run rather than globally so that deleting a run deletes its blobs with no cross-run refcount to maintain.
Both tables are removed by `remove_run_cascade_locked` - bodies before the results they hang off, so a delete interrupted between the two leaves results without bodies rather than body rows pointing at nothing.

Both tables are new in 0.15.0.
`sync_schema()` creates new tables outright, so there is no migration: an existing database picks them up on the next startup and older runs simply have no rows in them.

---

## `inbox_requests`

What a [webhook inbox](../api-reference/inbox.md#webhook-inbox) listener captured.
Struct is `db::InboxRequest`.

| Column           | Type       | Notes                                                            |
|------------------|------------|------------------------------------------------------------------|
| `id`             | INTEGER PK | Autoincrement; also the SSE event id on `GET /inbox/:id/live`     |
| `inbox_id`       | TEXT       | The inbox that recorded it - **not** an FK; inboxes are in memory |
| `received_at`    | INTEGER    | Unix ms                                                          |
| `method`         | TEXT       | Any verb cpp-httplib routes (GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS) |
| `path`           | TEXT       | Raw path as received (percent-escapes kept), no query            |
| `query`          | TEXT       | Raw query string, without the `?`                                 |
| `headers`        | TEXT       | JSON object; a repeated name is joined with `, `                  |
| `body`           | TEXT       | Stored bytes, truncated to the `inboxMaxBodyBytes` setting (default 64 KiB) |
| `body_bytes`     | INTEGER    | Size **as received**, which exceeds `length(body)` when truncated |
| `body_truncated` | INTEGER    | 1 when `body` is a prefix                                         |
| `remote_addr`    | TEXT       | Peer address the request arrived from                             |

**`body` is read back whole.**
A capture holding a zero byte (`abc\0def`) is stored with all its bytes and lists with all of them - as base64, since NUL is never text - through the same `db::BodyBytes` mapping `request_examples.body` uses (#3112).

**Bounded as it is written.**
`add_inbox_request` inserts and trims in one transaction, keeping the newest `inboxMaxCaptures` rows per inbox (default 500, settable 1-10000) and deleting the oldest by `id` - insertion order, which for an append-only table is arrival order and, unlike `received_at`, cannot tie.
A capture the caller was told had landed can therefore never be missing its insert, nor an untrimmed table its bound.
The retention and body limits are resolved by `read_inbox_limits` once, when the inbox starts, so every row belonging to one inbox was truncated and retained by the same rule - see [api-reference/inbox.md](../api-reference/inbox.md#webhook-inbox) for the settings.

**Cleared at startup.**
An inbox lives only as long as the engine process that opened it, so after a restart every row here belongs to an inbox nothing can list.
`Database::init` calls `clear_inbox_requests_all` for the same reason it reconciles orphaned runs: the previous process's leftovers are dealt with before anything can read them.
Rows are stored at all - rather than kept on the heap - so a long-lived listener's capture list is paged off disk instead of growing a running daemon's memory.

New in 0.16.0.
`sync_schema()` creates new tables outright, so there is no migration.
