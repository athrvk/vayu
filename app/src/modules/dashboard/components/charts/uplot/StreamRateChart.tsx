/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A streaming load run's events per second on the run's own timeline (issue
 * #3236) - the live view's counterpart of the stream card's number, so a rate
 * that sags mid-run is a line the reader sees rather than a figure that moved.
 *
 * One series, so no legend; the card's title names it. Plotted from the tick's
 * trailing-window rate (`pickEventsPerSecond`), never the run-cumulative total.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics } from "@/types";
import { useClientSettingsStore } from "@/stores";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";
import { bucketColumns, pickEventsPerSecond } from "./buildData";
import { axisRate, fmtRate } from "./formatters";

const STREAM_RATE_SERIES: UPlotSeriesSpec = {
	label: "events/sec",
	// `categorical-2`, not `primary`/`accent`/`chart-1`: those track the user's
	// accent and collide with a semantic series.
	role: "categorical-2",
	kind: "area",
	width: 1.8,
	format: fmtRate,
};

export function StreamRateChart({
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
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const data = useMemo<uPlot.AlignedData>(() => {
		const { times, cols } = bucketColumns(history, [pickEventsPerSecond], bucketSeconds);
		return [times, cols[0]];
	}, [history, bucketSeconds]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={[STREAM_RATE_SERIES]}
			xTime
			height={height}
			yFormat={axisRate}
			isLive={!isCompleted}
			syncKey={syncKey}
		/>
	);
}
