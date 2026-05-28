# Plan 3: UI changes for latency accuracy + backpressure

## Context

Plans 1 and 2 add three new engine-side signals: `dropped_requests`, `queue_wait_ms`, and `ramp_lag`. They also introduce a user-configurable `maxInFlight` cap. This plan covers all user-facing changes — the dashboard renders, the run-config form, and the settings panel — so the engine work in Plans 1 and 2 actually surfaces in the product.

The decisions below were made through visual brainstorming. Each is captured here so implementation can follow the agreed design without re-deriving the choice.

---

## Design decisions (locked from brainstorming)

### 1. Dropped Requests hero card

When `dropped_requests > 0` **AND** the run is `mode === "constant_rps"` with a non-zero `targetRps`, the existing "Rate Fidelity" hero card is **replaced** by a "Dropped Requests" card. For all other runs and when drops = 0, Rate Fidelity stays as-is.

**Card content (matching the existing hero card aesthetic):**
- Eyebrow: `DROPPED REQUESTS` (with InfoChip tooltip explaining the cause chain)
- Big number: count of drops in red (`hsl(var(--destructive))`)
- Sub-line: `of {scheduled} scheduled · {pct}%` in monospace, subtle-foreground
- Hint line below in warning amber: **"Server saturating — try lowering target RPS"**
- Reuse the same card chrome as `RateFidelityCard` (`bg-card border border-border rounded-md p-4`)

**InfoChip tooltip text:**
> Requests the generator could not submit because its in-flight pool filled up. Root cause is usually slow server responses tying up curl handles. Lowering `targetRps` or raising `maxInFlight` (in Settings) defers drops in exchange for higher queue wait — but the server is still the bottleneck.

**Helper:** add `isRateLimitedRun(metrics, finalReport): boolean` next to MetricsView that returns `mode === "constant_rps" && targetRps > 0`. Use it for the conditional render.

### 2. Latency-over-time chart

A new chart card sits as a new row between the existing "Throughput over time" (Row 2) and the "HDR percentile plot + Avg request timing" pair (Row 3). It's visible whenever there is any per-tick latency history — i.e., for all four load strategies.

**Visual design** (mirrors the existing `ThroughputOverTimeChart` SVG pattern):
- Two lines + one shaded gap between them:
  - **Top line — "Latency"**: solid, `hsl(var(--primary))` (purple), stroke-width 1.8. Data = `avg_latency_ms` per tick (which after Plan 1 Change 2 IS perceived).
  - **Bottom line — "Wire"**: solid, `hsl(var(--info))` (cyan/blue), stroke-width 1.5. Data = `avg_latency_ms − avg_queue_wait_ms` per tick.
  - **Amber-shaded region between them = "Queue wait"**: `fill: hsl(var(--warning) / 0.25)`. The gap IS the queue wait — no separate line.
- Reuse the existing chart chrome: same `bg-card border border-border rounded-md p-3.5` container, same viewBox dimensions (1080×240), same dashed grid (`hsl(var(--border))` `stroke-dasharray="2 2"`), same monospace tick labels, same live-dot pulse at end of the Latency line.
- Header: title "Latency over time" + InfoChip; legend on the right with 🟪 Latency · 🟦 Wire · 🟧 Queue wait (gap).
- InfoChip text: "Per-tick latency over the run. The amber gap between Latency and Wire shows generator-side queue wait. When the gap grows, your generator is the bottleneck. Identity: latency = wire + queue wait."

**Empty/loading state:** if `queue_wait_ms` is missing from older runs (data from before the engine change), the gap doesn't render — the two lines collapse to one and the chart degrades cleanly to "Latency over time".

### 3. RampUp degradation overlay

For `mode === "ramp_up"` runs, the existing "Throughput over time" chart gains an overlay: two more lines on a right-side Y-axis showing configured vs achieved concurrency, with an amber lag area between them.

**Visual design:**
- Existing throughput + send-rate lines remain unchanged (left Y axis, RPS).
- **Add right Y-axis**: range 0 → target_concurrency, labeled at `x = VW - PR + 4`, `text-anchor="start"`, same monospace style as left labels.
- **Configured concurrency line**: dashed, `hsl(var(--subtle-foreground))`, `stroke-dasharray="4 4"`, stroke-width 1.5. Plotted against the right axis.
- **Achieved concurrency line**: solid, `hsl(var(--success))` (green), stroke-width 1.8. Plotted against the right axis.
- **Amber shaded region between configured and achieved**: `fill: hsl(var(--warning) / 0.25)` — this is the ramp lag area, mirrors the queue-wait gap in chart 2 above.
- Extend the legend with: configured (dashed swatch) · achieved (solid green swatch) · ramp lag (amber dot).

**Footer row addition** (below the chart, separated by the same dashed-border pattern used elsewhere): three monospace stats:
- `ramp lag {pct}%` — `ramp_lag / target_concurrency_integral × 100`
- `peak achieved {n} / target {m}` — peak achieved concurrency vs configured target
- `⚠ ramp degraded` (amber) — visible only when `ramp_lag_pct > 5%`

**Conditional render:** the right axis, both new lines, the amber region, and the new footer stats render only when `mode === "ramp_up"`. For other modes the existing chart is untouched.

### 4. `maxInFlight` settings entry

Per the user's decision, this knob lives in the **Settings panel** (extending existing UI), not in `LoadTestConfigDialog`. The run-config dialog stays clean for the 99% case; power users find the knob where engine tuning already lives.

**Placement:**
- New entry under the `general_engine` settings category (most natural fit alongside other scheduler-level knobs). If the implementation prefers `network_performance`, that's also acceptable — pick the category that has the most semantically related neighbours at implementation time.
- The entry follows the same shape as other engine settings: label + numeric input + helper text.
- The run config can still override the setting on a per-run basis via JSON (not via UI in this plan) — the dialog form does not gain a `maxInFlight` field.

**Helper text (final wording):**
> Hard cap on concurrent in-flight requests. Default scales with your RPS (typically `target_rps × 10`). Lower this to drop sooner when the server is slow; raise it to defer drops in exchange for higher queue wait. The server is still the bottleneck — this knob just controls how the generator absorbs that backpressure.

**Default behaviour:** if the setting is unset (user has never touched it), the engine falls back to the per-strategy derived default (already specified in Plan 2). The setting acts as a global override, not a hard requirement.

### 5. Drop card and Latency chart — coordinated visibility

To avoid double-warning: the Dropped Requests hero card and the Latency-over-time chart's amber gap will commonly co-occur, since drops happen *because* the queue is backing up (which is also what the gap shows). That's fine — they're not redundant:
- The **drop card** is a discrete count ("N requests never made it").
- The **chart gap** is a continuous-time view ("this is when and how much queue wait built up").
- They reinforce the same diagnosis from two angles.

No special coordination logic needed — both render based on their own data.

---

## Files to change

| File | Change |
|---|---|
| `app/src/modules/dashboard/components/MetricsView.tsx` | Add `DroppedRequestsCard` (replaces RateFidelityCard when conditions met); add `LatencyOverTimeChart` component as a new row between Row 2 and Row 3; extend `ThroughputOverTimeChart` to accept optional ramp-up overlay props (configured / achieved concurrency, ramp_lag); update footer stats row for RampUp |
| `app/src/modules/dashboard/components/MetricCard.tsx` | If new shared patterns emerge from the Dropped Requests card, factor them here (otherwise leave alone) |
| `app/src/modules/dashboard/types.ts` (or wherever `MetricsViewProps` lives) | Extend types for new fields: `dropped_requests`, `avg_queue_wait_ms`, `ramp_lag`, configured/achieved ramp concurrency |
| `app/src/types/domain.ts` | New optional fields: `dropped_requests`, `avg_queue_wait_ms`, `ramp_lag` |
| `app/src/services/sse-client.ts` | Map engine's camelCase (`droppedRequests`, `avgQueueWaitMs`, `rampLag`) → snake_case domain fields |
| `app/src/modules/settings/main/` | New settings panel for the `general_engine` (or `network_performance`) category that includes `maxInFlight`. Extend whatever existing panel matches |
| `app/src/modules/settings/sidebar/SettingsCategoryTree.tsx` | If a category needs to be re-labeled or a new entry added, update here |
| Existing tooltip / InfoChip pattern in MetricsView | Reuse for all new InfoChip explanations — no new tooltip primitive |

---

## Reused patterns

- **`InfoChip`** component in `MetricsView.tsx` — every new tooltip uses this. Tooltip body wording is in §1, §2, §3 above.
- **`ThroughputOverTimeChart`** SVG pattern — copy the viewBox/padding constants for `LatencyOverTimeChart`, then specialize. Same dashed grid, same monospace tick label style, same live-dot pulse.
- **`StatCard`** for any future supplementary stats (none in this plan, but available if implementation finds a need).
- **Card chrome:** `bg-card border border-border rounded-md p-{3.5|4}` — every new card uses this exact pattern.
- **Color tokens:** primary (latency / throughput), info (wire / send rate), warning (queue wait / ramp lag / destructive hint), success (achieved concurrency), destructive (dropped count), subtle-foreground (configured / dashed reference lines).

---

## Verification

### Visual regression (manual, in `pnpm run electron:dev`)
1. Run a ConstantRps test against a healthy mock server — Rate Fidelity card visible, no Dropped card, Latency-over-time chart shows flat gap near zero. RampUp overlay absent.
2. Run a ConstantRps test against a deliberately slow server (50ms delay, `targetRps=10000`, default `maxInFlight`) — Rate Fidelity card replaced by Dropped Requests card (red big number, amber hint), Latency-over-time chart shows growing amber gap.
3. Run a RampUp test (start=1, target=200, ramp=20s) against a slow server — Dropped card stays hidden, Latency chart shows amber gap, throughput chart now has dashed configured-concurrency line + green achieved line + amber lag area, and footer shows `ramp lag X%` and `peak {achieved} / target 200`.
4. Open Settings → `general_engine` (or `network_performance`) — see `Max in-flight requests` entry with helper text. Change it, start a new ConstantRps run, verify the engine respects the override (by setting it very low and watching drops increase).
5. Run an Iterations test against a slow server — no Dropped card (mode isn't constant_rps), no RampUp overlay, Latency-over-time chart still renders the wire/queue-wait split.

### Type and lint
6. `cd app && pnpm type-check && pnpm lint && pnpm format:check` — all clean.

### Component tests (where they exist)
7. Run `cd app && pnpm test` — any existing MetricsView tests must still pass; add new ones for `isRateLimitedRun()` and for the conditional render of the new card.

### Older runs (no Plan-1 engine data)
8. Open a historical run from before the engine change — Latency-over-time chart should degrade cleanly: no `queue_wait_ms` → no amber gap, just the Latency line (which means wire-time in that older data).
