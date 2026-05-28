# Vayu backpressure: per-strategy scope + maxInFlight knob + RampUp signal

## Context

`docs/plans/1-latency-accuracy.md` proposed surfacing dropped requests via a counter + UI banner, treating it as a Vayu-wide problem. On closer reading of all four load strategies, the picture is sharper:

- **Only one of Vayu's four strategies actually drops requests** — ConstantRps in rate-limited mode. The original plan applies cleanly there.
- **Two strategies (Iterations, Constant in concurrency mode)** are already closed-loop; they naturally throttle throughput under backpressure and lose no information. They need no drop counter.
- **RampUp has a subtler, currently-silent failure mode** the original plan missed: under backpressure the configured concurrency curve flatlines, but no metric tracks the divergence.

Committed scope: original plan as written + a user-configurable `maxInFlight` knob + a RampUp degradation signal. This file captures the additions on top of `1-latency-accuracy.md`.

---

## Industry context (informs the design, not the deliverable)

Vayu's ConstantRps rate mode is open-loop. Among open-loop tools:
- **k6** drops scheduled iterations + exposes `dropped_iterations` counter — what Vayu is doing.
- **wrk2** queues and fires late; records latency from planned send time.
- **Vegeta** auto-scales workers up to a cap.

We're committing to the **k6 model** for ConstantRps: drops are honest failure signals, bounded memory, no test-duration stretch. The `queue_wait_ms` field already covers wrk2's diagnostic benefit (server-slow vs generator-slow) without the cost of unbounded queueing.

---

## Per-strategy behaviour after this change

| Strategy | Today | After this change |
|---|---|---|
| ConstantRps (rate mode) | Silent drops | `dropped_requests` counter + banner, perceived `total_ms`, `queue_wait_ms`, configurable `maxInFlight` |
| Constant (concurrency mode) | Sleep+retry, no signal | Perceived `total_ms`, `queue_wait_ms`. Configurable `maxInFlight`. No drop counter (none happen). |
| Iterations | Sleep+retry, no signal | Perceived `total_ms`, `queue_wait_ms`. Configurable `maxInFlight`. No drop counter. |
| RampUp | Sleep+retry, ramp silently degrades | Above + `ramp_lag_ms` metric + achieved-vs-configured concurrency overlay in live chart |

---

## Deliverables

### 1. Everything in `docs/plans/1-latency-accuracy.md`

Ship Changes 1, 2, and 3 as already specified. One scoping addition for the drop counter UI:

**`app/src/modules/dashboard/components/MetricsView.tsx`:** the `dropped_requests` counter badge and banner must only render when the run mode is ConstantRps in rate-limited mode. For the other three strategies, `dropped_requests` will always be 0 — hiding the badge entirely avoids "what does this metric mean?" confusion.

Inferring "is this a ConstantRps rate-mode run?" from the run config:
- `mode === "constant_rps"` (or whatever the API field is called — check `engine/src/core/load_strategy.cpp` `parse_load_test_type` and the matching app type)
- AND `targetRps > 0`

Add a small helper in the dashboard module: `isRateLimitedRun(run): boolean`.

### 2. Expose `maxInFlight` as a configurable run option

**Engine — `engine/src/core/load_strategy.cpp`:** in each strategy's `execute()`, replace the hardcoded `max_pending` derivation with:

```cpp
size_t max_pending = config.value ("maxInFlight", <existing-default-expression>);
```

So:
- ConstantRps (line 192, 211): default = `max(target_rps × 10, 1000)`
- Constant (concurrency, line 305): default = `max(concurrency × 5, 1000)`
- Iterations (line 351): default = `max(concurrency × 5, 100)`
- RampUp (line 442): default = `max(target_concurrency × 5, 1000)`

User-supplied value overrides the default. No internal API change to `EventLoop` is needed — `maxInFlight` is a scheduler-side knob.

**App — run config:**
- `app/src/types/api.ts` (or wherever the run JSON schema lives, around lines 154–187 per earlier exploration): add `maxInFlight?: number` to the run config type.
- Run-builder UI (find the matching form in `app/src/modules/request-builder/` or wherever load test config is edited): expose as an "Advanced" collapsible field with helper text:
  > **Max in-flight requests** — hard cap on concurrent in-flight requests. Default is auto-derived from your RPS or concurrency setting. Raise this if your generator has more headroom; in ConstantRps mode, lowering it causes drops sooner.

**Docs:** add a `maxInFlight` row to `docs/engine/api-reference.md` (the `/run` endpoint table) describing the default formula per strategy and what happens when it's exceeded.

### 3. RampUp degradation signal

This is the new piece not in the original plan.

**The problem:** in `RampUpLoadStrategy`, `current_concurrency` is recomputed each iteration from elapsed time. If backpressure causes us to sleep through the moment when concurrency should have hit (say) 50, we never go back and submit those requests — but unlike ConstantRps, there's no counter recording it.

**Engine — `engine/src/core/load_strategy.cpp` `RampUpLoadStrategy::execute`:**

Track a running `total_submitted_concurrency` and an `expected_concurrency_integral` (the integral of the configured concurrency curve from t=0 to now). After each loop iteration, compute:

```cpp
double expected = integral_of_ramp_curve (elapsed_ms, ramp_duration_ms,
                                          start_concurrency, target_concurrency);
double achieved = total_submitted_concurrency;
double ramp_lag = std::max (0.0, expected - achieved);
context->metrics_collector->record_ramp_lag (ramp_lag);
```

Where `integral_of_ramp_curve` is a closed-form: linear ramp from `start` to `target` over `ramp_ms`, then flat at `target` after. The integral is straightforward.

**Engine — `engine/include/vayu/core/metrics_collector.hpp`:** add `record_ramp_lag(double)` setter and `ramp_lag()` getter. Expose `rampLag` in `get_current_stats()` JSON.

**Engine — `engine/include/vayu/types.hpp`:** add `RampLag` to `MetricName` enum + `to_string` / `parse_metric_name` cases (`"ramp_lag"`).

**App — `app/src/types/domain.ts`:** add `ramp_lag?: number`.

**App — `app/src/services/sse-client.ts`:** map `metrics.rampLag` → `ramp_lag`.

**App — `app/src/modules/dashboard/components/MetricsView.tsx`:** for RampUp runs only:
- Add a second line series to the live concurrency chart (if one exists) or create one: "configured concurrency" (dashed) vs "achieved concurrency" (solid). Divergence is visually obvious.
- If `ramp_lag` exceeds a small threshold (e.g. `> 5% of target_concurrency`), show a subdued warning:
  > ⚠ Generator can't sustain the configured ramp. Reduce target concurrency or check generator capacity.

Inferring "is this a RampUp run?": `mode === "ramp_up"` in the run config.

---

## Critical files

| File | Change |
|---|---|
| `engine/src/core/load_strategy.cpp` | Per-strategy `maxInFlight` override; RampUp ramp-lag tracking |
| `engine/include/vayu/core/metrics_collector.hpp` | `record_ramp_lag`, `ramp_lag` getters |
| `engine/src/core/metrics_collector.cpp` | Ramp-lag accumulator |
| `engine/include/vayu/types.hpp` | `RampLag` enum entry |
| `app/src/types/api.ts` | `maxInFlight?: number` in run config |
| `app/src/types/domain.ts` | `ramp_lag?: number` |
| `app/src/services/sse-client.ts` | Map `rampLag` |
| `app/src/modules/dashboard/components/MetricsView.tsx` | Gate drop badge on ConstantRps; ramp-lag overlay for RampUp |
| `app/src/modules/request-builder/` (load config form) | `maxInFlight` advanced field |
| `docs/engine/api-reference.md` | `maxInFlight` parameter doc |
| `docs/architecture.md` (new section) | Per-strategy backpressure model + industry context |

All `docs/plans/1-latency-accuracy.md` files apply too — this plan is additive.

---

## Reused utilities / patterns

- `MetricsCollector::atomic_add_double` (`metrics_collector.cpp:71`) — already used for `total_latency_sum_`, reuse for any ramp-lag accumulation if it becomes a sum rather than a snapshot.
- `config.value ("key", default)` pattern (nlohmann::json) — already pervasive in `load_strategy.cpp`; same pattern for `maxInFlight`.
- The existing live-chart infrastructure in `MetricsView.tsx` for the new ramp overlay — extend, don't replace.

---

## Verification

### `maxInFlight` knob
1. ConstantRps run with `targetRps=10000, maxInFlight=100`: `dropped_requests` should be high and `avg_queue_wait_ms` should stay low (we drop before queueing).
2. Same run with `targetRps=10000, maxInFlight=100000`: `dropped_requests` ≈ 0, `avg_queue_wait_ms` grows (we queue instead of dropping).
3. Default (omitted): behaviour matches today's hardcoded heuristic — sanity-check by setting `maxInFlight=10000` (which equals `target_rps × 10`) and confirming identical results.

### Drop counter scoping
4. Run an Iterations test against a slow endpoint — confirm the drop badge in MetricsView is not rendered.
5. Run a RampUp test against a slow endpoint — confirm the drop badge is not rendered, the ramp overlay shows divergence, and `ramp_lag` increments.
6. Run a ConstantRps rate-mode test against a slow endpoint — drop badge appears, banner appears, and the ramp overlay is hidden.

### Ramp lag math
7. Unit test in `engine/tests/`: configure ramp 1→100 over 10s, simulate `current_concurrency` recomputation at t=5s — expected integral = ~252.5; assert `ramp_lag` matches when achieved is artificially held to 100.
8. Negative case: ramp 1→100 with no backpressure — `ramp_lag` stays ≤ small jitter throughout.

### Docs
9. Have someone unfamiliar with the codebase read the new `docs/architecture.md` section and answer: "If I configure targetRps=5000 but achieved RPS is 3000 and dropped_requests=2000, what should I do?" If they correctly land on "raise maxInFlight OR the server is the bottleneck", the docs work.
