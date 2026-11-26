/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's custom trends, counters and rates (`metric.record` / `pm.metrics`) on the run's own
 * timeline (issue #1579), the live/history sibling of `CustomMetricsSummary`'s static end-of-run
 * card. One generic chart, not one card per metric type, as `ServerVitalsChart` answers the same
 * question (a run names its own metrics, with no semantic mapping to make): a small categorical
 * palette cycled across the declared names.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics } from "@/types";
import {
	buildCustomMetricsOverTime,
	customMetricSeriesLabel,
} from "../../../utils/metricsTransforms";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";
import { describeChart } from "./chartLabel";
import { fmtVitals, axisVitals } from "./formatters";

/**
 * The categorical hues legible as a line on both grounds, in assignment order, the set and reason
 * `ServerVitalsChart` cycles: a series gets a colour by position, and up to 32 declared names
 * repeat the cycle well past four, which the tooltip keeps readable by naming every series.
 */
const CUSTOM_METRIC_ROLES: UPlotSeriesSpec["role"][] = [
	"categorical",
	"categorical-2",
	"categorical-3",
	"categorical-4",
];

export function CustomMetricsChart({
	history,
	isCompleted,
	syncKey,
	height,
}: {
	history: LoadTestMetrics[];
	isCompleted?: boolean;
	syncKey?: string;
	height?: number;
}) {
	const { data, series } = useMemo(() => {
		const built = buildCustomMetricsOverTime(history);
		const aligned: uPlot.AlignedData = [built.times, ...built.columns] as uPlot.AlignedData;
		const spec: UPlotSeriesSpec[] = built.names.map((name, i) => ({
			label: customMetricSeriesLabel(name, built.types[i]),
			role: CUSTOM_METRIC_ROLES[i % CUSTOM_METRIC_ROLES.length],
			width: 1.8,
			format: fmtVitals,
		}));
		return { data: aligned, series: spec };
	}, [history]);

	// Absent when the run recorded no custom metric - not an empty plot frame -
	// same guard shape as `ServerVitalsChart`'s "the run scraped nothing" case.
	if (series.length === 0 || data[0].length < 2) return null;
	return (
		<UPlotChart
			ariaLabel={describeChart("Custom metrics over time", data, series)}
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={axisVitals}
			yMin={null}
			isLive={!isCompleted}
			syncKey={syncKey}
		/>
	);
}
