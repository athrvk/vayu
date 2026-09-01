# Dashboard Module

**Location:** Main content area only

This module displays real-time load test metrics and results.

## Structure

- `index.tsx` - Main LoadTestDashboard component (entry point)
- `components/` - Sub-components (DashboardHeader, MetricsView, etc.)
- `hooks/` - Dashboard-scoped hooks (`useMode`)
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
  inline. Nothing outside the file locks the wording - no test pins a string and
  no document restates it - so `tooltips.tsx` is where wording is decided, and
  editing an entry there updates every card that shows it.
- **No chart geometry constants in component files.** `utils/chartGeometry.ts`
  owns `TIME_SERIES_DIMS` and `HDR_DIMS`. The full-width time-series charts must
  stay dimensionally identical or the dashboard rows stop lining up, and the HDR
  plot must match its own skeleton or the card shifts height when the final
  report arrives.
- **The mode mapping lives in exactly one place.** `hooks/useMode.ts` is the only
  interpreter of the freeform engine `mode` string. Mode-adaptive components take
  the discriminator from it instead of re-parsing the raw value, and the mode
  vocabulary is derived from `LOAD_TEST_MODES` rather than hand-listed.
- **No card re-derives from raw metrics.** `components/MetricsView.tsx` computes
  one memoized `DashboardDerived` bundle (shape in `types.ts`) and passes it to
  `HeroRow` and `ModeStatsRow`, which stay pure presentational components that
  read what they need.
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
  `components/stats/ModeStatsRow.tsx` decides which four cards each mode shows,
  and its file comment tabulates them. Add a mode there, next to the branch that
  renders it.

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
