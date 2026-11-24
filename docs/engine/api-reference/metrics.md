---
description: >-
  What counts as an error, what the latency population is, and the metrics and monitor routes of a run.
---

# Metrics & Statistics

## What counts as an error

A load run counts a request as an **error** when its response status is outside 2xx/3xx, or when it got no response at all - a transport failure (a timeout, a refused connection, a DNS or TLS failure), recorded under status code `0`.
A 3xx is a success, except an `mcp` request's reply that failed under one (a JSON-RPC `error` or a tool's `isError`), which is recorded under `0` too and counted by class in `summary.errorClasses` (issue #3828, [The `mcp` reply](request-body.md#the-mcp-reply)).
The count is derived from the run's status-code distribution (`vayu::count_status_failures`, issue #2124), so every surface reports the same number:
the live tick's `totalErrors` / `errorRate`, the stored tick's `requests_failed` / `error_rate`, the stop response's `summary.errors` / `summary.errorRate`, the report's `summary.failedRequests` / `summary.errorRate`, the [`maxErrorRatePct`](load-runs.md#the-thresholds-block-passfail-budgets) budget and `pm.info.run.errorRate`.

Each of those count surfaces also splits the errors in two, **HTTP errors** (a response came back, with an error status) and **No response**:

| Surface | HTTP errors | No response |
|---------|-------------|-------------|
| Live tick (`GET /runs/:runId/live`) | `httpErrors` | `noResponse` |
| Stored tick (`GET /runs/:runId/metrics`) | `http_errors` | `no_response` |
| Stop response (`POST /runs/:runId/stop`) | `summary.httpErrors` | `summary.noResponse` |
| Report (`GET /runs/:runId/report`) | `summary.httpErrorRequests` | `summary.noResponseRequests` |

A request `POST /runs/:runId/stop` cancels before it is answered is **not an error** (issue #2136), whether the Stop landed while the run was sending or cut its natural-end drain short (issue #3341).
It got no outcome from the target, so it is counted on its own, as **cancelled**, and is in no other count: not the total, not the status-code distribution, not either half above, not the error rate.
A healthy target stopped mid-run therefore reads `errorRate` 0 however many requests were in flight.
The surfaces that carry it:

| Surface | Cancelled |
|---------|-----------|
| Live tick (`GET /runs/:runId/live`) | `cancelled` |
| Stored tick (`GET /runs/:runId/metrics`) | `cancelled` |
| Stop response (`POST /runs/:runId/stop`) | `summary.cancelled` |
| Report (`GET /runs/:runId/report`) | `summary.cancelledRequests` |

The cancelled requests of a drain a Stop cut are also counted once more, as `drainCut: {cancelled}` (issue #3538): on the stored summary, the report's `summary` and the load row's `resultSummary`, and only there, never on a run a Stop stopped or one the Stop cancelled nothing from.
They are the requests that outlived the sending window, the slowest and the hung, so leaving them out of every figure leaves the run judged on its fastest answers: a reader treats such a run as not judged once no budget failed it ([verdict](export.md#post-exportrun-report)).
They are still not errors.

So `totalRequests` is the requests that got an outcome, `successfulRequests + failedRequests`, and every request the run sent is in exactly one of `totalRequests` and the cancelled count.
Only a Stop's cancellation is exempt.
When a run reaches its natural end and no Stop has been requested, a request still in flight after its effective timeout (the run's `timeout`, else the `defaultTimeout` setting) plus a 2s grace is cancelled too, except in a streaming run, whose bound is its `maxStreamDurationMs` plus grace (the 5s stream backstop plus the same 2s, issue #2834), so a stream still within its cap is never cut.
A collection run with a streaming step waits for whichever of the two bounds is longer (issue #3235).
A non-stream request cancelled there never answered: it stays an error, under status code `0`, and its stored error record carries `error_type` `cancelled` (`errors.types` in the report).

A request libcurl **re-sent on a new connection** is not an error either (issue #2799).
When the server drops or refuses a kept-alive connection after reading a request and before writing a byte of the answer (an idle timeout, a per-connection request cap, an HTTP/2 refused stream), libcurl replays the request on a fresh connection on its own; no option turns that off short of giving up connection reuse.
The replayed request is one request with one outcome: counted once in `totalRequests` and the status-code distribution, a success or an error by the status of its last attempt, and with a latency that covers both attempts.
What the target saw is not hidden: each replay is counted in the report's `summary.connectionReplays` and raises the run's `connection_replayed` [warning](runs.md#get-runsrunidreport), so the target received `totalRequests + connectionReplays` requests.
A non-idempotent request (a `POST`) may have run twice there.

## Latency population

A load run's latency figures all describe one set of requests: every request whose **transfer ran**, answered or not.
That is a response of any status (a 4xx or 5xx included) and a request that failed after the transfer began, where the duration is the time until it gave up (a timeout is about its timeout; a reset, a DNS or TLS failure and a body over the byte cap count the same way).
The set feeds the report's `latency` block (`p50` to `p999`, `max`), the live tick's windowed `latencyP50Ms` / `latencyP95Ms` / `latencyP99Ms`, its per-second `secondP*Ms` and cumulative `cumulativeP*Ms`, the stored ticks' `latency_p*_ms`,
`avgLatencyMs` and `avgQueueWaitMs`, the trailing-window means (`windowAvg*Ms` live, `window_avg_*_ms` stored), the exports, and the `latencyP50Ms` / `latencyP95Ms` / `latencyP99Ms` [budgets](load-runs.md#the-thresholds-block-passfail-budgets).
The mean is the sum over the set divided by the set's size, so it agrees with the percentiles and the max.
It is not divided by `totalRequests`.

Left out, because they have no duration to report:

- a request a Stop cancelled (`cancelled`), and a request cancelled at a run's natural end after its effective timeout plus the grace (a streaming run's `maxStreamDurationMs` plus grace), which is an error with no duration;
- a request refused before the wire: one dropped at the `maxInFlight` cap (`droppedRequests`), an invalid URL or an unsendable header, a residual `{{token}}` or file-rule refusal, a data-binding failure.
  An invalid URL includes one libcurl itself refuses before it resolves or connects (a URL it cannot parse, such as a space sent as typed with Send URL without encoding on, or a scheme it guessed for a URL naming none) (#2412).

So a run where 5% of requests hit a 2000 ms timeout reports a p99 and `max` near 2000 ms, and a `latencyP99Ms` budget below that fails it.
`totalRequests`, `errorRate`, `httpErrors`, `noResponse` and `cancelled` do not depend on this set.
The per-phase histograms of the [timing breakdown](runs.md#get-runsrunidreport) stay answered-only: a request that failed has no connect, TLS or first-byte split to report.
A scenario step's histogram follows the same rule as the run's.

Where libcurl reports the failure, the test is whether the transfer reached the network, not which error it ended with.
A reply libcurl cannot read comes back with the same code as a refused URL, but after a real hop, so it is timed.
A redirect to a scheme the engine does not send and an unparsable redirect `Location` are the engine's own refusals, reported by the engine rather than libcurl; the hops before them were answered, so they are timed too.
So are a DNS failure, a refused connection, and a client certificate or CA file libcurl cannot read: libcurl reads those files during the TLS handshake, after the TCP connect, so that failure has a duration.
(A client certificate whose file is already unreadable when the run resolves its transport is dropped there, with a logged error, and the request goes out without it.)

A stored error row carries the same duration (#2412): its `latencyMs` in `results[]`, the Samples tab, and the `results.latency_ms` column hold the time until the transfer gave up, so a request that timed out at 2000 ms is stored at about 2000 ms.
A request with no duration (refused before the wire, or cancelled at a run's natural end) is stored at `0`.
The row has no other way to say "no duration", and `0` can also be a real reading under a coarse clock, so the two cannot be told apart from a stored row; a load run stored by an engine before #2412 holds `0` for every error.
That bounds one report: a run whose summary holds no `latency` (a failed run that wrote no summary, or one the engine died under, whose summary is rebuilt from its last tick and flagged `summary.partial`) is reported from its stored rows alone, and there every stored row, a `0` included, is in the percentiles and the mean, which divides by the rows stored rather than by this population.
A run that finished on its own reports from its summary, which this does not affect.
Those two reports write no `latency` block at all (#2938), so none of this reaches a reader for them.

The sequential collection runner follows the same population, with two differences: its `latency` block is computed **exact nearest-rank** over every sent step's duration rather than from an HDR histogram, and a run in which no step sent stores a count of `0` and the report omits the block (issue #2389).

## GET /runs/:runId/metrics

Paginated **historical time-series** (JSON) for a run's charts.
The response is **always JSON** - any `format` query param is ignored.

**Query parameters:**
- `limit` - max records per page (default 5000, invalid/&le;0 falls back to 5000, capped at 50000).
- `offset` - skip N records (default 0, negative floored to 0).
- `maxPoints` - return the **whole series as at most this many ticks** (capped at 50000; anything but a positive integer is treated as absent).
  `limit` and `offset` are then ignored.
  See [Downsampling with `maxPoints`](#downsampling-with-maxpoints).

Per-tick rows carry the latency percentiles of **their second** (`latency_p50_ms` / `latency_p95_ms` / `latency_p99_ms`, snake_case): every 100 ms window since the previous row merged as one histogram before the percentile is read (issue #2385), so a stall anywhere in the second is in its row.
They sit alongside rps/throughput/concurrency/status codes, so the history view can rebuild the percentiles-over-time chart, the response-time-vs-concurrency scatter, and the capacity-breakpoint / saturation stats from stored data.
The live tick that wrote a row carries the same three figures as `secondP50Ms` / `secondP95Ms` / `secondP99Ms`.
A row stores no sample count, and a second with no completion has **none of the three keys** (issue #2386), the frame's `secondSamples` `0` and `null` percentiles: absent rather than `null` because the [run export](export.md#post-exportrun-report) types them as numbers.
Rows an engine older than issue #2386 stored hold `0` for such a second, and rows older than issue #2385 hold the last 100 ms window of their second instead.

**Response:**
```json
{
  "data": [
    {
      "timestamp": 1234567890,
      "elapsed_seconds": 10.5,
      "requests_completed": 1500,
      "requests_failed": 5,
      "http_errors": 5,
      "no_response": 0,
      "cancelled": 0,
      "current_rps": 150.5,
      "current_send_rate": 151.0,
      "window_avg_in_flight": 6.7,
      "window_avg_latency_ms": 44.8,
      "window_avg_queue_wait_ms": 0.3,
      "current_concurrency": 100,
      "send_rate": 150.0,
      "throughput": 149.5,
      "backpressure": 0,
      "error_rate": 0.33,
      "dropped_requests": 0,
      "skipped_requests": 0,
      "stalled_ms": 0,
      "bytes_sent": 48000,
      "bytes_received": 1920000,
      "status_codes": { "200": 1495, "404": 3, "500": 2 },
      "status_seconds": [ { "second": 10, "span": 1, "counts": [149, 0, 1, 0, 0] } ],
      "latency_p50_ms": 38.5,
      "latency_p95_ms": 95.1,
      "latency_p99_ms": 12.0
    }
  ],
  "pagination": { "total": 1, "limit": 5000, "offset": 0, "hasMore": false, "returned": 1 }
}
```

`requests_failed` is the producer's own error count, written into the tick at write time, by the [one error definition](#what-counts-as-an-error) and from the same status-code snapshot as that tick's `status_codes`; `http_errors` and `no_response` split it.
`cancelled` is the requests a Stop cancelled so far, outside all three (issue #2136); a tick stored before that issue has no `cancelled` key.
It is not derived at read time from `error_rate` and `requests_completed` any more - that derivation depended on the order the EAV rows came back in, and reported 0 failed requests for every bucket of every run.
A tick an engine older than issue #2124 stored has no `http_errors` / `no_response`, and its `requests_failed` counted no-response failures only.

`current_rps` and `current_send_rate` are completions and dispatches per second over the **trailing window** ending at the row's tick (issue #2393): at least the last second, divided by the window's actual span (one second plus up to one tick interval), and until a run has a second of ticks, everything since its first tick.
`window_avg_latency_ms` and `window_avg_queue_wait_ms` are the mean latency and queue wait of the [latency population](#latency-population) that completed in the same window, `null` when nothing did.
`window_avg_in_flight` is the mean number of requests in flight over the same window (issue #2821): the time requests spent in flight during the window, divided by its span (issue #3567).
A request is in flight from its submission to the event loop until it completes, its queue wait inside the generator or libcurl included, and it counts for every part of the window it was open in, so requests open across the whole window with none completing read their count, and a request longer than the window never reads above one.
A virtual user in a timer wait (`timer.think`, `timer.pacing`, `timer.throughput`) has none in flight, and neither does a request refused or skipped before it reached the event loop (a `maxInFlight` drop, a data-binding failure, a step a controller skipped).
A request a Stop cancels after submission was in flight until the cancellation.
With no think time it equals the virtual user count.
It is a number, `0` for a window with nothing in flight, never `null`.
Before issue #3567 the same key held the latency the window's completions carried divided by its span, which read `0` while a request longer than the window was still open and spiked when it completed; rows stored before the change keep that value under the same key.
The live frame of the same tick carries the same five values as `currentRps`, `currentSendRate`, `windowAvgInFlight`, `windowAvgLatencyMs` and `windowAvgQueueWaitMs`.
`current_concurrency` and `backpressure` are instantaneous: see the live frame's `activeConnections` and `backpressure` [below](live-metrics.md#get-runsrunidlive), which they equal.
A run whose virtual users wait in step aliases them between 0 and the user count, which is what `window_avg_in_flight` answers instead.
`send_rate` and `throughput` are **cumulative**: requests sent and completed since load start, divided by the time since load start, so they flatten a change of rate the window shows within a second.
A tick stored before issue #2393 has none of the three new keys, and its `current_rps` divided the completions since the previous row by the time since it.
A tick stored before issue #2821 has no `window_avg_in_flight`.

`status_seconds` (issue #2866) is the seconds the row's gate closed, each with the responses that **completed** in it, by class: `second` counts from load start (the clock `elapsed_seconds` counts from), `span` is `1`, and `counts` is `[2xx, 3xx, 4xx, 5xx, error]`, where `error` is a response with no status (code `0`) or a code outside 200-599.
A second is closed 250 ms after it ends, so a row usually holds one second, two when its gate's cadence crosses two second ends, and `[]` when none closed since the last gate.
Across a run's rows the seconds run on from `0`, one entry each, and a second in which nothing completed is an entry of zeros.
Each response is counted by the clock it completed at, not by the tick that read it, so `counts[i] / span` is a class' rate that a batch landing near a tick does not move; the difference of two rows' `status_codes` counts what landed between their ticks instead.
The live gate frame of the same tick carries the same entries as [`statusSeconds`](live-metrics.md#get-runsrunidlive).
The second still open when the run ends is stored nowhere, and the seconds that close after the last row ride the final live frame only.
A tick stored before the issue has no `status_seconds`.

A missing run returns `404` with the message `Run not found`.

**Storage.**
Each `data[]` entry is one stored row of `metric_ticks` - the engine writes the tick object once, at write time.
Two things follow:

- **Pagination is tick-aligned**: `limit`/`offset` count ticks, so `pagination.total` is the number of ticks (not rows), and a page boundary can no longer return a tick with half its fields zeroed.
- **`elapsed_seconds` keeps counting across pages**, since it is stored with the tick: the seconds since load start, the same reading the live frame of that tick carries as `elapsedSeconds` (issue #2881).
  No tick is stored before load start, and the first stored tick reads between `0` and about `1.0` (the 1 Hz gate counts from the metrics thread's start, so after a setup script it can land anywhere up to one interval after load start).
  A run an engine older than that issue stored counts from its first stored tick instead, so its first tick reads `0`, about one second behind the live clock.

A run with no ticks returns `200` with an empty `data` array - only a run that does not exist is a `404`.

### Downsampling with `maxPoints`

Without `maxPoints` the answer is exactly the paged series above (issue #2547 adds no key to it).
With it, the engine reads every stored tick and answers in one response:

- If the run has at most `maxPoints` ticks, every tick comes back unchanged.
- Otherwise each run of `ticksPerBucket = ceil(total / maxPoints)` consecutive ticks, in stored order, is folded into one; the last bucket may be shorter, and a one-tick bucket is that tick unchanged.

The envelope gains two top-level keys on this path only:

```json
{
  "data": [ ... ],
  "pagination": { "total": 86400, "limit": 2000, "offset": 0, "hasMore": false, "returned": 1964 },
  "bucketed": true,
  "ticksPerBucket": 44
}
```

`pagination.total` is the stored tick count, `limit` echoes `maxPoints`, `returned` is the number of `data` entries and `hasMore` is always `false`.
`bucketed` is `false` and `ticksPerBucket` is `1` when the series already fit.

Most tick fields are cumulative (a run total or a rate over the run so far), so a folded tick is its bucket's **last** tick, with a few keys replaced:

| Field | Folded value |
|-------|--------------|
| `timestamp`, `elapsed_seconds` | The last tick's |
| `requests_completed`, `requests_failed`, `http_errors`, `no_response`, `cancelled`, `dropped_requests`, `skipped_requests`, `stalled_ms`, `bytes_sent`, `bytes_received` | The last tick's (run totals) |
| `error_rate`, `send_rate`, `throughput` | The last tick's (run-long rates) |
| `status_codes`, `custom_metrics` | The last tick's (cumulative maps) |
| `latency_p50_ms`, `latency_p95_ms`, `latency_p99_ms` | The **max** over the bucket, its worst second |
| `current_concurrency`, `backpressure` | The max over the bucket |
| `current_rps` | The mean over the bucket's ticks |
| `current_send_rate` | The mean over the bucket's ticks (#2393) |
| `window_avg_in_flight` | The mean over the bucket's ticks (#2821): each covers about its own second, so this is the bucket's mean in flight |
| `window_avg_latency_ms`, `window_avg_queue_wait_ms` | The mean over the bucket's ticks that carried a number, `null` when none did (#2393) |
| `status_seconds` | Every entry of the bucket's ticks merged into one (#2866): the first entry's `second`, `span` the seconds the entries cover and `counts` summed per class, so `counts[i] / span` is still responses per second; `[]` when the ticks closed no second |
| Any other key | The last tick's |

The latency fields are never averaged: each row's percentile is of its own second, so the bucket's max is an **upper bound** on the bucket's percentile, not an estimate of it, and a one-second spike survives into the bucket that holds it.
A second with no completion carries none of the three keys (issue #2386) and so takes no part in the max: a bucket has them only when one of its seconds completed something.
A bucket of rows an engine older than issue #2386 stored reads `0` only when none of its seconds completed anything, which is what those rows store for such a second.
Rows an engine older than issue #2385 stored hold the last 100 ms window of their second instead, and the max is then taken over those windows.
A key no tick in the bucket carried (`http_errors` on an older row, `custom_metrics` on a run that recorded none) is never added.

Only `GET /runs/:runId/metrics` and `GET /runs/:runId/monitor` ([the same parameter, folded differently](#downsampling-the-monitor-series)) downsample.
The run-report export ([`POST /export/run-report`](export.md#post-exportrun-report)) reads the raw rows; the MCP `get_run_timeseries` and `get_run_monitor` tools page raw rows by default and pass `maxPoints` on request (at most 1000 there, never beside `limit` or `offset`).

## GET /runs/:runId/monitor

Paginated **server vitals** scraped during the run - the samples the [`monitor` block](load-runs.md#the-monitor-block-server-vitals) collected.
Same `{data, pagination}` envelope and the same `limit` / `offset` rules as `GET /runs/:runId/metrics`, so one pagination reader covers both.

**Query parameters:**
- `limit` - max records per page (default 5000, invalid/&le;0 falls back to 5000, capped at 50000).
- `offset` - skip N records (default 0, negative floored to 0).
- `maxPoints` - return the **whole series as at most this many samples** (capped at 50000; anything but a positive integer is treated as absent).
  `limit` and `offset` are then ignored.
  See [Downsampling the monitor series](#downsampling-the-monitor-series).

Its own endpoint rather than extra keys on the tick objects: that key set is the `/metrics` contract, and these samples land on the user's scrape cadence rather than the tick cadence, so they do not line up row for row.

**Response:**
```json
{
  "data": [
    {
      "timestamp": 1234567890,
      "series": { "node_cpu_seconds_total": 3.75, "process_resident_memory_bytes": 1048576 }
    }
  ],
  "pagination": { "total": 1, "limit": 5000, "offset": 0, "hasMore": false, "returned": 1 }
}
```

`timestamp` is wall-clock Unix ms - when the engine scraped, not an elapsed offset - because the scrape starts with the run while a tick's `elapsed_seconds` counts from load start, after any `script.setup`; a stored tick carries the same wall clock, so joining the two series onto one timeline is what `timestamp` is for.
A series the target did not report in that scrape is **absent** from its `series` object rather than zero.

The two fields are read off different clocks, which is why they can disagree.
`timestamp` is wall time, so it moves when the host's clock is adjusted, while every elapsed figure the engine reports (`elapsed_seconds` here, and a run's duration and rates) is measured on a monotonic clock that an NTP step or a manual clock change cannot move.
Over a run that spans an adjustment, the difference between two `timestamp` values is therefore not exactly the difference between their `elapsed_seconds`; the elapsed pair is the one that measures how long the run actually took.

A run that configured no monitor returns `200` with an empty `data` array; only a run that does not exist is a `404`.
Samples are deleted with the run, like every other child row.

### Downsampling the monitor series

`maxPoints` here is the same contract as [on `/metrics`](#downsampling-with-maxpoints) (issue #2611), read from the same `monitor_samples` rows in stored order (by `timestamp`, then insertion):

- Without it the answer is exactly the paged series above; no key is added.
- With a series of at most `maxPoints` samples, every sample comes back unchanged and `bucketed` is `false`.
- Otherwise each run of `ticksPerBucket = ceil(total / maxPoints)` consecutive samples is folded into one (the key keeps the tick series' name, though a bucket here holds samples); the last bucket may be shorter, and a one-sample bucket is that sample unchanged.

The envelope is the one the tick series answers with: `pagination.total` is the stored sample count, `limit` echoes `maxPoints`, `offset` is `0`, `hasMore` is `false`, `returned` is the number of `data` entries, plus `bucketed` and `ticksPerBucket` on this path only.

A folded sample is `{timestamp, series}` like any other:

| Field | Folded value |
|-------|--------------|
| `timestamp` | The last sample's |
| each `series.<name>` | The **max** over the bucket's samples that carried it |

The max keeps a one-scrape spike in a gauge (cpu, memory, a queue depth) that a mean would flatten, and for a monotone counter it equals the last reading.
A name no sample in the bucket carried is never added to the folded `series`, so a gap in the target's reporting stays a gap; a non-number value is skipped.
The MCP `get_run_monitor` tool passes `maxPoints` when asked and otherwise pages the raw samples.
