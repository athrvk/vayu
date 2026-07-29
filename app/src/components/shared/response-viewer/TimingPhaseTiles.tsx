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
 * This is the shape both sampled-exchange views want - the dashboard's live
 * sample rows and the history card's stored ones - and it was implemented
 * twice. The two copies had diverged in every respect that matters to a reader:
 * the dashboard formatted through `formatPhaseDuration` and carried the
 * per-phase tooltips, while the history copy (`history/main/components/
 * TimingBreakdown.tsx`, now deleted) had the tooltips missing and painted each
 * tile with a raw Tailwind pastel.
 *
 * **The tiles are deliberately neutral.** Colour is an encoding in the two
 * chart-like renderers - the builder's timeline segments and the dashboard's
 * waterfall bars, where the bar's hue is how you tell the phases apart - and
 * decoration here, where the label is right there in the tile. Carrying a
 * per-phase hue in a grid of labelled boxes bought nothing and cost the raw
 * palette that `docs/design-system.md` had to keep an exception open for.
 *
 * `surface-card`, not `bg-card` + `border-border`: these tiles sit on a
 * `bg-muted/30` panel rather than on the canvas, and `--border` is the same
 * colour as `--card` in dark, so the outline was simply absent in one theme.
 * The surface class declares the `--rule` that reads on it.
 */

import { InfoChip } from "@/components/ui";
import { cn } from "@/lib/utils";

import { formatPhaseDuration } from "./utils";
import type { MaybeResolvedTimingPhase, ResolvedTimingPhase } from "./timing-phases";

export interface TimingPhaseTilesProps {
	/** Usually from `phasesFromTrace()`. A phase with no value renders "-". */
	phases: readonly (ResolvedTimingPhase | MaybeResolvedTimingPhase)[];
	/** Smallest tile before the grid wraps to another row. */
	minTileWidth?: number;
	className?: string;
}

export default function TimingPhaseTiles({
	phases,
	minTileWidth = 90,
	className,
}: TimingPhaseTilesProps) {
	if (phases.length === 0) return null;

	return (
		<div
			className={cn("grid gap-2 text-xs", className)}
			style={{
				gridTemplateColumns: `repeat(auto-fit, minmax(${minTileWidth}px, 1fr))`,
			}}
		>
			{phases.map((phase) => {
				// `formatPhaseDuration`, never a raw `.toFixed(1)`: a 0.04ms cached
				// DNS lookup is the only signal a cached lookup gives, and one
				// decimal place rounds it away to "0.0ms".
				const duration =
					phase.value !== undefined ? formatPhaseDuration(phase.value) : undefined;

				return (
					<div
						key={phase.key}
						className="surface-card border border-rule rounded-md p-2 text-center"
					>
						<p className="text-muted-foreground">
							{phase.label}
							<InfoChip tip={phase.tip} />
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
			})}
		</div>
	);
}
