/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatLatency } from "@/lib/format-number";
import type { RunReport } from "@/types";
import { InfoChip } from "../shared";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import {
	hasPhaseAverages,
	phaseColor,
	phasesFromAverages,
} from "@/components/shared/response-viewer/timing-phases";

/**
 * Timing waterfall, from report.timingBreakdown, which the live view fills from the latest gate
 * frame's phase means (`utils/liveDistributions.ts`). Always 5 rows so the card height stays
 * constant; with no report the values show "-" and the bars are empty.
 *
 * The rows come from the shared `TIMING_PHASES` descriptor: its fixed categorical hues, never
 * `--primary` (which follows the user's accent, and under the green scheme lands on `--success`'s
 * hue, making two of the five bars one colour), and `PHASE_TIPS`, the one copy of the tooltip
 * sentences. A local list drifts from both. The guard that would catch the colour
 * (`charts/uplot/status-code-series.test.ts`) reads only the chart specs in `uplot/`, a directory
 * below this file.
 *
 * Values format through `formatPhaseDuration`, not `.toFixed(0)`, which renders any sub-millisecond
 * average as a flat "0".
 *
 * `hasData` asks whether the *averages* are there, not whether `timingBreakdown` is: the object
 * also carries `phases` (percentiles over every completion, from the histogram bank), present for
 * runs that stored no traces at all, so testing the object would paint five empty bars and a
 * confident "0 ms" total for exactly those runs.
 */
export function TimingWaterfall({ report }: { report: Pick<RunReport, "timingBreakdown"> | null }) {
	const hasData = hasPhaseAverages(report?.timingBreakdown);
	const stages = phasesFromAverages(report?.timingBreakdown);

	const total = stages.reduce((s, x) => s + (x.value ?? 0), 0);
	const widthFor = (v: number | undefined) =>
		hasData && total > 0 ? `${((v ?? 0) / total) * 100}%` : "0%";

	return (
		<>
			{stages.map((stage) => {
				const duration =
					hasData && stage.value !== undefined
						? formatPhaseDuration(stage.value)
						: undefined;

				return (
					<div
						key={stage.key}
						className="grid grid-cols-[68px_1fr_70px] items-center gap-2.5 py-1"
					>
						<span className="text-label text-muted-foreground">
							{stage.label}
							<InfoChip tip={stage.tip} />
						</span>
						<div className="h-2 rounded-sm bg-accent overflow-hidden">
							<span
								className="block h-full transition-[width] duration-300"
								style={{
									width: widthFor(stage.value),
									background: phaseColor(stage),
								}}
							/>
						</div>
						<span className="text-right font-mono tabular-nums text-label font-medium">
							{duration ? (
								<>
									<span className="text-foreground">{duration.value}</span>
									<span className="text-subtle-foreground ml-0.5">
										{duration.unit}
									</span>
								</>
							) : (
								<span className="text-subtle-foreground">-</span>
							)}
						</span>
					</div>
				);
			})}
			<div className="mt-2.5 pt-2.5 border-t border-dashed border-rule flex justify-between text-label text-muted-foreground">
				<span>Avg total</span>
				<span className="font-mono font-semibold">
					{hasData ? (
						<span className="text-foreground">{formatLatency(total)}</span>
					) : (
						<span className="text-subtle-foreground">-</span>
					)}
				</span>
			</div>
		</>
	);
}
