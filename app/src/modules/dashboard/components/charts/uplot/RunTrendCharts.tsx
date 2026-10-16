/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One metric across the runs of a request (#2165), on the shared uPlot
 * primitive: p95 latency, throughput and error rate, one point per run.
 *
 * The x axis is the run's position in the series (1 = oldest shown), not time:
 * runs are minutes or days apart, and a time axis would bunch a burst of runs
 * into one smear and strand the rest. The tooltip header is the run's start
 * time, so the position still says when. Hence no `syncKey`: the group's
 * cursor sync is by x value, and the three charts here already share an x.
 *
 * A run that did not record the metric is a gap, not a zero. Each series is
 * drawn twice - a line, and the same values as points - because a run is a
 * discrete sample: a lone point between two gaps would otherwise draw nothing.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import { formatInstant } from "@/lib/time-value";
import { formatErrorRate } from "@/components/shared/run-outcome";
import { UPlotChart, type Annotation, type Marker, type UPlotSeriesSpec } from "./UPlotChart";
import { axisMs, axisRate, fmtMs, fmtPct, fmtRate } from "./formatters";
import type { ColorRole } from "./uplotTheme";

/** One run of the series, oldest first. A metric the run did not record is `null`. */
export interface RunTrendPoint {
	/** Epoch milliseconds. */
	startTime: number;
	/** Ended early by the user: its window is shorter than a full run's. */
	stopped: boolean;
	/** The run the surrounding view is showing. */
	isOpen: boolean;
	p95Ms: number | null;
	rps: number | null;
	/** Percent, 0-100. */
	errorRate: number | null;
}

type TrendMetric = Exclude<keyof RunTrendPoint, "startTime" | "stopped" | "isOpen">;

interface RunTrendChartProps {
	points: RunTrendPoint[];
	height?: number;
}

/** The hover header: when the run started, and what is unusual about it. */
function runHeading(point: RunTrendPoint | undefined, position: number): string {
	if (!point) return `Run ${position}`;
	const notes = [point.stopped && "stopped", point.isOpen && "this run"].filter(Boolean);
	const when = formatInstant(point.startTime);
	return notes.length > 0 ? `${when} - ${notes.join(", ")}` : when;
}

function RunTrendChart({
	points,
	metric,
	label,
	seriesRole,
	format,
	yFormat,
	height,
}: RunTrendChartProps & {
	metric: TrendMetric;
	label: string;
	seriesRole: ColorRole;
	format: (v: number | null | undefined) => string;
	yFormat: (v: number) => string;
}) {
	const data = useMemo(() => {
		const values = points.map((p) => p[metric]);
		return [points.map((_, i) => i + 1), values, values] as uPlot.AlignedData;
	}, [points, metric]);

	// A stopped run is a dashed rule on its own x; the open run's rule carries the
	// label. The tooltip says the same in words, so colour is not the only cue.
	const annotations = useMemo<Annotation[]>(
		() =>
			points.flatMap((p, i) =>
				p.stopped
					? [{ startSeconds: i + 1, endSeconds: i + 1, label: "", role: "muted" }]
					: []
			),
		[points]
	);
	const markers = useMemo<Marker[]>(
		() =>
			points.flatMap((p, i) =>
				p.isOpen
					? [{ orient: "vertical", value: i + 1, label: "This run", role: "info" }]
					: []
			),
		[points]
	);

	const series: UPlotSeriesSpec[] = [
		{ label, role: seriesRole, width: 1.8, format },
		{ label, role: seriesRole, kind: "scatter", hideInTooltip: true },
	];

	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height ?? 160}
			xFormat={(v) => `${Math.round(v)}`}
			xTooltipFormat={(v) => runHeading(points[Math.round(v) - 1], Math.round(v))}
			yFormat={yFormat}
			annotations={annotations}
			markers={markers}
		/>
	);
}

export function RunP95TrendChart(props: RunTrendChartProps) {
	return (
		<RunTrendChart
			{...props}
			metric="p95Ms"
			label="p95 latency"
			seriesRole="warning"
			format={fmtMs}
			yFormat={axisMs}
		/>
	);
}

/** `categorical`, the role every throughput series in the app already uses. */
export function RunThroughputTrendChart(props: RunTrendChartProps) {
	return (
		<RunTrendChart
			{...props}
			metric="rps"
			label="throughput"
			seriesRole="categorical"
			format={fmtRate}
			yFormat={axisRate}
		/>
	);
}

/** Axis ticks keep the tooltip's decimal: an error rate of 0.2% is the interesting range. */
export function RunErrorRateTrendChart(props: RunTrendChartProps) {
	return (
		<RunTrendChart
			{...props}
			metric="errorRate"
			label="error rate"
			seriesRole="destructive"
			format={(v) => (v == null ? "-" : formatErrorRate(v))}
			yFormat={fmtPct}
		/>
	);
}
