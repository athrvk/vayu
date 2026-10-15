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
 * tooltip prints each class' own count (`tipValues`), not the stack height.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics } from "@/types";
import { buildStatusOverTime, stackStatusPoints } from "../../../utils/metricsTransforms";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";
import { fmtCount } from "./formatters";

/** The bucket `buildStatusOverTime` counts into; `TOOLTIPS.statusCodesOverTime` says the same. */
const STATUS_TOOLTIP_UNIT = "responses / 0.5 s";

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
	const { data, own } = useMemo(() => {
		const stack = stackStatusPoints(buildStatusOverTime(history));
		// Cumulative stack, bottom → top: 2xx, +3xx, +4xx, +5xx, +err.
		return {
			data: [stack.times, ...stack.stacked] as uPlot.AlignedData,
			own: stack.own,
		};
	}, [history]);

	// Each class = the band between its cumulative line and the one below it.
	const series: UPlotSeriesSpec[] = [
		{
			label: "2xx",
			role: "status-success",
			kind: "area",
			width: 0.75,
			format: fmtCount,
			tipValues: own[0],
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
			format: fmtCount,
			tipValues: own[1],
		},
		{
			label: "4xx",
			role: "status-client-error",
			width: 0.75,
			bandTo: 2,
			bandRole: "status-client-error",
			format: fmtCount,
			tipValues: own[2],
		},
		{
			label: "5xx",
			role: "status-server-error",
			width: 0.75,
			bandTo: 3,
			bandRole: "status-server-error",
			format: fmtCount,
			tipValues: own[3],
		},
		{
			label: "err",
			role: "status-no-response",
			width: 0.75,
			bandTo: 4,
			bandRole: "status-no-response",
			format: fmtCount,
			tipValues: own[4],
		},
	];

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={(v) => `${Math.round(v)}`}
			isLive={!isCompleted}
			tooltipCaption={STATUS_TOOLTIP_UNIT}
			syncKey={syncKey}
		/>
	);
}
