# Spike: unify charting on uPlot (N3)

_Spike branch `spike/uplot-charts` (base master `367902f`, engine/app `0.7.0`). Prototype lives in `app/src/modules/dashboard/components/charts/uplot/`._

## Why

Two problems surfaced while reviewing the app's charts:

1. **Two charting stacks.** The live dashboard uses a good, hand-rolled **SVG** system (`TimeSeriesChart` frame + `chartGeometry` + `metricsTransforms`, tokenized, tested). History uses **recharts** in exactly one file (`HistoricalChartsSection`), with three copy-pasted `<LineChart>` blocks and a duplicate "throughput over time" chart. One screen now mixes both engines.
2. **Density + interactivity ceiling.** A load test is a dense, high-frequency time-series (10 Hz ticks × minutes = thousands of points × many series). SVG/DOM charts strain there — the app already works around it with `CHART_DOWNSAMPLE_MAX_POINTS`. And neither stack lets a user *correlate* metrics or *drill into* the moment of degradation. That's the actual job: **understand the service under test**, not just draw lines.

How the field solves this: Grafana renders its time-series panel on **uPlot** (Canvas); Datadog uses a custom Canvas/WebGL engine; New Relic uses Victory (SVG) for lighter dashboards. The dense-time-series answer is consistently **Canvas**.

## Measured cost (real numbers)

Production `vite build` on this branch, gzipped chunk sizes:

| Library | raw | gzipped | notes |
|---|---|---|---|
| **recharts** (current) | 324 KB | **96.9 KB** | its own `charts` chunk (`test: /node_modules/recharts/`); d3 transitive deps extra |
| **uPlot** (proposed) | 51 KB min + 1.8 KB css | **~22.8 KB** | single dep, no d3 |

→ **~74 KB gzipped removed (~4×)**, plus Canvas rendering removes the need to downsample.

## Prototype (built, type-checks, lint-clean)

`app/src/modules/dashboard/components/charts/uplot/`:

- **`uplotTheme.ts`** — resolves Vayu's CSS tokens (`--primary`, `--destructive`, `--border`, …) via `getComputedStyle` into concrete `hsl(...)` strings for Canvas. **Answers the theming question: yes, Canvas stays token-driven.** Re-reads on light/dark flip.
- **`TimeSeriesUPlot.tsx`** — the proposed single primitive (replaces the SVG charts *and* recharts). Canvas, ResizeObserver sizing, cheap `setData` updates, crosshair + drag-zoom + optional cursor-sync + annotations.
- **`plugins.ts`** — `tooltipPlugin` (multi-series readout at the cursor) and `annotationsPlugin` (vertical insight markers, e.g. the W1 breakpoint).
- **`UplotSpikeDemo.tsx`** — three synced charts (RPS / latency percentiles / errors) over a synthetic ramp, with the breakpoint annotation. Rendered proof captured in the spike screenshot.

## The interactivity that makes it "understanding," not decoration

Understanding a service = **correlate metrics over time** and **drill into the moment it degraded**. Concretely:

1. **Synced cursor across charts** (`cursor.sync`) — hover once, read RPS + p50/p95/p99 + errors + concurrency at the *same instant*. This is the single most important diagnostic move; three independent tooltips can't do it. *(Demonstrated in the screenshot: one hover → cursor on all three charts.)*
2. **Multi-series tooltip** — exact values at the cursor, not eyeballed off an axis.
3. **Drag-to-zoom the shared time window** — select the spike, inspect it at full per-tick fidelity (the W1 data we now persist), double-click to reset. No downsampling loss.
4. **Insight annotations** — the capacity breakpoint (p99 crosses SLO), ramp-phase boundaries, later config/deploy markers — drawn on the axis so charts point at *conclusions*, not just data.
5. **Series toggle / SLO threshold lines / brushing the scatter** — isolate the tail, see headroom to the SLO, select a concurrency band.

uPlot supports all of the above natively (sync, drag-zoom, plugin draw hooks). The SVG stack would need each rebuilt by hand; recharts does tooltips but not fast synced-cursor over dense series.

## Tradeoffs (honest)

- **Canvas is less DOM-accessible** than the token-driven SVG (no per-element inspection; screen-reader story is weaker). Mitigation: keep a data-table fallback for exported/report views.
- **Pixel-crisp theming needs `devicePixelRatio` handling** (done in the prototype) and a re-read on theme flip (done).
- **Migration touches every chart.** Do it incrementally behind the existing component APIs.

## Recommendation & migration plan (N3)

Adopt uPlot as the **single** charting primitive; delete recharts.

1. Land `TimeSeriesUPlot` + theme + plugins (this prototype), with a unit/interaction test.
2. Re-point `HistoricalChartsSection` (RPS/throughput/connections) at it → **drop the `recharts` dep** (−~74 KB gz, kills the duplicate throughput chart).
3. Migrate the live SVG charts (`Latency`, `Throughput`, `Percentiles`, scatter) one at a time; keep `metricsTransforms` (data-shaping is engine-agnostic).
4. Add synced cursor across the dashboard rows + wire the W1 breakpoint as an annotation everywhere.
5. Retire `TimeSeriesChart`/`chartGeometry` SVG frame once nothing uses it (keep `niceYMax` — still handy).

_Size: medium (incremental, per-chart). Independent of PR #54; best done after W1 merges so the breakpoint annotation has real per-tick data to point at._

## Backlog entry (for `pending-backlog.md`)

> ### N3. Unify charting on uPlot (drop recharts)
> Two charting stacks today: a good hand-rolled SVG system (live dashboard) and recharts in one history file (`HistoricalChartsSection`, duplicate throughput chart, copy-pasted LineCharts). Load tests are dense time-series → the app already downsamples (`CHART_DOWNSAMPLE_MAX_POINTS`), and neither stack lets a user correlate metrics or zoom the moment of degradation. **Spike done** (`docs/plans/chart-spike-uplot.md`, branch `spike/uplot-charts`): uPlot (Canvas) is ~22.8 KB gz vs recharts ~96.9 KB gz (−~74 KB, ~4×), stays token-themed, and adds synced cursor / drag-zoom / breakpoint annotations — the "understand the service" interactivity. **Needs:** land `TimeSeriesUPlot` + tests, migrate history off recharts (drop the dep), then migrate live SVG charts incrementally, wire synced cursor + W1 breakpoint annotation. Medium; do after W1 merges.
