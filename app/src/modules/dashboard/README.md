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

Five rules this module holds to. Each names the file that owns it - that file is
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
- **The per-mode stat-card table lives with its router.**
  `components/stats/ModeStatsRow.tsx` decides which four cards each mode shows,
  and its file comment tabulates them. Add a mode there, next to the branch that
  renders it.
