# Metrics Enrichment (per-tick + report) — Design

**Goal:** Persist more of what the engine already knows so that (a) the completed-run
history view can reach mode-adaptive parity with the live dashboard, (b) the live
dashboard can surface richer signals (status-class timeline, bytes/MB-s), and
(c) stored runs are a faithful record for later analysis/export. One engine
enrichment pass serving all three.

**Scope:** Engine persistence + serialization, plus the app-side wiring to consume
the new fields. Does **not** include windowed/per-interval latency metrics — those
are explicitly parked (see "Parked / blocked").

**Non-goal / parked:** per-tick latency percentiles, avg-latency, avg-queue-wait
(only meaningful *windowed*, which is deferred — tracked as W1). Consequently the
ramp **breakpoint / saturation / response-time-vs-concurrency scatter** in the
history view stay **blocked** on W1 (they need per-tick p99). Everything else in
this spec is unblocked.

---

## Background: what's persisted today vs. available

The engine computes far more than it stores. Verified inventory:

- **Live SSE** (`get_current_stats` + `metrics.cpp`, 10 Hz) already emits: totals,
  errorRate, currentRps, sendRate, throughput, activeConnections, backpressure,
  requestsSent/Expected, **status2xx/3xx/4xx/5xx**, **droppedRequests**,
  **avgQueueWaitMs**, latencyP50/95/99 *(cumulative)*. The app's `sse-client.ts`
  maps only a subset and **discards the status classes**.
- **Stored time-series** (`collect_metrics`, 1 Hz → DB → `/stats`) persists only:
  Rps, ErrorRate, ConnectionsActive, RequestsSent, RequestsExpected, SendRate,
  Throughput, Backpressure. No latency, no queue, no dropped, no status classes.
- **Final report** (`/report`) has rich aggregates but is **missing**: dropped
  total, queue-wait summary, bytes, peak concurrency, and `startConcurrency` /
  `rampUpDuration` in `configuration`.
- **Bytes** are tracked **nowhere** — `bytes_sent`/`bytes_received` are hardcoded
  `0` in `sse-client.ts` and have no engine atomic or capture path.

The DB-contention architecture (in-memory per-result collection + 1 Hz batched
writes + WAL + `SQLITE_BUSY` retries) was a real, deliberate response to the
60k-RPS **per-result** hot path — it does **not** constrain the 1 Hz tick writer.
Adding a handful of rows/sec there is safe (see "Cost").

---

## Design

### Why counts are safe to persist cumulatively (and averages are not)

With windowed parked, per-tick metrics split cleanly:

- **Counts** (dropped, status-class counts, errors, **bytes**) are **monotonic**.
  Persisting them cumulatively per tick lets the *client diff consecutive ticks*
  to get per-interval rates (drops/sec, 5xx-in-interval, MB/s) with **no engine
  windowing**. Useful as-is.
- **Averages / percentiles** (avg-latency, avg-queue, p50/95/99) are
  cumulative-from-start, so a per-tick series **flattens** and can't show "p99
  worsened at minute 3." Worthless without windowing → parked with W1.

So this task persists **counts only** per tick, plus run-level report aggregates
(which are windowing-agnostic).

### 1. Bytes capture (new plumbing)

**`engine/src/http/event_loop/curl_utils.cpp`** (≈ lines 251-291 — the existing
block that calls `curl_easy_getinfo` for `CURLINFO_RESPONSE_CODE` and the
`CURLINFO_*_TIME` infos and populates `response.timing`): add
`curl_easy_getinfo(curl, CURLINFO_SIZE_DOWNLOAD_T, …)` and
`CURLINFO_SIZE_UPLOAD_T`. For wire-accurate totals, also add
`CURLINFO_HEADER_SIZE` (response headers) and `CURLINFO_REQUEST_SIZE` (request
headers). Store on the result as `response.timing.bytes_down` / `bytes_up` (new
fields). Rationale: curl's wire bytes (headers + on-wire body, honoring
transfer-encoding) are correct; `response.body.size()` would undercount
(decompressed, no headers). *(Note: `curl_callbacks.cpp` is only the debug/header
trace callback — NOT the completion/getinfo site.)*

**`engine/include/vayu/core/metrics_collector.hpp` / `.cpp`:** add atomics
`total_bytes_sent_`, `total_bytes_recv_` + accessors `total_bytes_sent()`,
`total_bytes_received()`, and a **dedicated `record_bytes(size_t up, size_t down)`**
method (relaxed-atomic `fetch_add`). `handle_result` calls `record_bytes(...)`
once on both the success and error paths.

**Do NOT extend `record_success`/`record_error` signatures.** Those are called
from `load_strategy.cpp` *and* from `metrics_collector_test.cpp` /
`metrics_helper_test.cpp` (several call sites using the current
`record_success(code, latency, queue)` form); threading bytes through the
signature forces every test to change. A separate `record_bytes()` keeps blast
radius to the single new call in `handle_result`.

### 2. MetricName enum

**`engine/include/vayu/types.hpp`:** add `DroppedRequests`, `BytesSent`,
`BytesReceived` with `to_string` (`"dropped_requests"`, `"bytes_sent"`,
`"bytes_received"`) and `parse_metric_name` cases. `StatusCodes` already exists
(used for the final status map) and is reused for the per-tick blob.

### 3. Per-tick persistence (`collect_metrics`, 1 Hz)

In `engine/src/core/run_manager.cpp` `collect_metrics`, add to the existing
batched metric vector (still one transaction):

- `DroppedRequests` = `metrics_collector->dropped_requests()` (cumulative)
- `BytesSent` = `total_bytes_sent()`, `BytesReceived` = `total_bytes_received()`
  (cumulative)
- `StatusCodes` row with `labels` = JSON of the full code→count map
  (`status_code_distribution()` serialized, same shape as the final metric)

*(Do NOT add avg-latency/queue/percentiles — parked.)*

**Final `StatusCodes` row coexists with the per-tick ones.** `run_manager` already
writes a final `StatusCodes` metric at run end; with per-tick rows sharing the
same `MetricName`, the `/stats` serializer will also bucket that final row (it
lands in the last time bucket). Benign, but the serializer must treat
per-timestamp `StatusCodes` as last-write-wins within a bucket so the final row
doesn't double-count.

### 4. Time-series serializer (`/stats`)

**`engine/src/http/routes/metrics.cpp`** time-bucket grouping: extend the
`if (metric.name == …)` chain to populate:

- `bucket["dropped_requests"]` ← `DroppedRequests`
- `bucket["bytes_sent"]` / `bucket["bytes_received"]` ← `BytesSent`/`BytesReceived`
- `bucket["status_codes"]` ← parsed `StatusCodes` labels JSON (object of code→count)

and initialize these in the bucket defaults (alongside the existing `current_rps`
etc.) so absent ticks are well-formed.

### 5. Live SSE (`get_current_stats`)

**`engine/src/core/metrics_collector.cpp`:** add `stats["bytesSent"]` /
`stats["bytesReceived"]`, and **`stats["statusCodes"]`** = the full code→count map
(`status_code_distribution()`, already available under `status_codes_mutex_` —
cheap at 10 Hz). dropped + queue are already emitted.

**Unify the status shape across live and stored.** Today live SSE emits only
status *classes* (`status2xx…5xx`) while the stored time-series (§3) carries the
full code→count map. If left split, the app must map two shapes and the
over-time chart can't consume both. Emitting the full `statusCodes` map live too
means **one `status_codes` field everywhere**; the 2xx/3xx/4xx/5xx classes are
derived from it client-side. (The legacy `status2xx…5xx` keys can stay for
back-compat but are no longer the source of truth.)

**Live instantaneous MB/s** is **client-derived**: the UI diffs cumulative
`bytesReceived` between consecutive ticks (mirroring how `currentRps` is already
derived from `totalRequests` deltas). No engine `bytesPerSec` field is added.

### 6. Final report

**`engine/src/core/run_manager.cpp`** (final metrics) + **`runs.cpp`** (report
builder + override loop) + **`app/src/types/domain.ts`** (`RunReport`):

- `summary.droppedRequests` ← dropped total
- `summary.avgQueueWaitMs` ← `average_queue_wait()`
- `summary.bytesSent` / `summary.bytesReceived` (+ derived
  `summary.throughputBytesPerSec` = bytesReceived / testDuration, computed in the
  report builder — **bytes**, not bits; the UI formats to MB/s. Avoid the name
  "Mbps" which reads as megabits.)
- `summary.peakConcurrency` ← **B1's `peak_in_flight` gauge** (see Dependency)
- `metadata.configuration.startConcurrency` / `.rampUpDuration` — add to the
  `config_obj` builder in `runs.cpp` (currently only mode/duration/targetRps/
  concurrency/timeout/comment). Enables ramp configured-vs-achieved recompute
  app-side without per-tick target storage.

*(min/max latency stays in the B1 closed-loop spec, per decision.)*

### 7. App consumption

- **`app/src/services/sse-client.ts`:** map `bytesSent`/`bytesReceived` (stop
  hardcoding `0`); map the status classes (currently discarded).
- **`app/src/types/domain.ts`:** `LoadTestMetrics` gains `status_codes?` (per-tick
  map) and the already-present `bytes_*` get real values; `RunReport.summary`
  gains the new fields; `RunReport.metadata.configuration` gains
  `startConcurrency?` / `rampUpDuration?`.
- **Charts (live + history):** a status-codes-over-time stacked area (from the
  unified per-tick `status_codes` map; classes derived client-side) and a bytes
  throughput (MB/s) readout (client-diffed cumulative bytes for live; report
  `throughputBytesPerSec` for the summary). History's `HistoricalChartsSection`
  and the live `MetricsView` both consume the same enriched `LoadTestMetrics`.
  **The stacked status chart is net-new UI** (no existing stacked-area primitive)
  — scope/estimate it as a new component, not a tweak.

---

## Dependency on B1

`summary.peakConcurrency` requires the `peak_in_flight` gauge defined in the
closed-loop spec (`2026-06-03-closed-loop-concurrency-design.md`). The gauge is
intrinsic to B1 (its tests assert peak≈N). Resolution: **whichever task lands
first adds the gauge to `RunContext`**; the other consumes it. If this enrichment
ships first, add the gauge here (it is ~3 lines) and B1 reuses it. The spec for
each notes the shared field so the two don't double-define it.

`min`/`max` latency report fix lives in the B1 spec; there is minor `run_manager`
final-metrics overlap (both append rows) — coordinate at implementation time, no
design conflict.

---

## Cost

`collect_metrics` goes from ~8 to ~12 rows/sec (dropped + 2 bytes + 1 status JSON),
still one batched WAL transaction at 1 Hz. A 5-minute run = ~3600 extra rows total
— negligible. The 60k-RPS contention story is the per-result path, which stays
in-memory and is untouched.

---

## Critical files

| File | Change |
|---|---|
| `engine/src/http/event_loop/curl_utils.cpp` | At the existing `curl_easy_getinfo` block (~251-291), read `CURLINFO_SIZE_DOWNLOAD_T`/`SIZE_UPLOAD_T` (+ `HEADER_SIZE`/`REQUEST_SIZE`); set `response.timing.bytes_down/up` |
| `engine/include/vayu/types.hpp` | `MetricName::DroppedRequests`/`BytesSent`/`BytesReceived` + `to_string`/`parse`; `timing.bytes_down`/`bytes_up` fields |
| `engine/include/vayu/core/metrics_collector.hpp` / `.cpp` | `total_bytes_sent_`/`recv_` atomics + accessors; new `record_bytes(up,down)` (NOT a signature change to record_success/error); emit `bytesSent`/`bytesReceived` + full `statusCodes` map in `get_current_stats` |
| `engine/src/core/load_strategy.cpp` | `handle_result` calls `record_bytes(timing.bytes_up, timing.bytes_down)` on both success and error paths |
| `engine/src/core/run_manager.cpp` | `collect_metrics`: persist Dropped/Bytes/StatusCodes per tick; final metrics: dropped total, queue summary, bytes totals, peakConcurrency |
| `engine/src/http/routes/metrics.cpp` | `/stats` serializer: map dropped/bytes/status into the time-series bucket |
| `engine/src/http/routes/runs.cpp` | Report builder: new `summary` fields + MB/s; `config_obj += startConcurrency, rampUpDuration` |
| `app/src/services/sse-client.ts` | Map `bytesSent`/`bytesReceived` (un-hardcode 0); map status classes |
| `app/src/types/domain.ts` | `LoadTestMetrics.status_codes?`; `RunReport.summary` + `configuration` new fields |
| `app/src/modules/dashboard` + `history` charts | Status-class-over-time stacked chart; bytes/MB-s readout |
| `engine/tests/` | Bytes capture/accumulation; per-tick rows present; report fields |
| `docs/engine/api-reference.md` | Document new `/stats` time-series fields, report fields, SSE bytes |

---

## Verification

TDD (engine test-first).

### Engine
1. **Bytes capture:** run N requests against a fixed-size mock response; assert
   `total_bytes_received()` is **monotonic, non-zero, and ≥ N × body_size**
   (header sizes vary, so don't assert an exact total unless the mock pins known
   headers); `report.summary.bytesReceived` matches the collector. Upload bytes
   asserted on a POST with a known body.
2. **Per-tick rows:** after a multi-second run, `/stats` time-series buckets each
   contain `dropped_requests`, `bytes_sent`, `bytes_received`, and a `status_codes`
   object; a `constant_rps` slow run shows non-zero `dropped_requests` accumulating.
3. **Report fields:** completed run's `/report` has `summary.droppedRequests`,
   `avgQueueWaitMs`, `bytesSent/Received`, `throughputMbps`, and
   `configuration.startConcurrency`/`rampUpDuration` for a ramp run.
4. **Live SSE:** a tick carries non-zero `bytesSent`/`bytesReceived` and a full
   `statusCodes` map (same shape as the stored time-series — assert one shape
   feeds both surfaces).
5. **Regression:** existing `/stats`/`/report` consumers unaffected; full engine
   suite green; the per-result hot path is untouched (no new per-request DB write).

### App
6. **`sse-client` mapping test:** a sample SSE blob maps `bytesSent`/`bytesReceived`
   to non-zero `bytes_*` and populates the unified `status_codes` map (and derived
   classes); type-check clean.
7. **Visual:** status-class-over-time chart renders on both live and history views;
   bytes/MB-s readout shows a real value (no longer 0). Verify live across modes.

### Parked (do NOT attempt here)
- Per-tick avg/queue/percentiles and the history breakpoint/saturation/scatter —
  blocked on windowed (W1).
