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
  owns `TIME_SERIES_DIMS`. The full-width time-series charts must
  stay dimensionally identical or the dashboard rows stop lining up.
- **The mode mapping lives in exactly one place.** `hooks/useMode.ts` is the only
  interpreter of the freeform engine `mode` string. Mode-adaptive components take
  the discriminator from it instead of re-parsing the raw value, and the mode
  vocabulary is derived from `LOAD_TEST_MODES` rather than hand-listed.
- **No card re-derives from raw metrics.** `components/MetricsView.tsx` computes
  one memoized `DashboardDerived` bundle (shape in `types.ts`) and passes it to
  `HeroRow` and `ModeStatsRow`, which stay pure presentational components that
  read what they need.
  A finished report reaches the same bundle through `utils/reportToDerived.ts`,
  and the Rate fidelity figure means one thing in both: pace over the sending
  window. A stopped report is therefore judged by `liveRateFidelity` too, with
  the report's plan share kept apart as `stoppedAt` (#2805); History's
  Performance tile reads the same `rateAchievementPct`.
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
- **p99 at peak is read at the run's peak load, not at the breakpoint**
  (#2802). It is the worst whole-second p99 (`secondPercentiles`, the reading
  `computeBreakpoint` uses) among the ticks whose `current_concurrency` equals
  the run's peak: `utils/p99AtPeak.ts`. The breakpoint tick is a lighter load
  than the peak, so reading it understated the stat on any run that crossed the
  SLO early. The store latches it with `peakConcurrency` (`p99AtPeakMs`),
  restarting whenever the peak rises, so retention cannot trim it; History
  derives it over its own series, buckets included. Until a tick at the peak
  has a whole-second reading the stat shows the run's cumulative p99, as it did
  before. `Breakpoint.p99Ms` stays the crossing tick's and is not repurposed.
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
  straight across the stall. A reading with an empty second on both sides (or a
  data end) has no neighbour to join, so `UPlotChart` draws it as a marker
  rather than nothing; a sparse run's 0.5 req/s shows every completion. An
  empty second never draws a bridge, and a continuous series draws no markers.
  `worstReading`, the merge both
  `buildPercentileChartData` and `rebucket(..., "max")` use, keeps a bucket
  null only when every second in it was empty. A row an older engine stored
  holds `0` for such a second and still reads as `0`: nothing rewrites it.
- **Row 3 reads the latest gate frame from `historicalMetrics`, never the newest
  tick** (#2782). The two cards used to be placeholders until the report
  arrived (#2261); they now draw the run-so-far data. The run-so-far latency
  distribution (`cumulative_latency`)
  and the per-phase means and percentiles (`cumulative_phases`) ride the gate
  frame alone,
  about one frame in ten, so the tick in `metrics` almost never has them and a
  card reading it would flicker to empty nine renders in ten.
  `utils/liveDistributions.ts` scans the buffer backwards for the latest frame
  carrying the key (`!== undefined`: a `null` is a gate frame with nothing
  completed yet) and adapts it to what History's cards take, so the live view
  draws the same `HdrPercentileChart`, `TimingWaterfall` and
  `PhasePercentiles` (the phases rebuilt in the report's `timingBreakdown`
  shape, `maxMs` as `max`), and `LiveDistributionRow` memoises on the frame's
  identity. A gate frame without
  `cumulative_phases` is a run with phase histograms off, and the timing card
  says so; before the first completion each card holds one "Waiting for the
  first response" line, sized to the HDR plot so it does not pop (the timing
  card then grows by the percentile table; the grid stretches the HDR card to
  match). The footer's mean is that
  frame's `avg_latency_ms` (the distribution carries none), so the footer and
  the curve are one instant; the "N completions so far" caption under it is
  the distribution's own `count`. The hero card keeps `cumulativePercentiles`, which
  is on every frame.
- **The dashed vertical line marks where p99 first crossed the SLO, and the
  horizontal one is the SLO itself** (#2698). The vertical line is labelled
  `p99 > SLO <threshold>`, never the observed p99, which is in its hover with the
  load at the crossing. It is drawn on every time chart for a `ramp_up` run, on
  the percentile chart alone for any other mode, and on none when
  `Breakpoint.atRunStart` is set: the first whole-second reading (a window
  between gates and an empty second are not readings) was already over the SLO,
  so there was no crossing, and the percentile chart's horizontal SLO line,
  drawn whether or not p99 reached it, carries the message. The store latches
  the flag with the breakpoint; History's `computeBreakpoint` sets it over its
  own series, where on a bucketed run it means the first bucket.
- **A tick's rates and means cover its trailing second, and the run-cumulative
  ones stay on the hero cards** (#2393). The engine reads one trailing window
  (at least a second) per tick, and a live frame and a stored row carry the
  same reading: `current_rps` (completions per second), `current_send_rate`
  (dispatches per second) and the means `window_avg_latency_ms` /
  `window_avg_queue_wait_ms`, `null` for a window in which nothing completed.
  The throughput chart plots `current_rps` (`pickThroughput`), the send-rate
  line `current_send_rate`, and the latency chart the two means; the cumulative
  `throughput`, `send_rate` and `avg_latency_ms` feed the hero cards and are
  never a fallback for a chart, because a cumulative line plotted under a
  per-tick label lags a real step by the run's age. A tick stored before the
  window existed has none of the new keys, and `mapSseMetrics` leaves them
  absent rather than `0` for the same reason: the send-rate line (and its
  legend entry, `hasSendRate`) is omitted for a data set none of whose ticks
  has the figure, and a tick with no window latency (absent or `null`) adds no
  point to the latency chart. The ETA reads the live `current_rps`, so it
  follows the last second rather than the last 100 ms.
- **Virtual user utilisation and the Active virtual users chart read the mean on
  the wire, not the instant** (#2821). `current_concurrency` counts the curl
  workers' active transfers at the sample, and a virtual user in a timer wait
  (`timer.think`, `timer.pacing`) holds none, so users that wait in step read 0
  and N alternately however fast the sample. The engine adds the mean by Little's
  law: `window_avg_in_flight` on a live frame (`windowAvgInFlight`) and a stored
  tick over the same trailing window as the means above (`0` for a window with no
  completion), and `summary.avgInFlight` on the report. `MetricsView` and
  `reportToDerived` fill `DashboardDerived.avgInFlight` from them, and
  `ConcurrencyUtilCard` shows it in `constant_concurrency` ("4.2 of 10 on the
  wire", 42.0%). `ConnectionsChart` plots `pickAvgInFlight`. A key the engine
  did not send (a run stored before it) is absent, never `0`: the card falls back
  to `currentConcurrency` live and `peakConcurrency` once finished, and the chart
  to `current_concurrency` per tick, so such a run reads as it always did. The
  chart keeps the last tick of a bucket like the other windowed series (a mean
  is not a maximum). `capacity`, `ramp_up` and `constant_rps` stay on the instant in the card and the chart. The window credits a request to the second it completes in, so a target slower than the window reads high for a tick and low after; the card clamps to the configured users. The "Peak
  virtual users" stat and `p99AtPeak` stay on the peak.
- **A finished `ramp_up` run's concurrency card is titled for the peak** (#2870).
  Instantaneous concurrency is 0 once a run ends, so `HeroRow` already hands
  `CurrentConcurrencyCard` the peak; with `isCompleted` the card reads "Peak
  virtual users" and drops the "active" unit instead of claiming 30 are active.
  The report carries no per-tick concurrency, so `reportToDerived` leaves
  `rampDeviationPct` empty and `LoadTestDetail` fills it from the stored series
  with `buildRampOverlay`, the overlay the live view uses. A series folded into
  buckets (#2547) feeds the bucket's max concurrency, so the figure is the
  overlay's over buckets. A run with no stored series prints no "lag" clause at
  all, never `lag -%`; the live card keeps its dash.
- **The Send / Throughput chip is judged on the windowed pair, held for a few
  seconds, and is grey until the run has settled** (#2802).
  `utils/dispatchLag.ts` decides, `ThroughputTwinCard` only draws what it is
  handed. The printed rates stay the run-cumulative `send_rate` and `throughput`,
  and on any healthy open-model run those part by in-flight / elapsed (500
  req/s against a 100 ms target is a 25 req/s gap at 2 s and still over 1 req/s
  at 50 s), so judging the printed pair turned the chip red on a healthy run.
  Live, the verdict reads the tick's `current_send_rate` against `current_rps`
  (`DisplayMetrics` carries the former): the gap counts only at 1 req/s **and**
  10% of the send rate (`LAG_TOLERANCE`), turns `lagging` only once it has stayed
  open for `LAG_HOLD_SECONDS`, and stays `settling` (muted tokens) until a mean
  latency, and a first full second, has elapsed, because a completion trails its
  dispatch by one latency. "Held" is `dispatchLagSinceSeconds` in the dashboard
  store, folded per tick by `foldLagStreak` in `addMetricsBatch` and cleared by
  `startRun`; `MetricsView`'s derived memo reads that one number, never the
  history array. A tick with no `current_send_rate` resets the streak and draws
  no chip, since the cumulative rate must not stand in for it. History feeds
  the same function the finished report's cumulative `sendRate` / `throughput`
  with held and settled true (`reportToDerived`), same tolerance; #2800 changes
  what that pair is, not the rule.

## Anomaly detection (`utils/detectAnomalies.ts`)

The run's degradation windows - latency spikes, error bursts, throughput drops
and the first 5xx - scanned out of the same per-tick series the charts plot
(throughput is `current_rps`, the field the throughput chart plots and the
engine's HTML export draws, #2393), with fixed factors over a trailing median and nothing tunable. Two readings of
one detection: the charts shade the windows, and the history Overview's
`RunEvents` card states them in words. Both are absent for a clean run.

An error burst's label states the **window's own rate** - its failures over its
completions, summed across the window's ticks - with the worst second beside it
only when that differs: `errors 7.8% of requests over 9.00s (worst second
10.0%)`. Printing the peak tick as the window's rate overstated a long burst, so
the peak survives only as the secondary figure and as the `magnitude` the cap
ranks by. A second needs `MIN_BURST_COMPLETIONS` (20) completions to start or
extend a burst: one failure among the last few requests of a drain is 100% of
almost nothing, and it would have opened a window out of a run that was ending.

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
frame included). A gate's p99 is its `second_p99_ms`. Its `current_rps` needs
no restating: it is the trailing-second reading the engine stores for the same
tick (#2393), so a gate goes through as the very frame it arrived as, and the
object the detector aligns on cannot change under a trim.

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
seconds: p99 and concurrency the bucket's worst second, `current_rps`, `current_send_rate` and the window latency means their mean (#2393),
every counter and the status map its last tick. The detector and
`computeBreakpoint` run over those buckets unchanged, on purpose: a bucket's p99
is an upper bound on its seconds, so no second over a threshold is missed, and
the breakpoint and the first 5xx land on the bucket holding them, at most one
bucket late. The tick counts then count buckets, so the baseline is 15 buckets
and a window needs 2 hot ones: a slowdown shorter than two buckets goes unnamed
while the breakpoint still marks it, and an error burst is a share of its
bucket's completions, diluted by the rest of the bucket (the completions floor
is per bucket too, so it only matters on a run quiet enough to complete under
20 requests a bucket). The Performance tab
says so in a note above the charts. The scraped server vitals are folded the
same way when a run scraped more than 2,000 (#2611, each series the bucket's
max); `joinMonitorToTimeline` needs nothing for it, because its staleness window
is derived from the samples' own spacing and so widens with the buckets, and the
Server vitals card carries its own note. A run of at most 2,000 ticks arrives raw and
behaves exactly as it always has; `utils/downsampled-series.test.ts` holds the
two paths to each other. The status chart rates each point per second over the
time it closes (`buildStatusOverTime`), so a bucket is not drawn
`ticksPerBucket` times taller than the second it stands for. Live, it reads
only the gate frames (`coversSecond`), the ticks the stored series is made of,
so it draws the points History will and never the second still open at the
edge; batched completions read flat but for one batch now and then (#2860).
A live window whose head is not at load start (a late attach, or a trimmed buffer)
drops its first point: with no predecessor to diff against, its count is the
run to date, not one interval's rate. The card's gate
(`hasStatusSeries`) counts the points that leave.
