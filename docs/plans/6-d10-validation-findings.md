# Plan 6: D10 End-to-End Validation Findings

End-to-end visual validation of the Plan 1–4 dashboard/engine work (backlog item D10),
driven against the live Electron-renderer UI (Vite `:5173` → engine `:9876`) using the
Chrome DevTools MCP and the `scripts/test/mock-server.go` mock (`:8080`, `/fast`,
`/slow/:ms`). Date: 2026-05-30. Branch: `claude/sweet-johnson-vUNGE`.

All four load-test modes were run live from the UI and every Plan 3/4 surface was
inspected. Screenshots saved under `.validation-shots/` (untracked).

---

## Rendering validation — PASS

All five scenarios drove cleanly; the new surfaces render correctly in the existing
(orange) design system:

| Scenario | Result |
|---|---|
| `constant_rps` healthy (`/fast`, 300 rps, 15s) | RateFidelity 99.9%, throughput+target overlay, latency-over-time (wire/queue legend), percentiles-over-time (p50/p95/p99), p99 headline (2ms). Dropped card correctly **hidden** at 0 drops. |
| `constant_concurrency` (`/slow/100`, 20 VUs, 12s) | "20 VUs · constant_concurrency" header, all charts, HDR p50/p95/p99=101/102/102, p99 headline 102ms. Dropped card hidden. |
| `iterations` (`/slow/100`, 15000 iters, 9s) | Exact total 15000 (closed-loop bounded), all charts, HDR populated, p99 headline 102ms. Dropped card hidden. |
| `ramp_up` (`/slow/100`, →50, ramp 8s, total 16s) | **RampUp overlay renders**: throughput chart shows `configured` (dashed) + `achieved` lines, plus "ramp lag %" and "peak achieved / target". Full ramp curve + plateau visible. HDR p50/p95/p99=102/103/103. |

Confirmed Plan-4 placeholders work: p99 headline shows "awaiting samples" and the HDR
plot shows "available after completion" / "p50/p95/p99 finalize after the run completes"
when no final samples exist (instead of a misleading "mean 0 ms").

---

## A. Defects in the validated work (Plan 1–4)

### A1. `maxInFlight` knob does not bound in-flight (Plan 2, commit 41026a1) — confirmed
The per-strategy `maxInFlight` option and the `dropped_requests` counter are gated on
`EventLoop::pending_count()`, which is the strategy→worker **submission-queue depth**
(`event_loop_worker.cpp:418`, `read_available()`). Workers drain that queue to ~0, so it
almost never reaches the cap. The true in-flight count is `backpressure = requests_sent −
completed` (`run_manager.cpp:536`), which the drop logic never consults.

Evidence (curl against mock, zero-stress):
- `maxInFlight:10`, `/slow/500`, 100 rps → in-flight settled at **50**, `droppedRequests:0`.
- `maxInFlight:10`, `concurrency:1`, `/slow/2000`, 100 rps → in-flight **200**, `droppedRequests:0`.
- 20k rps to `/fast` → `totalRequests=100000` (exact target), zero drops.

Consequence: a **slow upstream never triggers drops** — in-flight grows unbounded instead,
which choked the engine at ~1600 held connections (briefly "Cannot connect to Vayu Engine:
Failed to fetch"; it recovered after the sleeps drained). The helper text "lowering it
causes drops sooner" is misleading. Drops can only fire under *generator* saturation
(dispatch faster than workers drain), which the engine doesn't hit at achievable rates.

**Note on the Dropped card itself:** its render logic is correct
(`showDropped = isRateLimitedRun(mode,targetRps) && dropped>0`, `MetricsView.tsx:952/964`,
replaces RateFidelity in slot 1) — verified by it correctly staying hidden at 0 drops. But
its *populated* state is effectively unreachable in normal use because of A1.

### A2. `ramp_lag` cannot detect real degradation (Plan 2) — confirmed
`RampLagTracker` accumulates the **configured** concurrency when `!backpressured`, where
`backpressured = pending_count() > max_pending` (`load_strategy.cpp:465`). Since
`pending_count()` stays ~0 (A1), `backpressured` is always false, so achieved == expected
and `ramp_lag ≈ 0` regardless of actual degradation. The unit test passes only because it
sets `backpressured` directly. In the live 16s ramp, lag read 0.6% while real concurrency
overshot 9×.

### A3. RampUp overlay vs `ramp_lag` tell contradictory stories (Plan 2/3) — confirmed
On the same ramp run the UI shows **"peak achieved 450 / target 50"** (the overlay's
`achieved` = measured `current_concurrency`, `metricsTransforms.ts:103`) next to **"ramp
lag 0.6%"** (whose "achieved" is the re-accumulated *configured* curve). One says load ran
9× over target; the other says the ramp was essentially perfect. At least one is
misleading the user; they must be reconciled to a single definition of "achieved".

### A4. Time-series charts emit hundreds of SVG `NaN` errors (Plan 3/4) — new
The browser console fills with `<line> y1="NaN"`, `<circle> cy="NaN"`, `<text> y="NaN"`,
and `<path> d="M48.0,NaN …"` errors during/after runs. Charts still render visually but the
coordinate math produces NaN for many points — clustered around degenerate/zero data
(short runs with all-zero latency, see B2). Likely a zero-range y-scale (`max==min==0` →
divide-by-zero) in `LatencyOverTimeChart` / `PercentilesOverTimeChart` / ramp overlay / HDR
plot. Guard the coordinate math against zero/degenerate ranges. Not yet attributed to a
single component or checked against master.

---

## B. Pre-existing or uncertain (not regressions from this work)

### B1. Configured concurrency is not enforced — pre-existing
Asking for 20 VUs produced peak concurrency 199 and ~1637 rps; ramp target 50 produced peak
450. The `max(concurrency, 100)` floor (`run_manager.cpp:298`) and the unbounded-in-flight
behavior are on **master** (verified: the line predates this branch; 41026a1 only made
`max_pending` overridable). User-visible (ask for 20, get 200) but pre-existing.

### B2. Short runs show empty final HDR + p99=0 — uncertain
Runs ≤ ~6–7s finish with the HDR plot and p99 headline at 0 / "awaiting samples" (all of
min/mean/p50/p95/p99/max = 0), even with thousands of successful ~100ms responses and
correct per-tick percentiles. Longer runs (≥9s) populate correctly. Persisted after waiting
~18s, so not a load race — the engine's final latency aggregation appears empty on
short/truncated runs. Likely engine-side and possibly pre-existing; the "awaiting samples"
placeholder itself behaves correctly.

### B3. `ramp_up` duration semantics + misleading dialog copy — minor
The dialog says "ramp over Ns then maintain for {duration}s", but the engine treats
`duration` as **total** test time — so `duration < ramp` ends the test mid-ramp (observed:
`duration=6, ramp=10` → 6.26s run). Either fix the engine to add the hold after the ramp,
or fix the copy to "total duration {duration}s (includes ramp)".

### B4. Minor a11y warning — pre-existing
`Missing Description or aria-describedby for {DialogContent}` on the Load Test config dialog.

---

## Recommended follow-ups (priority order)

1. **A1 / A2** — re-gate `maxInFlight`, drops, and `ramp_lag` on real in-flight
   (`requests_sent − completed`) instead of `pending_count()`. This is the root cause behind
   three deliverables not functioning. (Largest item; also see backlog C7/D9.)
2. **A4** — clamp chart coordinate math against zero/degenerate ranges (quick, removes
   hundreds of console errors).
3. **A3** — pick one definition of "achieved" so the overlay and ramp-lag agree.
4. **B3** — fix the ramp_up duration copy (or engine semantics).
5. **B1 / B2** — investigate concurrency enforcement and short-run HDR aggregation
   (engine-side, confirm against master first).
