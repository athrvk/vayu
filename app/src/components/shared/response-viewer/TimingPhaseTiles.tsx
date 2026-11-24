/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dense timing breakdown: one small tile per network phase, label over
 * value, wrapped in an auto-fitting grid.
 *
 * **The tiles are deliberately neutral.** Colour is an encoding in the two
 * chart-like renderers - the builder's timeline segments and the dashboard's
 * waterfall bars, where the bar's hue is how you tell the phases apart - and
 * decoration here, where the label is right there in the tile. Carrying a
 * per-phase hue in a grid of labelled boxes bought nothing and cost the raw
 * palette that `docs/design-system/categorical-colors.md` had to keep an exception open for.
 *
 * `surface-card`, not `bg-card` + `border-border`: these tiles sit on a
 * `bg-muted/30` panel rather than on the canvas, and `--border` is the same
 * colour as `--card` in dark, so the outline was simply absent in one theme.
 * The surface class declares the `--rule` that reads on it.
 *
 * **Script time is a tile here and not a phase** (#3739). It is no network phase
 * and never part of a total, so it is not in `TIMING_PHASES` (the waterfall and
 * the averages card would draw it as one); a step that waited on its script has
 * no other place to say so, and a reported `0` is drawn, because "ran, took no
 * time" is not "unreported".
 */

import { InfoChip } from "@/components/ui";
import { cn } from "@/lib/utils";

import { SCRIPT_TIME_TIP, formatPhaseDuration, isReportedMs } from "./utils";
import type { MaybeResolvedTimingPhase, ResolvedTimingPhase } from "./timing-phases";

export interface TimingPhaseTilesProps {
	/** Usually from `phasesFromTrace()`. A phase with no value renders "-". */
	phases: readonly (ResolvedTimingPhase | MaybeResolvedTimingPhase)[];
	/**
	 * `trace.scriptMs` / `timing.scriptMs`: drawn as a "Scripts" tile after the
	 * phases when reported (`isReportedMs`, so `0` draws and absent does not).
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
	// `formatPhaseDuration`, never a raw `.toFixed(1)`: a 0.04ms cached
	// DNS lookup is the only signal a cached lookup gives, and one
	// decimal place rounds it away to "0.0ms".
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
