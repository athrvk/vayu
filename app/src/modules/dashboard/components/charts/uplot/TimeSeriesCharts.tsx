/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Centralized time-series charts — the semantic wrappers every UI uses.
 *
 * Each takes the app's `LoadTestMetrics[]` (or a report) and renders through the
 * single `UPlotChart` primitive, so the live dashboard and the history view show
 * byte-identical charts. Pass a `syncKey` to correlate a stack of them under one
 * cursor; pass `breakpoint` to mark the W1 capacity elbow.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics } from "@/types";
import {
	buildLatencyChartData,
	buildPercentileChartData,
	type RampOverlay,
} from "../../../utils/metricsTransforms";
import type { Breakpoint } from "../../../utils/computeBreakpoint";
import { UPlotChart, type UPlotSeriesSpec, type Marker } from "./UPlotChart";
import {
	bucketColumns,
	pickThroughput,
	pickSendRate,
	pickConcurrency,
	pickErrorRate,
} from "./buildData";
import { axisMs, axisRate, axisPct, fmtMs, fmtRate, fmtCount, fmtPct } from "./formatters";

interface BaseProps {
	history: LoadTestMetrics[];
	isCompleted?: boolean;
	syncKey?: string;
	height?: number;
	breakpoint?: Breakpoint | null;
}

/** Vertical breakpoint marker (p99 crossed SLO), shared by the time-series charts. */
function breakpointMarker(breakpoint?: Breakpoint | null): Marker[] {
	if (!breakpoint?.crossed || breakpoint.timeSeconds == null) return [];
	return [
		{
			orient: "vertical",
			value: breakpoint.timeSeconds,
			role: "warning",
			label: breakpoint.p99Ms != null ? `SLO · ${Math.round(breakpoint.p99Ms)}ms` : "SLO",
		},
	];
}

/** Response-time percentiles over time — the canonical "latency vs time" chart. */
export function LatencyPercentilesChart({
	history,
	isCompleted,
	syncKey,
	height,
	breakpoint,
}: BaseProps) {
	const { data, series } = useMemo(() => {
		const d = buildPercentileChartData(history);
		const aligned: uPlot.AlignedData = [
			d.map((p) => p.time),
			d.map((p) => p.p50),
			d.map((p) => p.p95),
			d.map((p) => p.p99),
		];
		const spec: UPlotSeriesSpec[] = [
			{ label: "p50", role: "success", format: fmtMs },
			{ label: "p95", role: "warning", format: fmtMs },
			{ label: "p99", role: "destructive", width: 1.8, format: fmtMs },
		];
		return { data: aligned, series: spec };
	}, [history]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			height={height}
			yFormat={axisMs}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={breakpointMarker(breakpoint)}
		/>
	);
}

/** Latency breakdown: perceived latency vs wire time, with the queue-wait gap band. */
export function LatencyBreakdownChart({ history, isCompleted, syncKey, height }: BaseProps) {
	const { data, series } = useMemo(() => {
		const d = buildLatencyChartData(history);
		const aligned: uPlot.AlignedData = [
			d.map((p) => p.time),
			d.map((p) => p.latencyMs),
			d.map((p) => p.wireMs),
		];
		// Band between latency (idx 1) and wire (idx 2) = the generator queue-wait gap.
		const spec: UPlotSeriesSpec[] = [
			{
				label: "latency",
				role: "primary",
				width: 1.8,
				format: fmtMs,
				bandTo: 2,
				bandRole: "warning",
			},
			{ label: "wire", role: "info", format: fmtMs },
		];
		return { data: aligned, series: spec };
	}, [history]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			height={height}
			yFormat={axisMs}
			isLive={!isCompleted}
			syncKey={syncKey}
		/>
	);
}

/**
 * Request rate over time: throughput (received) + send rate (dispatched), with an
 * optional target reference line and an optional ramp_up concurrency overlay on a
 * secondary axis (configured vs achieved, with the lag band).
 */
export function RequestRateChart({
	history,
	isCompleted,
	syncKey,
	height,
	targetRps,
	rampOverlay,
	breakpoint,
}: BaseProps & { targetRps?: number; rampOverlay?: RampOverlay | null }) {
	const { data, series, hasRamp } = useMemo(() => {
		const { times, cols } = bucketColumns(history, [pickThroughput, pickSendRate]);
		const spec: UPlotSeriesSpec[] = [
			{ label: "throughput", role: "primary", kind: "area", width: 1.8, format: fmtRate },
			{ label: "send rate", role: "info", format: fmtRate },
		];
		const columns: number[][] = [cols[0], cols[1]];

		let ramp = false;
		if (rampOverlay && rampOverlay.points.length > 1) {
			ramp = true;
			const byTime = new Map<number, RampOverlay["points"][number]>(
				rampOverlay.points.map((p) => [p.time, p])
			);
			const configured = times.map((t) => byTime.get(t)?.configured ?? null);
			const achieved = times.map((t) => byTime.get(t)?.achieved ?? null);
			columns.push(configured as number[], achieved as number[]);
			spec.push(
				{
					label: "configured",
					role: "subtle",
					scale: "y2",
					dash: [4, 4],
					format: fmtCount,
					bandTo: 4,
					bandRole: "warning",
				},
				{ label: "achieved", role: "success", scale: "y2", width: 1.8, format: fmtCount }
			);
		}
		const aligned: uPlot.AlignedData = [times, ...columns];
		return { data: aligned, series: spec, hasRamp: ramp };
	}, [history, rampOverlay]);

	const markers = useMemo<Marker[]>(() => {
		const m: Marker[] = [];
		if (targetRps && targetRps > 0)
			m.push({
				orient: "horizontal",
				value: targetRps,
				role: "subtle",
				label: `target ${targetRps}`,
			});
		m.push(...breakpointMarker(breakpoint));
		return m;
	}, [targetRps, breakpoint]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			height={height}
			yFormat={axisRate}
			y2Format={(v) => `${Math.round(v)}`}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={markers}
			key={hasRamp ? "ramp" : "plain"}
		/>
	);
}

/** Active connections (in-flight) over time. */
export function ConnectionsChart({ history, isCompleted, syncKey, height, breakpoint }: BaseProps) {
	const data = useMemo<uPlot.AlignedData>(() => {
		const { times, cols } = bucketColumns(history, [pickConcurrency]);
		return [times, cols[0]];
	}, [history]);
	const series: UPlotSeriesSpec[] = [
		{ label: "connections", role: "info", kind: "area", format: fmtCount },
	];
	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			height={height}
			yFormat={(v) => `${Math.round(v)}`}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={breakpointMarker(breakpoint)}
		/>
	);
}

/** Error rate (%) over time. */
export function ErrorRateChart({ history, isCompleted, syncKey, height, breakpoint }: BaseProps) {
	const data = useMemo<uPlot.AlignedData>(() => {
		const { times, cols } = bucketColumns(history, [pickErrorRate]);
		return [times, cols[0]];
	}, [history]);
	const series: UPlotSeriesSpec[] = [
		{ label: "error rate", role: "destructive", kind: "area", format: fmtPct },
	];
	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			height={height ?? 160}
			yFormat={axisPct}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={breakpointMarker(breakpoint)}
		/>
	);
}
