# Plan 4: Mode-adaptive dashboard redesign

## Context

Vayu's MetricsView today is built around the `constant_rps` model — it has a Rate Fidelity hero card, a target-line throughput chart, and a generic "Avg latency" headline. For the other three modes (`constant_concurrency`, `iterations`, `ramp_up`), the same dashboard renders, but several cards are semantically wrong: Rate Fidelity shows "—" when there's no target, throughput chart has a phantom target line, and the headline metric is mean latency where p99 should be.

This plan delivers a **mode-adaptive dashboard** that swaps the two mode-sensitive hero cards and the Row 4 stat cards per test type, adds one universal "Response time percentiles over time" chart (and a "Response time vs concurrency" scatter for `ramp_up`), and renames `Avg latency` → `p99 latency` as the headline. All of this is an **evolution of the existing MetricsView**, not a rewrite — same card chrome, same color tokens, same SVG patterns.

Plan 4 sits on top of Plans 1–3:
- Plan 1 adds engine-side `dropped_requests`, `queue_wait_ms` (perceived `total_ms`).
- Plan 2 adds `maxInFlight` settings and `ramp_lag` engine signal.
- Plan 3 adds the Dropped Requests hero card, Latency-over-time chart, and ramp overlay on the Throughput chart.
- **Plan 4** adds per-mode hero/stat card swaps, the percentile-over-time chart, the ramp_up breakpoint scatter, and standard metric naming + InfoChip explanations across all new cards.

---

## Design system compliance — non-negotiable

This plan introduces **no new colors, no new typography, no new card shapes**. Everything reuses tokens from `app/src/index.css` and existing components in `MetricsView.tsx`:

| Element | Token / component | Source |
|---|---|---|
| Card chrome | `bg-card border border-border rounded-md p-{3.5,4}` | existing `RateFidelityCard`, `StatCard` |
| Hero numbers | 34px monospace tabular-nums | existing `RateFidelityCard` |
| Stat numbers | 22px monospace tabular-nums | existing `StatCard` |
| Eyebrow + InfoChip | existing `Eyebrow` + `InfoChip` components | `MetricsView.tsx:33–62` |
| Primary color | `hsl(var(--primary))` (orange `#f97316`) | `app/src/index.css` |
| Semantic colors | success / warning / info / destructive | `app/src/index.css` |
| Chart palette | `hsl(var(--chart-1..5))` | `app/src/index.css` |
| SVG conventions | viewBox 1080×240, dashed `var(--border)` grid, monospace ticks, 1.5–1.8 stroke width, 0.14-opacity area fills | existing `ThroughputOverTimeChart` |
| Live-dot pulse | existing animated circle pattern | `ThroughputOverTimeChart:504–518` |

Any new component must follow these patterns. Code review must reject any new color literal, any new component skeleton that doesn't reuse an existing one, and any deviation from the SVG geometry shared with `ThroughputOverTimeChart`.

---

## Per-mode layout

Same 4-row structure for every mode. Only the **content** of three positions changes.

| Row | Common | Mode-adaptive |
|---|---|---|
| Header | DashboardHeader (status pill, method badge, URL, config summary, Stop) | — (unchanged) |
| Row 1 — Hero | Card 3: Error Rate (universal) | Card 1, Card 2 swap per mode |
| Row 2 — Throughput chart | Same chart card chrome | Target reference line only for `constant_rps`; ramp overlay (Plan 3) only for `ramp_up`; single-line otherwise |
| Row 2.5 — Latency over time (Plan 3) | wire + queue gap; renders whenever `avg_queue_wait_ms` is present | identical across modes |
| Row 2.7 — Percentiles over time (NEW) | p50 / p95 / p99 lines | for `constant_rps`, `constant_concurrency`, `iterations`; replaced by Response-time-vs-concurrency scatter for `ramp_up` |
| Row 3 — HDR plot + Timing waterfall | universal | — (unchanged) |
| Row 4 — Stats | Same 4-card grid | 4 stat cards swapped per mode |

### Per-mode hero card #1 and #2

| Mode | Hero card 1 | Hero card 2 |
|---|---|---|
| `constant_rps` | **Rate Fidelity** (existing) | **Send · Throughput** (existing, plus inline `queue Xms` chip when `avg_queue_wait_ms > 5`) |
| `constant_concurrency` | **Achieved Throughput** (req/s big number, sub: "from N concurrent · X req/user/sec") | **Concurrency Utilisation** (e.g., "94 of 100 active") |
| `iterations` | **Progress** (% big number, sub: "M / N complete · ETA Ws", fidelity-style bar) | **Throughput** (single value, sub: "mean iter Xms") |
| `ramp_up` | **Current Concurrency** (big number, sub: "targeting N over Ws ramp · lag X%") | **Saturation** (text-headline like "⚠ degrading" in amber, sub: "p99 crossed Xms at conc Y · errors started at Z") |

When Plan 1 conditions trigger (drops > 0 AND `constant_rps` rate mode), Card 1 swaps to the **Dropped Requests** card from Plan 3 — that takes precedence over Rate Fidelity.

### Per-mode Row 4 stats

| Mode | Stat 1 | Stat 2 | Stat 3 | Stat 4 |
|---|---|---|---|---|
| `constant_rps` | Duration | Total requests | Peak concurrency | **p99 latency** |
| `constant_concurrency` | Duration | Total requests | **Throughput / VU** | **p99 latency** |
| `iterations` | **Elapsed** | **Remaining (ETA)** | **Mean iter time** | **p99 latency** |
| `ramp_up` | **Peak concurrency** | **Breakpoint** | **p99 at peak** | Total requests |

`p99 latency` replaces today's `Avg latency` universally (mean and median become its sub-text). Tail latency is the operationally meaningful headline; mean is misleading on heavy-tailed distributions.

---

## Engine prerequisite — per-tick percentile snapshot

The current `MetricsCollector::get_current_stats()` (`engine/src/core/metrics_collector.cpp:297-311`) emits `totalRequests`, `avgLatencyMs`, `sendRate`, `throughput`, `status2xx/3xx/4xx/5xx`, etc. — but it does **not** emit per-tick percentiles. The Percentiles-over-time chart (and the breakpoint scatter for ramp_up) cannot ship without engine work.

**Add to `get_current_stats()`:**
```cpp
stats["latencyP50Ms"] = histogram_.get_value_at_percentile(50.0);
stats["latencyP95Ms"] = histogram_.get_value_at_percentile(95.0);
stats["latencyP99Ms"] = histogram_.get_value_at_percentile(99.0);
```

The `HdrHistogram` instance is already there (it's what powers the final-report percentiles in `RunReport.latency`). Per-tick lookup is O(1)-ish — same call already happens at run-end for the final report. Cheap.

**TS surface (already prepared):** `LoadTestMetrics` in `app/src/types/domain.ts` already has `latency_p50_ms`, `latency_p95_ms`, `latency_p99_ms` declared but unpopulated. They'll start populating once the engine emits them. No type changes needed on the app side.

**SSE mapping:** add to `app/src/services/sse-client.ts` the camelCase → snake_case remap for `latencyP50Ms` → `latency_p50_ms`, etc., consistent with the existing `avgLatencyMs` → `avg_latency_ms` pattern.

---

## Metric naming convention (locked)

All new metric identifiers follow Vayu's existing two-layer convention:

| Layer | Convention | Examples |
|---|---|---|
| Engine JSON (over SSE) | `camelCase` | `latencyP99Ms`, `avgQueueWaitMs`, `droppedRequests`, `rampLag` |
| TS `LoadTestMetrics` / `RunReport` types | `snake_case` | `latency_p99_ms`, `avg_queue_wait_ms`, `dropped_requests`, `ramp_lag` |
| Component-local derived values | `camelCase` (TS-idiomatic) | `breakpointConcurrency`, `throughputPerVu`, `etaSeconds` |
| CSS variables / class names | unchanged | — |

**Rules:**
- Units in suffix: `Ms` (camelCase) / `_ms` (snake_case), `Pct` / `_pct`, `Bytes` / `_bytes`. Don't omit units.
- Percentile metrics: `latencyP{N}Ms` / `latency_p{n}_ms`. Don't invent variants (no `p99LatencyMs`, no `latencyP99`).
- Cumulative counters use plural nouns (`droppedRequests`, `totalErrors`). Rates use suffix (`sendRate`, `currentRps`). Averages prefixed (`avgLatencyMs`, `avgQueueWaitMs`).
- New metric? Run `grep -ri "latency\|throughput\|concurrency" engine/include/vayu/` first — match the closest existing convention.

---

## InfoChip explanation requirement

**Every metric card — hero, stat, and chart — must have an InfoChip tooltip explaining what the metric means and how to read it.** The existing `InfoChip` component (`MetricsView.tsx:33–52`) is the only mechanism; no other tooltip primitive.

Audience: developers running load tests. Wording should explain the concept, units, and the diagnostic value of the number — not just restate the label.

### Tooltip wording (final, lockable)

**Per-mode hero card #1:**

| Mode | Tooltip |
|---|---|
| `constant_rps` (Rate Fidelity) | (existing wording — no change) |
| `constant_concurrency` (Achieved Throughput) | "Requests per second emerging from the configured concurrent users. In closed-loop testing the rate is an output, not a target — the server's response time determines what RPS you actually achieve. Throughput / VU below shows what each simulated user produced per second." |
| `iterations` (Progress) | "Progress through the configured iteration count. The bar fills as requests complete; ETA is computed from current throughput. Once 100%, the test stops automatically." |
| `ramp_up` (Current Concurrency) | "Current number of in-flight requests at this instant. The configured ramp climbs concurrency linearly from `startConcurrency` to the target over `rampUpDuration`. Ramp lag is the percentage of the configured curve that the generator failed to deliver — non-zero values mean the server is too slow to absorb the planned concurrency." |

**Per-mode hero card #2:**

| Mode | Tooltip |
|---|---|
| `constant_rps` (Send · Throughput) | (existing wording — no change; if a `queue Xms` chip appears, that chip gets its own InfoChip: "Average time requests spent waiting in the generator's in-flight queue before being sent. Non-zero values mean the generator is queueing — usually because the server is slow to respond.") |
| `constant_concurrency` (Concurrency Utilisation) | "Of your configured N concurrent users, how many were actually in-flight on average. Below 100% means some VUs were idle — usually because the test was completing requests faster than it could re-fire (rare) or because the server occasionally returned errors that aborted iterations." |
| `iterations` (Throughput) | "Average requests per second across the run so far. In iterations mode, throughput is an output of how fast the server returns responses — there is no rate target." |
| `ramp_up` (Saturation) | "Whether the server has reached its capacity ceiling. 'Healthy' means p99 latency is below the SLO threshold and the error rate is near zero. 'Degrading' means p99 has crossed the threshold or errors started — the call-out shows the concurrency value at which the degradation began (the breakpoint)." |

**Row 4 stat cards:**

| Stat | Tooltip |
|---|---|
| Duration / Elapsed | "Wall-clock time since the run started. For iterations mode this counts until all N requests complete; for the others it counts up to the configured duration." |
| Total requests | "Cumulative count of requests dispatched and completed (success + failure). For iterations mode this approaches the configured target; for the others it grows with throughput." |
| Peak concurrency | "Maximum simultaneously in-flight requests at any point during the run. Backpressure shown beneath is the current queue depth (requests dispatched but not yet sent to curl)." |
| p99 latency | "Tail latency — 99 of every 100 requests completed in this time or less. Real user-impact lives at p99, not at the mean. Use this as the headline number; mean (sub-text) is misleading on heavy-tailed distributions." |
| Throughput / VU | "Achieved throughput divided by configured concurrency — the average req/sec produced by each simulated user. A useful capacity number when planning for N real users." |
| Remaining (ETA) | "Estimated time to complete the remaining requests, computed as `(requestsExpected - requestsSent) / currentRps`. Updates each tick — a noisy ETA early in the run usually stabilises within 5–10s." |
| Mean iter time | "Average wall-clock time per iteration. Closely tracks p50 latency in closed-loop tests; divergence indicates queueing or other generator overhead." |
| Breakpoint | "The current concurrency at which p99 latency first crossed the configured SLO threshold (default 200ms). Use this as your capacity ceiling — beyond this load, response time grows nonlinearly." |
| p99 at peak | "Tail latency observed during the held-target portion of the ramp (after the curve flattens). Captures the latency this concurrency level actually produces, not just how it ramped up." |

**Chart cards:**

| Chart | Tooltip |
|---|---|
| Throughput over time | (existing wording — no change) |
| Latency over time (Plan 3) | (already specified in Plan 3) |
| Response time percentiles over time (NEW) | "Per-tick p50 / p95 / p99 latency over the run. p50 is what most users felt; p99 is the tail — heavy-tail divergence shows up as p99 climbing while p50 stays flat. Sourced from per-tick HdrHistogram snapshots." |
| Response time vs concurrency (NEW, ramp_up only) | "Scatter plot — each dot is one tick. X axis is the concurrency at that moment; Y is p99 latency at that moment. A flat left region means the server has headroom; the elbow (knee) is the breakpoint; the steep right region means the server is saturated. The amber vertical line marks where p99 first crossed the SLO threshold." |

---

## Modular component structure

The current `MetricsView.tsx` is a single 1090-line file mixing card components, chart components, and the main layout. Plan 4 introduces enough mode-specific variation that continuing in one file would be unwieldy. **The redesign must extract per-concern modules.**

Proposed structure under `app/src/modules/dashboard/`:

```
dashboard/
├── components/
│   ├── MetricsView.tsx                ← thin orchestrator: selects mode-variant components
│   ├── DashboardHeader.tsx            ← unchanged
│   ├── RunMetadata.tsx                ← unchanged
│   ├── RequestResponseView.tsx        ← unchanged
│   ├── hero/                          ← NEW: hero card variants
│   │   ├── RateFidelityCard.tsx       ← extracted from MetricsView (constant_rps)
│   │   ├── SendThroughputCard.tsx     ← extracted (constant_rps)
│   │   ├── DroppedRequestsCard.tsx    ← from Plan 3 (constant_rps when drops > 0)
│   │   ├── AchievedThroughputCard.tsx ← NEW (constant_concurrency)
│   │   ├── ConcurrencyUtilCard.tsx    ← NEW (constant_concurrency)
│   │   ├── ProgressCard.tsx           ← NEW (iterations)
│   │   ├── ThroughputCard.tsx         ← NEW (iterations)
│   │   ├── CurrentConcurrencyCard.tsx ← NEW (ramp_up)
│   │   ├── SaturationCard.tsx         ← NEW (ramp_up)
│   │   └── ErrorRateCard.tsx          ← extracted (universal)
│   ├── charts/                        ← NEW: chart cards
│   │   ├── ThroughputOverTimeChart.tsx          ← extracted, gains optional rampOverlay prop
│   │   ├── LatencyOverTimeChart.tsx              ← from Plan 3
│   │   ├── PercentilesOverTimeChart.tsx          ← NEW (all modes except ramp_up alternative)
│   │   ├── ResponseTimeVsConcurrencyScatter.tsx  ← NEW (ramp_up)
│   │   ├── HdrPercentilePlot.tsx                 ← extracted, unchanged
│   │   └── TimingWaterfall.tsx                   ← extracted, unchanged
│   ├── stats/                         ← NEW: stat row
│   │   ├── StatCard.tsx               ← extracted (the 22px primitive)
│   │   └── ModeStatsRow.tsx           ← routes to mode-specific stats
│   ├── shared/                        ← NEW: cross-cutting
│   │   ├── InfoChip.tsx               ← extracted
│   │   ├── Eyebrow.tsx                ← extracted
│   │   └── chartGeometry.ts           ← shared SVG constants (HDR_DIMS etc.)
│   └── tooltips.ts                    ← centralized InfoChip wording from §"Tooltip wording"
├── hooks/
│   ├── useMode.ts                     ← derives `mode` from run config consistently
│   ├── useChartData.ts                ← per-tick history → chart data bucketing
│   └── useBreakpoint.ts               ← client-side breakpoint detection (ramp_up only)
├── utils/
│   ├── isRateLimitedRun.ts            ← from Plan 3 (constant_rps + targetRps > 0)
│   ├── computeEta.ts                  ← (requestsExpected - requestsSent) / currentRps
│   └── computeBreakpoint.ts           ← scan per-tick history for first p99 > threshold
└── types.ts                           ← extends/uses domain types; no new public types
```

**Why this structure (modularity goals):**
- Each card/chart is **independently testable** — no implicit dependencies on the parent.
- The orchestrator `MetricsView.tsx` becomes a routing layer: read mode, pick variants, compose. ~150 lines max.
- **Tooltips live in one place** (`tooltips.ts`) — wording changes happen in one diff, not 14.
- **Chart geometry constants live in one place** (`chartGeometry.ts`) — Y/X padding, viewBox dimensions, grid stroke widths all match `ThroughputOverTimeChart`'s.

---

## Files changed — summary

| Area | Files | Change |
|---|---|---|
| Engine | `engine/src/core/metrics_collector.cpp:297-311` | Emit `latencyP50Ms / P95Ms / P99Ms` per tick |
| App — SSE | `app/src/services/sse-client.ts` | Map percentile fields (camelCase → snake_case); already in `LoadTestMetrics` |
| App — module structure | `app/src/modules/dashboard/` | Refactor into the structure above |
| App — orchestrator | `app/src/modules/dashboard/components/MetricsView.tsx` | Becomes a thin router; existing logic moves into extracted modules |
| App — new cards | `dashboard/components/hero/` (8 new card files) | All new hero cards per mode |
| App — new charts | `dashboard/components/charts/PercentilesOverTimeChart.tsx`, `ResponseTimeVsConcurrencyScatter.tsx` | New chart cards |
| App — stats | `dashboard/components/stats/ModeStatsRow.tsx` | Routes to mode-specific stat sets |
| App — tooltips | `dashboard/components/tooltips.ts` | Centralized wording (locked in §"Tooltip wording") |
| Docs | `docs/design-system.md` | Add note: tail latency (p99) is the headline metric across the dashboard, not mean |

Plans 1, 2, 3 files apply as before — this plan is additive.

---

## Code quality requirements

These are pass/fail criteria for code review:

1. **No new colors or design tokens.** Every color comes from `index.css` via `hsl(var(--*))`. Hex literals only allowed for opacity tweaks where the design system permits (e.g., `hsl(var(--primary) / 0.14)`).
2. **No new InfoChip tooltip primitive.** Reuse the existing component. Tooltip content lives in `tooltips.ts` — components import strings, not write them inline.
3. **Every new card and chart has an InfoChip.** Lint rule (manual review acceptable): `grep -L "InfoChip" dashboard/components/hero/*.tsx` returns empty.
4. **No new chart geometry constants in component files.** All SVG dimensions come from `chartGeometry.ts`. If you find yourself typing a viewBox, extract it.
5. **Mode discriminator is one function.** `useMode()` is the only place that maps run config to `"constant_rps" | "constant_concurrency" | "iterations" | "ramp_up"`. Components consume this hook, don't derive mode themselves.
6. **No barrel imports across modules.** `import { X } from "@/modules/dashboard"` is fine for public surface; internal modules use direct paths to keep dependency graph readable.
7. **Per-card files stay under 200 lines.** If one grows past that, it's doing too much — split before merging.
8. **Type-safety.** No `any`, no `@ts-ignore`. Strict TS as the project already requires per `CLAUDE.md`.
9. **Memoize chart data.** Per-tick history → chart data should go through `useMemo` in `useChartData.ts` — never recompute on every render.
10. **Lint + format + type-check pass.** `pnpm lint && pnpm format:check && pnpm type-check`.

---

## Post-implementation: run the `simplify` skill

After the implementation is complete (cards extracted, charts added, MetricsView refactored, tests passing), invoke the **`simplify` skill** on the diff:

```
/simplify
```

This is equivalent to `/code-review --fix` — it reviews the current diff for correctness bugs and reuse/simplification/efficiency cleanups, then applies the fixes. Specific focus areas to call out when invoking:

- **De-duplication:** the eight new hero cards all share an `Eyebrow + InfoChip + BigValue + Sub` shape. If `simplify` finds opportunities to extract a `HeroCardShell` primitive, take them.
- **Chart abstraction:** `LatencyOverTimeChart`, `PercentilesOverTimeChart`, and the (existing) `ThroughputOverTimeChart` all share grid-rendering, tick-rendering, and live-dot logic. A shared `<TimeSeriesChart>` primitive may emerge. Let `simplify` propose it.
- **Tooltip indirection:** components should import tooltip text by key, not by string. If components ended up with inline text, `simplify` should refactor to constant references.

The `simplify` pass is part of the deliverable, not optional. The diff after `simplify` is what gets reviewed and merged.

---

## Verification

### Visual (`pnpm run electron:dev`)
1. Run a `constant_rps` test against a healthy server — Rate Fidelity hero + Send/Throughput hero (no queue chip) + Error Rate. Throughput chart shows target line. Percentiles chart shows three flat lines. Row 4 ends with `p99 latency`.
2. Run a `constant_rps` test against a slow server — Send/Throughput card now shows a `queue 12ms` amber chip; if drops > 0, Rate Fidelity is replaced by Dropped Requests (Plan 3).
3. Run a `constant_concurrency` test — Achieved Throughput + Concurrency Utilisation + Error Rate; throughput chart has no target line; Percentiles chart present; Row 4 ends with `Throughput / VU`.
4. Run an `iterations` test — Progress + Throughput + Error Rate; Row 4 stats are Elapsed / Remaining / Mean iter time / p99 latency; ETA updates each tick.
5. Run a `ramp_up` test against a slow server — Current Concurrency + Saturation + Error Rate; Throughput chart has the configured/achieved overlay (Plan 3); Row 2.7 is the Response time vs concurrency scatter with a labelled breakpoint vertical line; Row 4 shows Peak / Breakpoint / p99 at peak / Total.
6. Hover every metric card and chart — InfoChip tooltip appears with wording matching §"Tooltip wording".

### Type and lint
7. `cd app && pnpm type-check && pnpm lint && pnpm format:check` — all clean.
8. `cd app && pnpm test` — existing tests pass; add new tests for `useMode()`, `computeEta()`, `computeBreakpoint()`, and one rendering snapshot per hero card variant.

### Engine
9. `cd engine && ctest --preset macos-dev --output-on-failure` — passes, including a new test that `get_current_stats()` includes the `latencyP{50,95,99}Ms` keys with non-negative values after recording some samples.

### Cross-mode regression
10. Switch between modes by starting different runs in sequence — confirm no stale card lingers from a prior mode. The orchestrator should remount its children when mode changes.

### Older runs
11. Open a historical run from before Plans 1–4 — Percentiles-over-time chart degrades cleanly to "data not available in this run" placeholder; HDR plot still renders from the final report.

### Post-`simplify`
12. After `simplify` runs, re-run steps 7–11 to confirm no regressions from the refactor.
