/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Centralized non-time x-axis charts on the same uPlot primitive: the
 * response-time-vs-concurrency scatter (x = concurrency) and the HDR percentile
 * distribution (x = percentile). Both share the app's theming + tooltip + markers.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics, RunReport } from "@/types";
import { type Breakpoint } from "../../../utils/computeBreakpoint";
import { formatConcurrency } from "@/constants/load-test-modes";
import { useClientSettingsStore } from "@/stores";
import { UPlotChart, type UPlotSeriesSpec, type Marker } from "./UPlotChart";
import { SCATTER_LEGEND } from "./legend";
import { buildConcurrencyScatter } from "./buildData";
import { formatLatency } from "@/lib/format-number";
import { axisMs, fmtMs } from "./formatters";
import { hdrPercentileMarkers, pctToX } from "./hdrMarkers";

/**
 * Response time vs virtual users - a scatter of (virtual users, p99), one point per
 * chart bucket. The flat-left headroom, the elbow (breakpoint) and the
 * steep-right saturation read against the origin. Amber marker at the
 * SLO-crossing user count.
 */
export function ResponseTimeVsConcurrencyChart({
	history,
	height,
	breakpoint,
	syncKey,
}: {
	history: LoadTestMetrics[];
	height?: number;
	breakpoint?: Breakpoint | null;
	/** Join a chart group's focus channel - hovering a time chart highlights the
	 *  dot for that tick, and hovering a dot moves the time charts' cursor. */
	syncKey?: string;
}) {
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const { data, focusTimes } = useMemo(() => {
		// Bucketed to the same width as every other chart here, so a dot is a
		// bucket rather than a tick and the redraw cost stops following the
		// retention window. `times` keeps each point's moment for the focus
		// channel, which maps a dot ↔ the time charts' cursor.
		const { concurrency, p99, times } = buildConcurrencyScatter(history, bucketSeconds);
		return {
			data: [concurrency, p99] as uPlot.AlignedData,
			focusTimes: times,
		};
	}, [history, bucketSeconds]);

	const series: UPlotSeriesSpec[] = [
		{
			label: SCATTER_LEGEND.p99.label,
			role: SCATTER_LEGEND.p99.role,
			kind: "scatter",
			format: fmtMs,
		},
	];

	const sloMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const markers = useMemo<Marker[]>(() => {
		const m: Marker[] = [
			{
				orient: "horizontal",
				value: sloMs,
				role: SCATTER_LEGEND.slo.role,
				label: `SLO ${formatLatency(sloMs)}`,
			},
		];
		if (breakpoint?.crossed && breakpoint.concurrency != null) {
			m.push({
				orient: "vertical",
				value: breakpoint.concurrency,
				role: "warning",
				label: `~${formatConcurrency(breakpoint.concurrency)}`,
			});
		}
		return m;
	}, [breakpoint, sloMs]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			height={height}
			xFormat={(v) => `${Math.round(v)}`}
			yFormat={axisMs}
			isLive={false}
			markers={markers}
			syncKey={syncKey}
			xValueSync={false}
			focusTimes={focusTimes}
		/>
	);
}

const HDR_MARKS = [0, 50, 90, 95, 99, 99.9];
const HDR_SPLITS = HDR_MARKS.map(pctToX);

/** HDR percentile distribution - latency at each percentile, tail-weighted x. */
export function HdrPercentileChart({
	report,
	height,
	sloMs,
}: {
	/** A stored report, or the live view's adapter from the latest gate frame. */
	report: Pick<RunReport, "latency"> | null;
	height?: number;
	/** The SLO in ms. A p95/p99 marker takes a status colour only past it; omit it and none does. */
	sloMs?: number;
}) {
	const data = useMemo<uPlot.AlignedData | null>(() => {
		const lat = report?.latency;
		if (!lat) return null;
		const pts: Array<{ x: number; v: number }> = [];
		const push = (pct: number, v?: number) => {
			if (v != null && v >= 0) pts.push({ x: pctToX(pct), v });
		};
		push(0, lat.min);
		push(50, lat.p50);
		push(75, lat.p75);
		push(90, lat.p90);
		push(95, lat.p95);
		push(99, lat.p99);
		push(99.9, lat.p999);
		push(99.99, lat.max);
		if (pts.length < 3) return null;
		return [pts.map((p) => p.x), pts.map((p) => p.v)];
	}, [report]);

	const series: UPlotSeriesSpec[] = [
		{ label: "latency", role: "categorical", kind: "area", width: 1.8, format: fmtMs },
	];

	const markers = useMemo<Marker[]>(
		() => hdrPercentileMarkers(report?.latency, sloMs),
		[report, sloMs]
	);

	if (!data) return null;
	// The axis ticks at exactly HDR_SPLITS, so each tick is one mark's own position.
	const xTickLabel = (x: number) => `${HDR_MARKS.find((m) => pctToX(m) === x)}%`;

	return (
		<UPlotChart
			data={data}
			series={series}
			height={height ?? 200}
			xFormat={xTickLabel}
			xSplits={HDR_SPLITS}
			yFormat={axisMs}
			isLive={false}
			markers={markers}
		/>
	);
}
