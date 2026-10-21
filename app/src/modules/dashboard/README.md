# Dashboard Module

**Location:** Main content area only

This module displays real-time load test metrics. A finished run - completed,
failed or stopped - renders History's `LoadTestDetail` over its report once the
report has arrived (#2220), so the dashboard and History never draw one run two
ways; until then the live view stays, with the report fetch's Retry.

## Structure

- `index.tsx` - Main LoadTestDashboard component (entry point)
- `components/` - Sub-components (DashboardHeader, MetricsView, etc.). The header takes the
  finished run's verdict (`outcome`, from `components/shared/run-outcome.ts`) as a string so a
  `completed` pill does not wear the success tick for a run that missed a budget; it is a string
  because the header is memo'd on `Object.is`. The verdict's banner is the report's own
  (`LoadTestDetail`, first in its scrolling body below a one-row breadcrumb header, #2271), so a
  finished run's header is Back, that pill, the run's comment (#2270, which the report body no
  longer draws) and its Export menu (#2139: `exportRunId`, with the report's URL and method for the
  baseline lookup, all primitives and handed over only once the report is on screen). A collection
  load run has no URL, so the live header
  shows its collection name and step count there (`collectionName` / `stepCount`, primitives for
  the same memo reason).
- `hooks/` - Dashboard-scoped hooks (`useMode`, `useCollectionRunTarget`)
- `utils/` - Pure derivation and geometry helpers
- `types.ts` - Type definitions

## Usage

```tsx
import LoadTestDashboard from "@/modules/dashboard";
```

## Code-quality gates

Seven rules this module holds to. Each names the file that owns it - that file is
the authority, so a change belongs there rather than in the component that
consumes it.

- **Tooltip copy lives in one file.** `components/tooltips.tsx` is the single
  source of every InfoChip string. Components import by key
  (`<InfoChip tip={TOOLTIPS.rateFidelity} />`) and never write tooltip copy
  inline. No document restates the wording, and the one test that reads it
  (`tooltips.rate-fidelity.test.tsx`) holds only which window the rate tooltips
  name (#2392), so `tooltips.tsx` is where wording is decided, and editing an
  entry there updates every card that shows it.
- **No chart geometry constants in component files.** `utils/chartGeometry.ts`
  owns `TIME_SERIES_DIMS` and `HDR_DIMS`. The full-width time-series charts must
  stay dimensionally identical or the dashboard rows stop lining up, and the HDR
  plot and the live view's skeleton of it hold one height.
- **The mode mapping lives in exactly one place.** `hooks/useMode.ts` is the only
  interpreter of the freeform engine `mode` string. Mode-adaptive components take
  the discriminator from it instead of re-parsing the raw value, and the mode
  vocabulary is derived from `LOAD_TEST_MODES` rather than hand-listed.
- **No card re-derives from raw metrics.** `components/MetricsView.tsx` computes
  one memoized `DashboardDerived` bundle (shape in `types.ts`) and passes it to
  `HeroRow` and `ModeStatsRow`, which stay pure presentational components that
  read what they need.
- **An error is counted once, by the engine (#2124).** A response outside
  2xx/3xx, or no response at all; a 3xx is a success. `DashboardDerived`
  carries `failedRequests` and its split `httpErrors` / `noResponse`, read off
  the live tick or the report summary through `utils/errorBreakdown.ts`. No
  card recounts them from the status map: `ErrorRateCard` only buckets that
  map for its bar, which `MetricsView` feeds from the latest tick and
  `reportToDerived` from the report's distribution.
- **A request a Stop cancelled is not an error (#2136).** The engine counts it
  apart (`summary.cancelledRequests`) and leaves it out of `totalRequests`, the
  status-code distribution and every error figure, so the Error rate card and
  its bar never include it. The report draws it as one muted line,
  `CancelledRequestsNote` ("N requests cancelled by Stop"), beside the error
  card rather than inside it, since a stopped run with no errors still has it.
  The card's colour follows its digits (`formatErrorPercent`): a rate above zero
  is never printed as `0.0` in red. A `stopped` run renders the report like
  `completed` and `failed` do.
- **A chart card's render gate asks a predicate, not a series.**
  `utils/metricsTransforms.ts` owns both halves: the transform a chart plots,
  and the `spansMultipleBuckets` / `hasPercentileSignal` predicates a card reads
  to decide whether it is worth rendering. `MetricsView` used to build the
  latency, percentile and status series purely to read `.length`, while the
  chart inside that card built the identical series again from the identical
  array - and the store hands down a new array on every batch, so neither memo
  held and the three heaviest transforms were paid twice per flush (#1152). A
  gate that needs a count builds nothing.
- **Every chart buckets before it draws.**
  `components/charts/uplot/buildData.ts` owns the reduction: `bucketColumns` and
  `rebucket` for the time-series charts, `buildConcurrencyScatter` for the
  ramp-up scatter, all at the user's `chartBucketSeconds`. This is the step that
  makes `constants/live-window.ts`'s retention cap a memory bound rather than a
  rendering one, and the scatter - one dot per tick, up to the 50,000-tick cap -
  was the one chart that argument did not cover (#1152).
- **The per-mode stat-card table lives with its router.**
  `components/stats/ModeStatsRow.tsx` decides which cards each mode shows, and
  its file comment tabulates them. Add a mode there, next to the branch that
  renders it. The throughput-led modes (`constant_rps`, `constant_concurrency`,
  `iterations`) show three stats: their p99 is in the hero row's
  `LatencyPercentilesCard`, beside p95, and `ramp_up` / `capacity` keep p99 in
  the stats row as p99 at peak.
- **A tick's percentiles mean different things by where it came from** (#2385),
  and `utils/tickPercentiles.ts` is the one place that says which. A stored
  tick's `latency_p*_ms` are its whole second's. A live frame's are only the
  last ~100 ms window, so the per-second readers use `secondPercentiles`: a
  gate frame (about one a second, the final one included) contributes its
  `second_p*_ms`, every frame between gates contributes nothing, and a stored
  tick contributes its own. The percentile chart, the response-time scatter
  and the breakpoint (`breakpointAt`, shared by the store and
  `computeBreakpoint`) all read it; at a chart interval wider than a second
  the percentile chart keeps the worst second per bucket (`rebucket(..., "max")`),
  never an average. `mapSseMetrics` marks a live frame (`live`) because that
  flag is what tells a frame between gates from a stored tick. The hero card
  reads `cumulativePercentiles` instead, the run so far, which is the span its
  mean covers. The anomaly detector reads `secondPercentiles` too, over the
  gate frames alone (below).
- **A second with no completion is a gap, never 0 ms** (#2386). The engine
  sends it as a gate with `second_samples` `0` and stores it with no
  `latency_p*_ms` keys (a live window with nothing in it has `null` ones), and
  `mapSseMetrics` passes every percentile through as sent. `coversSecond` says a
  tick stands for a second at all; one that does with no `secondPercentiles` is
  that empty second. The percentile chart plots it as a `null` point, which
  uPlot draws as a break in the line - skipping it would join its neighbours
  straight across the stall - and `worstReading`, the merge both
  `buildPercentileChartData` and `rebucket(..., "max")` use, keeps a bucket
  null only when every second in it was empty. A row an older engine stored
  holds `0` for such a second and still reads as `0`: nothing rewrites it.

## Anomaly detection (`utils/detectAnomalies.ts`)

The run's degradation windows - latency spikes, error bursts, throughput drops
and the first 5xx - scanned out of the same per-tick series the charts plot,
with fixed factors over a trailing median and nothing tunable. Two readings of
one detection: the charts shade the windows, and the history Overview's
`RunEvents` card states them in words. Both are absent for a clean run.

It has two entry points, and which one a view wants depends on how its series
arrives:

- **`detectAnomalies(history)`** is the one-shot, pure over the whole series.
  `LoadTestDetail` uses it: a stored run's series arrives once, complete.
- **`createAnomalyDetector()`** holds its derivation across calls, for a caller
  handing over the same growing buffer again and again. `MetricsView` holds one
  for the run's life. The live buffer's array identity changes on every commit
  (twice a second by default), so a from-scratch pass re-derived a trailing
  median per tick per series over the whole retained window - ~9,000
  fifteen-element sorts twice a second at the default 5-minute window, up to
  ~150,000 during a full-run soak, on the renderer's main thread (#1151).

The two answer identically for the same buffer, and the rule that keeps them
that way is in the file's header comment: what a tick and its predecessors
decide is cached once under an index no trim renumbers, and what a tick's
_position in the buffer_ decides is re-applied when the buffer is trimmed. A new
rule that reads a tick's position without honouring the second half will pass
its own unit test and disagree with the one-shot the first time the window
fills; `detectAnomalies.test.ts` replays randomized append/trim sequences
against a from-scratch pass to catch exactly that.

**Both views run it on one tick a second** (#2589), except on a long run in
History (below). Every rule counts ticks (a 15-tick baseline, 2 ticks to open a
window), so a live buffer of 100 ms frames would shrink the baseline to 1.5 s
and judge windows History never sees.
`MetricsView` passes its buffer through `wholeSecondTicks` first, which keeps a
stored tick as it is and, of a live stream, only the gate frames (the final
frame included). A gate's p99 is its `second_p99_ms`, and its `current_rps`, a
100 ms delta on the frame, is restated as completions over the interval since
the previous gate, which is what a stored tick holds. That figure is fixed the
first time a gate is seen and cached per frame, so a later trim of the gate
before it changes neither the figure nor the object the detector aligns on.

**A second with no p99 is no reading to the spike rule** (#2386). It is not
hot, it is left out of the trailing median (a baseline is the median of the
readings among the fifteen ticks before, `null` if there are none), and it
does not close a recovery tail, so a stall inside a spike extends the window
rather than ending it. Read as 0 ms, a few stalled seconds dragged the median
to 0, and a 0 baseline judges nothing. The throughput rule still sees the
stall, as the drop it is.

**A long run in History is judged over buckets** (#2547). `LoadTestDetail`
reads its series in one `maxPoints` request of `HISTORY_SERIES_MAX_POINTS`
(2,000). A run that stored more arrives folded into buckets of `ticksPerBucket`
seconds: p99 and concurrency the bucket's worst second, `current_rps` its mean,
every counter and the status map its last tick. The detector and
`computeBreakpoint` run over those buckets unchanged, on purpose: a bucket's p99
is an upper bound on its seconds, so no second over a threshold is missed, and
the breakpoint and the first 5xx land on the bucket holding them, at most one
bucket late. The tick counts then count buckets, so the baseline is 15 buckets
and a window needs 2 hot ones: a slowdown shorter than two buckets goes unnamed
while the breakpoint still marks it, and an error burst is a share of its
bucket's completions, diluted by the rest of the bucket. The Performance tab
says so in a note above the charts. A run of at most 2,000 ticks arrives raw and
behaves exactly as it always has; `utils/downsampled-series.test.ts` holds the
two paths to each other. The status chart rates each point per second over the
time it closes (`buildStatusOverTime`), so a bucket is not drawn
`ticksPerBucket` times taller than the second it stands for.
