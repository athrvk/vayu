# Latency Accuracy Plan

## Problem Statement

Vayu currently reports **wire-only latency** — the time libcurl measures from the moment
a request is handed to it until the response completes. This misses two things:

1. **Queue wait time**: every request sits in an SPSC queue between `submit()` and
   `curl_multi_add_handle()`. Under backpressure, this can be milliseconds. It is
   invisible in the current measurement.
2. **Dropped requests**: when the event loop is saturated (`pending_count >= max_pending`),
   the scheduler silently discards entire batches. These requests never reach the server,
   never enter the histogram, and are never reported. The run looks healthy when it isn't.

The result: at high RPS with backpressure, p99 numbers are **systematically understated**
and the reported RPS is **higher than what the server actually received**.

### Why this matters — industry baseline

Every mature load-testing tool handles this correctly:

| Tool | Headline latency | Queue wait exposed | Silent drops? |
|---|---|---|---|
| wrk (default) | Wire time | No | No (closed-loop) |
| wrk -R | Perceived from intended-time | Implicit | No |
| Vegeta | Perceived from scheduled-time | Yes (`Wait` field) | No (fires late) |
| k6 | Full perceived (`http_req_duration`) | Yes (`http_req_blocked`) | **`dropped_iterations` counter** |
| JMeter | Perceived (`elapsed`) | N/A (closed-loop) | No |
| **Vayu today** | **Wire only** | **No** | **Yes, silently** |

Vayu is the only tool that (a) reports wire-time as the headline metric, (b) exposes no
queue wait, and (c) silently drops requests.

---

## What "perceived latency" means

```
submitted_at (stamped at EventLoop::submit())
      │
      │  ← queue wait: SPSC queue + handle pool + curl setup
      │
curl_multi_add_handle()
      │
      │  ← wire time: DNS + TCP + TLS + send + recv (CURLINFO_TOTAL_TIME)
      │
completion
      │
      └── perceived_ms  = completion_time − submitted_at   ← the truth
          wire_ms       = CURLINFO_TOTAL_TIME              ← what curl saw
          queue_wait_ms = perceived_ms − wire_ms           ← generator overhead
```

`perceived_ms` is not a statistical estimate or synthetic correction — it is the actual,
measured latency for every individual request, from the moment Vayu decided to send it
until the response was fully received. This is what Vegeta calls `Latency` and what k6
calls `http_req_duration`.

### Why not use `hdr_record_corrected_value`?

`hdr_record_corrected_value` is a workaround for when you do **not** have per-request
timing — it synthesises missing samples statistically based on how long a response took
relative to the expected interval. Once we stamp `submitted_at` on every request we have
the exact number; statistical synthesis is unnecessary and less accurate than measurement.

### Why wire-time is still worth keeping

Users need to distinguish "the server is slow" from "my generator is overloaded". If
`queue_wait_ms` is near zero, the server owns the latency. If `queue_wait_ms` is
significant, the generator is the bottleneck and the test is not generating the load the
user intended. Exposing both in the `Timing` struct enables this diagnosis.

---

## Three changes, shipped in order

### Change 1 — Fix silent drops (ship first)

**Why first:** this is a correctness bug, not a measurement accuracy issue. A dropped
request is worse than a 500 error — the server never saw it, so the load test is lying
about the load it generated. Users must know when this happens.

**What happens today (`load_strategy.cpp:241-244`):**

```cpp
if (context->event_loop->pending_count () >= max_pending) {
    next_batch_time = now + std::chrono::microseconds (batch_interval_us);
    break;  // ← entire batch silently discarded, no record kept
}
```

**Files to change:**

**`engine/include/vayu/core/metrics_collector.hpp`**

Add to private section (after `total_latency_sum_`):
```cpp
std::atomic<size_t> dropped_requests_{ 0 };
```

Add to public section (after `record_error`):
```cpp
void record_drop_batch (size_t count);
[[nodiscard]] size_t dropped_requests () const {
    return dropped_requests_.load (std::memory_order_relaxed);
}
```

**`engine/src/core/metrics_collector.cpp`**

Add implementation:
```cpp
void MetricsCollector::record_drop_batch (size_t count) {
    dropped_requests_.fetch_add (count, std::memory_order_relaxed);
}
```

Add `droppedRequests` to `get_current_stats()`:
```cpp
stats["droppedRequests"] = dropped_requests_.load (std::memory_order_relaxed);
```

**`engine/src/core/load_strategy.cpp`** — replace the silent break:
```cpp
if (context->event_loop->pending_count () >= max_pending) {
    context->metrics_collector->record_drop_batch (batch_size);
    next_batch_time = now + std::chrono::microseconds (batch_interval_us);
    break;
}
```

The counter + UI banner (below) are the user-visible signal; no engine-side log is
needed. A warning log per drop would be either noisy (every batch) or stateful for no
gain (the counter already encodes "first drop seen").

Why `record_drop_batch` instead of `record_drop` called N times: avoids N atomic
fetch_add calls in the hot path; one call for the whole batch.

**`engine/include/vayu/types.hpp`** — add to `MetricName` enum:
```cpp
DroppedRequests,  // Requests discarded due to backpressure (never reached server)
```

And its `to_string` / `parse_metric_name` cases: `"dropped_requests"`.

**`engine/src/utils/json.cpp`** — add `droppedRequests` alongside other metrics in the
JSON serialiser if it serialises `MetricName` values to the stored metrics table.

**App (`app/src/types/domain.ts`):**
```typescript
dropped_requests?: number;
```

**App (`app/src/services/sse-client.ts`):**
```typescript
dropped_requests: metrics.droppedRequests || 0,
```

**App (`app/src/modules/dashboard/components/MetricsView.tsx`):**

- Add a `dropped_requests` counter badge, visible only when `> 0`.
- When non-zero during a live run: show a warning banner:
  > ⚠ **N requests dropped due to backpressure.** The server received less load than
  > configured. Reduce target RPS or increase server capacity.
- The warning must be prominent — a silent drop invalidates the meaning of the RPS number.

**Note on coordinated omission:** dropped requests are intentionally **not** synthesised
into the latency histogram. A request that was never sent has no meaningful end time, and
fabricating one would corrupt the percentile distribution. The counter + banner are the
honest signal: "the histogram below describes N requests; M others were dropped."

**SSE field naming:** the engine emits camelCase (`droppedRequests`); the app remaps to
snake_case (`dropped_requests`). This matches the existing `avgLatencyMs` →
`avg_latency_ms` convention in `sse-client.ts` — not a bug.

---

### Change 2 — Perceived latency as headline (`total_ms` = perceived)

**Why second:** once you can see drops (Change 1), you know when measurements are and
aren't trustworthy. Redefining `total_ms` to perceived is then a coherent next step.

**No DB migration needed:** there are no production users. The column `latency_ms` in
`db::Result` will simply start meaning perceived latency from this point forward.

**Key insight:** changing `total_ms` at its source — `curl_utils.cpp` — means every
downstream consumer (DB write at `execution.cpp:202`, histogram at `load_strategy.cpp:84`,
trace JSON, `avgLatencyMs` in SSE) automatically becomes perceived latency with no further
changes. The measurement point is the single source of truth.

**Files to change:**

**`engine/include/vayu/http/event_loop/transfer_context.hpp`**

Add one field to `TransferData` (after `resolve_list`):
```cpp
std::chrono::steady_clock::time_point submitted_at{};
```

This uses `vayu::Clock` (already `std::chrono::steady_clock`, defined in `types.hpp`).
`steady_clock` is safe: monotonic, no NTP jumps, sub-microsecond resolution.

**`engine/src/http/event_loop/event_loop_impl.cpp`** — in `EventLoop::submit()`:
```cpp
data->submitted_at = std::chrono::steady_clock::now();
// ... existing SPSC queue push
```

Stamp must happen **before** the SPSC push, not after, so it includes any time the push
itself blocks (unlikely with the SPSC but correct by definition).

**`engine/include/vayu/types.hpp`** — extend `Timing` struct (currently lines 122-129):
```cpp
struct Timing {
    double total_ms      = 0.0;  // perceived: submit → completion (new definition)
    double wire_ms       = 0.0;  // new: pure CURLINFO_TOTAL_TIME
    double queue_wait_ms = 0.0;  // new: total_ms − wire_ms (generator overhead)
    double dns_ms        = 0.0;
    double connect_ms    = 0.0;
    double tls_ms        = 0.0;
    double first_byte_ms = 0.0;
    double download_ms   = 0.0;
};
```

`total_ms` is redefined, not renamed — all existing consumers (DB write, trace JSON,
histogram) continue to compile and automatically get the better number. `wire_ms` and
`queue_wait_ms` are new additive fields.

**`engine/src/http/event_loop/curl_utils.cpp`** — rewrite the timing block (around
line 257):
```cpp
// Wire time from curl's internal clock
double wire_seconds = 0.0;
curl_easy_getinfo (curl, CURLINFO_TOTAL_TIME, &wire_seconds);

// Component breakdowns (unchanged)
double namelookup = 0.0, connect = 0.0, appconnect = 0.0, starttransfer = 0.0;
curl_easy_getinfo (curl, CURLINFO_NAMELOOKUP_TIME,   &namelookup);
curl_easy_getinfo (curl, CURLINFO_CONNECT_TIME,      &connect);
curl_easy_getinfo (curl, CURLINFO_APPCONNECT_TIME,   &appconnect);
curl_easy_getinfo (curl, CURLINFO_STARTTRANSFER_TIME, &starttransfer);

// Perceived: wall-clock from submit() to now
auto completion = std::chrono::steady_clock::now ();
double perceived_ms = std::chrono::duration<double, std::milli>(
    completion - transfer_data->submitted_at).count ();

response.timing.wire_ms       = wire_seconds * 1000.0;
response.timing.total_ms      = perceived_ms;                          // redefined
response.timing.queue_wait_ms = std::max (0.0, perceived_ms - response.timing.wire_ms);
response.timing.dns_ms        = namelookup * 1000.0;
response.timing.connect_ms    = (connect - namelookup) * 1000.0;
response.timing.tls_ms        = (appconnect - connect) * 1000.0;
response.timing.first_byte_ms = (starttransfer - appconnect) * 1000.0;
response.timing.download_ms   = (wire_seconds - starttransfer) * 1000.0;
```

The `std::max(0.0, ...)` clamp on `queue_wait_ms` guards against sub-microsecond clock
jitter where `perceived_ms` could appear slightly smaller than `wire_ms`. In debug builds,
also assert `perceived_ms - wire_ms > -1.0` to catch real bugs (wrong clock, `submitted_at`
stamped after `submit()`, etc.) — sub-ms jitter passes, ms-scale negatives trip the assert.
Production behaviour is unchanged.

**`engine/include/vayu/core/metrics_collector.hpp`** — `ResponseSample` constructor
(line 53) reads `resp.timing.total_ms`. After this change it will automatically capture
perceived latency. No code change needed.

**`engine/src/core/load_strategy.cpp`** — `latency = response.timing.total_ms` (line 84)
automatically becomes perceived. The inline trace JSON builder at lines 90–96 also needs
`wireMs` and `queueWaitMs` added alongside `totalMs`/`dnsMs`/…, otherwise per-request
traces silently keep the old fields. Prefer extracting both this site and `utils/json.cpp`
into a single shared serializer rather than maintaining two parallel builders.

**`engine/src/http/routes/execution.cpp:202`** — `db_result.latency_ms =
response.timing.total_ms` automatically becomes perceived. No code change needed.

**`engine/src/utils/json.cpp`** — add `wire` and `queueWait` alongside existing timing
fields in the trace JSON serialiser:
```cpp
timing["total"]     = response.timing.total_ms;       // now perceived
timing["wire"]      = response.timing.wire_ms;         // new
timing["queueWait"] = response.timing.queue_wait_ms;   // new
timing["dns"]       = response.timing.dns_ms;
// ... rest unchanged
```

---

### Change 3 — Queue wait in SSE and live UI chart

**Why third:** depends on Change 2 (`queue_wait_ms` in `Timing`). Also this is the
visible product feature — Change 1 and 2 are correctness fixes, Change 3 is user-facing
observability.

**What we're adding:** `avgQueueWaitMs` in the SSE stream, a live latency chart in the
dashboard showing server time vs. generator overhead as stacked areas.

**Note on live percentiles:** there are no live latency percentiles in the SSE stream
today — only `avgLatencyMs`. p50/p95/p99 are computed from HdrHistogram post-run only.
The live chart therefore shows averages during the test, which is appropriate (averages
are smooth and readable in real-time). Full percentiles remain post-run.

**Files to change:**

**`engine/include/vayu/core/metrics_collector.hpp`**

Add to private section:
```cpp
std::atomic<double> total_queue_wait_sum_{ 0.0 };
```

Add to public section:
```cpp
[[nodiscard]] double average_queue_wait () const {
    size_t count = success_count ();
    return count > 0 ?
        total_queue_wait_sum_.load (std::memory_order_relaxed) / static_cast<double> (count)
        : 0.0;
}
```

**`engine/src/core/metrics_collector.cpp`**

Extend `record_success` signature:
```cpp
void MetricsCollector::record_success (int status_code,
                                        double latency_ms,
                                        double queue_wait_ms,
                                        const std::string& trace_data)
```

Add inside `record_success`:
```cpp
atomic_add_double (total_queue_wait_sum_, queue_wait_ms);
```

Reuses the existing private `MetricsCollector::atomic_add_double` helper
(`metrics_collector.cpp:71`) already used for `total_latency_sum_` — no new infrastructure.

**Breaking signature change — all `record_success` callers must be updated:**
- `engine/src/core/load_strategy.cpp:107` (production call site)
- `engine/tests/metrics_collector_test.cpp` lines 40–42, 65, 85, 114, 131–136, 161, 229
- `engine/tests/metrics_helper_test.cpp:23`

Test call sites can pass `0.0` for `queue_wait_ms` since they don't exercise queueing.

Add to `get_current_stats()`:
```cpp
stats["avgQueueWaitMs"] = average_queue_wait ();
```

**`engine/src/core/load_strategy.cpp`** — update the `record_success` call (around
line 107) to pass `response.timing.queue_wait_ms`.

**`engine/include/vayu/types.hpp`** — add to `MetricName` enum:
```cpp
QueueWaitAvg,   // Average time requests spent queued inside the generator
```

And its `to_string` / `parse_metric_name` cases: `"queue_wait_avg"`.

**App (`app/src/types/domain.ts`):**
```typescript
avg_queue_wait_ms?: number;
```

**App (`app/src/services/sse-client.ts`):**
```typescript
avg_queue_wait_ms: metrics.avgQueueWaitMs || 0,
```

(camelCase→snake_case remap matches the existing `avgLatencyMs` → `avg_latency_ms`
convention in the same file.)

**App (`app/src/modules/dashboard/components/MetricsView.tsx`):**

Add a new live latency panel. Data interface:
```typescript
interface LatencyPoint {
    time: number;         // elapsed_seconds
    serverMs: number;     // avg_latency_ms - avg_queue_wait_ms
    queueWaitMs: number;  // avg_queue_wait_ms
}
```

Chart: stacked area with two areas:
- **Bottom area** (design-system primary colour) — `serverMs`: pure server response time
- **Top area** (warning colour, semi-transparent) — `queueWaitMs`: generator overhead

When `queueWaitMs` is near zero the top area is invisible — test is clean. When
backpressure builds, the warning band grows visibly.

Tooltip on hover:
```
Latency at 4.5s
  Total (perceived):  47.3 ms
  Server wire:        43.1 ms
  Queue wait:          4.2 ms  ⚠ generator overhead
```

---

## Ship order and rationale

```
Change 1 (drops)  →  Change 2 (perceived latency)  →  Change 3 (live chart)
    |                        |                               |
correctness bug         measurement fix              product feature
no new timestamps      requires submitted_at        requires queue_wait_ms
smallest patch         medium patch                 largest patch (UI)
```

Change 1 is independent. Changes 2 and 3 share the `submitted_at` field — implement them
in the same PR or sequentially, but 2 must land before 3.

---

## Files changed — full list

| File | Change |
|---|---|
| `engine/include/vayu/types.hpp` | Extend `Timing`; add `MetricName` entries |
| `engine/include/vayu/http/event_loop/transfer_context.hpp` | Add `submitted_at` |
| `engine/include/vayu/core/metrics_collector.hpp` | Add `dropped_requests_`, `total_queue_wait_sum_`, getters, `record_drop_batch` |
| `engine/src/http/event_loop/event_loop_impl.cpp` | Stamp `submitted_at` in `submit()` |
| `engine/src/http/event_loop/curl_utils.cpp` | Compute perceived, wire, queue_wait |
| `engine/src/core/metrics_collector.cpp` | Implement drop counter, queue wait accumulator; update SSE payload |
| `engine/src/core/load_strategy.cpp` | Call `record_drop_batch`; pass `queue_wait_ms` to `record_success` |
| `engine/src/utils/json.cpp` | Add `wire`, `queueWait` to trace JSON |
| `app/src/types/domain.ts` | Add `dropped_requests`, `avg_queue_wait_ms` |
| `app/src/services/sse-client.ts` | Map new SSE fields |
| `app/src/modules/dashboard/components/MetricsView.tsx` | Drop warning banner; live latency stacked chart |
| `engine/tests/metrics_collector_test.cpp` | Update existing `record_success` calls; add tests for `record_drop_batch`, queue-wait accumulator, new SSE keys |
| `engine/tests/metrics_helper_test.cpp` | Update `record_success` call to pass `queue_wait_ms` |
| `engine/tests/event_loop_test.cpp` (or new) | Assert `total_ms ≈ wire_ms + queue_wait_ms` end-to-end through `submit()` |

---

## Verification

### Manual scenarios (against `scripts/test/` mock server)

**Regression (low RPS, healthy server):** `target_rps=100`, mock server with no
artificial delay.
- `dropped_requests = 0` throughout
- `avg_queue_wait_ms < 1ms` throughout
- `avg_latency_ms` ≈ same as before (queue wait negligible)

**Backpressure scenario:** `target_rps=10000` against the mock server with
`--delay 50ms` and `max_pending=1000`.
- `dropped_requests > 0` within 5s — counter increments, banner appears
- `avg_queue_wait_ms` lands in the 5–50ms range and is visible as the top band of the
  stacked chart
- `avg_latency_ms` (perceived) is higher than pre-change `avgLatencyMs` (wire-only)
  — this is correct, not a regression

**Idle queue (server fast, low RPS):**
- `queue_wait_ms ≈ 0` for individual requests
- `avg_latency_ms ≈ wire_ms` — identical within clock jitter (~1–5µs)

### Unit tests (Google Test, `engine/tests/`)

- `metrics_collector_test.cpp` — add:
  - `record_drop_batch(N)` increments `dropped_requests()` by exactly N; multiple calls
    accumulate.
  - `record_success(status, latency, queue_wait, …)` accumulates `total_queue_wait_sum_`
    such that `average_queue_wait()` returns the mean across N calls.
  - `get_current_stats()` includes `droppedRequests` and `avgQueueWaitMs` keys.
- New test (or extend `event_loop_test.cpp` if present) — assert the invariant
  `Timing::total_ms ≈ Timing::wire_ms + Timing::queue_wait_ms` within the jitter clamp
  for a request driven end-to-end through `submit()`.

### Local DB note

No prod migration is needed (no users), but local dev DBs will contain pre-change rows
where `latency_ms` = wire-time and post-change rows where it = perceived. The two are
not directly comparable across the cutover. Wipe local DBs after upgrading or treat the
discontinuity knowingly when comparing historical runs.
