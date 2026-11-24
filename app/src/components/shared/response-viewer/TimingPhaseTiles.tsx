/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dense timing breakdown: a small tile per network phase, label over value, in an auto-fitting
 * grid. **Neutral tiles**: colour encodes the phase only in the chart-like renderers (the builder's
 * timeline, the dashboard's waterfall), and is decoration where the label is in the tile, costing
 * the raw-palette exception `docs/design-system/categorical-colors.md` kept open. `surface-card`,
 * not `bg-card` + `border-border`: the tiles sit on a `bg-muted/30` panel, and `--border` is
 * `--card`'s colour in dark, so the outline vanished; the surface class declares a `--rule` that
 * reads. **Script time is a tile, not a phase** (#3739): no network phase and never in a total, so
 * not in `TIMING_PHASES` (the waterfall and averages card would draw it as one), yet a step waiting
 * on its script has nowhere else to say so; a reported `0` is drawn, as "ran, took no time" is not
 * "unreported".
 */

import { InfoChip } from "@/components/ui";
import { cn } from "@/lib/utils";

import { SCRIPT_TIME_TIP, formatPhaseDuration, isReportedMs } from "./utils";
import type { MaybeResolvedTimingPhase, ResolvedTimingPhase } from "./timing-phases";

export interface TimingPhaseTilesProps {
	/** Usually from `phasesFromTrace()`. A phase with no value renders "-". */
	phases: readonly (ResolvedTimingPhase | MaybeResolvedTimingPhase)[];
	/**
	 * `trace.scriptMs` / `timing.scriptMs`, a "Scripts" tile after the phases when reported
	 * (`isReportedMs`: `0` draws, absent does not).
	 */
	scriptMs?: number;
	/** Smallest tile before the grid wraps to another row. */
	minTileWidth?: number;
	className?: string;
}

function TimingTile({
	label,
	tip,
	value,
}: {
	label: string;
	tip: string;
	value: number | undefined;
}) {
	// `formatPhaseDuration`, never `.toFixed(1)`: a 0.04ms DNS lookup is the only sign of a cached
	// lookup, which one decimal rounds to "0.0ms".
	const duration = value !== undefined ? formatPhaseDuration(value) : undefined;

	return (
		<div className="surface-card border border-rule rounded-md p-2 text-center">
			<p className="text-muted-foreground">
				{label}
				<InfoChip tip={tip} />
			</p>
			<p className="font-mono font-medium">
				{duration ? (
					<>
						{duration.value}
						{duration.unit}
					</>
				) : (
					<span className="text-subtle-foreground">-</span>
				)}
			</p>
		</div>
	);
}

export default function TimingPhaseTiles({
	phases,
	scriptMs,
	minTileWidth = 90,
	className,
}: TimingPhaseTilesProps) {
	const showScript = isReportedMs(scriptMs);
	if (phases.length === 0 && !showScript) return null;

	return (
		<div
			className={cn("grid gap-2 text-xs", className)}
			style={{
				gridTemplateColumns: `repeat(auto-fit, minmax(${minTileWidth}px, 1fr))`,
			}}
		>
			{phases.map((phase) => (
				<TimingTile
					key={phase.key}
					label={phase.label}
					tip={phase.tip}
					value={phase.value}
				/>
			))}
			{showScript && <TimingTile label="Scripts" tip={SCRIPT_TIME_TIP} value={scriptMs} />}
		</div>
	);
}
