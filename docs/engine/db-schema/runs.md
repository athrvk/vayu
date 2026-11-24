---
description: >-
  The `runs` table: one row per execution and everything a run records about itself.
---

# The runs table

## `runs`

Stores design-mode and load-test run records.
Defined in `database_impl.hpp` (`make_table("runs", …)`); struct is `db::Run` in `engine/include/vayu/types.hpp`.

| Column            | Type    | Notes                                                       |
|-------------------|---------|-------------------------------------------------------------|
| `id`              | TEXT PK | `run_` + UUID                                               |
| `request_id`      | TEXT    | FK → `requests.id` (optional; set in design mode)           |
| `environment_id`  | TEXT    | FK → `environments.id` (optional)                           |
| `type`            | TEXT    | `"design"`, `"load"` or `"scenario"` (a collection run)      |
| `status`          | TEXT    | `"pending"` / `"running"` / `"completed"` / `"failed"` / `"stopped"` |
| `config_snapshot` | TEXT    | JSON: the run's request as composed, credentials withheld (see below) |
| `start_time`      | INTEGER | Unix ms                                                     |
| `end_time`        | INTEGER | Unix ms; `0` = no end recorded (readers guard on `> 0`); the API emits it only once terminal (below) |
| `summary`         | TEXT    | JSON: whole-run results, written once at terminal status (`""` = not written) |
| `baseline`        | INTEGER | `1` when the run is pinned as a baseline. NOT NULL DEFAULT `0`               |
| `has_warnings`    | INTEGER | `1` when `summary.warnings` is non-empty. NOT NULL DEFAULT `0`               |
| `origin`          | TEXT    | Who started the run: `"app"` / `"mcp"` / `"other"`. NOT NULL DEFAULT `'other'` |
| `origin_client`   | TEXT    | The MCP client's name, `mcp` runs only (nullable)                            |
| `outcome`         | TEXT    | The verdict the run's list row draws: `"passed"` / `"failed"` / `"not_judged"`; NULL = none (nullable, no default); `"failed"` for every `failed` status, summary or not |

**`status`** moves through `Database::transition_run_status` (#3340), which takes an edge only when the row's current status is one the caller names: there is no wildcard, so a run that is `completed`, `failed` or `stopped` stays that way unless a caller names that exact status as the one being left.
The read, the decision and the write hold one DB mutex acquisition.
A busy database is retried; a terminal write is retried until it lands, because a lost final status leaves the run `running`, which retention never prunes.
A graceful shutdown waits for that worker, and a daemon killed before the write lands leaves the row to startup reconciliation (below).
A refused move is logged (run id, the statuses named, the one found) and answered, never thrown.

A load run's phase (`setup`, `sending`, `draining`, `summarising`, `settled`; #3341) is in-memory state of the active run (`core/run_phase.hpp`) and is not stored: `status` is the only column that records where a run is, and the phase adds no column and no schema version.
What a Stop meant is visible only in the terminal `status` it left (`stopped` when it decided the outcome; a Stop in the natural-end drain leaves the run's own `completed` or `failed`).

Every status write after the insert goes through it, each naming its real edge.
A load or collection run is inserted `pending` and a design send `running`.
A worker moves `pending` to `running` as it starts and `running` to its terminal status as it ends; a run that fails before its worker starts, or whose move to `running` threw, fails from `pending`.
`POST /runs/:runId/stop` on a run no worker holds (a buffered design send, or a run whose worker has not registered yet) moves `pending` or `running` to `stopped`.
A Stop in that window therefore stands: the worker's move to `running` is refused and it ends without sending, and a buffered send's result is stored under a row that stays `stopped`.
A worker that registered and moved to `running` between the route's look-up and the move is signalled as well.
The one move out of a terminal status is `completed` to `failed`, when a design send throws after its result was recorded (`guard_recorded_send`): its caller got no response, so the row must not say it completed.

**`end_time`** moves with the status edge `transition_run_status` takes.
Both inserts *seed* it to `start_time` up front (`seed_run_times`, `http/routes/execution.cpp`).
A move to `running` clears it to `0`, so a live report measures up to now rather than to the seed; a design send, inserted `running`, keeps the seed until its terminal move.
`update_run_end_time` stamps it when a load run's load ends, before its cleanup and summary, and when a collection run's teardown is done, before its summary; the terminal move that follows keeps any value later than `start_time`; otherwise (the seed, or `0`) the terminal move stamps now.
A move to any other status leaves it alone.

A run killed by a daemon crash never reaches a terminal status: `reconcile_orphaned_runs` marks it failed (with a partial `summary` for a load run, see `summary` below) and keeps the `end_time` it recorded, or gives it `start_time` when it recorded none (`0`, a run that died while `running`).
The restart time would report a duration spanning however long the daemon was down.
This is safe without an owner column because the engine holds the instance lock before the database opens, so no live engine owns the rows it meets (issue #2422).
`db::Run::end_time` defaults to `0` as the backstop for a future insert site that forgets to seed - `0` is the "no end recorded" sentinel, and readers (`GET /runs/:runId/report`, the app's dashboard) guard on `> 0`.

The stored seed is never what an API client reads for a live run: `GET /runs`, `GET /runs/:runId`, the report's `metadata.endTime` and the baseline row emit `endTime: null` while `status` is `pending` or `running` and the column once it is terminal, through `vayu::json::serialize_run_end_time` (#2953).
A run a crash left behind is `failed` after reconciliation, so it reports the end it kept, or its `start_time`.

**`baseline`** is the pin set by [`PUT /runs/:runId/baseline`](../api-reference/runs.md#put-runsrunidbaseline): the known-good run later runs of the same request (or, for a load run, the same collection) are compared against.
Several rows may carry it at once - the engine records the pin and leaves the choice of which baseline applies to a given run to the client.
NOT NULL with a `default_value`, which is what lets `sync_schema` `ALTER TABLE ADD COLUMN` it onto an existing `runs` table (the same pattern as `summary` and `requests.follow_redirects`); rows written before the column read as unpinned.
**Retention reads it** - see below.

**`has_warnings`** (issue #1527) is derived, never written directly: every `Database::update_run_summary` call parses the JSON it is about to store into `summary` and sets this column to whether that JSON's `warnings` array (issue #1503) is non-empty, in the same row write.
The two columns are stamped together and can never disagree.
It exists apart from `summary` so [`GET /runs`](../api-reference/runs.md#get-runs)'s paginated list can read it straight off the row it already fetched for every page - no extra query, and no risk of the compact-summary cache (`RunSummaryCache`, keyed on the immutable `config_snapshot`) ever caching a completion-time fact.
The same cache's second table holds a terminal load or collection run's list-row `resultSummary` (#2130, #2954), built from `summary` and only once `status` is terminal: every writer stores `summary` before the terminal status, so from then on the column is final.

**`origin` / `origin_client`** (#1817, schema version 5) record who started the run, as the starting client asserted it on `POST /execute` or `POST /runs` (`read_run_origin`, `http/routes/execution.cpp`; the rules are in [POST /execute](../api-reference/execute.md#post-execute)).
Client-asserted metadata, not identity: any caller can claim any kind and nothing authorises on it.
`origin_client` is set only for `mcp`, trimmed and capped at 128 characters, and stored as the client sent it.
The `default_value` on `origin` is what lets `sync_schema` `ALTER TABLE ADD COLUMN` it onto an existing table, and it is the honest answer for every row stored before: nobody recorded one.
No data migration.
The client's `origin` object is kept out of `config_snapshot` (`sanitize_config_snapshot`), so these two columns are its one record.
[`GET /runs?origin=<kind>`](../api-reference/runs.md#get-runs) filters on `origin` (`run_filter_where`, `db/db_runs.cpp`) with no index: History's list is already bounded by retention and ordered by `idx_runs_start_time`.
The column sits past `config_snapshot` in the stored row, so reading it walks the snapshot's overflow pages; like every filter there, the term is a `CASE` that reads its column only when the filter is set (#2548).

**`outcome`** (#3547, schema version 11) is the verdict a run's [`GET /runs`](../api-reference/runs.md#get-runs) row draws from its own `resultSummary`, stored so the list can filter on it (`?outcome=<verdict>`, the same `CASE` term and no index, for the same reasons as `origin`).
Derived like `has_warnings`, never written by a caller: `vayu::core::stored_run_outcome` (`core/run_result_summary.hpp`) builds the row's `resultSummary` from `type`, `status` and `summary` and judges it by the app's row rule (`rowOutcome`; the rules are in [GET /runs](../api-reference/runs.md#get-runs)).
`Database` re-derives it in every write of either column, inside the same retried callback as the write (`stamp_run_outcome`, `db/db_runs.cpp`): `transition_run_status`, because a worker stores `summary` while the row is still `running` and the terminal move comes after;
`update_run_summary`, because a Stop's `stopped` can land before the worker's summary; and `reconcile_orphaned_runs`, which writes `failed` directly.
A `failed` status is `failed` for every run type with no summary needed (#3643: the list draws the failed mark from the status, so a failed design run, a run that failed before a summary was written and an orphan with no metric tick are listed by `?outcome=failed`).
NULL is no verdict: a run in flight, a design run that did not fail, a clean collection run, a `completed` or `stopped` row with no summary that yields a `resultSummary`, and every row stored before the column, `failed` ones included.
Nullable with no default because a default would claim a verdict nothing judged; `sync_schema` adds it and backfills nothing, and the migration only stamps.

**`summary`** holds the aggregates `GET /runs/:runId/report` would otherwise rebuild by scanning every metric row of the run: totals, the cumulative latency percentiles, the status-code distribution, bytes, and the script-validation tallies.
It is written once - by `run_manager.cpp` when the run reaches `completed`/`stopped`, and best-effort (`setup_overhead` and `cleanup_overhead` left at `0`, with a wall-clock `test_duration`) when it fails.
`setup_overhead` is the seconds from the load run's worker taking the run up to load start, its `script.setup` pass included; `cleanup_overhead` is the seconds from the end of load to its background threads stopped (issue #2894).
A summary with no `cleanup_overhead` was stored before that issue, and its `setup_overhead` holds the cleanup figure: the report reads it as `cleanupOverhead` and leaves `setupOverhead` out.
`""` means no terminal status has written one: the run is still `pending`/`running`, or it failed on a path that writes none.
The report then stands on the run's sampled `results` alone, and a failed load run says so with `summary.summaryMissing`.
NOT NULL with a `""` default, so `sync_schema()` can `ALTER TABLE ADD COLUMN` it onto an existing table (same pattern as `requests.follow_redirects`).

**A run the engine died under** (issue #2895) is given a partial summary at the next start, in the same transaction `reconcile_orphaned_runs` marks it `failed` in:
a load run whose `summary` is `""` and that wrote at least one [`metric_ticks`](run-artifacts.md#metric_ticks) row is given the last row's cumulative figures (one `ORDER BY id DESC LIMIT 1` read per such run, `get_last_metric_tick`), under this column's own keys, plus `"partial": true`:

```json
{
  "partial": true, "total_requests": 40, "test_duration": 4.0, "rps": 10.0, "cancelled": 1,
  "send_rate": 11.0, "throughput": 10.0, "dropped_requests": 4,
  "skipped_requests": 3, "stalled_ms": 300.0,
  "bytes_sent": 4000, "bytes_received": 40000, "status_codes": { "200": 38, "503": 2 }
}
```

`rps` is `total_requests / test_duration`, not the tick's trailing `current_rps`.
Nothing a tick holds for its last second only (`current_*`, `window_*`, the latency percentiles) is copied, and nothing it never measures (`latency`, `peak_concurrency`, `avg_in_flight`, `queue_wait_avg`, `error_types`, `error_classes`, `sampling`, the sending window, `connection_replays`) is written, so the report reads each absent key as it reads an older engine's summary.
The report flags the run with `summary.partial` and leaves its `latency` block out (#2938), derived on read: a run already reconciled by an earlier version reads without latency with nothing rewritten.
A summary the run already stored is never replaced, a run that wrote no tick keeps `""`, design and collection runs are given nothing, and `has_warnings` stays `0`.

```json
{
  "total_requests": 100, "cancelled": 0, "rps": 50.0, "send_rate": 51.0, "throughput": 49.5,
  "test_duration": 2.0, "setup_overhead": 0.25, "cleanup_overhead": 0.03,
  "requests_sent": 102, "requests_expected": 100, "sending_duration": 2.0,
  "completed_while_sending": 96,
  "peak_concurrency": 8, "avg_in_flight": 4.2, "dropped_requests": 2,
  "skipped_requests": 0, "stalled_ms": 0.0, "queue_wait_avg": 1.5,
  "bytes_sent": 1024, "bytes_received": 8192,
  "http_version_downgraded": 0, "connection_replays": 1,
  "status_codes": { "200": 90, "500": 7, "0": 3 },
  "error_types": { "timeout": 2, "connection_failed": 1 },
  "error_classes": {},
  "latency": { "count": 97, "min": 1.0, "max": 90.0, "avg": 12.5, "p50": 10.0,
               "p75": 15.0, "p90": 20.0, "p95": 25.0, "p99": 30.0, "p999": 35.0 },
  "phases": {
    "dns":       { "p50": 0.1, "p95": 0.2, "p99": 1.4,  "max": 12.0, "count": 100, "mean": 0.15 },
    "connect":   { "p50": 0.3, "p95": 0.9, "p99": 8.2,  "max": 40.1, "count": 100, "mean": 0.42 },
    "tls":       { "p50": 0.0, "p95": 0.0, "p99": 22.0, "max": 61.0, "count": 100, "mean": 0.31 },
    "firstByte": { "p50": 2.9, "p95": 4.0, "p99": 6.1,  "max": 30.0, "count": 100, "mean": 3.1 },
    "download":  { "p50": 0.1, "p95": 0.3, "p99": 0.9,  "max": 4.2,  "count": 100, "mean": 0.14 }
  },
  "slow_requests": { "count": 6, "thresholdMs": 25 },
  "tests": { "sampled": 10, "passed": 9, "failed": 1 },
  "assertions": {
    "exact": { "passed": 40, "failed": 0 }, "sampled": { "passed": 9, "failed": 1 },
    "errored": 0, "teardownFailed": 0
  },
  "thresholds": {
    "checks": [
      { "metric": "latencyP99Ms", "limit": 50, "actual": 30.0, "passed": true, "evaluated": true }
    ],
    "passed": 1, "failed": 0
  },
  "schemaValidation": {
    "sampled": 40, "checked": 36, "valid": 30, "failed": 6, "unevaluated": 0,
    "uncheckedReasons": { "body_not_json": 4 },
    "failures": [ { "step": "get pet", "status": 200, "path": "/id", "message": "..." } ],
    "failuresTotal": 6
  }
}
```

`phases` carries the whole-run distribution of each network phase, drained from the collector's five per-phase HdrHistograms - which every successful completion feeds, unlike the sampled `results` rows.
Each phase's `mean` (issue #2782) is what the report's `timingBreakdown.avg*Ms` read; a summary stored before it has no `mean`, and its report averages the sampled `results` rows' traces instead, as every report did before.
Keyed by wire name (`firstByte`, not `ttfb`), and the only section here written in camelCase, because the report passes it through verbatim rather than translating it.
**Omitted** when the run recorded no distribution - the `phaseHistograms` setting (or the run's own `phase_histograms`) off, or nothing successful completed - which keeps the report's `timingBreakdown.phases` absent rather than showing five zeroed rows; a zeroed TLS row would claim the handshake was free, which is a different statement from "this run did not measure it".
A zero *inside* a present section is meaningful and kept: a run over reused connections genuinely has a TLS p50 of 0.

`cancelled` counts the requests a user stop cancelled before they answered (issue #2136).
They are in neither `total_requests` nor `status_codes`, which is why the count is stored: nothing else here can recover it.
Always written, `0` included; a summary stored before the issue has no key and the report reads it as `0`.

`drainCut` (`{"cancelled": 15}`, issue #3538) is written only when a Stop cut the drain of a run that ended on its own and cancelled something (`RunContext::drain_cut`): its `cancelled` repeats the top-level `cancelled`, because every request such a Stop cancels is one the drain was waiting on.
Absent on every other run, a stopped one included, never `0`.
The report serves it as `summary.drainCut` and the list row as `resultSummary.drainCut`, and a verdict reader treats the run as not judged unless a budget already failed it, since the cut requests are the slowest of the run and in no other figure.

`connection_replays` (issue #2799) counts the requests libcurl re-sent on a new connection after the server dropped or refused a reused one before answering.
Each replayed request is still one entry in `total_requests` and `status_codes`, by the outcome of its last attempt, so the target received `total_requests + connection_replays` requests.
Written by the completed and the failed run alike, `0` included; a non-zero count also adds a `connection_replayed` entry to `warnings`.
A summary stored before the issue has no key, and the report then leaves `summary.connectionReplays` out rather than reading it as `0`.

`avg_in_flight` (issue #2821) is the mean number of requests in flight over the run:
the collector's in-flight integral over `test_duration` (`MetricsCollector::average_in_flight`, issue #3567), the time every request spent between its submission to the event loop and its completion, a Stop's cancellation included, so timer waits between requests and requests refused before the event loop count for nothing.
A summary stored before issue #3567 holds the old figure under the same key, the latency sum over `test_duration`, which left cancelled requests out; no schema version marks the change.
Written by the completed and the failed run alike, `0` included; the report's `summary.avgInFlight` reads it.
A summary stored before the issue has no key, and the report leaves `avgInFlight` out rather than reading it as `0`.
A collection (design-mode) run's summary does not carry it.

`error_types` (issue #2400) is every error the run recorded, by the type name its stored error traces carry (`timeout`, `connection_failed`, ...), counted by the collector as it happened; a type with no error is left out.
It is exact where the error records in `results` stop at `maxStoredErrors`, and the report's `errors.types` reads it while `errors.withDetails` counts the stored records.
Written by the completed and the failed run alike, `{}` included.
A summary stored before the issue has no key, and the report then counts the stored records by type as it always did.
A design-mode collection run's summary does not write it.

`error_classes` (issue #3828) is every failed `mcp` reply the run counted, by class, stored in the report's own shape (`McpErrorCounts::to_json`): `{ "transport"?, "protocol"?, "tool"?, "protocolCodes"? }`, a class only when counted and `protocolCodes` a `protocol` failure's JSON-RPC `error.code` (`"-32602"`, ..., and `"other"` for any code outside the reserved and server ranges).
It counts every failed reply whatever its status, so it is a superset of `error_types`' `mcp_*` names, which count only a failure under a 2xx or 3xx.
Written by the completed and the failed run alike, `{}` included, and by a collection run, whose `status_codes` bucket a failed reply under a 2xx or 3xx under `0` as the load path does.
A summary stored before the issue has no key, and the report then leaves `summary.errorClasses` out.
A reconciled crash summary (above) does not write it.

`slow_requests` (issue #2399) is every successful completion at or past the run's `slow_threshold_ms`, counted by the collector as it happened, and the threshold it was counted against.
It is exact where the slow traces in `results` are a sample capped at `max_slow_results`; the report shows both, as `slowRequests.count` and `slowRequests.tracesStored`.
Written by the completed and the failed run alike, `0` included, and **omitted** when the threshold was `0`, which disables slow capture.
A summary stored before the issue has no key either, and the report then counts the stored slow traces as it always did.

`requests_sent`, `requests_expected` and `sending_duration` (issue #2392) are what the run submitted,
what its mode set out to submit (`targetRps` x `duration` for a rate-limited run, the iteration count for an `iterations` one, `0` for an open-ended mode; a scenario `iterations` run stores what it sent when it reached its own end, because its iterations x steps figure is only an upper bound once an iteration is abandoned, issue #2914), and the seconds it submitted in:
load start to the moment it stopped submitting, before the end-of-run drain that `test_duration` includes.
An `iterations` run that reached its own end stores its whole `test_duration` there instead (see the report's [two clocks](../api-reference/runs.md#get-runsrunidreport)).
`send_rate` is `requests_sent` over `sending_duration`; `rps` and `throughput` stay completed requests over `test_duration`, and so does every threshold that reads them.
A failed run stores its wall-clock `test_duration` in `sending_duration` too.
Always written, zeros included: a summary with no `sending_duration` key predates the issue, and the report keeps that run's old rate-fidelity formula.

`skipped_requests` and `stalled_ms` (issue #2911) are the requests a `constant_rps` pacer owed beyond its 100 ms catch-up window and skipped instead of bursting, and the schedule time they cover in milliseconds (`skipped_requests ÷ targetRps`).
They are counted apart from `dropped_requests`, which is the `maxInFlight` cap's: for a run that reaches its deadline `requests_sent + skipped_requests + dropped_requests` is `requests_expected`.
Always written, zeros included, by the completed and the failed run alike, and `0` on every mode but `constant_rps`; a summary stored before the issue has neither key and the report reads both as `0`.
`requests_sent / requests_expected` (the report's `rateControl.achievement`) is not adjusted for them: the skips are what separate a stalled generator from a slow target.
The metric ticks carry the same two cumulative keys.

`completed_while_sending` (issue #2882) is `total_requests` as it stood when `sending_duration` ended, before the drain, so it is never above `total_requests`; the report's `summary.completedWhileSending` reads it.
Where `sending_duration` is the whole `test_duration` (an `iterations` run that reached its own end, a failed run) it is `total_requests`.
Always written, `0` included; a summary stored before the issue has no key, and the report leaves `completedWhileSending` out rather than reading it as `0`.

`tests` is **omitted** when deferred script validation did not run, which is what keeps the report's `testValidation` section absent rather than reporting zero tests.
Beside its counts it carries `console` (`[{level, text, count?}]`, the first 10 distinct lines the replayed scripts logged, each cut to 500 bytes, `count` written only on a line logged more than once) and `consoleDropped` (occurrences a full list turned away), each written only when non-empty and non-zero (#3127).
A scenario load run writes them on each step's own `scenario.steps[].tests` (the same object, built by the same `test_totals_payload`) and never on the run's `tests`.
A summary stored before them has neither.

`assertions` (issue #3537) is every failed check a load run's verdict reads, written by both load run kinds in one shape:
`exact` and `sampled` (each `{passed, failed}`) are the two populations a `maxAssertionFailureRatePct` check judges, `exact` every `assert.*` outcome, required `extract.*` miss and inline `pm.test` call counted on each completion and `sampled` the deferred replay that `tests` also counts.
`errored` is the element executions that ended in error (a script that threw, an element that could not run): the summed `error` of a single-request run's `elements` rows, or of a scenario load run's `scenario.steps[].elements` rows, never `scenario.errored`, which also counts a step that got no response.
A deferred script's throw is not in it, since the replay counts it in `tests.failed`.
`teardownFailed` is the `lifecycle.teardown` rows whose `outcome` is `failed` or `error`; a failed setup fails the run instead.
Absent when the run made no assertion and nothing errored, and every member is written once the block is, zeros included.
The failed run's summary never writes it.
A summary stored before the issue has none;
the report's `assertions`, its `scenario.assertions` and the list row's `resultSummary` read it through `read_run_assertions` (`http/routes/runs.cpp`), the one place such a summary is derived from: a scenario load run's `scenario.assertions` as `exact`, and a single-request run's `assert.*` and `script.*` rows of `elements` as `exact` and its `tests` as `sampled`, which is what each read before.
Nothing derives `errored` or `teardownFailed` for it.

`schemaValidation` follows the rule `tests` does (issue #682): omitted when the deferred pass over the run's sampled responses walked nothing, so an unbound collection's report carries no block rather than one saying its contract held.
Written in camelCase because the report passes it through verbatim, the `phases` rule.
Its `sampled` count is stored rather than derived because it is the denominator that says these tallies describe the run's bounded reservoir and not the run - unlike `coverage` beside it, which is exact.
`thresholds` follows the same rule and for the same reason: absent when the run declared no [budgets](../api-reference/load-runs.md#the-thresholds-block-passfail-budgets), so the report's `thresholdValidation` section is left out rather than claiming a run passed nothing.
Its `metric` keys are the wire names the payload declared, carried through unchanged; the report derives `verdict` from `failed` rather than storing it, so the two cannot contradict.
Each check's `evaluated` follows the same absent-vs-zero rule one level down (issue #1484): a latency percentile with no completed requests writes `evaluated: false` and omits `actual` rather than storing the default `0`, which a reader could not tell apart from a genuine 0ms measurement; such a check counts toward `failed`.
An evaluated `maxAssertionFailureRatePct` check also stores `assertionsExact` and `assertionsSampled` (each `{passed, failed}`) and, when the sampled one is non-empty, `sampleRate` (issue #2892), so a report read after a restart still names the two populations its `actual` was the worse of; a check stored before the issue has none of them and nothing backfills them.
The writer is `vayu::core::build_run_summary_payload` and the reader is `apply_run_summary` (`http/routes/runs.cpp`); `runs_route_report_summary_test.cpp` round-trips the pair, so the key names cannot drift apart silently.

Do not confuse this **results** summary with the `summary` key on a `GET /runs` list row - that one is a derived view of `config_snapshot` (url/method/mode/duration/concurrency/comment/requestName) and is never stored.
It is built once per run id and held in a bounded in-memory cache for as long as the process lives (issue #1150), which is sound only because `config_snapshot` is write-once: `create_run` sets it, and every later write to a run row - status, end time, summary, baseline, the startup reconcile - is a read-modify-write that puts the same string back.
**A change that edits a stored snapshot in place breaks that**, and would have to invalidate the cache in `engine/include/vayu/http/run_summary_cache.hpp`.

The list row's `resultSummary` on a terminal load run (#2130) *is* read from this results summary (`rps`, `latency.p95`, the `status_codes` error rate, the `thresholds` verdict, the `assertions` block as `assertions`,
with its two populations summed as `assertionsPassed` / `assertionsFailed` (#2820, #3458, #3537), `drainCut` as it is stored (#3538), and for a capacity run the `capacity` section's `stop_reason`, `max_healthy_concurrency` and `knee_concurrency` (#2930);
`load_result_summary` in `core/run_result_summary.cpp`) and,
on a terminal collection run, from `scenario.passed` / `failed` / `skipped` / `errored` / `stopped` and the same `thresholds` verdict (`scenario_result_summary`, #2954), held in the same cache, which is sound for the same reason:
each `update_run_summary` writer stores the summary before the terminal status, and nothing rewrites it after.
**A change that writes the summary after the terminal status, or rewrites it later, breaks that** too.

**A scenario run's `summary`** is a different shape, written by `vayu::core::build_scenario_summary_payload` (`core/scenario_runner.cpp`): the four keys `apply_run_summary` reads plus everything sequence-shaped under `scenario`, which the report serves as its own section.

```json
{
  "total_requests": 5, "status_codes": { "0": 1, "200": 4 },
  "http_version_downgraded": 0, "error_classes": {}, "test_duration": 1.8, "rps": 2.8,
  "latency": {
    "count": 5, "min": 12.0, "max": 240.0, "avg": 71.6,
    "p50": 40.0, "p75": 60.0, "p90": 240.0, "p95": 240.0, "p99": 240.0, "p999": 240.0
  },
  "scenario": {
    "iterations": 3, "iterations_completed": 3, "steps_executed": 6,
    "passed": 4, "failed": 0, "skipped": 1, "errored": 1, "stopped": 0,
    "steps_stored": 6, "steps_dropped": 0, "steps_not_run": 0,
    "stop_on_error": false
  }
}
```

`total_requests` is the number of **requests sent** and `status_codes` their distribution, in the load summary's shape (issue #2822):
a step the plan skipped is in `scenario.steps_executed` and in neither, while a request that got no response is in both, under `"0"`, as is a failed `mcp` reply under a 2xx or 3xx (issue #3828, counted by class in `error_classes`, the load summary's key and shape, always written).
Both are here precisely because the report would otherwise read the rows that survived `maxScenarioStoredSteps`, call their count the run's size, and count a skipped step's status-`0` row as a failure.
`status_codes` is written even when empty: `{}` is a run in which no step sent, and a summary with no `status_codes` key (a run stored before the issue, whose `total_requests` is the step count) reports its split from the stored rows.
`http_version_downgraded` (#3262) is how many of those requests asked for HTTP/2 and negotiated something older, the load summary's key and unit, always written (a `0` is a run that counted and saw none, a missing key a run stored before the issue).
`rps` is requests sent over `test_duration`.
`steps_dropped` is what that cap thinned - always successes or `stopped` steps, never a failure.
`stopped` (#3397) counts the steps a Stop or an engine shutdown cut short; with `passed`, `failed`, `skipped` and `errored` it sums to `steps_executed`, and a stopped step is in neither `total_requests` nor `status_codes`, as a load run's stop-cancelled request is not.
A summary stored before the issue has no `stopped` (read as `0`), and the report and the list row then leave it out.
`steps_not_run` is the plan positions errors cost (issue #2526): for every iteration an `errored` step ended, the positions after it the iteration had not attempted; an iteration that `setNextRequest(null)`, a jump or a stop ended adds nothing.
`stop_on_error` is the run's `stopOnError` as it ran.
The report serves both as `scenario.stepsNotRun` / `scenario.stopOnError`, and only when stored: a summary written before the issue, and a scenario load run's, carries neither.
The step row that ended an iteration short of the plan's end carries the same per-iteration count as `stepsNotRun` on its `trace_data`, absent on every other row, and a step row whose extractors found nothing carries `extractorMisses` (#3053) on the same absent-at-0 terms.

A scenario load run's `scenario` object (`build_scenario_load_summary` in `core/scenario_load.cpp`, then `collect_summary_inputs` in `core/run_manager.cpp`) adds **`assertions`**, `{passed, failed}` (issue #2820):
the exact assertion population `exact_assertion_totals` reads, every `assert.*` outcome, required `extract.*` miss and inline `pm.test` call, never the deferred sampled replay under `tests`.
Absent, never zeros, for a run that made none; a sequential collection run never writes it and nothing backfills a run stored before it.
It is the same figure as the top-level `assertions` block's `exact`, which the report serves as `scenario.assertions` (absent at zero, as stored); the list row reads the block.

It also adds **`pass_duration`**, `{count, mean, min, p50, p95, p99, max}` in milliseconds (#3570): how long the completed passes took, each from the claim of its first step to the completion of its last, timer waits between steps included.
An abandoned pass is not in it, so `count` is `iterations_completed`.
Absent for a run in which no pass completed; a sequential collection run never writes it and nothing backfills a run stored before it.
The report serves it as `scenario.passDuration`.

`latency` (issue #2389) is the run's latency over the steps that sent a transfer (a step the plan skipped or one refused before the wire has no duration), exact nearest-rank over the full sample rather than a histogram.
It is computed once and is the same sample the run's `thresholds` judge, so `latency.p99` equals a `latencyP99Ms` check's `actual`.
A run in which no step sent stores `{"count": 0}` alone, and the report omits its `latency` block on that marker; a summary with no `latency` key (a run stored before the issue) reports from the stored rows.
A load run's `latency` carries `count` too (#3540): a load run that timed no request stores zeroed percentiles with `count: 0`, its report omits the `latency` block on that marker, and its history row omits `p95Ms`.
A load summary stored before `count` existed has none, so its stored percentiles stand.

**`config_snapshot` redaction** - the snapshot is the run payload as composed, with its credentials withheld.
Composition has already written every `{{variable}}`'s value into the payload, so before persistence `sanitize_config_snapshot` (`utils/json.cpp`) withholds three things (issue #1803):

- the top-level `auth` object is reduced to just `{"mode": "..."}` - an allowlist, so no current or future auth field (`clientSecret`, `password`, tokens) leaks into a stored run;
- the value of every `headers` entry named in the shared secret set (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, ...; `vayu::utils::is_secret_field_name`, case-insensitive) or by the request's own `apikey` auth becomes `"<redacted>"`, the name kept -
  in either shape `headers` arrives in, an object's member or each `{name, value}` line's `value` (issue #2466), and a repeated line every time;
- every occurrence of a value of a variable marked `secret` -
  raw, strictly percent-encoded (RFC 3986), as composition writes a query value, as it writes a URL's path, fragment and user info (a space is `%20` while `/ @ & : + '` stay raw there, so `a b/c` in a path is `a%20b/c`; a user name and a password are spelled alike except at the user's own colon),
  JSON-escaped (a JSON body is stored as text, so `pa"ss\word` is `pa\"ss\\word` inside it) and XML-escaped (character data, and each attribute delimiter) -
  inside `url`, `params`, `headers`, `body.content` and `body.fields` becomes `<redacted>`.
  The values come from the scopes the payload names: globals, `environmentId`, and the collection chain of `requestId`'s request (a scenario run: of its collection and of every folder a step sits in, #3270).
  A value under four characters is left alone, because it recurs in ordinary text and masking it would shred the snapshot.

`results.trace_data` still records what was sent, credentials included, by design ([architecture](../architecture.md#security)).
Rows stored before #1803 stay as they were written: nothing rewrites a stored snapshot, and the schema version did not change.
A run exported as a file is held to a stricter rule than the snapshot: [`POST /export/run-report`](../api-reference/export.md#post-exportrun-report) copies an allowlist of the snapshot (header and parameter names, the body's mode and size, the URL with its credentials blanked) and none of its values.

**`config_snapshot`'s body is capped at `maxTraceBodyBytes`** (issue #1486), the same limit and the same sibling-key shape the [`results`](run-artifacts.md#results) trace bodies use - `sanitize_config_snapshot` truncates `body.content` in place and records `bodyTruncated: true` / `bodyBytes: <original length>` on the `body` object when it cuts.
Without this cap a single oversized send (a large upload, a big JSON fixture) left a permanently bloated `config_snapshot` behind:
the one-time summary build the cache above pays per run id, and the `q` filter's `LIKE` / `collectionId`'s `json_valid` / `json_extract` (`run_filter_where`, `db/db_runs.cpp`, evaluated only when that filter is set, #2548) all scan the stored string's full length on every call that uses them.
The by-id route (`GET /runs/:id`) returns whatever was stored, cap included - it never re-derives or re-truncates.

**`config_snapshot` for a scenario run** - a run started from a `scenario` block (see [POST /runs](../api-reference/load-runs.md#post-runs)) stores a **step manifest**, never the resolved plan.
The manifest *replaces* the block as sent, rather than sitting beside it (`scenario_snapshot`, `http/routes/execution.cpp`).

```json
{
  "source": "collection", "collectionId": "col_123", "recursive": false,
  "iterations": 3, "dataRowCount": 2,
  "dataFileName": "users.csv", "dataFileHash": "<sha256 hex>",
  "dataFileCastNumbers": true,
  "steps": [
    { "index": 0, "requestId": "req_1", "name": "Log in",
      "url": "https://{{host}}/login", "method": "POST" }
  ]
}
```

`url` is the **stored, uncomposed** one.
The resolved plan is credential-grade - it carries resolved `Authorization` headers, and an `apikey` auth with `in: "query"` puts a live key in the composed URL - and the redaction above reads one composed request, not a plan's steps or the auth built for them.
The plan lives in memory for the run's life and nowhere else.
Inline `data` rows are not snapshotted either: they are user data of unknown sensitivity, and the manifest records only their count plus the file's name and content hash (`dataFileName` and `dataFileHash`, each absent when the run named no file; issue #2051), never its path, and `dataFileCastNumbers: true` when the client read the file's numbers as numbers (issue #2540).
That key is written only when true: absent is the one spelling of "read as text", which is also how every run recorded before it reads, so it needed no migration or schema version.
A single-request load run's snapshot carries the same keys at its top level (`load_data_snapshot`), the flag written from the validated payload rather than the body's own copy.
The writer is `vayu::core::build_scenario_manifest` (`core/scenario_plan.cpp`).
Only the `scenario` block is replaced: the run's top-level options (`environmentId`, `failOnSchemaError`, `stopOnError`, `thresholds` and the rest) stay beside it as sent, which is what keeps two runs that differ only in one of them from reading as the same run.

**`config_snapshot`'s `defaultHeaders`** (issue #1488) - a load or collection run's snapshot also carries the run's resolved default-header decision at start: `{"userAgent": "Vayu/0.26.0", "requestId": false, "acceptEncoding": true, "expectContinue": false}` (`expectContinue`, #2516, is `DefaultHeaderPolicy::expect_continue`).
This is a deliberate, narrow exception to [Default request headers](../api-reference/health-config.md#default-request-headers)'s "nothing here is stored" rule - that rule is about not writing an applied default back into a *saved request*, as freezing `X-Request-ID` into one would (#1229).
Here nothing is applied to anything: the value is read back only to compare one run's report against another's, most often a pinned baseline against a newer run after `loadNegotiateCompression`'s default changed underneath both.
Written once at `POST /runs` alongside the rest of the snapshot (`with_default_headers_snapshot`, `http/routes/execution.cpp`); absent on a design run and on any run recorded before this issue.

**Retention** - runs are append-only in normal use (every design-mode click adds a `runs` row, every load run its `metric_ticks`/`results`), so `Database::prune_runs(max_runs, max_age_days, after_selection, max_design_runs)` trims the history.
The count caps are **per kind** (issue #2429): load and scenario runs are counted under **`maxRunsRetained`**, design Sends under **`maxDesignRunsRetained`**, and neither kind evicts the other, so an afternoon of Sends cannot push last week's load runs out.
A run is a victim when it falls **beyond its kind's most-recent N** (ordered by `start_time`) **or** its `start_time` is older than **`runRetentionDays`** days, one age for every kind; each knob is disabled by `0`.
Runs still `running`/`pending` are never pruned and never count toward either cap, and neither are runs whose `baseline` is set: a pin that retention can expire is not a pin, and pins counting toward a cap would let a handful of them evict the recent history the cap exists to keep.
Deletion goes through the run cascade (runs + their `metric_ticks` + their `monitor_samples` + their `results`), batched inside transactions that release the DB mutex between batches so a large backlog cannot stall `/health`, SSE, or the runs poll.
Because victims are chosen under an earlier acquisition, each batch re-reads its rows under its own lock and spares one that has since been pinned, gone back in flight or been deleted (issue #1906); that batch loop is `remove_unexempt_runs`.
"Clear run history" ([`DELETE /runs`](../api-reference/runs.md#delete-runs), `Database::clear_runs`, issue #2429) is its second caller: every stored id is a candidate, and the same per-row exemption under the batch lock keeps baselines and in-flight runs.
The cascade itself lives in one function (`remove_run_cascade_locked`), which both `delete_run` and `remove_unexempt_runs` call, so a new child table is wired into every delete at once.
`prune_runs_configured()` reads the three knobs (config, `data_retention`, defaults 200 / 100 / 30) and runs at **startup** (`Database::init`) and after a run reaches a **terminal** status (design mode's `record_design_result`, and the load-run completion/failure paths in `run_manager.cpp`).
What a prune frees is disk the file keeps until [Reclaiming freed pages](startup-and-recovery.md#reclaiming-freed-pages) gives it back.

**A run row read without the DB mutex** (#2679).
`Database::get_run_snapshot` reads one row through a second connection to the file, read-only (`query_only`), unmapped (`mmap_size = 0`) and guarded by its own small mutex, never the DB mutex.
WAL lets it read the last commit while the main connection writes, so it waits on neither a results chunk nor the automatic WAL checkpoint inside that chunk's commit, which holds the DB mutex for 21-35 ms about every 4,500 rows, and it does not see a transaction still in flight.
It is opened on its first call, after `init`'s migration, reclamation and checkpoint have run, and closed before the main connection, which stays the last to close and so the one that checkpoints and deletes the `-wal`.
`get_run` stays the read under the DB mutex, the one a read-then-write composes with.
