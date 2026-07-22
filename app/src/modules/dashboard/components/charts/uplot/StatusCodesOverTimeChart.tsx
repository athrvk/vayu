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
		{ label: "2xx", role: "status-success", kind: "area", width: 0.75, format: fmtCount },
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
		},
		{
			label: "4xx",
			role: "status-client-error",
			width: 0.75,
			bandTo: 2,
			bandRole: "status-client-error",
			format: fmtCount,
		},
		{
			label: "5xx",
			role: "status-server-error",
			width: 0.75,
			bandTo: 3,
			bandRole: "status-server-error",
			format: fmtCount,
		},
		{
			label: "err",
			role: "status-no-response",
			width: 0.75,
			bandTo: 4,
			bandRole: "status-no-response",
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
