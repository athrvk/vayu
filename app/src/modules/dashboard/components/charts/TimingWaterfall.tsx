/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { InfoChip } from "../shared";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import { phaseColor, phasesFromAverages } from "@/components/shared/response-viewer/timing-phases";

/**
 * Timing waterfall - from report.timingBreakdown. Always renders 5 rows so the
 * card height stays constant; during live (no report yet) values show "-" and
 * bars are empty.
 *
 * The rows come from the shared `TIMING_PHASES` descriptor. They used to be a
 * local list, and being local is what let two defects sit here unseen:
 *
 *   - TTFB was painted `hsl(var(--primary))` and Download `hsl(var(--success))`.
 *     The request-builder's timing tab had the identical bug and fixed it -
 *     `--primary` follows the user's accent, so under the green scheme it lands
 *     on the same hue as `--success` and two of the five bars became one colour
 *     - but the fix could only reach the list it was written against. The guard
 *     that would have caught it (`charts/uplot/status-code-series.test.ts`)
 *     reads chart specs in `uplot/`, and this file is a directory above.
 *   - The five tooltip sentences were a private copy, longer than and drifting
 *     from `PHASE_TIPS`, whose whole purpose was to be the one copy.
 *
 * Values format through `formatPhaseDuration` rather than `.toFixed(0)`, which
 * rendered any sub-millisecond average as a flat "0".
 */
export function TimingWaterfall({ report }: { report: RunReport | null }) {
	const hasData = !!report?.timingBreakdown;
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
						<span className="text-[11px] text-muted-foreground">
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
						<span className="text-right font-mono tabular-nums text-[11px] font-medium">
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
			<div className="mt-2.5 pt-2.5 border-t border-dashed border-border flex justify-between text-[11px] text-muted-foreground">
				<span>Avg total</span>
				<span className="font-mono font-semibold">
					{hasData ? (
						<span className="text-foreground">{total.toFixed(0)} ms</span>
					) : (
						<span className="text-subtle-foreground">- ms</span>
					)}
				</span>
			</div>
		</>
	);
}
