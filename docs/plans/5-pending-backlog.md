# Plan 5: Pending Backlog

Consolidated list of everything deferred or surfaced while implementing Plans 1–4. Each item notes **why** it's pending and **what** it needs, so it can be picked up as its own focused plan.

Status of the four prior plans:
- **Plan 1 (latency accuracy)** — ✅ shipped (drops counter, perceived `total_ms`, `queue_wait_ms`).
- **Plan 2 (backpressure)** — ✅ shipped (`maxInFlight` per-run knob, `ramp_lag`).
- **Plan 3 (UI surfaces)** — ✅ shipped §1–§4 (Dropped card, Latency-over-time chart, RampUp overlay, `maxInFlight` global Settings panel).
- **Plan 4 (dashboard redesign)** — ✅ shipped *core* (per-tick percentiles, percentiles-over-time chart, p99 headline); the rest deferred → items A1–A4, B5–B6 below.

Post-D10 fixes and Plan 4 remainder also shipped:
- **D10/A1 (maxInFlight/drops gated on wrong counter)** — ✅ fixed (`0c92cec`): all five `pending_count()` gates in `load_strategy.cpp` switched to `RunContext::in_flight()` (`requests_sent − completed`); `load_strategy_test.cpp` added to assert drops fire under real in-flight load.
- **C7 (maxInFlight global setting)** — ✅ shipped (`9bd9c90`): `LoadDefaultsPanel` in Settings, `maxInFlight` persisted in `settings-store`, `applyMaxInFlightDefault` utility injects global default when per-run value is absent.
- **A1 (mode-adaptive hero cards)** — ✅ shipped (`91860df`).
- **A2 (mode-adaptive Row 4 stat sets)** — ✅ shipped (`f54c7fa`).
- **A3 (RTvsConcurrency scatter for ramp_up)** — ✅ shipped (`b932dea`, `3f754a3`).
- **A4 (centralized tooltips + useMode + chart geometry)** — ✅ shipped (`66b730d`).
- **B5 (MetricsView modular refactor)** — ✅ shipped (`53e56a3`).
- **B6 (simplify pass — HeroCardShell + TimeSeriesChart primitives)** — ✅ shipped (`6934fde`).

---

## A. Deferred from Plan 4 — the rest of the "dashboard redesign"

### A1. Mode-adaptive hero cards
Hero Card 1 / Card 2 still render `constant_rps`-centric content for every mode, so `constant_concurrency` / `iterations` / `ramp_up` runs show a "Rate Fidelity —" card that is semantically wrong.

**Needs:**
- New cards: `AchievedThroughputCard`, `ConcurrencyUtilCard`, `ProgressCard`, `ThroughputCard` (single-value), `CurrentConcurrencyCard`, `SaturationCard`.
- A per-mode hero-row selector + a `useMode()` discriminator (one place that maps run config → `"constant_rps" | "constant_concurrency" | "iterations" | "ramp_up"`).
- **Config plumbing:** per-mode `concurrency` and `iterations` target threaded to `MetricsView` (today only `targetRps` + ramp params are threaded).
- Tooltip wording is locked in `docs/plans/4-dashboard-redesign.md` §"Tooltip wording".

### A2. Mode-adaptive Row 4 stat sets
Row 4 is fixed (Duration / Total / Peak concurrency / p99). Plan 4 wants per-mode sets:
- `constant_rps`: Duration · Total · Peak concurrency · p99
- `constant_concurrency`: Duration · Total · **Throughput / VU** · p99
- `iterations`: **Elapsed · Remaining (ETA) · Mean iter time** · p99
- `ramp_up`: **Peak concurrency · Breakpoint · p99 at peak** · Total

**Needs:**
- `requestsExpected` / `requestsSent` exposed in SSE + mapped to `LoadTestMetrics` (for ETA).
- `computeEta` = `(requestsExpected − requestsSent) / currentRps`.
- `computeBreakpoint` (shared with A3).
- A `ModeStatsRow` that routes to the per-mode stat set (extract `StatCard` to its own file first).

### A3. Response-time-vs-concurrency breakpoint scatter (ramp_up)
The capacity-discovery chart: X = concurrency at each tick, Y = p99 at that tick; the elbow is the breakpoint. Replaces the percentiles row for `ramp_up`.

**Needs:**
- `computeBreakpoint(history, sloThresholdMs)` — first concurrency where p99 crosses the SLO (default 200 ms); scan per-tick history.
- `ResponseTimeVsConcurrencyScatter` component (dots + amber vertical line at the breakpoint).
- Per-tick percentiles (already shipped in Plan 4 core) + `current_concurrency` (already flowing).

### A4. Centralized `tooltips.ts`
Plan 4 wants all InfoChip wording imported from one module so wording changes are one diff. Today tooltips are inline strings in components. Low-risk consolidation; do it alongside A1/A2 so the new cards import from it from day one.

---

## B. Deferred internal refactor (invisible to users, higher-risk)

### B5. Full modular refactor of `MetricsView.tsx`
`MetricsView.tsx` is ~1,260 lines. Plan 4's target tree:
```
dashboard/components/{hero/, charts/, stats/, shared/}, dashboard/hooks/, dashboard/utils/
```
Partially seeded already: `shared.tsx` (InfoChip/Eyebrow), `utils/metricsTransforms.ts`, and the new chart files (`LatencyOverTimeChart`, `PercentilesOverTimeChart`, `DroppedRequestsCard`) are standalone. Remaining: relocate `RateFidelityCard`, `SendThroughputCard`, `ErrorRateCard`, `ThroughputOverTimeChart`, `HdrPercentilePlot`, `TimingWaterfall`, `StatCard` into the tree; reduce `MetricsView` to a thin orchestrator.

**Note:** A1/A2 will force most of this extraction anyway (the hero-row selector + ModeStatsRow naturally pull cards into `hero/` and `stats/`). Best done *as part of* A1/A2 rather than as a separate big-bang refactor.

### B6. `simplify` pass
After A1/A2/B5, run `/simplify` (`/code-review --fix`) focused on:
- **`HeroCardShell` primitive** — the (soon) ~9 hero cards share an `Eyebrow + InfoChip + BigValue + Sub` shape.
- **Shared `TimeSeriesChart` primitive** — `ThroughputOverTimeChart`, `LatencyOverTimeChart`, `PercentilesOverTimeChart` duplicate grid/tick/live-dot/axis logic (viewBox 1080×240, PL56/PR12/PT16/PB28). Extract a `chartGeometry.ts` + a base chart.

---

## C. Deferred from Plan 3

### C7. `maxInFlight` as a global Settings entry
The per-run `maxInFlight` knob (Plan 2) works via the run-API JSON, but there is no UI to set a global default. Plan 3 §4 wanted it in the Settings panel — but the Settings panel renders **engine-registered `ConfigEntry[]`** from `useConfigQuery()`, not free-form form fields.

**Needs (engine + app):**
1. Register a `maxInFlight` (or `max_in_flight`) config key in the engine's config registry/endpoint, under `general_engine` or `network_performance`, with label + helper + default + range.
2. Have each strategy fall back to that registered global when the per-run `maxInFlight` is absent (today `config.value("maxInFlight", <heuristic>)` falls back to the heuristic, not a global setting).
3. The generic settings form then renders it for free — no bespoke UI.

Helper text is locked in `docs/plans/3-ui-changes.md` §4. This is a separate engine+config change, best as its own small plan.

---

## D. Known limitations surfaced during reviews (not bugs — judgment calls to revisit)

### D8. HdrHistogram concurrent read/write
`MetricsCollector::get_current_stats()` reads the histogram lock-free (`hdr_value_at_percentile`) while worker threads call `hdr_record_value`. This is a benign data race in strict C++ terms — it yields an approximate-but-valid live snapshot, and it mirrors the pre-existing `calculate_percentiles()` pattern. Fine on x86_64 / Apple Silicon / Linux arm64 (atomic 64-bit reads). If Vayu ever targets an arch without naturally-atomic 64-bit reads, switch the recording path to `hdr_record_value_atomic`.

### D9. RampUp `ramp_lag` baseline for `start=0`
A `startConcurrency=0` ramp shows ~0.8% structural lag on a perfectly healthy run, because integer concurrency truncation floors the first steps to 0 while the real-valued expected integral has already grown. Documented in `ramp_lag_tracker.hpp`; far below the >5% real-stall threshold, so the signal is intact. Optional cure: floor `startConcurrency` to 1 at the UI/validation layer (don't do it in the engine — it would silently override the user's configured value).

### D10. No end-to-end visual confirmation of Plans 3–4
The Plan 3 & 4 dashboard work is verified by type-check, vitest, and code review — but the Electron app has **not** been driven against live runs to visually confirm the new cards/charts render correctly across all four modes. Recommended before any release: run `constant_rps` (healthy + slow), `constant_concurrency`, `iterations`, and `ramp_up` against the mock server and eyeball each surface (Dropped card, Latency-over-time gap, RampUp overlay, percentiles chart, p99 stat).

---

## Suggested sequencing

1. **D10 first** — cheap, gates confidence in everything Plans 3–4 already shipped. Do before building more on top.
2. **A1 + A2 + A4 + B5 together** — one coherent "mode-adaptive + modularize" plan (the refactor falls out of the feature work; tooltips centralize as the new cards are written). Needs the SSE `requestsExpected`/`requestsSent` addition for ETA.
3. **A3** — ramp_up breakpoint scatter (shares `computeBreakpoint`; small once A1/A2 land).
4. **C7** — `maxInFlight` global setting (engine config-registry; independent, can run any time).
5. **B6** — `simplify` pass last, once the component surface is stable.
6. **D8 / D9** — revisit only if their triggering conditions become real (non-x86 target; `start=0` confusion).
