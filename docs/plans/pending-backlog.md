# Vayu — Pending Backlog

Living backlog of deferred / surfaced work. Each item notes **why** it's pending and **what** it needs so it can be picked up as a focused plan.

_Last updated: 2026-06-05 (branch `claude/sweet-johnson-vUNGE`)._

---

## Open features

### W1. Windowed (rolling) percentiles
The latency percentiles are computed from a single **cumulative-from-start** HdrHistogram, so the live "Response time percentiles over time" chart **flattens** as a run progresses (each point is the all-time percentile, not the recent window). This also leaves several history surfaces empty/inert.

**Needs:**
- Engine: a **windowed** percentile source alongside the cumulative one — use the vendored `hdr_interval_recorder` (writer/reader phaser, designed for sample-and-reset per interval; also properly resolves D8). `record_success` records into both; the per-tick producer (`collect_metrics`) samples the interval recorder each tick → windowed p50/p95/p99.
- Producer: emit windowed percentiles in the live tick blob, and **persist per-tick `LatencyP50/P95/P99`** to the DB (explicitly deferred out of N1 — N1 only persists `LatencyAvg`/`QueueWaitAvg`).
- App: live percentile chart consumes windowed values; **unblocks the history ramp stats** that currently render empty — `computeBreakpoint` (first concurrency where p99 crosses the SLO), p99-at-peak, saturation, and the response-time-vs-concurrency scatter all depend on a meaningful per-tick p99 series.
- Tests: windowed-vs-cumulative behaviour; interval-recorder sampling.

_Size: medium — engine interval-recorder integration (TDD-able) + per-tick persistence; app is small if the percentile mapping already exists, medium if the ramp-stat derivations (breakpoint/saturation) need building. Verify before committing scope._

---

## Engine performance / stability (surfaced 2026-06-05 high-RPS investigation)

### P1. High-RPS worker/connection defaults
Against `/fast` on loopback, tuned Vayu reaches ~45k req/s (vs `wrk` ~51k), but the **defaults collapse it to ~11–27k**:
- `workers = ncpu` over-subscribes the busy-poll worker threads → throughput scales to ~9 workers then **collapses** at `ncpu` (no cores left for the strategy-producer + co-located target). Sweet spot ≈ `ncpu − 2/3`.
- `eventLoopMaxPerHost` is applied **per worker**, so effective host connections = `workers × maxPerHost` — over-provisions past the loopback sweet spot.
- `maxInFlight` default (`target × 10`) is effectively unbounded → backlog balloons (390k) instead of shedding load.

**Needs:** lower the default `workers`; make the connection cap a **global budget** (or auto-derive from workers); bound the default `maxInFlight`. (Confirmed PR #10 is NOT the cause; ceiling is long-standing architecture. The branch-only 12-worker collapse was traced to added per-completion CPU and only bites at `workers=ncpu`.) Needs a spec.

### P2. `/config` validation error message
`POST /config` returns a generic `"Failed to update configuration. Check logs for details."` on a validation failure — the specific reason (which key / out-of-range / min-max) is logged server-side (`config.cpp:167`) but never returned. **Needs:** echo the specific validation error in the 400 body. Small UX fix.

---

## Janitorial

### N2. Lint sweep
~120 ESLint findings in the app (mostly `@typescript-eslint/no-explicit-any` + misc). Janitorial; no behaviour change.

---

## Parked (revisit only if the trigger becomes real)

### D8. HdrHistogram concurrent read/write
`get_current_stats()` reads the histogram lock-free while workers record. Benign on x86_64 / Apple Silicon / Linux arm64 (atomic 64-bit reads). **W1's interval recorder resolves this properly** (phaser-based). Otherwise only a concern on an arch without atomic 64-bit reads → switch to `hdr_record_value_atomic`.

### D9. RampUp `ramp_lag` baseline for `start=0`
A `startConcurrency=0` ramp shows ~0.8% structural lag on a healthy run (integer truncation vs real-valued integral). Far below the >5% real-stall threshold; signal intact. Optional cure: floor `startConcurrency` to 1 at the UI/validation layer (not the engine).

---

## Process

- **Branch `claude/sweet-johnson-vUNGE` is well past reviewable** — ~40+ commits spanning many features, diverged from origin (ahead, 1 behind), **no PR**. Land PR(s); pull fresh master first; confirm target per qa→staging→master.
- **cpp-httplib FD_SETSIZE fix is a master bug** — worth cherry-picking to master independently/first.
- `docs/engine/api-reference.md` updated for `/metrics/live` replay + `liveRetentionMs` — currently uncommitted.

---

## Shipped (history)

Plans 1–4 (latency accuracy · backpressure/`maxInFlight` · UI surfaces · mode-adaptive dashboard) and their follow-ups (A1–A4, B5–B6, C7, D10 E2E validation) — all shipped. This session also shipped: B1 closed-loop concurrency · metrics enrichment (per-tick dropped/bytes/status, peak/queue/bytes in reports) · `maxInFlight` relocation · live-timer fix · mode-adaptive history view · transport-errors-as-status-0 · dropped-card gate fix · **cpp-httplib FD_SETSIZE fix** · **N1 in-memory metrics topic** (race-free live metrics + retention + DB enrichment, E2E-verified) + its UI regression fix.
