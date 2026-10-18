/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The key above a chart card, built from the roles its series are drawn with.
 *
 * A swatch resolves through `ROLE_TOKEN`, the table the canvas resolves its
 * strokes through, so a legend cannot disagree with its chart. A hand-written
 * `hsl(var(--x))` here is what #2311 removed: thirteen of them had drifted
 * from the roles the series used.
 */

import { BAND_FILL_ALPHA } from "./uplot/UPlotChart";
import type { LegendEntry, LegendShape } from "./uplot/legend";
import { ROLE_TOKEN } from "./uplot/uplotTheme";

const SWATCH_CLASS: Record<LegendShape, string> = {
	line: "inline-block w-2.5 h-0.5 mr-1.5 align-middle",
	dot: "inline-block w-2 h-2 mr-1.5 rounded-full align-middle",
	band: "inline-block w-2.5 h-2 mr-1.5 align-middle rounded-sm",
};

function swatchColor({ role, shape }: LegendEntry): string {
	const token = `var(${ROLE_TOKEN[role]})`;
	return shape === "band" ? `hsl(${token} / ${BAND_FILL_ALPHA})` : `hsl(${token})`;
}

export function ChartLegend({ entries }: { entries: readonly LegendEntry[] }) {
	return (
		<div className="flex gap-3.5 text-label font-mono text-muted-foreground">
			{entries.map((entry) => (
				<span key={entry.label} data-legend-role={entry.role}>
					<span
						className={SWATCH_CLASS[entry.shape]}
						style={{ background: swatchColor(entry) }}
					/>
					{entry.label}
				</span>
			))}
		</div>
	);
}
