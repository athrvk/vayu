# Vayu - Pending Backlog

Living backlog of deferred / surfaced work. Each item notes **why** it's pending and **what** it needs so it can be picked up as a focused plan.

_Last updated: 2026-07-18 (branch `claude/backlog-prioritization-sku0xx`; base master `367902f`, engine `0.7.0`)._

---

## Open features

_(none currently open — W1 implemented, see below)_

### W1. Windowed (rolling) percentiles - _implemented on `claude/backlog-prioritization-sku0xx`, pending merge_
The latency percentiles were computed from a single **cumulative-from-start** HdrHistogram, so the live "Response time percentiles over time" chart **flattened** as a run progressed (each point was the all-time percentile, not the recent window). This also left several history surfaces empty/inert.

**Shipped on branch:**
- Engine: a **windowed** percentile source (`MetricsCollector::sample_window_percentiles`) backed by the vendored `hdr_interval_recorder` (writer/reader phaser, sample-and-reset per tick; also properly resolves D8). `record_success`/`record_latency` record into both the cumulative histogram and the interval recorder; `get_current_stats` now takes an optional `window_percentiles` and prefers it for `latencyP50/95/99Ms`.
- Producer (`collect_metrics`): samples the window once per tick, emits windowed percentiles in the live tick blob, and **persists per-tick `LatencyP50/P95/P99`** (unlabeled rows) to the DB. `/run/:id/report` keys on the summary label so per-tick rows don't clobber the cumulative report; `/stats?format=json` maps the per-tick rows into `latency_p50/95/99_ms`.
- App: history view now fetches the per-tick series in `LoadTestDetail`, derives the capacity breakpoint from it (Saturation card / Breakpoint stat / p99-at-peak light up for completed ramp_up runs), and renders the percentiles-over-time chart / response-time-vs-concurrency scatter in the Performance tab. Live chart consumes the windowed values with no client change.
- Tests: 6 new `MetricsCollector` tests (windowed-vs-cumulative, reset-between-intervals, concurrent-writer safety, `get_current_stats` preference); history-detail characterization tests wrapped in a `QueryClientProvider`.

_Verified: engine `build.py -t` + `ctest` green; app `type-check` + `test` (293) green; changed files lint-clean._

---

## Engine performance / stability (surfaced 2026-06-05 high-RPS investigation)

### P1. High-RPS worker/connection defaults
Against `/fast` on loopback, tuned Vayu reaches ~45k req/s (vs `wrk` ~51k), but the **defaults collapse it to ~11–27k**:
- `workers = ncpu` over-subscribes the busy-poll worker threads → throughput scales to ~9 workers then **collapses** at `ncpu` (no cores left for the strategy-producer + co-located target). Sweet spot ≈ `ncpu − 2/3`.
- `eventLoopMaxPerHost` is applied **per worker**, so effective host connections = `workers × maxPerHost` - over-provisions past the loopback sweet spot.
- `maxInFlight` default (`target × 10`) is effectively unbounded → backlog balloons (390k) instead of shedding load.

**Needs:** lower the default `workers`; make the connection cap a **global budget** (or auto-derive from workers); bound the default `maxInFlight`. (Confirmed PR #10 is NOT the cause; ceiling is long-standing architecture. The branch-only 12-worker collapse was traced to added per-completion CPU and only bites at `workers=ncpu`.) Needs a spec.

### P2. `/config` validation error message - _✅ merged (PR #50, commit `4a6ce5f`); test-seed follow-up in `83a5397`_
`POST /config` returned a generic `"Failed to update configuration. Check logs for details."` on a validation failure. Turned out to be **two** bugs: the reason wasn't returned, **and** the generic `send_error` helper emits the flat `{"error":"..."}` shape while the app's http-client reads the nested `error.message` shape - so even the generic string was dropped and surfaced as a bare "HTTP 400".

**Fix (shipped on branch):** extracted the parse/validate/apply logic into a pure `apply_config_update(db, body) -> {status, json}` (mirrors `oauth2_token_post`, now unit-testable via `config_route_test.cpp`); returns the specific reason (unknown key / non-numeric / out-of-range with offending value + bound) in the **nested** shape the client surfaces. All-or-nothing preserved. _Not yet built/verified - the sandbox can't reach vcpkg dep hosts; needs a local `build.py -t && ctest` or CI green before merge._

### P3. Remaining flat-error routes swallowed by the app client _(surfaced 2026-07-18 during P2)_
The generic `send_error` helper (`routes.hpp:39`) emits flat `{"error":"<string>"}`, but `http-client.ts` only reads the nested `error.message`/`error.code`. Every route still using the flat helper (e.g. `config.cpp`'s "Invalid JSON", `execution.cpp:287/456`, `health`, 500 fallbacks) therefore shows a bare `HTTP <status>` in the UI, dropping the message. P2 fixed only the `/config` validation path. **Needs:** either migrate `send_error` to the nested shape (audit all call sites - some may rely on the flat body) or teach the client to accept both. Small, but cross-cutting. Low priority - most of these are developer-facing.

---

## Janitorial

### N2. Lint sweep
~120 ESLint findings in the app (mostly `@typescript-eslint/no-explicit-any` + misc). Janitorial; no behaviour change.

---

## Parked (revisit only if the trigger becomes real)

### D8. HdrHistogram concurrent read/write - _mitigated by W1; cumulative-path atomic cure intentionally deferred_
`get_current_stats()` read the histogram lock-free while workers record. **W1 mitigated this:** the live percentile path now reads the phaser-based `hdr_interval_recorder` (race-free by construction), and the cumulative histogram is no longer read concurrently on the live path — `calculate_percentiles()` runs post-run after workers stop. The literal cure (switch cumulative recording to `hdr_record_value_atomic`) is **intentionally not applied**: it adds a CAS per sample on the 60k+ RPS hot path (works against P1) for a race that is benign on every arch Vayu ships (x86_64 / Apple Silicon / Linux arm64 all have atomic 64-bit reads). Revisit only if a 32-bit / non-atomic-64-bit-read arch becomes a target — and pair it with a hot-path benchmark.

### D9. RampUp `ramp_lag` baseline for `start=0`
A `startConcurrency=0` ramp shows ~0.8% structural lag on a healthy run (integer truncation vs real-valued integral). Far below the >5% real-stall threshold; signal intact. Optional cure: floor `startConcurrency` to 1 at the UI/validation layer (not the engine).

---

## Process

- **`claude/sweet-johnson-vUNGE` concerns are resolved** - that work (OAuth 2.0 + N1 metrics + live retention) landed via PRs #45/#46 into **`0.6.0`**; the `/metrics/live` + `liveRetentionMs` api-reference doc is committed. The branch no longer exists on origin.
- **cpp-httplib FD_SETSIZE fix - status unclear.** No `FD_SETSIZE`/`CPPHTTPLIB_` reference exists anywhere in `engine/` on current master, despite the "Shipped" note below claiming it landed. Re-verify whether the high-FD ceiling is actually addressed before relying on it.
- P2 landed via PR #50; its `ConfigRouteTest` seeding was fixed in `83a5397` (seed config via `init()`), so the suite is green on master `367902f` (engine `0.7.0`).
- Active branch `claude/backlog-prioritization-sku0xx` carries the W1 implementation (unmerged); rebased onto master `367902f`.

---

## Shipped (history)

Plans 1–4 (latency accuracy · backpressure/`maxInFlight` · UI surfaces · mode-adaptive dashboard) and their follow-ups (A1–A4, B5–B6, C7, D10 E2E validation) - all shipped. This session also shipped: B1 closed-loop concurrency · metrics enrichment (per-tick dropped/bytes/status, peak/queue/bytes in reports) · `maxInFlight` relocation · live-timer fix · mode-adaptive history view · transport-errors-as-status-0 · dropped-card gate fix · **cpp-httplib FD_SETSIZE fix** · **N1 in-memory metrics topic** (race-free live metrics + retention + DB enrichment, E2E-verified) + its UI regression fix.
