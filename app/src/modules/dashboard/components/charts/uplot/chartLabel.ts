/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The text alternative of a chart (#3498). A canvas has no DOM for a screen
 * reader to walk, so `UPlotChart` takes a label and this builds it from the
 * series the chart already holds: per series, the latest reading and the
 * lowest and highest the chart shows.
 *
 * The figures go through each series' own `format`, so the sentence spells a
 * value the way the hover tooltip does ("2.27ms"), and `spokenSymbols` turns a
 * "<0.01" the formatter writes for a value that rounds to nothing into words.
 * A series the tooltip leaves out (a band's lower edge, the marker twin of a
 * line) is left out here too, and a stacked series reads its own values
 * (`tipValues`), not the running total it plots.
 */

import type uPlot from "uplot";
import { formatTrimmed } from "@/lib/format-number";
import { spokenSymbols } from "@/lib/spoken-text";
import type { UPlotSeriesSpec } from "./UPlotChart";

function plainFigure(value: number): string {
	return formatTrimmed(value, 2);
}

/** The readings a chart actually has, gaps dropped, in x order. */
function readings(values: ArrayLike<number | null | undefined>): number[] {
	return Array.from(values).filter(
		(v): v is number => typeof v === "number" && Number.isFinite(v)
	);
}

function describeSeries(spec: UPlotSeriesSpec, values: ArrayLike<number | null | undefined>) {
	const found = readings(values);
	if (found.length === 0) return null;
	const show = spec.format ?? plainFigure;
	// A reduce, not `Math.min(...found)`: a long run's series outgrows the argument limit.
	const lowest = found.reduce((a, b) => Math.min(a, b));
	const highest = found.reduce((a, b) => Math.max(a, b));
	return `${spec.label}: latest ${show(found[found.length - 1])}, lowest ${show(lowest)}, highest ${show(highest)}`;
}

/** `title`, then one clause per series that has a reading. A chart with none is just its title. */
export function describeChart(
	title: string,
	data: uPlot.AlignedData,
	series: readonly UPlotSeriesSpec[]
): string {
	const clauses = series.flatMap((spec, i) => {
		if (spec.hideInTooltip) return [];
		const clause = describeSeries(spec, spec.tipValues ?? data[i + 1] ?? []);
		return clause ? [clause] : [];
	});
	return spokenSymbols([title, ...clauses].join(". "));
}
