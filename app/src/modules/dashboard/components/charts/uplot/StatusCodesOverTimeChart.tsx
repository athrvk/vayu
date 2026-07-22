/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Status-class composition over time, as stacked areas, on the shared uPlot
 * primitive. Stacking is done by feeding cumulative sums and filling each class'
 * band between consecutive cumulative series (bottom 2xx fills to zero).
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics } from "@/types";
import { buildStatusOverTime } from "../../../utils/metricsTransforms";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";
import { fmtCount } from "./formatters";

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
	const data = useMemo<uPlot.AlignedData>(() => {
		const d = buildStatusOverTime(history);
		const times = d.map((p) => p.time);
		// Cumulative stack, bottom → top: 2xx, +3xx, +4xx, +5xx, +err.
		const s0 = d.map((p) => p.c2xx);
		const s1 = d.map((p) => p.c2xx + p.c3xx);
		const s2 = d.map((p) => p.c2xx + p.c3xx + p.c4xx);
		const s3 = d.map((p) => p.c2xx + p.c3xx + p.c4xx + p.c5xx);
		const s4 = d.map((p) => p.c2xx + p.c3xx + p.c4xx + p.c5xx + p.cErr);
		return [times, s0, s1, s2, s3, s4];
	}, [history]);

	// Each class = the band between its cumulative line and the one below it.
	const series: UPlotSeriesSpec[] = [
		{ label: "2xx", role: "success", kind: "area", width: 0.75, format: fmtCount },
		/*
		 * 3xx was painted with `primary`, which is the user's chosen accent - so
		 * this series changed hue with the theme and could land on top of a
		 * neighbouring one. Measured as OKLab distance, the accent sits 0.050 from
		 * `--success` on the Forest theme and 0.037 from `--destructive` on Coral;
		 * anything under about 0.10 reads as the same colour. On Forest, 2xx and
		 * 3xx were the same green. On Coral, 3xx and 5xx were the same red.
		 *
		 * Colour is the whole encoding in a stacked area chart, so two series
		 * sharing one is a misread, not an aesthetic issue. `categorical` is fixed
		 * across themes and does not track the accent.
		 */
		{
			label: "3xx",
			role: "categorical",
			width: 0.75,
			bandTo: 1,
			bandRole: "categorical",
			format: fmtCount,
		},
		{
			label: "4xx",
			role: "warning",
			width: 0.75,
			bandTo: 2,
			bandRole: "warning",
			format: fmtCount,
		},
		{
			label: "5xx",
			role: "destructive",
			width: 0.75,
			bandTo: 3,
			bandRole: "destructive",
			format: fmtCount,
		},
		{
			label: "err",
			role: "muted",
			width: 0.75,
			bandTo: 4,
			bandRole: "muted",
			format: fmtCount,
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
			syncKey={syncKey}
		/>
	);
}
