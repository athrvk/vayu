/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Status-class composition over time, as stacked areas, on the shared uPlot
 * primitive. Stacking is done by feeding cumulative sums and filling each class'
 * band between consecutive cumulative series (bottom 2xx fills to zero). The
 * tooltip prints each class' own rate (`tipValues`), not the stack height.
 * `buildStatusOverTime` buckets on whole seconds, where the other live charts
 * use half a second. A class with no responses in the history keeps its
 * zero-height band, so the `bandTo` indices hold, but draws no line (#2860).
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics } from "@/types";
import { buildStatusOverTime, stackStatusPoints } from "../../../utils/metricsTransforms";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";
import { axisRate, fmtRate } from "./formatters";

/**
 * What the tooltip's figures count; each carries its own "/s", the rate
 * `buildStatusOverTime` returns. `TOOLTIPS.statusCodesOverTime` says the same.
 */
const STATUS_TOOLTIP_CAPTION = "responses";

export function StatusCodesOverTimeChart({
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
	const { data, own, stroked } = useMemo(() => {
		const stack = stackStatusPoints(buildStatusOverTime(history));
		// Cumulative stack, bottom → top: 2xx, +3xx, +4xx, +5xx, +err.
		return {
			data: [stack.times, ...stack.stacked] as uPlot.AlignedData,
			own: stack.own,
			// An empty class' line would lie on the top of the stack in its own colour.
			stroked: stack.own.map((rates) => rates.some((r) => r > 0)),
		};
	}, [history]);

	// Each class = the band between its cumulative line and the one below it.
	const series: UPlotSeriesSpec[] = [
		{
			label: "2xx",
			role: "status-success",
			kind: "area",
			width: 0.75,
			format: fmtRate,
			tipValues: own[0],
			stroked: stroked[0],
		},
		/*
		 * The five series resolve through `constants/http-status.ts` now, so a
		 * colour means the same class here as on a response badge or a history
		 * tile. 3xx used `categorical` and a failed connection used `muted`, which
		 * were series slots rather than status colours: `categorical` is also p99,
		 * HDR latency, the latency breakdown and the throughput area, so the violet
		 * a user saw for 3xx taught them nothing, and `muted` made "nothing came
		 * back" read as de-emphasised rather than as its own outcome.
		 *
		 * Colour is the whole encoding in a stacked area chart, so two classes
		 * sharing one is a misread. These five are at least 0.144 apart in OKLab.
		 */
		{
			label: "3xx",
			role: "status-redirect",
			width: 0.75,
			bandTo: 1,
			bandRole: "status-redirect",
			format: fmtRate,
			tipValues: own[1],
			stroked: stroked[1],
		},
		{
			label: "4xx",
			role: "status-client-error",
			width: 0.75,
			bandTo: 2,
			bandRole: "status-client-error",
			format: fmtRate,
			tipValues: own[2],
			stroked: stroked[2],
		},
		{
			label: "5xx",
			role: "status-server-error",
			width: 0.75,
			bandTo: 3,
			bandRole: "status-server-error",
			format: fmtRate,
			tipValues: own[3],
			stroked: stroked[3],
		},
		{
			label: "err",
			role: "status-no-response",
			width: 0.75,
			bandTo: 4,
			bandRole: "status-no-response",
			format: fmtRate,
			tipValues: own[4],
			stroked: stroked[4],
		},
	];

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={axisRate}
			isLive={!isCompleted}
			tooltipCaption={STATUS_TOOLTIP_CAPTION}
			syncKey={syncKey}
		/>
	);
}
