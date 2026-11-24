---
description: >-
  Per-step verdicts in a collection run: the validation each step carries, and the sections a run report adds for each kind of run.
---

# Per-step verdicts in a collection run

Each step of a collection run carries its own verdict on its stored trace as a `validation` node - the same object and the same shape [`POST /execute`](execute.md#post-execute) returns - and the live `step` SSE frame carries it too, so a run being watched and the same run read back cannot disagree (issue #681).
A step that sent nothing carries no `validation` at all: there was no response to judge.

**`failOnSchemaError`** is a top-level boolean on `POST /runs`, default `false`, type-checked before the run row is created.
It is read by a collection run (a `scenario` without a load `mode`) alone: `true` on a single-request run or a scenario load run is a `400` with code `invalid_run_config` naming the flag, because those validate sampled responses once the run drains and never fail a step on them (`false` and `null` stay accepted).
Left off, a schema failure does not change any step's outcome: it is its own verdict channel, and a response the document does not describe is not a failed assertion.
Set, a step that passed everything else and whose response did not match is classified `failed`, with the first problem in its `results.error`; a step already failing keeps the error that named it.
A step failed only by this gate moves `scenario.failed` (and the run list's `resultSummary.failed`), the step's trace outcome and `results.error`, and `schemaValidation`; it does not move `summary.failedRequests`, `httpErrorRequests`, `successfulRequests`, `errorRate`, `statusCodes` (its `200` stays a `200`), the `maxErrorRatePct` input or `summary.assertions`.
Those are HTTP-only, the same rule a failed assertion follows (see `assertions` under [Scenario load runs](scenario-load.md#scenario-load-runs)).


**Response:**
```json
{
  "metadata": {
    "runId": "run_1234567890",
    "runType": "load",
    "status": "completed",
    "startTime": 1234567890,
    "endTime": 1234567950,
    "requestUrl": "https://api.example.com/users",
    "requestMethod": "GET",
    "configuration": {
      "mode": "constant_rps",
      "duration": "60s",
      "concurrency": 100,
      "targetRps": 100,
      "followRedirects": true,
      "maxRedirects": 10,
      "httpVersion": "auto",
      "dataRowCount": 2,
      "dataFileName": "users.csv",
      "dataFileHash": "<sha256>",
      "dataFileCastNumbers": true,
      "carriedBudgets": ["latencyP99Ms"],
      "acceptEncoding": true,
      "expectContinue": false
    },
    "openapi": {
      "specId": "spec_3f2b1c9a-...",
      "specHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    }
  },
  "summary": {
    "totalRequests": 6000,
    "successfulRequests": 5970,
    "failedRequests": 30,
    "httpErrorRequests": 20,
    "noResponseRequests": 10,
    "cancelledRequests": 0,
    "errorRate": 0.5,
    "totalDurationSeconds": 60.4,
    "avgRps": 99.34,
    "testDuration": 60.4,
    "sendRate": 100.0,
    "throughput": 99.34,
    "setupOverhead": 0.12,
    "cleanupOverhead": 0.03,
    "peakConcurrency": 100,
    "droppedRequests": 0,
    "skippedRequests": 0,
    "stalledMs": 0,
    "avgQueueWaitMs": 0.4,
    "avgInFlight": 4.2,
    "bytesSent": 192000,
    "bytesReceived": 7680000,
    "throughputBytesPerSec": 127152.32,
    "httpVersionDowngraded": 0,
    "connectionReplays": 0,
    "sendingDurationSeconds": 60.0,
    "completedWhileSending": 5990,
    "errorClasses": {}
  },
  "latency": {
    "min": 12.3, "max": 1250.5, "avg": 42.1, "median": 38.5,
    "p50": 38.5, "p75": 45.2, "p90": 78.3, "p95": 95.1, "p99": 156.7, "p999": 450.2
  },
  "statusCodes": [[0, 10], [200, 5970], [500, 20]],
  "rateControl": { "targetRps": 100, "actualRps": 100.0, "achievement": 100.0,
                   "requestsSent": 6000, "requestsExpected": 6000 },
  "errors": {
    "total": 30,
    "withDetails": 10,
    "types": { "timeout": 6, "connection_failed": 4 },
    "byStatusCode": [[0, 10], [500, 20]]
  },
  "timingBreakdown": {
    "avgDnsMs": 0.15, "avgConnectMs": 0.42, "avgTlsMs": 0.31,
    "avgFirstByteMs": 3.1, "avgDownloadMs": 0.14,
    "phases": {
      "dns":       { "p50": 0.1, "p95": 0.2, "p99": 1.4,  "max": 12.0, "count": 6000, "mean": 0.15 },
      "connect":   { "p50": 0.3, "p95": 0.9, "p99": 8.2,  "max": 40.1, "count": 6000, "mean": 0.42 },
      "tls":       { "p50": 0.0, "p95": 0.0, "p99": 22.0, "max": 61.0, "count": 6000, "mean": 0.31 },
      "firstByte": { "p50": 2.9, "p95": 4.0, "p99": 6.1,  "max": 30.0, "count": 6000, "mean": 3.1 },
      "download":  { "p50": 0.1, "p95": 0.3, "p99": 0.9,  "max": 4.2,  "count": 6000, "mean": 0.14 }
    }
  },
  "slowRequests": { "count": 12, "thresholdMs": 1000, "tracesStored": 12, "percentage": 0.2 },
  "warnings": [
    { "code": "unresolved_tokens",
      "message": "12 requests sent with unresolved variables: token",
      "count": 12, "names": ["token"] },
    { "code": "pre_request_script_skipped",
      "message": "1 step carries a pre-request script that does not run under load",
      "steps": 1 },
    { "code": "cookies_dropped",
      "message": "4 Set-Cookie headers were dropped across the run by libcurl's cookie engine (a line over 5000 bytes, a name and value over 4096 bytes, or more than 50 in one response), so the virtual users that received them sent their later steps without those cookies.",
      "count": 4 }
  ],
  "stream": { "...": "streaming runs only - see below" },
  "sampling": {
    "errorsDropped": 0, "successTracesDropped": 29000,
    "slowTracesDropped": 0, "responseSamplesDropped": 998000,
    "exemplarsDropped": 0, "sampleBodiesDropped": 12,
    "responseBodiesCaptured": 23, "responseSampleBudgetSpent": false
  },
  "monitor": {
    "samples": 58, "failures": 2, "noMatchScrapes": 0, "lastError": "timed out",
    "series": {
      "node_cpu_seconds_total": { "min": 1.2, "max": 3.9, "avg": 2.6, "count": 58 }
    }
  },
  "testValidation": {
    "samplesTested": 500, "testsPassed": 498, "testsFailed": 2, "successRate": 99.6,
    "console": [ { "level": "warn", "text": "cache miss for /users", "count": 412 } ],
    "consoleDropped": 3
  },
  "thresholdValidation": {
    "checks": [
      { "metric": "latencyP99Ms", "limit": 50, "actual": 47.2, "passed": true, "evaluated": true }
    ],
    "passed": 1, "failed": 0, "verdict": "passed"
  },
  "assertions": {
    "exact": { "passed": 0, "failed": 0 }, "sampled": { "passed": 498, "failed": 2 },
    "errored": 0, "teardownFailed": 0
  },
  "customMetrics": {
    "ttfb2": { "type": "trend", "count": 42, "p50": 10.0, "p95": 40.0, "p99": 47.0, "max": 50.0 },
    "bytesOut": { "type": "counter", "count": 4, "value": 4096.0 },
    "cacheHit": { "type": "rate", "count": 10, "value": 30.0 }
  },
  "auth": { "refreshes": [ { "atSeconds": 3620.4 } ], "refreshFailures": 0 },
  "coverage": {
    "operationsTotal": 18, "operationsCovered": 14,
    "declaredResponsesTotal": 41, "declaredResponsesHit": 29,
    "declaredResponseCoveragePct": 70.7, "undeclaredStatusesSeen": 1,
    "operations": [
      { "operationId": "deletePet", "method": "DELETE", "path": "/pets/{petId}",
        "sent": 0, "statusesSeen": [], "declaredHit": [], "declaredMissed": ["204"],
        "undeclaredSeen": [] }
    ]
  },
  "schemaValidation": {
    "sampled": 40, "checked": 36, "valid": 30, "failed": 6, "unevaluated": 0,
    "uncheckedReasons": { "body_not_json": 4 },
    "failures": [ { "step": "get pet", "status": 200, "path": "/id", "message": "Value type not permitted by 'type' constraint." } ],
    "failuresTotal": 6
  },
  "lifecycle": {
    "setup": [ { "id": "el_setup1", "kind": "script.setup", "outcome": "ok",
                 "scriptRequests": [ { "scope": "collection", "status": 200, "request": { "...": "..." },
                                       "response": { "...": "..." }, "totalMs": 41.2 } ] } ],
    "teardown": [ { "id": "el_teardown1", "kind": "script.teardown", "outcome": "error", "message": "Error: boom",
                    "messages": [ { "kind": "error", "text": "Error: boom" } ],
                    "console": [ { "level": "log", "text": "tearing down" } ] } ]
  },
  "elements": [
    { "id": "el_1", "kind": "assert.status", "name": "Is 200",
      "passed": 9, "failed": 1, "missing": 0, "error": 0, "skipped": 0, "deferred": 0 },
    { "id": "el_2", "kind": "extract.json", "required": true,
      "passed": 8, "failed": 0, "missing": 2, "error": 0, "skipped": 0, "deferred": 0 },
    { "id": "el_3", "kind": "script.post",
      "passed": 0, "failed": 0, "missing": 0, "error": 0, "skipped": 0, "deferred": 10 }
  ],
  "results": [ { "id": 41, "...": "request/response outcomes, failures first" } ],
  "resultsStored": 4812,
  "resultsCap": 100
}
```

**Two clocks, and which rate reads which** (issue #2392).
`testDuration` (and `totalDurationSeconds`, the same figure) is the wall time from load start - the instant of the first submission -
to the last request settling, so it includes the end-of-run drain, in which requests still in flight at the deadline are let answer (up to the run's effective timeout, its `timeout` or else the `defaultTimeout` setting, plus a grace, except a streaming run, whose bound is its `maxStreamDurationMs` plus grace).
`avgRps` and `throughput` are completed requests over that wall time: they describe what the target served, and a run whose requests outlive its deadline reads below its target there by design.
`sendRate` and `rateControl` describe what the generator sent, and divide by `sendingDurationSeconds`: load start to the moment the run stopped submitting, before the drain.
`completedWhileSending` (issue #2882) is the requests completed by that same moment, so it is never above `totalRequests`, and `completedWhileSending / sendingDurationSeconds` is the response rate while sending, the figure to hold beside `sendRate`; `throughput` counts the drain in both its completions and its seconds.
A run whose few slow requests time out long after the sending ends reads a `throughput` far below that rate; a run whose every request takes the same time reads a little above it, because the drain answers the requests the sending window left in flight.
`rateControl.achievement` is `requestsSent / requestsExpected x 100`, the pacer's own count with `requestsExpected` = `targetRps` x `duration`, and `rateControl.actualRps` is `requestsSent / sendingDurationSeconds`.
`rateControl.requestsSent` and `requestsExpected` are the run totals behind the live `metrics` frame's fields of the same name.
A shortfall there is not only a slow generator: a request dropped at the `maxInFlight` cap (`droppedRequests`) was never sent, a request a stalled pacer skipped (`summary.skippedRequests`, with the schedule time they cover in `summary.stalledMs`) was never sent either, and a Stop ends the sending early, so a stopped run's achievement is the share of its plan it reached.
The app's Rate fidelity card instead divides by what the target owed up to now (`targetRps` times the time spent sending, capped at the duration; once the sending window is over, the engine's whole count `floor(targetRps x duration)`, so 33.3 RPS over 3 s ending at 99 sent reads 100), so on a Stop it reads the pace.
It does so live, and for a stopped run in History from `requestsSent`, `sendingDurationSeconds` and the configured duration (issue #2805), while the stored `rateControl.achievement` stays the plan share and the card states it beside the figure ("stopped at 50% of the planned 60s").
A stopped report without the counts keeps its stored value.

**Skips lower the achievement and are shown beside it** (issue #2911).
`summary.skippedRequests` is the requests a `constant_rps` pacer owed beyond its 100 ms catch-up window and chose not to send after a stall of the load generator itself, and `summary.stalledMs` the schedule time they cover (`skippedRequests ÷ targetRps`, in ms).
They are the run's totals, stored as `skipped_requests` / `stalled_ms` in the [summary](../db-schema.md#runs) and on every metric tick, and read as `0` from a summary stored before them (the run skipped nothing, it had no cap to skip under).
`rateControl.achievement` is not adjusted for them: a skipped request was owed and never sent, so `requestsSent / requestsExpected` is the honest share of the plan, and the two counters are what tell a stall from a slow target.
`sent + skipped + dropped` is `requestsExpected` for a run that reaches its deadline.
The [run export](export.md#post-exportrun-report) carries both in `report.summary` (optional in its schema, absent from a document written before them); its Markdown and HTML renderings print them as one `Skipped requests` row of the results table when `skippedRequests` is above 0, apart from `maxInFlight` drops, which they do not print (`droppedRequests` has no row).

An `iterations` run, single-request or scenario, is the one exception: its loop returns on its last submission with the batch before it still in flight, so a window measured to that point would overstate the rate it sustained.
Its `sendingDurationSeconds` is its whole `testDuration` and its `completedWhileSending` its `totalRequests`, unless a Stop ended it, in which case the measured window and the count at its end stand.
A run stored before issue #2392 has neither `sendingDurationSeconds` nor the two counts: its `sendRate` divided by `testDuration`, and its `rateControl` keeps the formula it was stored with, `actualRps` the completed rate and `achievement` = `actualRps / targetRps x 100`.
A run stored before issue #2882 has no `completedWhileSending`, never a `0`.

**`statusCodes` and `errors.byStatusCode` are `[[code, count], ...]` pairs** on the wire, in ascending code order, not objects: each is a `std::map<int, size_t>`, which nlohmann serialises that way.
The app folds the pairs (`run-report-transformer.ts`) and the MCP comparison reads either form (`statusCodeEntries`).
The stored summary, a live `metrics` frame and the document [`POST /export/run-report`](export.md#post-exportrun-report) writes all spell the distribution as an object.

**`errors`** is the run's failures three ways.
`total` is the [one error definition](metrics.md#what-counts-as-an-error) and `byStatusCode` its distribution, code `0` being the requests that got no response.
`types` counts those no-response requests by what went wrong (`timeout`, `connection_failed`, `dns_failed`, ...), so its counts sum to `byStatusCode`'s code `0`.
For a load run, a collection load run included, they are counted as the run happened and stored in its summary (issue #2400), exact past the error store's cap.
`withDetails` is how many error records the run kept, at most `maxStoredErrors`, so past the cap it is smaller than `types` adds up to.
Load runs stored before issue #2400, and design-mode collection runs, have no stored per-type counts: their `types` counts the kept records, and past the cap covers only the first `maxStoredErrors` errors.

**`slowRequests`** is present when the run set a `slow_threshold_ms` above `0`.
`count` is every successful completion at or past `thresholdMs`, counted as it happened (issue #2399), and `percentage` is `count` over `summary.totalRequests` - a denominator that includes failed requests, although only a success is ever marked slow.
`tracesStored` is how many of them the run kept a trace for: the slow store is a reservoir capped at `max_slow_results`, so past the cap `count - tracesStored` is what the reservoir dropped (`sampling.slowTracesDropped`).
`count: 0` is a run that measured and found nothing slow.
A run stored before issue #2399 has no exact count in its summary, so its `count` is the stored traces again (equal to `tracesStored`, and never past the cap), and the section is absent when none of its traces was slow.

**`elements`** (issues #1594, #1641) is a single-request run's own `requestElements` outcomes -
`extract.*` / `assert.*` / `timer.*` / `script.*`,
tallied across every submission in the row shape a scenario step's `elements` uses (`{id, kind, name?, origin?, required?, passed, failed, missing, error, skipped, deferred}`, one count per outcome word, #3051;
see [Scenario load runs](scenario-load.md#scenario-load-runs)), and an inline `script.*` row's `messages?`, `messagesDropped?`, `console?` and `consoleDropped?`: what it threw, each failing test and its console lines, a bounded distinct sample (#3127, described there).
There is one row per element, in `requestElements` order, so a collection's element and the request's own that share an id (#3101) are two rows, each with its own counts and `origin`.
`deferred` (issue #2144) counts the submissions an un-inlined `script.post` was left to the completion replay on: its verdicts are the report's `testValidation`, drawn from the sampled responses, so it is not a script that never ran.
`skipped` is every other skip: a disabled element, an un-inlined `script.pre`, an optional `extract.json` over a body it could not read, or an inline `script.*` the run's Stop cut short, its `pm.sendRequest` cancelled (#3371) or the script itself ended (#3460).
Absent, not `[]`, for a run that declared no `requestElements`, one whose elements never ran, and every scenario run - a scenario's own per-step tallies live under `scenario.steps[].elements` instead (see [The `scenario` block](load-runs.md#the-scenario-block-collection-runs) and [Scenario load runs](scenario-load.md#scenario-load-runs)), and the two never coexist on one report.

**`testValidation`** counts in two units: `samplesTested` is a number of *responses* (each sampled response the post-run replay evaluated the plan's `script.post` against), while `testsPassed` and `testsFailed` are numbers of *assertions* (`pm.test` calls) across those responses, so `testsPassed + testsFailed` is not `samplesTested` once a script holds more than one assertion.
`successRate` is `testsPassed` as a percentage of assertions.
`samplesTested` is also not `summary.totalRequests`: the replay buffer is bounded (`sampling.responseSamplesDropped`) and a request with no response has nothing to test.
`console?` and `consoleDropped?` (#3127) are what the replayed scripts logged, in the element row's console shape (`[{level, text, count?}]`): the first 10 distinct lines across every sample, each cut to 500 bytes, kept whatever the script's verdict and with `count` when it was logged more than once (absent means once), and the count of occurrences a full list turned away.
Both are absent when the replay logged nothing (`consoleDropped` also when nothing was turned away), and on a scenario load run, whose replay keeps one list per step on [`scenario.steps[].tests`](scenario-load.md#scenario-load-runs) instead, so one step's line is never merged into another's.

The failing assertions are named on one synthetic row of `results[]`, the one whose `trace` carries `failures` (no captured request has it):
`failures` (each distinct message once, at most 10, a scenario step's name prefixing it), `failureCounts` (how many times each failed), `failuresDistinct` (every distinct message, so `failuresDistinct - failures.length` were turned away), `totalFailed` and `totalPassed` (assertions, each occurrence counted).
A script failing the same way on every sampled response is one entry with a count, not one entry per sample (#3127).
`failureCounts` and `failuresDistinct` are absent on a row from an older engine; see [`results`](../db-schema.md#results) for the stored shape.

**`thresholdValidation`** is one check per declared [budget](load-runs.md#the-thresholds-block-passfail-budgets) with the run's verdict.
A `maxAssertionFailureRatePct` check also names the two populations it judged (issue #2892): `assertionsSampled` is `testValidation`'s `testsPassed` and `testsFailed`, at `sampleRate`, and `assertionsExact` is the inline assertions counted on every completion that `testValidation` does not see.
`actual` is the worse of the two failure rates.

**`assertions`** (issue #3537) is every failed check a load run's verdict reads, in one shape for both load run kinds, judged or not:

| Key | Meaning |
|-----|---------|
| `exact` | `{passed, failed}`: every `assert.*` outcome, required `extract.*` miss and inline `pm.test` call, counted on each completion. A `maxAssertionFailureRatePct` check's `assertionsExact`, and a scenario load run's `scenario.assertions` |
| `sampled` | `{passed, failed}`: the deferred replay, `testValidation`'s `testsPassed` and `testsFailed`. A replayed script that threw is one failed test here |
| `errored` | Element executions that ended in error: an inline script that threw, an element that could not run. The summed `error` of the `elements` rows (a scenario load run's `scenario.steps[].elements`), never `scenario.errored`, which also counts a step with no response |
| `teardownFailed` | The `lifecycle.teardown` rows whose `outcome` is `failed` or `error`. A failed setup fails the run instead |

**Absent** for a run that made no assertion and errored nowhere, and for a sequential collection run.
A run stored before the block gets one derived from what it stored, carrying only what the readers then read: a scenario load run's `scenario.assertions` as `exact`, a single-request run's `assert.*` and `script.*` element rows as `exact` and its `testValidation` as `sampled`, never `errored` or `teardownFailed`.
A member it could not derive is absent, not `0`.

**`customMetrics`** (issue #1500) is this run's `metric.record` / `pm.metrics` values, by name - absent, not `{}`, for a run that recorded none.
A `"trend"` entry carries `count`/`p50`/`p95`/`p99`/ `max`; a `"counter"` or `"rate"` entry carries `count` and `value` (a running total, or a 0-100 percentage).
`count` is always how many times the name was recorded: a trend's samples, a counter's records (four increments of 1024 are `count: 4, value: 4096`, never the total; #1937), a rate's evaluations, so a `metric.record` whose source is a stream's `eventJsonpath` (#3780) adds one sample per stream, read from the last event the path matches, never one per event.
A counter's increments are finite and never negative - see [`custom.<name>.<stat>`](load-runs.md#the-thresholds-block-passfail-budgets).
The same shape rides every [`GET /runs/:runId/metrics`](metrics.md#get-runsrunidmetrics) tick, and [`custom.<name>.<stat>`](load-runs.md#the-thresholds-block-passfail-budgets) reads it for a threshold.

**`timingBreakdown` averages every completion.**
`phases` comes from five HdrHistograms fed by **every** successful completion, and each phase carries its `mean` beside its percentiles; the `avg*` fields are those means (issue #2782), so `avgTlsMs` and `phases.tls.p99` describe the same completions, and the last live gate frame's [`cumulativePhases`](live-metrics.md#get-runsrunidlive) means equal them.
`phases` is absent when `phaseHistograms` was off, nothing succeeded, or the run predates the bank.
Without it, and for a run stored before the means existed (its `phases` carry no `mean`), the `avg*` fields fall back to the run's *retained trace sample* - the 1-in-`success_sample_rate` completions stored while `save_timing_breakdown` is on, plus any slow-request outliers - and are absent for a run that stored no traces.
Read each half by its own key: the object's presence proves neither.

`phases` is what answers "was the latency the server or the connection path".
A `tls.p50` of 0 beside a large `tls.p99` is a run re-handshaking under load - most requests reused a connection, a minority did not - which the average over both flattens into a number that looks merely mediocre.
`count` is the number of completions behind each distribution and is identical across the five.

**`warnings` (issue #1503) is what the run did not do**, even though it finished and its other numbers may look fine:
a request sent with a `{{token}}` composition never resolved (a scenario load run, and a single-request run that declares `requestElements`, re-resolve what composition left against the executing virtual user's or submission's own scopes before sending, so a name an inline script or extractor set is answered;
a single-request run without `requestElements` resolves its request once, at run start, against the scopes an `environmentId` or `requestId` names, and runs no pass at all when it names neither, so either way a value a pre-request script would have set goes on the wire literally),
or a step whose pre-request script this mode never executes -
one that did not run inline (issue #1938: `elements.scripts: "allInline"`, or the element's own `inline: true` under `asMarked`, runs it and raises no warning).
Neither refuses the run - a literal `{{` can be deliberate in a body - they are counted, not fixed.
Each entry carries `code` and a human-readable `message`; `unresolved_tokens` also carries `count` (requests affected) and `names` (a few of the unresolved names, capped); `pre_request_script_skipped` carries `steps` (how many carried a `script.pre` that did not run inline).
`per_host_limit_raised` ([#2394](https://github.com/athrvk/vayu/issues/2394)) is of another kind: the run did everything, but opened more connections per host than `eventLoopMaxPerHost` says, because each worker's share of the virtual users (`ceil(concurrency / workers)`) was larger; it carries `configured` (the setting) and `effective` (the per-host limit each worker ran with).
It appears only when the run asked for virtual users, a config that carries `concurrency` ([#2801](https://github.com/athrvk/vayu/issues/2801)): a run that sets none is sized from the `eventLoopMaxConcurrent` default and gets the same raise, but has no virtual users to cover and no warning about them.
`connection_replayed` ([#2799](https://github.com/athrvk/vayu/issues/2799)) is another: libcurl re-sent `count` requests on a new connection after the server dropped or refused a reused one before answering, so the target received that many more requests than the run counted, each of those requests' latency covers both attempts, and a non-idempotent one may have run twice;
`count` equals `summary.connectionReplays`, and it is raised only when that is above 0 (see [What counts as an error](metrics.md#what-counts-as-an-error)).
`cookies_dropped` ([#3307](https://github.com/athrvk/vayu/issues/3307)) means libcurl's cookie engine discarded `count` `Set-Cookie` headers from the run's responses, summed over every response and redirect hop:
a line over 5000 bytes, a cookie whose name and value pass 4096, or one past the 50th of its response, the limits a design send reports per cookie (see [Cookies](cookies-and-certificates.md#cookies)).
A virtual user that lost a session cookie this way sent its later steps without it.
The message names no cookie.
Only a scenario load run's steps carry cookies, so only it can raise this; a step with `disableCookies` drops nothing.
The outgoing caps (a `Cookie` line over 8190 bytes, more than 150 jar cookies) are not detected under load: reading libcurl's notice needs `CURLOPT_VERBOSE` on every transfer.
`think_timer_skipped_open_loop` ([#3541](https://github.com/athrvk/vayu/issues/3541)) is raised once by a `constant_rps` single-request run that sent anything and whose `requestElements` hold an enabled `timer.think`: the pacer sends on a schedule, so the timer was skipped on every submission (each tallied `skipped` under `summary.elements`) and held no slot.
Its `message` is "A think timer does not apply to a constant-rate run: requests are sent on a schedule, not one after another", and it carries `timers` (how many enabled timers were skipped).
A closed-loop mode runs the timer and raises nothing.
Three are about [Retry-After back-off](load-runs.md#retry-after-back-off-retryafterbackoff) ([#3782](https://github.com/athrvk/vayu/issues/3782)), at most one per run.
`rate_limited_dominant` is raised with `retryAfterBackoff` off when more than half of the responses that carried a status (a transport failure carries none) were `429`: the report describes the target's rate limit more than the target.
On a closed-loop run the `message` names the option; on a `constant_rps` run, which never backs off, it says so instead and does not advise the option.
`count` is the `429`s.
With the option on, `retry_after_backoff` carries `count`, the responses whose `Retry-After` a virtual user waited out, so a reader knows the run's rate is the one the target allowed;
and `retry_after_skipped_open_loop` is raised instead by a `constant_rps` run that sent anything, with the `message` "Retry-After back-off does not apply to a constant-rate run: requests are sent on a schedule, not one after another".
Absent, not an empty array, for a run with nothing to report - which is every run before this field existed and every run that genuinely had nothing to say.
`unresolved_tokens` covers every load shape alike (issue #1540): a single-request run with no data set and a scenario step report the same warning for the same mistake.

**`lifecycle` (issue #1499) is `script.setup` / `script.teardown`'s outcomes** - what ran once at the run's own boundary, never at a step.
Each key is present only when that phase ran at least one element (`ElementOutcome`'s usual shape: `id`, `kind`, `name?`, `origin`, `outcome`, `message?`, `waitedMs?`, plus the two lists below); absent entirely, not `{}`, for a run whose collections (or, for a single-request run, whose own `lifecycleElements` array - issue #1573) declared neither.
A collection run's elements come from its lifecycle set (#3456): every collection from the root down to the one being run and, on a `recursive` run, every folder beneath it in sidebar order, a folder before the folders nested in it.
`setup` lists them in that order and `teardown` in reverse, and each row's `origin` is `{kind: "collection", scope: "collection" | "folder", id, name}`, naming whose script it was.
A `script.setup` outcome other than `"ok"` or `"skipped"` means setup refused the run before it sent anything:
`status` is `Failed`, no step ran, and the run still stores a summary whose `lifecycle.setup` holds every setup that ran up to and including that outcome with its `message` (#3455), every other section above absent or zeroed - so a reader who finds one here knows why the rest of the report is empty.
The collections after the refusing one set up nothing.
No teardown runs on such a run, so it has no `teardown` key.
A `script.teardown` outcome of `"error"` carries the thrown message but never changes `status`: a teardown failure is reported, not fatal.
A script that ran and failed only `pm.test`s is `"failed"`, its `message` the first failing test, as a `script.post`'s is.
A script element's row also carries **`messages`** (what it threw, then each failing test, as `{kind: "error" | "test", text}`) and **`console`** (each console line, as `{level, text}`) -
the entry shape, the cap of ten distinct entries, the `count` on a repeat and the `messagesDropped` / `consoleDropped` counts of an element row's lists (#3127), each key present only when the script said something.
On a **sequential** collection run a row also carries **`scriptRequests`** (#3633): every `pm.sendRequest` the script made, in call order, each record in the shape, masking and shared body budget [`POST /execute`](execute.md#post-execute)'s `scriptRequests` describes, with `scope` but no `source` (the row says which phase it is).
The `console` sample folds a repeated line into one entry, so its lines carry no `scriptRequest` index; the records are a flat list under the row.
A load run's rows, a single-request run's included, carry none.
A script the run's Stop cut short is `"skipped"`, with a `message` saying which way: its `pm.sendRequest` was cancelled (#3371), or the script itself was ended while it ran (#3460).
The run ended under it, nothing failed, and the app shows the row muted rather than as a failure.

**A streaming run adds a `stream` section** and no other run carries one:

```json
"stream": {
  "completions": 480,
  "totalEvents": 19200,
  "capped": 480,
  "eventsPerSecond": 320.0,
  "events": { "min": 40, "max": 40, "p50": 40, "p90": 40, "p95": 40, "p99": 40, "count": 480 },
  "timeToFirstEvent": { "p50": 412.0, "p95": 655.0, "p99": 803.0, "max": 910.0, "count": 480 },
  "timeToFirstMatch": { "p50": 1204.0, "p95": 1388.0, "p99": 1910.0, "max": 2480.0, "count": 476 },
  "maxEventGap": { "p50": 27.1, "p95": 33.8, "p99": 41.0, "max": 312.4, "count": 480 },
  "eventRate": { "p50": 40.0, "p95": 41.2, "p99": 41.9, "max": 42.3, "count": 480 }
}
```

Absent for every run that did not stream, and for one started with `stream_metrics: false` - not zeroed, because "this run was not a stream" and "this stream delivered nothing" are different answers, and a run whose target closed every stream before the first event is where telling them apart matters.

**A completion is a reply that announced `text/event-stream`** (#3771), on its final hop.
Asking for a stream does not make the answer one: a `429` or `500` in JSON, or a `200` JSON body from a server that ignored the request's `stream`, counts in `statusCodes` and the error tallies as it would on any run and nowhere in this section.
A rate-limited run therefore reports `completions` equal to the streams that opened, its `events` percentiles their event counts, and a target that never streamed leaves the section absent.
A transfer that got no answer at all is not a stream either.
The duration cap still ends such a transfer, as a `timeout` error naming `maxStreamDurationMs` rather than a capped success.
A stream that announced itself and was then cut off still counts, with the events it delivered.

`events` is the **per-completion** distribution, not the run's total: 480 streams of 40 events each have a p50 of 40, not of 19200.
`eventsPerSecond` is the whole-run rate, derived from the same `testDuration` the report's `rps` uses so the two are comparable.
Both are reported because one long stream and 250 short ones can share a rate while being entirely different runs.
A stream that delivered nothing is a 0 in `events` like any other count (#3240), so a run whose target announced every stream and closed it before the first event reads `min`, `max` and every percentile as 0 beside `totalEvents: 0`.
The figures are exact up to 2,046 events per stream and within 0.1% above.

`capped` counts the completions a cap ended rather than the server.
In the example above every stream hit the event cap - the `events` percentiles all sitting exactly on it is the tell - so those counts measure the caps, not the target.

`timeToFirstEvent` (issue #3234) is the per-completion distribution, in milliseconds, of how long each stream took to deliver its first event: from the moment the request was submitted, the origin `latency` is measured from, to the write that completed the first frame carrying a `data` field.
It is not `timingBreakdown.phases.firstByte`, which ends at the response headers: an LLM gateway answers `200` at once and then thinks, so its wait lands in the download phase and `firstByte` reads fast for a stream whose first token was slow.
Nor is it time to first token: an API that opens a stream with a preamble event (Anthropic's `message_start`, an OpenAI chunk that carries only the role) delivers that event at once, so `timeToFirstEvent` reads near zero however late the first token comes, and a budget on it passes falsely for such an API.
`count` is the completions that delivered an event, so a stream the target closed before its first event, a silent one a cap ended, and one whose only event was an unterminated frame the close completed are all left out (the last arrived at the close, and no time for it was measured).
The object is absent when no completion delivered a timed event.

`timeToFirstMatch` (issue #3774) is the figure for that first token:
the per-completion distribution, in milliseconds from the same submission, of the wait for a request's first content marker (`streamFirstContentMarker`), a literal byte string such as `content_block_delta` or `"delta":{"content":"`, which a saved request stores ([`POST /requests`](requests.md#post-requests)) and a single-request run's payload states ([`POST /runs`](load-runs.md#post-runs)).
Each stream is timed at the write that delivered the marker's last byte, on the clock `timeToFirstEvent` reads, so the two compare: a preamble API reads near zero on the first and its real wait on the second.
The match is on the stream's wire bytes, not its parsed events: it runs across the SSE framing, so a marker can match in an `event:` name or a comment as well as in `data`, and a partial match carries across writes however the server chunked them.
It is not JSON-aware: a marker containing a quote matches only the escaping the server writes, which differs between APIs (`"text":"` against one server is `"text": "` against another).
Only a reply that announced `text/event-stream` is scanned, and only until its first match.
`count` is the completions whose marker arrived; a stream that never matched, and one whose request declared no marker, are left out rather than read as 0, and the object is absent when no completion matched.
It is report-only, with no live counterpart.

`maxEventGap` and `eventRate` (issue #3776) are per-completion distributions of how each stream paced its events, in the same `{p50, p95, p99, max, count}` shape.
`maxEventGap` is each stream's largest wait, in milliseconds, between two consecutive writes that delivered an event: a stall mid-reply shows at its `max` however fast the stream ran otherwise.
`eventRate` is each stream's own rate in events per second, the events delivered after the first write that delivered one over the time from that write to the last, so 8 streams at 25 ms per event read a p50 near 40 beside one stream at 3 ms reading a `max` near 333, where the whole-run `eventsPerSecond` blends them.
The first write's own events are left out however many it carried: a backlog replayed in it took no measured time.
Both are stamped on the write that completed an event, as `timeToFirstEvent` is: events that share a write share one time, and a proxy that buffers the stream shortens the gaps it holds back.
A keep-alive comment is not an event and closes no gap, and the unterminated last frame the close completes counts toward `events` but toward neither of these.
`count` is the completions with at least two such writes (`eventRate` also leaves out one whose writes all landed at one instant), so a stream whose events arrived in one write is in neither, and each object is absent when no completion measured it.
Neither is on the live frames: they are report-only.

**A capacity run adds a `capacity` section** and no other mode carries one:

```json
"capacity": {
  "sloMs": 200,
  "maxErrorPct": 1,
  "stopReason": "slo_exceeded",
  "maxHealthyConcurrency": 48, "maxHealthyRps": 23400, "p99AtMaxHealthyMs": 41.2,
  "kneeConcurrency": 64, "kneeP99Ms": 312.0, "kneeErrorPct": 0.4,
  "levels": [ { "concurrency": 1, "rps": 980, "p99Ms": 1.4, "errorPct": 0, "samples": 4900 } ]
}
```

`stopReason` is one of `slo_exceeded`, `errors_exceeded`, `plateau`, `cap_reached`, `deadline` or `stopped` - see [Capacity semantics](load-runs.md#post-runs).
`maxErrorPct` is the error-share limit each level was judged against, and `errorPct` / `kneeErrorPct` are percentages (0-100) on the same scale, so a reader can mark an over-limit level without knowing the constant.
The optional groups are **omitted rather than zeroed**, and the distinction carries information:

- `maxHealthy*` is the highest level tried that stayed inside the budget, and is absent when the very first level already breached it (on latency or on errors).
  The search found no sustainable capacity, which is not the same claim as a capacity of zero.
  On a `plateau` stop it is the last level tried, which overshoots: read `saturation*` for the plateau.
- `knee*` is absent unless `stopReason` is `slo_exceeded` or `errors_exceeded`.
  A run that ended at its ceiling, its deadline, or on a plateau inside the budget never watched the target give out, so it has no knee to report.
- `saturation*` (`saturationConcurrency`, `saturationRps`, `saturationP99Ms`) is present only when `stopReason` is `plateau`: the lowest healthy level whose throughput the best healthy level beat by under 5%, i.e. where more concurrency stopped buying work.
  A run that stopped any other way never observed a plateau and carries none.
- `maxErrorPct`, `kneeErrorPct` and `levels[].errorPct` are absent from a run stored before the search judged errors (#2815): it never measured an error share, and a 0 would call every level clean.
- `levels[].samples` is the number of completions the level's histogram held when the level was judged (#2926), i.e. what `p99Ms` was computed over.
  A `0` means the level measured no latency (only refused connections), so its `p99Ms` of 0 is "nothing measured", not "answered instantly".
  It is absent from a run stored before the field existed, never `0`, for the same reason as the error share.

`levels[]` is one entry per level *judged*, in order - bounded by construction (a search holds tens of levels, not thousands).
A level that breached once and was re-measured appears twice, at the same concurrency; the level still being measured when the run ended does not appear at all, because it was never judged.

**`auth`** appears only for a run whose OAuth 2.0 credential could be renewed while it ran - a header-placed, expiring token with `autoRefreshToken` on (see [db-schema.md](../db-schema.md#oauth_tokens) for the full eligibility list).
Each entry in `refreshes` is when a renewal landed, in seconds from the run's start.
`refreshFailures` plus a `lastError` string is the other half of the answer: the run kept sending the credential it had, so 401s in `statusCodes` from that point on are explained here rather than by the target.
A renewal still in flight when the run ends is cancelled rather than waited out, and is not a failure.
The section is **absent** for a run that could never refresh, which is not the same claim as a run that watched and never needed to (that one reports an empty `refreshes` array).
A collection load run that keeps several tokens current (one per distinct cache key its steps send, #3199) reports them in this one shape: every renewal in `refreshes`, in order of `atSeconds`, `refreshFailures` summed, and `lastError` the most recent failure of any of them.

**A scenario run adds a `scenario` section** and no other run type carries one:

```json
"scenario": {
  "iterations": 3, "iterationsCompleted": 3, "stepsExecuted": 6,
  "passed": 4, "failed": 1, "skipped": 0, "errored": 1,
  "stepsStored": 6, "stepsDropped": 0, "stepsNotRun": 0, "stopOnError": false,
  "stopped": 0,
  "transactions": [
    { "name": "checkout", "count": 3, "errors": 0,
      "latency": { "min": 8.1, "p50": 14.2, "p90": 22.0, "p95": 26.5, "p99": 33.0, "max": 55.4 } }
  ]
}
```

`stepsStored` versus `stepsExecuted` is the honest reading of `results[]`: a run that filled `maxScenarioStoredSteps` reports fewer rows than it ran, with every failed, errored and skipped step among the ones kept (a `stopped` one is kept like a success).
On a collection run (design mode) `stepsExecuted` counts **steps** and `summary.totalRequests` counts **requests sent** (issue #2822): a step the plan skipped (`control.if`, `control.throughput`, `pm.execution.skipRequest()`) is a step and not a request, while a request that got no response is one, under status `0`.
`statusCodes`, `successfulRequests`, `failedRequests` and `errorRate` come from the distribution the runner stored over those same requests, never from the kept rows, where a skipped step is a status-`0` row: they describe the whole run past `maxScenarioStoredSteps` and agree with a `maxErrorRatePct` check's `actual`.
A run in which every step was skipped reports `totalRequests` `0` and an empty `statusCodes`.
A summary stored before #2822 has no distribution: its `totalRequests` is the step count and the split comes from the kept rows.

**`passed`, `failed`, `skipped` and `errored` mean the same in both run kinds** (#2824, the Outcomes table under [Scenario runs](scenario-runs.md#scenario-runs)): one per step execution, disjoint, with an HTTP error status that no assertion rejected counted as `passed` and in `summary.failedRequests`.
`stepsExecuted` is every step reached, a skipped one included, so in both `passed + failed + errored + skipped + stopped = stepsExecuted`, `stopped` read as `0` where it is absent.
A scenario load run's `steps[].executed` counts every execution that was not `skipped`, so there the sum of `steps[].executed`, plus `skipped`, also equals `stepsExecuted`; a collection run has no `steps` array.
A scenario load run stored by engine 0.45.0 or earlier keeps its old numbers: `failed` was the sum of every step's `httpErrors`, and `passed` was `stepsExecuted` less `failed` and `errored`, skipped steps included.

`stepsNotRun` is how many plan positions errors cost the run - summed over every iteration an `errored` step ended, the positions after that step the iteration had not attempted (Outcomes under [Scenario runs](scenario-runs.md#scenario-runs)).
`stepsExecuted` beside a non-zero `stepsNotRun` is a run that did less than its plan, not a complete one with an error in it.
`stopOnError` is the run's own setting, echoed because the same counts describe a different run under it.
Both are written by a collection run (design mode) only: a scenario load run's section carries neither, and a summary stored before issue #2526 carries neither either.
`stopped` (#3397) is the steps a Stop or a shutdown cut short, which no failure count includes and which take no failure's place among the kept rows; it is likewise a collection run's alone, absent for a scenario load run (whose stop-cancelled steps are in no count) and for a summary stored before it.

`assertions` (#2820) is the other way round: a scenario load run's alone, `{ passed, failed }` over the exact population (every `assert.*` outcome, required `extract.*` miss and inline `pm.test` call, never the sampled replay `testValidation` reports), the report's top-level `assertions.exact`.
It counts assertions where `failed` above counts step executions, so an execution that failed three is one `failed` step and three `assertions.failed`.
It is **absent** for a run that made no such assertion, a collection run in design mode and a run stored before it; [Scenario load runs](scenario-load.md#scenario-load-runs) has the rest.

`passDuration` (#3570) is a scenario load run's alone too: `{count, mean, min, p50, p95, p99, max}` in milliseconds over its completed passes, each from the claim of its first step to the completion of its last, timer waits between steps included and abandoned passes left out.
**Absent** for a run in which no pass completed, a collection run in design mode and a run stored before it; [Scenario load runs](scenario-load.md#scenario-load-runs) has the rest.

`transactions` (issue #1515) is a sibling of `steps`, not a member of it - a `control.transaction` spans a folder, not one step - and is **absent**, never `[]`, for a run with no `control.transaction` element or one whose folder never closed.
One entry per declared name that closed at least once, in the same shape `scenario.transactions` documents elsewhere on this page.

`latency.*` and the enriched `summary` fields (`peakConcurrency`, `avgInFlight`, `droppedRequests`, `skippedRequests`, `stalledMs`, `avgQueueWaitMs`, `bytesSent/Received`, `throughputBytesPerSec`) come from the run's stored `summary`, not from the per-tick `metrics` rows.
`latency_ms` in `results` is **perceived** latency.

**A collection run's `summary` omits the load-only figures** (issue #2822).
A sequential run feeds no load collector, so `sendRate`, `throughput`, `peakConcurrency`, `droppedRequests`, `avgQueueWaitMs`, `bytesSent`, `bytesReceived`, `throughputBytesPerSec`, `setupOverhead` and `cleanupOverhead` are absent rather than `0`; `avgRps` is requests sent over `testDuration`.
A scenario load run is a `load` run and carries every one of them.

**A collection run's `latency` block** (issue #2389) is the stored `latency` its runner wrote, over the [latency population](metrics.md#latency-population) of the sequential path: every step whose transfer ran, answered or not, and not a step the plan skipped or one refused before the wire.
That is the sample the run's `latency*Ms` [budgets](load-runs.md#the-thresholds-block-passfail-budgets) judge, from one computation, so `latency.p99` equals the `actual` of a `latencyP99Ms` check.
Unlike the HDR histogram the load paths read, the figures are **exact nearest-rank** over the full sample (`avg` is its mean), and they are not read from the `results[]` rows, which can include a skipped step's `0` ms and are thinned past `maxScenarioStoredSteps`.
A collection run in which no step sent has **no `latency` block** rather than zeros.
A summary written before this existed carries no `latency` and reports from the stored rows as before.

`summary.failedRequests` and `summary.errorRate` are the [one error definition](metrics.md#what-counts-as-an-error), recounted from the run's status-code distribution; `summary.httpErrorRequests` and `summary.noResponseRequests` split `failedRequests` and always sum to it.
`summary.totalRequests` is `successfulRequests + failedRequests`, the requests that got an outcome, and `errorRate` is `failedRequests` over it.

`summary.cancelledRequests` is the requests a `POST /runs/:runId/stop` cancelled before they answered (issue #2136): sent, never an outcome, and so in none of the figures above - a healthy target stopped mid-run reports `errorRate` 0 beside them.
Always present: `0` for a run nothing cancelled, and for a run whose stored summary predates the count, because only the stored summary records it (the status-code distribution never held them).
`summary.drainCut` (`{cancelled}`, issue #3538) is present only when a Stop cut the drain of a run that ended on its own: the part of `cancelledRequests` still unanswered when the drain was stopped, which keeps the run's verdict [not judged](export.md#post-exportrun-report) unless a budget already failed it.

`summary.errorClasses` (issue #3828) is the run's failed `mcp` replies by class, `{ "transport"?, "protocol"?, "tool"?, "protocolCodes"? }`, for example `{ "tool": 20, "protocol": 10, "transport": 5, "protocolCodes": { "-32602": 10 } }`.
A class is present only when counted, so a run in which no reply failed (every run whose requests are not `mcp`) reads `{}`.
`protocolCodes` counts a `protocol` failure's JSON-RPC `error.code`: each of `-32700`, `-32600` to `-32603` and `-32000` to `-32099` by its code, any other under `"other"`, and a JSON-RPC error with no integer code in `protocol` and none of them.
Every failed reply is counted whatever its status, so each is an error inside `failedRequests` and `errorRate`, and the classes are a superset of `errors.types`' `mcp_*` names, which leave out a failure under a 4xx or 5xx ([The `mcp` reply](request-body.md#the-mcp-reply)).
**Absent and `{}` are different answers**: absent is a run stored before the count existed, or one reported from its sampled results.
A partial report of a running load run reads it from the live counter, and a collection run carries it too.

`summary.partial` (`true`) marks a run the engine died under, whose figures are its last persisted tick's; `summary.summaryMissing` (`true`) marks a failed load run with no summary at all, whose counts are not a measurement.
Neither report has a `latency` block (issue #2938).
Each flag is absent otherwise, never `false`; "A run the engine died under" above says what each figure then holds.

`summary.httpVersionDowngraded` is the count of this run's transfers that asked for HTTP/2 and negotiated something older - see [`httpVersionDowngraded` on a response](execute.md#post-execute).
A collection run counts its sent requests the same way (#3262, [Scenario runs](scenario-runs.md#scenario-runs)); a collection run stored by an engine older than that fix reads `0` here although its steps' traces may say otherwise.
It is the only figure in `summary` that describes the report's *validity* rather than its performance: non-zero means the latency and throughput beside it were measured over a protocol other than the one `metadata.configuration.httpVersion` names.

**`0` is "none recorded", not "none happened".**
An engine from 0.15.0 always emits the key - including for a run whose stored summary predates the count, and for one reported from its sampled results because that summary was malformed or never written, neither of which can produce a figure.
The key is absent only from an engine older than 0.15.0.
That is deliberately a weaker guarantee than the per-response `httpVersionDowngraded`, which is exact for the exchange it describes.

`summary.connectionReplays` is the count of requests libcurl re-sent on a new connection after the server dropped or refused a reused one before a byte of the answer (issue #2799).
The extra sends are in no other count, not `totalRequests`, the error counts or `noResponseRequests`: each replayed request is counted once, by the outcome of its last attempt, so the target received `totalRequests + connectionReplays` requests (see [What counts as an error](metrics.md#what-counts-as-an-error)).
A non-zero value also raises the `connection_replayed` warning.
**Absent and `0` are different answers**: `0` is a run whose engine counted and saw none (the key is always stored, zero included), and absent is a run stored before the count existed, or one reported from its sampled results because its summary was malformed or never written.
A partial report of a running load run reads it from the live counter.

`summary.avgInFlight` is the mean number of requests in flight over the run (issue #2821): the time requests spent in flight, summed over every request, divided by `testDuration` (issue #3567).
A request is in flight from its submission to the event loop until it completes, its queue wait inside the generator or libcurl included, and a Stop's cancellation ends it, so a request the Stop cancelled counts the time it was open.
A virtual user in a timer wait between requests has none, and neither does a request refused or skipped before it reached the event loop (a `maxInFlight` drop, a data-binding failure, a step a controller skipped).
A step's script time (`elements.includeScriptTime`) is not part of it.
With no think time it equals the virtual user count, and over that count it is the run's utilisation.
A run stored before issue #3567 keeps the old figure under the same key: the latency sum of the [latency population](metrics.md#latency-population) divided by `testDuration`, which left out cancelled requests and folded in included script time.
`peakConcurrency` beside it is the high-water mark of the instantaneous in-flight gauge (the live stream's `backpressure`), which the load generator reads after each batch of submissions in every mode: the closed-loop controller behind `constant_concurrency`, `ramp_up`, `iterations`, `capacity` and every scenario run, and the open-loop pacer behind `constant_rps` (issue #2912).
The once-a-second metrics sample is a backstop writer.
A closed-loop single-request run's gauge counts the slots a `timer.think` wait holds too; a `constant_rps` run's counts requests alone, because it skips the timer (#3541).
The peak is the most requests ever in flight at once, so on a run whose users wait in step it can read the full user count though most of the run had far fewer in flight; `avgInFlight` is the figure that measures utilisation.
`avgInFlight` is present for a load run stored since issue #2821, `0` included; **absent** for a run stored before it, a collection (design-mode) run, and a run reported from its sampled results, never a `0` nobody measured.

`summary.setupOverhead` and `summary.cleanupOverhead` (issue #2894) are the two stretches of a load run outside `testDuration`, in seconds.
`setupOverhead` runs from the run's own thread taking it up to load start: reading the run's settings, building its request or plan, and the `script.setup` pass (a collection's, or a single request's `lifecycleElements`), so a slow setup script shows here and never in `testDuration`.
`cleanupOverhead` runs from the end of load, the drain included in `testDuration` before it, to the run's background threads (the metrics tick, the token-refresh watchdog, the monitor scrape) having stopped, before the deferred script and schema passes and the summary write.
Both read `0` for a failed run's best-effort summary, a partial report of a running run, a run reported from its sampled results, and a collection (design-mode) run, none of which times them.
A run stored before the issue stored the cleanup figure under the setup name: its report carries that figure as `cleanupOverhead` and has **no** `setupOverhead`, rather than a setup time nobody measured.

`sampling` says how much each bounded store thinned away: all zeros means the error, trace and tested-response sets are complete, and a non-zero count means they are a **uniform sample of the whole run** (reservoir retention) rather than a truncated prefix of it.
The section is absent on a run recorded before it was reported, which is not the same claim as "nothing was dropped".
It does not describe `results[]`, which has its own selection rule below.

**`results[]` is not a uniform sample (#2210).**
A non-scenario run returns at most 100 stored rows.
When it stored more, the rows are chosen by value: every row with a failing status (anything outside 2xx/3xx, including the `0` of a transport failure) takes a slot first, up to the cap, and rows that succeeded fill the remainder in storage order.
The chosen rows are listed in `timestamp` order, ties broken by row id, whichever way they were selected.
A `Scenario` run keeps every stored step (bounded at write time by `maxScenarioStoredSteps`, see `stepsStored`).
Two top-level keys, always present, say whether the array was cut: `resultsStored` is the number of rows stored for the run and `resultsCap` is the cap applied (equal to `resultsStored` for a scenario run).
`resultsStored > resultsCap` is the only signal that `results[]` is a selection and not the whole set; both sit beside `results` rather than inside `sampling` because that section is optional.

`responseSamplesDropped` counts responses the post-run test scripts and schema checks never saw, for either of the two bounds on that store: the count cap (`max_response_samples`), and the byte budget (`max_response_sample_bytes`) that drops a whole sample once the run's retained bodies would exceed it.
Both mean the same thing to a reader - this response was not validated - and neither ever stores a *cut* body, because a deferred check reading one reports a failure the target never produced.
They differ in one way worth knowing: the count cap displaces an incumbent, so the tested set stays a uniform sample of the run, while an exhausted byte budget stops admitting - a run that spends it is graded on the part of the run whose bodies fit.
The counter cannot say which bound applied on its own; `responseSampleBudgetSpent` is the answer (issue #1192).
`true` means the byte budget ended at least one sample, so the tested set is drawn from the part of the run whose bodies fit; `false` means only the count cap displaced anything, so the tested set stays a uniform sample of the whole run.
It is written by every run recorded since the marker existed, and is **absent** on a summary written before that - absent means "not known", not "not spent", which matters because weakening the uniform claim for every pre-marker run would cost the accurate message in the case that is nearly all of them:
only a target whose retained bodies average more than ~256 KiB reaches the budget at the defaults.
The app's retention note drops its uniformity sentence only when the key reads `true`; absent or `false` both keep it.

Three of its keys are about captured responses rather than retention: `responseBodiesCaptured` is how many exchanges the run stored (see [GET /runs/:runId/samples](runs.md#get-runsrunidsamples)), and is also the run's own marker that it holds response data **stored verbatim** - non-zero is what the Samples tab warns on.
`sampleBodiesDropped` counts samples whose headers were kept but whose body was dropped once the run's `maxSampleBytes` budget was spent.
`exemplarsDropped` counts per-status exemplars refused because `max_exemplar_results` was full, which only a target answering with more distinct status codes than that limit can reach.
All three are absent on runs recorded before 0.15.0.

`monitor` is present only for a run that declared a [`monitor` block](load-runs.md#the-monitor-block-server-vitals) - absent is "this run scraped nothing", never "the target reported zeros".
`samples` counts scrapes that read at least one requested name; the others are split by cause.
`failures` counts the scrapes that got no 2xx answer, and `lastError`, present once one has, names the most recent one's cause: `HTTP <status>`, or one of `timed out`, `unreachable`, `host not found`, `TLS handshake failed`, `proxy failed`, `URL refused`, `too many redirects`, `undecodable body`, `response too large` and `transport error`.
It is never the transport's own message, which can quote the URL.
`noMatchScrapes` counts the 2xx answers that carried none of the requested names.
So `samples: 0` with a non-zero `failures` says the endpoint was unreachable or erroring for the whole run, and `samples: 0` with a non-zero `noMatchScrapes` says it answered every time but the names matched nothing.
A series that never produced a reading is absent from `series` for the same reason.
`noMatchScrapes` and `lastError` are absent on a run recorded by an engine that predates them, whose `failures` count no-matches too.
The per-sample readings are served separately by [`GET /runs/:runId/monitor`](metrics.md#get-runsrunidmonitor).

`results[].id` is the `results` row id, and the join key against `GET /runs/:runId/samples`.
It is absent on reports served by an engine older than 0.15.0.
The rows are listed by `timestamp`, not by `id`.

`metadata.configuration` carries the load-test tuning knobs present in the snapshot (`mode`, `duration`, `concurrency`, `iterations`, `startConcurrency`, `rampUpDuration`, `timeout`, `comment`, `followRedirects`, `maxRedirects` - each omitted when absent, and recording what the run was sent, never a default the engine filled in; issue #2437) plus `httpVersion`,
which is always present with the same `"auto"`-when-unknown normalization `GET /runs`'s `summary` uses (see above), and `acceptEncoding` (issue #1488) and `expectContinue` (issue #2516),
read out of the snapshot's `defaultHeaders` and omitted on the same terms as `GET /runs`'s `summary` key `acceptEncoding` (`expectContinue` is on the report only, not in the list row: only the comparison reads it).
`rps` in the raw snapshot is renamed to `targetRps` here, and `rps` is read first (`targetRps` is the rate only when `rps` is absent, null or zero), as in `GET /runs`'s `summary`.
`dataRowCount` is the size of the data set a run bound, and `dataFileName` / `dataFileHash` (issue #2051) the file it came from, by display name and SHA-256 of its bytes, never its path, with `dataFileCastNumbers: true` (issue #2540) when that file's numbers were read as numbers.
A single-request run's are read off the snapshot's top level; a collection run's off its `scenario` manifest, so every report of a run that named a file carries them here, and a run that named none has no such key.
`carriedBudgets` (issue #2195) is the list of `thresholds` keys the client sent as carried over from an earlier run rather than set for this one, echoed as sent and omitted when the run sent none (see [Carried-over budgets](load-runs.md#carried-over-budgets-carriedbudgets)); `GET /runs`'s `summary` does not carry it.
A `capacity` run's own two knobs (issue #2925), `stepDuration` (the string the run was started with, as `duration` is) and `sloMs`, are echoed as sent, on a `capacity` run only and omitted when it left one at its default: the search's effective budget is the report's `capacity.sloMs`.
A run of any other mode has neither key, whatever its snapshot holds.
`POST /export/run-report` carries both in `config.configuration`.
