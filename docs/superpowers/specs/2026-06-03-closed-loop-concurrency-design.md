# Closed-Loop Concurrency + Report max/min Fix — Design

**Goal:** Make `constant_concurrency`, `ramp_up`, and `iterations` enforce a true
in-flight concurrency target (the closed-loop / "virtual user" model) instead of
the current open-loop timer-driven batch submitter, so a "50 concurrent" run
actually holds ~50 requests in flight (today it peaks at ~900). Plus a small,
unrelated fix: the report's `latency.max`/`latency.min` are always `0`.

**Scope:** Engine only. App/UI unchanged (the dashboard already reads
`peakConcurrency` and the report percentiles correctly — it will simply start
showing correct numbers).

---

## Background: the two bugs

### B1 — concurrency is not enforced (the headline)

`ConstantLoadStrategy` (concurrency mode), `IterationsLoadStrategy`, and
`RampUpLoadStrategy` all share one broken pattern: a submission thread wakes
every ~10 ms and dumps a **fresh batch of `concurrency` requests** into the
event loop, sleeps, repeats — only backing off when in-flight crosses a loose
ceiling. There are in fact **two** independent wrong ceilings:

1. **Submission loop** (`load_strategy.cpp`): `maxInFlight` default =
   `max(concurrency * 5, 1000)`. The **floor of 1000** dominates for small N.
2. **EventLoop** (`event_loop_worker.cpp:264`): caps at `max_concurrent`
   **per worker**, where `max_concurrent = max(concurrency, 100)` and there are
   ~12 workers → an effective ceiling near `12 × 100`.

So `concurrency = 50` against a 200 ms endpoint fires ~50 every 10 ms; by the
time the first responses return, ~1000 are already outstanding. The knob today
behaves like a **rate** (~5000/s), not a concurrency of 50. This is why
Concurrency Utilisation reads >100% and peak concurrency hits ~897.

**No production load tool uses this model for a concurrency profile.** They pin
concurrency *structurally*: either N execution units (k6 `constant-vus`
goroutines, JMeter threads, Locust greenlets) or N self-refilling slots on an
async engine (wrk/wrk2 connections, Gatling `constantConcurrentUsers`). Vayu's
architecture (C++ event loop + curl-multi) is the closest cousin to **wrk2**,
whose connections re-issue on each response. That is the model we adopt.

### B2 (redirected) — report `latency.max`/`min` always 0

`calculate_percentiles()` produces correct `max`/`min` from the HdrHistogram,
but `run_manager.cpp` only persists `LatencyP50…P999` + `LatencyAvg` as final
metrics — **not** max/min. The `/report` endpoint overrides p50–p999/avg from
those metric rows, but leaves `latency.max`/`min` as whatever
`MetricsHelper::calculate_detailed_report` computed from the **sampled-only**
`results[]` rows (typically empty) → `0`. (The original B2 symptom — p99=0 /
empty HDR on short runs — no longer reproduces; verified correct across
`constant_rps` 2 s, `iterations` 1000/1.2 s, and `ramp_up` 3 s runs. This task
is the residual `max=0` gap only.)

---

## Design: the closed-loop model

### The invariant

For these three modes, at any instant **in-flight ≈ `target(t)`**, where
in-flight = `requests_sent − total_requests()` (already exposed as
`RunContext::in_flight()`). When a request completes, another is issued to
refill toward the target. Throughput becomes a *result* (`target / latency`),
not an input.

### `target(t)` and stop condition per mode

| Mode | `target(t)` | Stop refilling when | Initial seed |
|---|---|---|---|
| `constant_concurrency` | `N` (constant) | `elapsed ≥ duration` or `should_stop` | `N` |
| `ramp_up` | `start + (target−start)·min(1, elapsed/ramp)` then flat at `target` | `elapsed ≥ duration` or `should_stop` | `start` |
| `iterations` | `N`, but never submit beyond `M` total | `requests_sent ≥ M` or `should_stop` | `min(N, M)` |

After refilling stops, the already-outstanding requests **drain naturally** —
`run_manager.cpp:345` already calls `event_loop->stop(true)` which waits for
pending. No change needed there.

### Refill mechanism — and why it is NOT "submit inside the callback"

The textbook wrk-style realization resubmits *inside the completion callback*.
**That is unsafe in Vayu as built.** Each worker's `pending_queue` is an **SPSC
ring buffer** (single-producer-single-consumer — confirmed by
`EventLoopImpl::cancel`'s comment and the round-robin sharding in
`EventLoopImpl::submit`). Today the **strategy thread is the sole producer**.
Submitting from completion callbacks would make all ~12 worker threads
producers → violates the single-producer invariant → data race. Rebuilding the
queue as MPSC is a high-risk change to the 60k-RPS hot path and is out of scope.

**Chosen realization — single producer, woken by completions.** Keep the
strategy thread as the *only* thread that calls `submit()`, but make it
**event-driven** instead of timer-driven: it sleeps on a condition variable and
is woken the instant a request completes, then refills to the exact deficit.
Behaviorally this is identical to Option A (holds N tightly even for sub-ms
endpoints — the wake latency is µs-scale, not the 10 ms of a fixed timer), and
it respects the SPSC invariant. It also keeps all load-mode logic in the
strategy layer; the mode-agnostic EventLoop is untouched.

A **50 ms timeout** on the wait is the safety net: it guarantees progress even
when no completions arrive (all requests stalled), drives `ramp_up` growth
(target rises with time, not with completions), and bounds stop-detection
latency. This is the "event-driven + poll safety net" that was approved.

#### Why the condvar is correct despite reading atomics outside its mutex

This is a **timeout-backed** condition variable: **correctness never depends on
never losing a wakeup.** The wait predicate reads `in_flight()` (=
`requests_sent − total_requests()`), and those atomics are updated *outside*
`refill_mtx` — which looks like a classic lost-wakeup bug but is not, for two
reasons:

1. `total_requests` only ever **increases**, and `requests_sent` is written
   **only by the producer (strategy) thread itself**. So between the producer's
   own submissions, `in_flight()` can only *decrease*. A missed notification can
   therefore only make the producer **sleep when it could have refilled**
   (a brief undershoot) — it can never cause an overshoot past target.
2. The 50 ms timeout bounds that undershoot, and the *next* completion
   re-notifies. The system self-heals; no wakeup is load-bearing.

Because the deficit is always recomputed against the real `in_flight()`, the cv
is purely a "wake sooner" hint, never the source of truth.

#### The shared controller

A single helper used by all three strategies:

```
maintain_concurrency(context, db, request,
                     target_fn(elapsed) -> size_t,
                     budget_remaining() -> size_t,   // SIZE_MAX for time-bounded modes
                     should_continue(elapsed) -> bool):
    context.closed_loop = true                  // BEFORE seeding (see hook section)
    seed = min(target_fn(0), budget_remaining())
    submit `seed` requests; requests_sent += seed; update_peak()
    loop:
        wait on context.refill_cv for up to 50 ms, OR until
            should_stop || in_flight() < target_fn(now)
        elapsed = now - start
        if !should_continue(elapsed) || should_stop: break
        target = target_fn(elapsed)
        deficit = clamp(target - in_flight(), 0, budget_remaining())
        submit `deficit` requests; requests_sent += deficit; update_peak()
    // return; run_manager drains via event_loop->stop(true)

    // update_peak(): peak_in_flight = max(peak_in_flight, in_flight())
```

- `deficit` is normally 1 in steady state (one completion → one refill) and >1
  during `ramp_up` growth or initial catch-up. Always reconciled against the
  *real* `in_flight()`, so the cv is only a wake signal, never the source of
  truth — lost/extra notifications cannot cause drift.
- `iterations`: `budget_remaining() = M − requests_sent`; `should_continue`
  returns `requests_sent < M`. The clamp guarantees we never exceed `M`.
- `constant_concurrency` / `ramp_up`: `budget_remaining()` = `SIZE_MAX`;
  `should_continue` returns `elapsed < duration`.

#### Completion hook

`RunContext` gains:

```cpp
std::mutex refill_mtx;
std::condition_variable refill_cv;
std::atomic<bool> closed_loop{ false };     // set true by the 3 closed-loop strategies
std::atomic<size_t> peak_in_flight{ 0 };    // monotonic high-water mark of in_flight()
void notify_refill() { refill_cv.notify_one(); }
```

`handle_result` (after recording the metric, so `in_flight()` already reflects
the departure) does: `if (context->closed_loop.load(relaxed)) context->notify_refill();`
`notify_one` with no waiter is near-free, so the cost to the open-loop
`constant_rps` path (which never sets `closed_loop`) is a single relaxed atomic
load per completion.

**`notify_refill()` deliberately does NOT lock `refill_mtx`.** Locking on every
completion would put a contended mutex on the 60k-RPS hot path. Skipping the
lock is exactly what makes the *timeout-backed* correctness argument above
load-bearing rather than merely elegant: it is the reason a wakeup may be lost,
and the reason that's safe.

**Set `closed_loop = true` before seeding** (before the first request can
complete), so no early completion's notify is dropped on the floor.

**`notify_refill` lifetime is safe:** every completion callback captures
`shared_ptr<RunContext>`, and `run_manager.cpp:345`'s `stop(true)` drains all
outstanding requests before the context is torn down — so `refill_cv` is always
alive when a worker notifies it.

**Prompt cancellation:** the two `should_stop = true` sites
(`runs.cpp:135`, `run_manager.cpp:199`) must also call `context->notify_refill()`.
Without it, a stopped run waits up to 50 ms (the safety-net timeout) before the
producer observes `should_stop`. With it, cancellation is immediate.

#### Peak-in-flight gauge

There is **no engine-side peak-concurrency tracking today** — the dashboard
derives "peak" from sampled SSE `activeConnections` ticks, which is too coarse
to assert a tight bound against. The controller updates
`context->peak_in_flight` on every submit (`peak = max(peak, in_flight())`).
This serves two purposes: it is the **ground truth the integration tests assert
against**, and it lets the final report / dashboard show an *exact* peak instead
of a sample-rate-limited one. (Persisting it to the report is optional follow-up;
the gauge itself is the requirement here.)

#### Throughput at high RPS — the model self-coalesces

The obvious objection: the old batch-submitter woke ~100×/s (large batches),
whereas this model is woken *per completion* — up to 60k+ wakeups/s at target
throughput. Does the single producer thread become the bottleneck and cap
throughput below the old code? **No, because the design self-coalesces under
load:**

- When the producer can't keep up, completions accumulate and `in_flight()`
  drops, so a single wakeup submits a **large `deficit`** rather than one. Fewer
  wakeups, bigger batches — automatically, with no tuning.
- `notify_one()` on a producer that is actively looping (not parked) is
  near-free (no futex wake). The producer only parks when it has *caught up* to
  target — precisely when the completion/notify rate is low.

So wakeup frequency self-limits and throughput is preserved relative to the old
batch submitter. (This is what tests #2 and #5 confirm empirically.)

### What gets removed / changed

- **Removed:** the per-mode 10 ms batch-submit loops and their `maxInFlight`
  backpressure ceilings (the `max(concurrency*5, 1000)` defaults) in
  `ConstantLoadStrategy` (concurrency branch), `IterationsLoadStrategy`,
  `RampUpLoadStrategy`. Replaced by `maintain_concurrency`.
- **Unchanged:** `ConstantLoadStrategy`'s rate-limited (`targetRps > 0`) branch
  stays open-loop with its `maxInFlight` ceiling — that is correct for an
  open-loop rate model and was the subject of the earlier backpressure plan.
- **`maxInFlight` semantics:** for closed-loop modes the target `N` *is* the cap,
  so `maxInFlight` is no longer consulted there. It remains meaningful only for
  `constant_rps` rate mode. (Update `docs/engine/api-reference.md` accordingly.)
- **EventLoop `max_concurrent`:** left as-is. With ≤ N total in-flight spread
  round-robin across ~12 workers (~N/12 each) and `max_concurrent = max(N,100)`
  per worker, curl never throttles below the target. No change required;
  documented here so a future reader doesn't "fix" a non-issue.

### max/min report fix (independent, small)

1. `engine/include/vayu/types.hpp`: add `MetricName::LatencyMax`, `LatencyMin`
   with `to_string` (`"latency_max"`, `"latency_min"`) + `parse_metric_name`
   cases.
2. `engine/src/core/run_manager.cpp`: persist `percentiles.max` and
   `percentiles.min` as final metrics alongside the existing p50–p999.
3. `engine/src/http/routes/runs.cpp`: in the metric-override loop, set
   `report.latency_max = m.value` / `report.latency_min = m.value` for the new
   names (same pattern as p50–p999).

---

## Coordinated omission (context, not a deliverable)

Closed-loop concurrency inherently under-samples latency during a server stall
(blocked VUs send fewer requests exactly when things are worst — Gil Tene's
"coordinated omission"). This is expected behavior of the model, not a bug, and
the existing `queue_wait_ms` / perceived-latency work already covers the
generator-side slice. No correction is in scope; noted so metric semantics are
understood.

---

## Critical files

| File | Change |
|---|---|
| `engine/include/vayu/core/run_manager.hpp` | `RunContext`: `refill_mtx`, `refill_cv`, `closed_loop`, `peak_in_flight`, `notify_refill()` |
| `engine/src/core/load_strategy.cpp` | New `maintain_concurrency` helper (incl. peak gauge update); rewrite the 3 closed-loop strategies to use it; `handle_result` notifies on completion; set `closed_loop=true` before seeding in each |
| `engine/src/http/routes/runs.cpp` | Stop handler (`:135`) calls `notify_refill()` after `should_stop = true` |
| `engine/src/core/run_manager.cpp` (stop path) | `stop()` (`:199`) calls `notify_refill()` after `should_stop = true` |
| `engine/include/vayu/types.hpp` | `MetricName::LatencyMax`/`LatencyMin` + `to_string`/`parse` |
| `engine/src/core/run_manager.cpp` | Persist `percentiles.max`/`.min` as final metrics |
| `engine/src/http/routes/runs.cpp` | Override `report.latency_max`/`latency_min` from the new metrics |
| `engine/tests/` | Controller unit test + integration test asserting peak in-flight ≈ N; report max/min test |
| `docs/engine/api-reference.md` | Clarify `maxInFlight` applies to `constant_rps` only; document closed-loop concurrency model |

---

## Verification

TDD (engine work is test-first per project convention).

Ground truth for all in-flight assertions is `RunContext::in_flight()` and the
new `peak_in_flight` gauge — **not** SSE `active_count()` (which is curl-active,
close to but not identical to in-flight). The controller unit test reads them
directly; integration tests assert against the gauge after the run.

**Measuring *mean* in-flight without sampling — Little's Law.** In closed-loop
steady state, mean in-flight `L = throughput(λ) × mean_latency(W)`, so a
black-box check that the system *held* N is:

```
report.actual_rps × (report.latency.avg / 1000) ≈ N   (±ε)
```

using fields the report already exposes — no in-process sampler needed. The
peak gauge bounds the top; Little's Law pins the mean. This applies only to the
**steady-state** modes (tests #2, #5); `ramp_up` (#3) is non-steady, so its
check stays "the peak gauge tracks the ramp line."

### Closed-loop concurrency
1. **Controller unit test:** drive `maintain_concurrency` with a fake submit sink
   and a controllable in-flight source. Assert the **invariant**, not a 1-for-1
   rule: in-flight converges to `target(t)` and **never exceeds `target + ε`**
   (the controller submits `deficit = target − in_flight`, which is >1 when
   completions batch between wakes — so "exactly one refill per completion" is
   wrong). Also assert `ramp_up` grows to target and `iterations` submits
   **exactly `M`** (exact because `requests_sent` is written only by the producer,
   so the budget clamp has no race).
2. **Integration (mock server):** `constant_concurrency` N=50 against
   `/slow/100` for 3 s. Assert **`peak_in_flight` ≤ N + small epsilon** (a few,
   for worker scheduling slop) and **mean ≈ 50 via Little's Law**
   (`actual_rps × avg_latency_s ≈ 50`) — today this is ~900. Throughput
   ≈ `50 / 0.1s` ≈ 500 RPS.
3. **`ramp_up`** 1→50 over 2 s, total 4 s, against `/slow/50`: `peak_in_flight`
   tracks the ramp line; never overshoots target by more than epsilon.
4. **`iterations`** M=1000, N=20 against `/fast`: exactly 1000 requests
   submitted (a **regression guard** — the old loop already capped at `M`; this
   pins that it still holds under the rewrite); `peak_in_flight` never exceeds ~20.
5. **Fast-endpoint hold (the Option-B failure):** N=50 against `/fast` (~0.5 ms);
   assert mean in-flight (Little's Law) stays near 50, NOT collapsing to single
   digits — proves the cv wake beats a fixed poll.
6. **`ramp_up` with `duration < ramp` (behavior-change check):** e.g. duration
   6 s, ramp 10 s. Under the old open-loop code this was observed to finish
   instantly with **0 requests**; the new model should run a *partial ramp* for
   the full 6 s and submit a non-trivial number of requests. Assert requests > 0
   and the run lasts ~`duration`. (The misleading ramp/duration *copy + input
   validation* — B3 — stays explicitly out of scope here; this only pins the
   engine behavior.)
7. **Regression:** `constant_rps` rate mode unchanged — same drops / queue-wait
   behavior as before (the closed-loop path must not touch it). Full existing
   engine suite stays green.

### Report max/min
8. Any completed run: `report.latency.max > 0`, equals `hdr_max` (ms), and
   `report.latency.min` equals `hdr_min` (ms). Verify in the dashboard report
   view that Max is no longer 0.
