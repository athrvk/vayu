---
description: >-
  The live SSE stream of a running load test and the events route.
---

# Live metrics and events

## GET /runs/:runId/live

Stream live metrics for a run via Server-Sent Events, replayed from a retained in-memory tick topic.
The engine produces one wire-ready `metrics` tick per `liveTickIntervalMs` (default 100ms) into a per-run buffer; this endpoint replays that buffer **from offset 0** (or, for a reconnecting client that names a resume point, from the frame after it) and then tails new ticks until the run finishes, ending with a `complete` event.
Because the topic is retained for `liveRetentionMs` (default 60000ms) after completion, a client that connects late - even after a sub-second run has already finished - still receives the full series.
There is no attach race.

**Events:**
```
event: metrics
id: 0
data: {"runId":"...","timestamp":1234567890,"elapsedSeconds":10.5,
       "totalRequests":1500,"totalSuccess":1495,"totalErrors":5,"errorRate":0.33,
       "httpErrors":5,"noResponse":0,"cancelled":0,
       "currentRps":150.5,"currentSendRate":151.0,
       "sendRate":150.0,"throughput":149.5,
       "activeConnections":100,"backpressure":0,"phase":"sending","droppedRequests":0,
       "skippedRequests":0,"stalledMs":0,
       "avgLatencyMs":45.2,"avgQueueWaitMs":0.4,
       "windowAvgInFlight":6.7,"windowAvgLatencyMs":44.8,"windowAvgQueueWaitMs":0.3,
       "latencySamples":15,"latencyP50Ms":38.5,"latencyP95Ms":95.1,"latencyP99Ms":156.7,
       "cumulativeP50Ms":36.0,"cumulativeP95Ms":90.2,"cumulativeP99Ms":160.4,
       "bytesSent":48000,"bytesReceived":1920000,
       "requestsSent":1500,"requestsExpected":0,
       "status2xx":1495,"status3xx":0,"status4xx":3,"status5xx":2,
       "statusCodes":{"200":1495,"404":3,"500":2}}

event: complete
data: {"event":"complete","runId":"run_1234567890","status":"completed"}
```

`status` is the run's own terminal status - `completed`, `stopped` or `failed` - and it is what tells a client which of the three happened while the run is ending, rather than after the stored report has been fetched (issue #1415).
`complete` is sent only once the run has written that status (issue #2140): the last tick can land while the run is still finishing - flushing results, replaying deferred scripts and schema validation, running `script.teardown`, storing the summary - and the stream stays open, sending nothing, until that pass ends.
`status` is **omitted** only when the engine gave up waiting, 60s after the last tick was sent (`LIVE_SETTLE_TIMEOUT_MS`), or the status write itself failed.
A client must read that as "ask the report", never as success: the field is absent on that frame, not `null`, and a client older than it saw no `status` at all.

`elapsedSeconds` is the time since **load started**, the instant the report's `testDuration` is measured from: after the request is built and any `script.setup` has run, immediately before the first submission (issue #2395).
Until then the run is still setting up, and every frame carries `elapsedSeconds: 0` with `sendRate` and `throughput` at `0`, because both divide by it.
The last frame, published just after load ends, therefore reads within a fraction of a second of the report's `testDuration`.
`currentRps` and `currentSendRate` do not divide by it: they divide by the trailing window's own span on the monotonic clock (issue #2393), so they read `0` while nothing is sent, and a window that reaches back before load start counts that idle time in its span.
An engine older than that issue counted from when the run was registered, so a slow setup ran its live clock ahead of the report and dragged the rates down.
The last frame's `sendRate` is still not the report's: the report divides requests sent by the sending window, which ends before the end-of-run drain, where a live frame divides by everything elapsed so far ([`GET /runs/:runId/report`](runs.md#get-runsrunidreport), issue #2392).

A capacity run's frames carry one more key, the search's state (the `capacity` row of the field reference below), here three seconds into the search's third measurement:

```
data: {..., "capacity":{"level":16,"levelElapsedMs":3000,"levelsJudged":2}}
```

**A scenario run streams `step` events instead of `metrics` ticks.**
One per step execution, on the same ring and the same monotonic `id:` numbering, so `Last-Event-ID` resume works identically and a client that reconnects mid-run replays the steps it missed:

```
event: step
id: 3
data: {"iteration":1,"stepIndex":0,"name":"Log in","outcome":"passed",
       "statusCode":200,"latencyMs":42.7,"dataRowIndex":1,
       "requestId":"req_abc123","method":"POST",
       "url":"https://api.example.com/login?access_token=<redacted>",
       "bodyBytes":812,
       "tests":{"passed":2,"failed":0},"extractorMisses":1,
       "unresolvedTokens":1,
       "validation":{"checked":true,"valid":true,"matchedStatus":"200",
                     "matchedContentType":"application/json",
                     "failures":[],"failuresTotal":0}}

event: complete
data: {"event":"complete","runId":"run_1234567890","status":"completed"}
```

`status` carries the same three values and the same absent-means-ask rule as on the metrics stream above.

`outcome` is one of `passed`, `failed`, `skipped`, `errored`, `stopped` - see [Scenario runs](scenario-runs.md#scenario-runs).
`dataRowIndex` is present only for a run with `data`, on the same terms as on the stored row, so a step reads the same live and after a reload.
`stepsNotRun` follows the same rule: present only on the step whose error ended its iteration short of the plan's end, with how many plan positions that cost (see Outcomes under [Scenario runs](scenario-runs.md#scenario-runs)), and absent rather than `0` everywhere else.
`extractorMisses` is the stored row's count of extractions that found nothing (#3053), on the same terms, and `unresolvedTokens` its count of names the step sent unresolved (#3248).
`validation` is the step's schema verdict (issue #681) in the same shape and on the same terms - absent for a step of an unbound collection and for one that sent nothing, and byte-identical to the node its stored trace carries, so a watched run and a read-back one agree.
`tests` is how many of the step's assertions held (issue #724) - two numbers, because the ring is fixed-size and a script may make hundreds of them; the list itself rides the stored `scripts` node.
It counts exactly the assertions that node lists - both script phases, every level's (#2522), and `assert.*` elements beside them - and is absent for a step that asserted none: `0 passed` would read as a result.
`requestId` names the stored request the step ran (issue #831) - the same id `stamp_step_identity` writes onto the stored trace, so a step read live and the same step read back from the report name one request, and a client watching a run can offer the way back to it before the rows are written.
One id is constant-size, which is why it rides the frame where the assertion list does not; absent when the plan step names no stored request, because an empty id is not a request.
`method`, `url` and `bodyBytes` (#3634) say what the step sent, so a watched run can draw its row before the rows are written: the verb, the URL, and the response body's size in bytes (what the stored trace's `response.bodyBytes` reports; a stream's is what it delivered).
The URL is masked as an export masks one - the password of `user:pass@` and the value of a credential query parameter, or of the one the step's own auth wrote, are withheld - but written as `<redacted>` where an export leaves a blank (`user:<redacted>@host`, `?access_token=<redacted>`), so a frame never reads as a value resolved empty;
it is then cut to 512 bytes on a character boundary, which keeps the frame constant-size; the stored row holds the URL whole and unmasked.
All three are absent for a step that sent nothing (a skip, a data row that would not bind), and `url` for a send refused before it had one; `bodyBytes` is `0`, not absent, for an empty body.
A `stopped` step carries no `tests` and no `validation`: what its scripts made of a cancelled send is no verdict.
A scenario run publishes no `metrics` ticks: its work is sequential, so per-tick aggregates would be a rate of one request at a time rather than anything about the sequence.

**Its stream opens with one `plan` frame** (issue #1398), published before the first `step`:

```
event: plan
id: 0
data: {"stepsPerIteration":4,"iterations":3,"stepsExpected":12}
```

`stepsPerIteration` is the plan's length, steps in one pass over it.
`iterations` is how many passes the engine resolved - a data set's row count where the run named no explicit count of its own.
`stepsExpected` is `stepsPerIteration * iterations`, an upper bound rather than a promise, on the same terms as a scenario load run's `requestsExpected` while it runs (the live frame table below):
an errored step can end its iteration (see Outcomes under [Scenario runs](scenario-runs.md#scenario-runs)), `POST /runs/:id/stop` ends the run, `setNextRequest` can walk an iteration in fewer steps than the plan holds, and the `maxStepsPerIteration` cap can end one that walks in more.
It rides the same monotonic id space as the `step` frames that follow - the same ring, so `Last-Event-ID` resume works identically - and a client that attaches after the frame has aged out of the retained ring simply never sees it:
it should read that as no total rather than compute a fraction of a number nobody sent, and show an indeterminate bar the way it would against an older engine that never sent this frame at all.
One frame ahead of the work rather than a number on every tick, because this run publishes no ticks to carry one: the load path's total rides its `metrics` events precisely because that path has them.
(A collection run's report likewise reads its `latency` from the stored summary, not from ticks: see [the report](runs.md#get-runsrunidreport).)

**A run with a [`monitor` block](load-runs.md#the-monitor-block-server-vitals) also streams `monitor` events**, one per successful scrape, interleaved with its `metrics` ticks on the same ring and the same monotonic `id:` numbering - so `Last-Event-ID` resume replays both kinds in the order they happened:

```
event: monitor
id: 12
data: {"timestamp":1234567890,
       "series":{"node_cpu_seconds_total":3.75,"process_resident_memory_bytes":1048576}}
```

The payload is byte-identical to one `data[]` entry of [`GET /runs/:runId/monitor`](metrics.md#get-runsrunidmonitor), so the live overlay and the history overlay are drawn from the same rows.
A scrape that read nothing emits no frame.

**Field reference** (every key of a `metrics` frame; `MetricsCollector::get_current_stats()` builds all but the trailing-window keys (`eventsPerSecond` among them) and a capacity run's `capacity`, which the metrics thread adds on every tick, and the `second*`, `cumulativeLatency`, `cumulativePhases`, `streamTimeToFirstEvent`, `statusSeconds` and `scenario` keys, which it adds on a gate tick):

| Field | Meaning |
|-------|---------|
| `totalRequests` / `totalSuccess` / `totalErrors` | Completed counts; `totalErrors` by the [one error definition](metrics.md#what-counts-as-an-error). All three are counted from the tick's one status-code snapshot (issue #3572), so `totalSuccess + totalErrors` is `totalRequests` on every frame and one frame's `totalErrors` never exceeds its `totalRequests` |
| `httpErrors` / `noResponse` | `totalErrors` split: an error status came back, or no response did |
| `cancelled` | Requests a Stop cancelled before they answered; in none of the counts above ([issue #2136](metrics.md#what-counts-as-an-error)) |
| `errorRate` | `totalErrors` as a percentage of the status-code distribution's total |
| `currentRps` / `currentSendRate` | Completions / dispatches per second over the **trailing window** (issue #2393): at least the last second (`LIVE_RATE_WINDOW_MS`), divided by its actual span, and everything since the first frame until the stream has a second of frames. `0` for a window with nothing in it. A gate frame's pair is its [stored row](metrics.md#get-runsrunidmetrics)'s `current_rps` / `current_send_rate` |
| `sendRate` | Requests dispatched per second, **cumulative**: `requestsSent` over the time since load start |
| `throughput` | Responses received per second, **cumulative**: `totalRequests` over the time since load start |
| `activeConnections` | Transfers active in the curl workers at the sample, the stored tick's `current_concurrency`. Instantaneous: a virtual user in a timer wait holds none, so a run whose users wait in step reads 0 or the user count depending on where the sample lands. `windowAvgInFlight` is the mean |
| `backpressure` | In flight at the sample: requests sent but not yet settled (`RunContext::in_flight`), plus, on a **closed-loop single-request** run only, every slot a `timer.think` wait still holds. A scenario run's timer waits are not counted, because its dispatcher treats a waiting virtual user as not in flight, and a `constant_rps` run reserves none, because it skips the timer ([#3541](load-runs.md#the-requestelements-array-a-single-request-runs-own-step-level-elements)). The same figure as the stored tick's `backpressure` and the high-water mark behind the report's `peakConcurrency`, so on a single-request think-timer run it exceeds `requestsSent - totalRequests`, and once a Stop has cancelled requests it is `requestsSent - totalRequests - cancelled` |
| `phase` | Where the run's worker is at the sample (issue #3568), on every frame: `setup`, `sending`, `draining` (the strategy returned on its own and `backpressure` is the in-flight requests the natural-end drain waits out, no longer new load), `summarising` or `settled`. A run moves forward only and may skip one; see [Stop semantics](runs.md#post-runsrunidstop) for what a Stop does in each. Live only: no [stored row](metrics.md#get-runsrunidmetrics) carries it, and an older engine sends no such key |
| `droppedRequests` | Requests discarded at the `maxInFlight` cap (never sent) |
| `skippedRequests` / `stalledMs` | `constant_rps` only (#2911): requests a stalled pacer owed beyond its 100 ms catch-up window and skipped (never sent, not in `droppedRequests`), and the schedule time they cover in ms, `skippedRequests ÷ targetRps`. `0` on every other mode |
| `avgLatencyMs` | Mean **perceived** latency over the same requests as the percentiles and the max ([Latency population](metrics.md#latency-population)): answered requests plus those that failed after their transfer ran |
| `avgQueueWaitMs` | Mean time queued before the wire, inside the generator or in libcurl waiting for a connection slot (#2394), over the same requests as `avgLatencyMs` ([Latency population](metrics.md#latency-population)) |
| `windowAvgLatencyMs` / `windowAvgQueueWaitMs` | The same two means over only the requests that completed in the trailing window `currentRps` covers (issue #2393), from the difference of the run's sums and counts across it; `null` when nothing completed in it. A gate frame's pair is its stored row's `window_avg_latency_ms` / `window_avg_queue_wait_ms` |
| `windowAvgInFlight` | Mean requests in flight over the same trailing window (issue #2821): the time requests spent in flight during the window divided by its span (issue #3567), so a request open across the window counts whether or not anything completed. A request is in flight from submission to completion, queue wait included, and a Stop's cancellation ends it; a timer wait between requests and a request refused or skipped before it reached the event loop are not. With no think time it equals the virtual user count, and it does not alias the way `activeConnections` does. `0` for a window with nothing in flight, never `null`. A gate frame's value is its stored row's `window_avg_in_flight` |
| `latencySamples` | How many completions the tick's window held, the population of the three below (issue #2386). `0` says the window had no completion, which no percentile can say |
| `latencyP50Ms` / `latencyP95Ms` / `latencyP99Ms` | Live **windowed** percentiles over the [latency population](metrics.md#latency-population) - the last tick's window (100 ms at the default cadence) sampled from a phaser-based `hdr_interval_recorder`; `null` when `latencySamples` is `0`, never a 0 ms reading (issue #2386; an engine before it wrote `0`). The capacity search steers by these |
| `cumulativeP50Ms` / `cumulativeP95Ms` / `cumulativeP99Ms` | The same percentiles over **every completion so far**, the span `avgLatencyMs` covers, merged from every window sampled up to this tick; on every frame, `null` until something has completed. The final report's `latency` block is the same population read from the run's own histogram |
| `secondSamples`, `secondP50Ms` / `secondP95Ms` / `secondP99Ms` | **Gate frames only** (issue #2385): the frame of the tick that wrote a [stored row](metrics.md#get-runsrunidmetrics), about once a second, carries that row's figures - every window since the previous gate merged, and how many completions they held. The final frame carries them too, for the partial second since the last gate, which is stored nowhere. The percentiles are `null` when `secondSamples` is `0`. Absent from every other frame |
| `cumulativeLatency` | **Gate frames only** (issue #2782), the final frame included: the run-so-far latency distribution, `{minMs, p50Ms, p75Ms, p90Ms, p95Ms, p99Ms, p999Ms, maxMs, count}`, over the same completions as the `cumulative*Ms` keys. `null` until something has completed, never zeros. The final frame merges the last window after the drain, so its figures are the report's [`latency`](runs.md#get-runsrunidreport) block. Absent from every other frame |
| `cumulativePhases` | **Gate frames only** (issue #2782): `{dns, connect, tls, firstByte, download}`, each `{meanMs, p50Ms, p95Ms, p99Ms, maxMs, count}`, from the same per-phase histograms as the report's [`timingBreakdown`](runs.md#get-runsrunidreport), which every successful completion feeds. `null` until a completion has recorded its phases; **absent** when the run has the [phase histograms](load-runs.md#post-runs) off, so absent means "not measured" and `null` means "nothing yet". Read while the run is still recording, one phase at a time, so a mid-run reading's phase counts can differ from each other and from its frame's counts by the completions that landed between the reads; the final frame is read after the drain and its means are the report's `avg*Ms`. Absent from every other frame |
| `streamEvents` / `streamsOpen` | **Streaming runs only** (issue #3236; a single-request run with `stream`, or a collection load run with a streaming step, #3304), on every frame, and only while [`stream_metrics`](load-runs.md#post-runs) is on: the events delivered so far, counted on the write path as they arrive rather than when a stream completes, so a run of long streams is not blank until the first one ends; and the streaming transfers open at the sample, which on a collection run that mixes streaming and ordinary steps is fewer than `activeConnections` (that one counts every transfer). A stream leaves `streamsOpen` however it ends (a cap, the server's close, an error, a Stop), so the settled frame reads `0`. Once the run settles, the final frame's `streamEvents` equals the report's [`stream.totalEvents`](runs.md#get-runsrunidreport), the unterminated last frame a close completes included; a run a Stop ended also counts the events of the streams it cancelled, which the report does not. Absent from every other run's frames, never zeroed |
| `eventsPerSecond` | **Streaming runs only** (issue #3236), on the same frames as `streamEvents`: events per second over the trailing window `currentRps` covers, from the difference of `streamEvents` across it. `0` on the first frame and for a window with nothing in it. Live only: no [stored row](metrics.md#get-runsrunidmetrics) carries it |
| `streamTimeToFirstEvent` | **Gate frames only** (issue #3236), on the runs that carry `streamEvents`: `{p50, p95, p99, max, count}` in milliseconds, from submission to the first event, over the streams **completed** so far, from the histogram behind the report's [`stream.timeToFirstEvent`](runs.md#get-runsrunidreport); a stream still open is not in it. Absent until a completed stream delivered a timed event, and from every other frame. The report's `stream.timeToFirstMatch` (#3774), `stream.maxEventGap` and `stream.eventRate` (#3776) have no live counterpart: they are read once, after the drain |
| `bytesSent` / `bytesReceived` | Cumulative wire bytes: every hop's headers and body, each counted once, so a followed redirect counts its own response (body included) and, for a `307`/`308`, the request body it sent again (issue #2893) |
| `requestsSent` / `requestsExpected` | Progress for bounded modes (drives ETA). A scenario `iterations` run starts `requestsExpected` at iterations x steps per iteration, an upper bound while it runs because an abandoned iteration never sends its later steps; a natural end settles it to the sent count, so the final frame reads 100%. A stopped run keeps the upper bound (issue #2914) |
| `capacity` | **Capacity runs only** (issue #2928), on every frame from tick 0: where the search stands, `{level, levelElapsedMs, levelsJudged, stopReason?}`. `level` is the concurrency being measured, `0` until the first level opens (tick 0 is emitted before it does). `levelElapsedMs` is the time since that level opened, `0` while `level` is `0`, and held at the moment the search ended once it has. `levelsJudged` counts the levels judged so far, a re-measured level once per measurement, so the report's [`capacity.levels`](runs.md#get-runsrunidreport) holds that many rows. `stopReason` appears once the search has ended, with the value the report's `capacity.stopReason` carries, `stopped` included, and is absent while it runs. The four are published together, so one frame never pairs a level with another level's time or count. Absent from every other run's frames, never zeroed |
| `status2xx`–`status5xx` | Per-class counts |
| `statusCodes` | Full per-code distribution map |
| `statusSeconds` | **Gate frames only** (issue #2866), the final frame included: the seconds since load start that closed since the previous gate, `[{second, span, counts}]` with `span` `1` and `counts` `[2xx, 3xx, 4xx, 5xx, error]`, each response counted in the second it completed in. A gate frame's entries are its [stored row](metrics.md#get-runsrunidmetrics)'s `status_seconds`, drained once for both, so live and History hold the same seconds; the final frame's are the seconds closed since the last gate, which only it carries. `[]` when no second closed. Absent from every other frame |
| `scenario` | **Gate frames only** (issue #2823), the final frame included, and only on a scenario load run: the sequence so far, `{iterations, iterationsCompleted, iterationsAbandoned, stepsExecuted, meanIterationMs?, steps: [{index, name, executed, errors}]}`, one `steps` entry per plan step in plan order. The same counters as the stored summary's `scenario` block (`iterations`, `iterations_completed`, `iterations_abandoned`, `steps_executed`, and each step's `executed` and `errors`), read while the workers still write, so a mid-run reading's figures can differ from each other by the completions that landed between the reads; the final frame is read after the drain and equals the summary. `meanIterationMs` (#3570) is the mean of the completed passes so far, the report's `scenario.passDuration.mean`, from a sum and a count kept beside its histogram; absent until a pass completes. No other latency: a step's percentiles and the pass percentiles are in the [report](runs.md#get-runsrunidreport) alone. Absent from every other frame and from every frame of any other run

**Read order within one tick.**
The metrics thread snapshots the status-code distribution once, and the request, error and status counts on the frame are that one sample: `totalRequests` is the snapshot's own total, and `totalSuccess`, `totalErrors`, `httpErrors`, `noResponse`, `errorRate`, `throughput` and the `status*` keys all derive from the same copy (issue #3572).
A gate tick's stored row reads the same snapshot, so its `requests_completed` and `requests_failed` are the frame's `totalRequests` and `totalErrors`.
A completion landing after the snapshot is in the next frame's counts, never half in this one, so between two frames the error delta never exceeds the request delta and no per-tick error rate a client derives from them can exceed 100 percent.
An engine before #3572 read `totalRequests` after the snapshot, which could put a completion in one frame's total and only the next frame's errors.

Each `metrics` event carries an `id:` equal to its zero-based offset.
The browser's built-in `EventSource` retry automatically replays this id as `Last-Event-ID` on its **own** intra-connection retries (no application code needed), and the stream resumes from `Last-Event-ID + 1`.

**`?lastEventId=<id>` is the same resume point as a query parameter**, for a client that reconnects by hand: `EventSource` sets `Last-Event-ID` only on its *own* retry and exposes no way to set a header on a fresh connection.
The header wins when both are given.
Frame ids start at **0**, so `lastEventId=0` means "I saw frame 0" rather than "from the start"; absence is what means the start.
A value that is not a non-negative frame id is refused with `400` and code `invalid_last_event_id` rather than resumed from the start, which would replay every retained tick to a client that already holds them - the [change feed](changes.md#get-changes) and [inbox](inbox.md#get-inboxinboxidlive) streams' rule.

**Replay window.**
The in-memory tick topic is a bounded ring, so a long run's memory does not grow with its duration.
Its span is `liveReplayWindowMs` (default 300000, i.e. 5 minutes) and the tick count is derived from that window and the configured cadence - `liveReplayWindowMs / liveTickIntervalMs`, 3000 ticks at both defaults.
The bound is a duration rather than a fixed count because the cadence is itself configurable: one tick count would mean a 30-second window at `liveTickIntervalMs=10` and a 50-minute one at `1000`.
`liveReplayWindowMs = 0` means the full run (no time limit).
Whatever the pair, the ring is capped at `liveMaxRetainedTicks` (default **50,000**, ~50 MB), so a fast cadence reaches that ceiling before a long window does.
Raising it is cheap at stock settings - the window, not the ceiling, is what sizes the ring.

Ids keep counting past an eviction, so they stay monotonic; a `Last-Event-ID` older than the retained window resumes from the oldest retained tick rather than replaying from 0, which means a client that was disconnected for longer than the window sees a gap, not a duplicate flood.

The window also bounds the **replay-from-0** path, which the bundled app takes on a first attach: a dashboard attaching mid-run rebuilds its chart from the retained ring.
Its Reconnect resumes with `?lastEventId=` instead and is sent only the frames after the last one it holds.
That is why `liveReplayWindowMs` is the *same* setting as the app's live-chart window rather than a second one to keep aligned - the app's **Settings → Live Dashboard → Chart window** picker reads and writes this entry (`GET`/`POST /config`), so the span the engine retains and the span the chart displays cannot disagree.
Editing it here and editing it there are the same action.

The final `metrics` event is emitted only once the run's worker has actually settled.
On `POST /runs/:runId/stop` the engine keeps ticking while in-flight requests are cancelled and counted as `cancelled`, so the last live numbers agree with the stored report rather than freezing at the moment of the stop request.

**Application-level reconnect**: a client that closes the EventSource itself (e.g. after observing `readyState === CLOSED`) and opens a new connection resumes with `?lastEventId=<id of the last frame it held>`, because a fresh `EventSource` sends no `Last-Event-ID` and would otherwise start at offset 0 and replay the entire retained topic, duplicating ticks already shown.
A connection that names no resume point is the first attach and does start at 0.
The other recovery is to converge on the stored report via `GET /runs/:runId/report` (the same path used at normal run end).

**Responses:**
- `200` - SSE stream (active run, or finished run still within the retention window).
- `404` - no live topic for the run.
  The flat body is `{"error", "code", "hint"}` and `code` says which of two cases it is (#2775):
  - `live_expired` - the run is stored but its topic aged out past `liveRetentionMs`; `error` is `Live metrics for this run are no longer retained`.
  - `run_not_found` - the engine has no run by that id; `error` is `Run not found or expired`.

  Both hint `Use /runs/:runId/report for the stored report`, and a client should fall back to the stored report in either case (for `run_not_found` the report then answers its own `404`).
  `code` is for clients to branch on; the bundled app has no reader for it yet.
  MCP's `get_live_metrics` reads it (#2779): `live_expired` answers that the buffer expired and the run still exists, naming `get_run_report`, and `run_not_found` keeps the unknown-id text.

Tuning: `liveTickIntervalMs` (live tick cadence, 10–1000ms), `liveReplayWindowMs` (retained replay span *and* the dashboard's chart window, 0–3600000ms; 0 = full run), `liveMaxRetainedTicks` (the tick ceiling for that window on both sides, 1000–500000) and `liveRetentionMs` (post-completion retention, 0–600000ms; 0 disables retention) are configurable via `POST /config`.

## GET /runs/:runId/events

Relay a streaming run's events via Server-Sent Events (issue #573).
Started by `POST /execute` with `"stream": true`, which returns this URL as `eventsUrl`.

The endpoint replays the run's retained events, then tails until the stream terminates, and closes with a `complete` event naming the termination reason.
`complete` is sent only once the post-request script has run and the run row and trace are stored (#3239), so a `GET /runs/:runId/report` made on it already reads the result and a terminal status.
Like the live-metrics topic, the ring is retained for `liveRetentionMs` after the stream ends, so a client that connects late - even after a short stream has already finished - still receives the whole series.

**Events:**
```
event: open
id: 0
data: {"statusCode":200,"statusText":"OK","headers":{"content-type":"text/event-stream"}}

event: message
id: 1
data: {"event":"token","data":"Hello","sourceId":"42","receivedAt":1234567890}

event: complete
data: {"runId":"run_1234567890","reason":"completed","totalEvents":128}
```

- `open` is published once, as soon as the response's header block arrives, so even a late consumer learns what the stream connected to.
  A reply with no body (a `204`, a bodiless `401`, an empty `200`) still publishes it, with its status, before `complete` (#3342).
  With `followRedirects` on it describes the hop the stream ends at: a redirect the stream follows publishes no `open`, and its body is neither an event nor counted.
  Neither does an interim `1xx` (a `100 Continue`) nor a proxy's answer to `CONNECT`: a tunnel refused there ends the stream as `error` with no `open`.
  A stream that failed before any response arrived has none either, and neither does one that ends on a redirect the engine refuses to follow (too many hops, an unsendable scheme).
- `message` carries one upstream event: its `event` name (`message` when the origin sent none), its `data` (multiple `data:` lines joined with `\n`), the origin's own `id:` as **`sourceId`**, and `receivedAt`.
  An event larger than `sseMaxEventBytes` is stored as a prefix and says so in band, with `dataTruncated: true` and `dataBytes` (the size as sent) - never silently cut.
  A send that declared a `streamTextPath` adds `text`, what the path read off this event, and leaves it off an event the path reads nothing from; see [POST /execute](execute.md#post-execute) (issue #3773).
- `complete`'s `reason` is one of `completed`, `stopped`, `shutdown`, `maxStreamEvents`, `maxStreamDurationMs`, `idleTimeout`, `error`; see [POST /execute](execute.md#post-execute).
  No frame carries the exchange's `warnings` (issue #3315): they are on the stored trace, which the report already holds when `complete` arrives.

**`sourceId` is not the resume point.**
`id:` on the wire is this relay's own frame offset, which is what `?lastEventId=` / `Last-Event-ID` takes; `sourceId` is what the *origin* would want back.
Conflating them would make one of the two resumes silently wrong.

**Resume** picks up at the frame *after* the one named, so a dropped consumer re-renders nothing.
The header wins over the query parameter when both are present (`EventSource` cannot set a header on a fresh connection, so a client owning its retry uses the parameter).
Unlike the inbox's capture ids, frame ids start at **0**, so `lastEventId=0` means "I saw frame 0" rather than "from the start"; absence is what means the start.
A present-but-unreadable value is a **400** (`invalid_last_event_id`) rather than a silent replay from 0.
A resume point older than the retained window is fast-forwarded to the oldest retained frame rather than looping on ids that will never come back.

**One consumer at a time.**
Each stream parks a cpp-httplib pool thread for its whole life, so a second concurrent watcher is a `409` (`run_events_in_use`) - but a claim whose holder has stopped writing for two keep-alive intervals is taken over instead of refused, since `EventSource` treats a 409 as fatal and a reconnect racing the previous socket's death would otherwise kill the stream for good.

**Responses:**
- `200` - SSE stream (live stream, or finished one still within the retention window).
- `400` - unreadable `lastEventId` / `Last-Event-ID`.
- `409` - already being streamed.
- `404` - no stream for this run, or it expired past `liveRetentionMs`; the body hints `GET /runs/:runId/report`, whose trace carries the stored `events` node.
