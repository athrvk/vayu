/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Centralized time-series charts - the semantic wrappers every UI uses.
 *
 * Each takes the app's `LoadTestMetrics[]` (or a report) and renders through the
 * single `UPlotChart` primitive, so the live dashboard and the history view show
 * byte-identical charts. Pass a `syncKey` to correlate a stack of them under one
 * cursor; pass `breakpoint` to mark the W1 capacity elbow.
 */

import { formatLatency, formatNumber } from "@/lib/format-number";
import { useMemo } from "react";
import type uPlot from "uplot";
import type { LoadTestMetrics, MonitorSample } from "@/types";
import {
	buildLatencyChartData,
	buildPercentileChartData,
	type RampOverlay,
} from "../../../utils/metricsTransforms";
import type { Breakpoint } from "../../../utils/computeBreakpoint";
import type { Anomaly } from "../../../utils/detectAnomalies";
import type { HostSleep } from "@/stores/host-sleep-store";
import { runAnnotations } from "./annotations";
import { joinMonitorToTimeline } from "../../../utils/monitorSeries";
import { UPlotChart, type UPlotSeriesSpec, type Marker } from "./UPlotChart";
import { THROUGHPUT_LEGEND, LATENCY_LEGEND, PERCENTILE_LEGEND } from "./legend";
import {
	bucketColumns,
	rebucket,
	pickThroughput,
	pickSendRate,
	hasSendRate,
	type Sample,
	pickAvgInFlight,
	pickConcurrency,
	pickErrorRate,
} from "./buildData";
import {
	axisMs,
	axisRate,
	axisPct,
	axisVitals,
	fmtMs,
	fmtRate,
	fmtCount,
	fmtPct,
	fmtVitals,
} from "./formatters";
import {
	concurrencyMeasureLabel,
	formatConcurrency,
	isClosedLoopMode,
} from "@/constants/load-test-modes";
import { pluralize } from "../../../utils/format";
import { useClientSettingsStore } from "@/stores";

interface BaseProps {
	history: LoadTestMetrics[];
	isCompleted?: boolean;
	syncKey?: string;
	height?: number;
	breakpoint?: Breakpoint | null;
	/**
	 * Detected degradation windows, shaded on the time axis. Derived once by the
	 * view that owns the series (live dashboard / history detail) and passed down,
	 * so every chart in a synced stack shades the same windows.
	 */
	anomalies?: Anomaly[] | null;
	/**
	 * Intervals the host spent asleep under the run (#1357), marked on the same
	 * layer as the anomaly windows. Not derived from the series - the series is
	 * exactly what a suspend interrupts - so they arrive from the app's own
	 * record of the run rather than from a detector.
	 */
	sleeps?: readonly HostSleep[] | null;
}

/** The run's concurrency in the words its mode measures it in. */
function concurrencyPhrase(concurrency: number, mode?: string): string {
	if (isClosedLoopMode(mode)) return formatConcurrency(concurrency);
	return `${formatNumber(concurrency)} ${pluralize(concurrency, "request")} in flight`;
}

/** What the cursor learns on the breakpoint line: the p99 and the load at the crossing. */
function breakpointHover(breakpoint: Breakpoint, mode?: string): string | undefined {
	if (breakpoint.p99Ms == null) return undefined;
	const p99 = `p99 ${formatLatency(breakpoint.p99Ms)}`;
	if (breakpoint.concurrency == null) return p99;
	return `${p99} at ${concurrencyPhrase(breakpoint.concurrency, mode)}`;
}

/**
 * The vertical line where p99 first crossed the SLO, shared by the time-series
 * charts. A capacity elbow only means something on a ramp_up run, where load
 * rises under the line, so the other modes draw it on the percentile chart
 * alone; and a run whose first reading was already over the SLO never crossed
 * anything, which the horizontal SLO line on that chart says better.
 */
function breakpointMarker(
	breakpoint: Breakpoint | null | undefined,
	mode: string | undefined,
	onPercentileChart = false
): Marker[] {
	if (!breakpoint?.crossed || breakpoint.timeSeconds == null || breakpoint.atRunStart) return [];
	if (mode !== "ramp_up" && !onPercentileChart) return [];
	return [
		{
			orient: "vertical",
			value: breakpoint.timeSeconds,
			role: "warning",
			label:
				breakpoint.sloMs != null
					? `p99 > SLO ${formatLatency(breakpoint.sloMs)}`
					: "p99 > SLO",
			hover: breakpointHover(breakpoint, mode),
		},
	];
}

/** Response-time percentiles over time - the canonical "latency vs time" chart. */
export function LatencyPercentilesChart({
	history,
	isCompleted,
	syncKey,
	height,
	mode,
	breakpoint,
	anomalies,
	sleeps,
}: BaseProps & { mode?: string }) {
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const settingSloMs = useClientSettingsStore((s) => s.sloThresholdMs);
	// The SLO the breakpoint was judged against, so the line and the marker
	// agree even after the setting has changed; the setting where none was.
	const sloMs = breakpoint?.sloMs ?? settingSloMs;
	const markers = useMemo<Marker[]>(
		() => [
			{
				orient: "horizontal",
				value: sloMs,
				role: PERCENTILE_LEGEND.slo.role,
				label: `${PERCENTILE_LEGEND.slo.label} ${formatLatency(sloMs)}`,
			},
			...breakpointMarker(breakpoint, mode, true),
		],
		[sloMs, breakpoint, mode]
	);
	const annotations = useMemo(() => runAnnotations(anomalies, sleeps), [anomalies, sleeps]);
	const { data, series } = useMemo(() => {
		const d = buildPercentileChartData(history);
		const { times, cols } = rebucket(
			d.map((p) => p.time),
			[d.map((p) => p.p50), d.map((p) => p.p95), d.map((p) => p.p99)],
			bucketSeconds,
			"max"
		);
		const aligned: uPlot.AlignedData = [times, ...cols];
		const { p50, p95, p99 } = PERCENTILE_LEGEND;
		const spec: UPlotSeriesSpec[] = [
			{ label: p50.label, role: p50.role, format: fmtMs },
			{ label: p95.label, role: p95.role, format: fmtMs },
			{ label: p99.label, role: p99.role, width: 1.8, format: fmtMs },
		];
		return { data: aligned, series: spec };
	}, [history, bucketSeconds]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={axisMs}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={markers}
			annotations={annotations}
		/>
	);
}

/** Latency breakdown: average latency (queue wait included) vs wire time, with the queue-wait gap band. */
export function LatencyBreakdownChart({
	history,
	isCompleted,
	syncKey,
	height,
	anomalies,
	sleeps,
}: BaseProps) {
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const annotations = useMemo(() => runAnnotations(anomalies, sleeps), [anomalies, sleeps]);
	const { data, series } = useMemo(() => {
		const d = buildLatencyChartData(history);
		const { times, cols } = rebucket(
			d.map((p) => p.time),
			[d.map((p) => p.latencyMs), d.map((p) => p.wireMs)],
			bucketSeconds
		);
		const aligned: uPlot.AlignedData = [times, ...cols];
		// Band between average latency (idx 1) and wire time (idx 2) = the generator queue-wait gap.
		const { average, wire, queueWait } = LATENCY_LEGEND;
		const spec: UPlotSeriesSpec[] = [
			{
				label: average.label,
				role: average.role,
				width: 1.8,
				format: fmtMs,
				bandTo: 2,
				bandRole: queueWait.role,
			},
			{ label: wire.label, role: wire.role, format: fmtMs },
		];
		return { data: aligned, series: spec };
	}, [history, bucketSeconds]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={axisMs}
			isLive={!isCompleted}
			syncKey={syncKey}
			annotations={annotations}
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
	mode,
	breakpoint,
	anomalies,
	sleeps,
}: BaseProps & { targetRps?: number; rampOverlay?: RampOverlay | null; mode?: string }) {
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const annotations = useMemo(() => runAnnotations(anomalies, sleeps), [anomalies, sleeps]);
	const { data, series, hasRamp, hasSend } = useMemo(() => {
		// Decided over the whole data set, like `ramp` below: a run stored before
		// the trailing window existed has no per-tick send rate, and plotting its
		// cumulative `send_rate` under this label is the defect (#2393).
		const send = hasSendRate(history);
		const { times, cols } = bucketColumns(
			history,
			send ? [pickThroughput, pickSendRate] : [pickThroughput],
			bucketSeconds
		);
		const {
			throughput,
			sendRate,
			configured: configuredLine,
			achieved: achievedLine,
		} = THROUGHPUT_LEGEND;
		const spec: UPlotSeriesSpec[] = [
			{
				label: throughput.label,
				role: throughput.role,
				kind: "area",
				width: 1.8,
				format: fmtRate,
			},
		];
		if (send) spec.push({ label: sendRate.label, role: sendRate.role, format: fmtRate });
		const columns: Sample[][] = [...cols];

		// Decided from the run's own config (rampOverlay is non-null only for a
		// ramp_up run with a target concurrency, both known at run start), not
		// from how many buckets history has accumulated - `points.length` grows
		// from the caller's history one tick at a time, so gating on it here
		// flipped the series set (and the `key` below) partway through every
		// ramp-up run and force-remounted the chart (#1717).
		const ramp = rampOverlay != null;
		if (ramp) {
			const byTime = new Map<number, RampOverlay["points"][number]>(
				rampOverlay.points.map((p) => [p.time, p])
			);
			const configured = times.map((t) => byTime.get(t)?.configured ?? null);
			const achieved = times.map((t) => byTime.get(t)?.achieved ?? null);
			// The band closes on the achieved series, which sits two columns on.
			const achievedColumn = columns.length + 2;
			columns.push(configured, achieved);
			spec.push(
				{
					label: configuredLine.label,
					role: configuredLine.role,
					scale: "y2",
					dash: [4, 4],
					format: fmtCount,
					bandTo: achievedColumn,
					bandRole: "warning",
				},
				{
					label: achievedLine.label,
					role: achievedLine.role,
					scale: "y2",
					width: 1.8,
					format: fmtCount,
				}
			);
		}
		const aligned: uPlot.AlignedData = [times, ...columns];
		return { data: aligned, series: spec, hasRamp: ramp, hasSend: send };
	}, [history, rampOverlay, bucketSeconds]);

	const markers = useMemo<Marker[]>(() => {
		const m: Marker[] = [];
		if (targetRps && targetRps > 0)
			m.push({
				orient: "horizontal",
				value: targetRps,
				role: THROUGHPUT_LEGEND.target.role,
				label: `target ${targetRps} req/s`,
			});
		m.push(...breakpointMarker(breakpoint, mode));
		return m;
	}, [targetRps, breakpoint, mode]);

	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={axisRate}
			y2Format={(v) => `${Math.round(v)}`}
			y2Label={hasRamp ? concurrencyMeasureLabel(mode) : undefined}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={markers}
			annotations={annotations}
			key={`${hasRamp ? "ramp" : "plain"}-${hasSend ? "send" : "nosend"}`}
		/>
	);
}

/**
 * The run's concurrency over time: virtual users in a closed-loop mode,
 * requests in flight under Constant RPS, so the series is named for the `mode`
 * it measures.
 */
export function ConnectionsChart({
	mode,
	history,
	isCompleted,
	syncKey,
	height,
	breakpoint,
	anomalies,
	sleeps,
}: BaseProps & { mode?: string }) {
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const annotations = useMemo(() => runAnnotations(anomalies, sleeps), [anomalies, sleeps]);
	const data = useMemo<uPlot.AlignedData>(() => {
		const { times, cols } = bucketColumns(
			history,
			[mode === "constant_concurrency" ? pickAvgInFlight : pickConcurrency],
			bucketSeconds
		);
		return [times, cols[0]];
	}, [history, bucketSeconds, mode]);
	const series: UPlotSeriesSpec[] = [
		{ label: concurrencyMeasureLabel(mode), role: "info", kind: "area", format: fmtCount },
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
			markers={breakpointMarker(breakpoint, mode)}
			annotations={annotations}
		/>
	);
}

/** Error rate (%) over time. */
export function ErrorRateChart({
	history,
	isCompleted,
	syncKey,
	height,
	mode,
	breakpoint,
	anomalies,
	sleeps,
}: BaseProps & { mode?: string }) {
	const bucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const annotations = useMemo(() => runAnnotations(anomalies, sleeps), [anomalies, sleeps]);
	const data = useMemo<uPlot.AlignedData>(() => {
		const { times, cols } = bucketColumns(history, [pickErrorRate], bucketSeconds);
		return [times, cols[0]];
	}, [history, bucketSeconds]);
	const series: UPlotSeriesSpec[] = [
		{ label: "error rate", role: "destructive", kind: "area", format: fmtPct },
	];
	if (data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height ?? 160}
			yFormat={axisPct}
			isLive={!isCompleted}
			syncKey={syncKey}
			markers={breakpointMarker(breakpoint, mode)}
			annotations={annotations}
		/>
	);
}

/**
 * The categorical hues legible as a line on both grounds, in the order the
 * vitals overlay assigns them. A run names its own metrics, so a series gets a
 * colour by position - there is no semantic mapping to make. A run may name up
 * to eight metrics, so past four the cycle repeats; the tooltip names every
 * series, which is what keeps a repeated hue readable.
 */
const VITALS_ROLES: UPlotSeriesSpec["role"][] = [
	"categorical",
	"categorical-2",
	"categorical-3",
	"categorical-4",
];

/**
 * Server vitals scraped from the target during the run, on the run's own
 * timeline.
 *
 * Not bucketed like the charts above: those average a metric the engine emits
 * every tick, while these are point readings on the user's scrape cadence -
 * averaging two of them into a bucket would report a number the target never
 * exported. The resampling onto the tick x axis (and the gaps where a scrape
 * failed) is `joinMonitorToTimeline`'s, so this component only paints.
 *
 * Renders nothing when the run scraped nothing, which is what keeps the row out
 * of a dashboard for a run that configured no monitor.
 */
export function ServerVitalsChart({
	history,
	samples,
	isCompleted,
	syncKey,
	height,
	anomalies,
	sleeps,
}: BaseProps & { samples: MonitorSample[] }) {
	// The most useful place a degradation window can be shaded: this row is where
	// "the p99 spike at t=41" gets answered with what the server was doing then.
	const annotations = useMemo(() => runAnnotations(anomalies, sleeps), [anomalies, sleeps]);
	const { data, series } = useMemo(() => {
		const joined = joinMonitorToTimeline(history, samples);
		const aligned: uPlot.AlignedData = [
			joined.times,
			...joined.columns.map((col) => col as (number | null)[]),
		] as uPlot.AlignedData;
		const spec: UPlotSeriesSpec[] = joined.names.map((name, i) => ({
			label: name,
			role: VITALS_ROLES[i % VITALS_ROLES.length],
			width: 1.8,
			format: fmtVitals,
		}));
		return { data: aligned, series: spec };
	}, [history, samples]);

	if (series.length === 0 || data[0].length < 2) return null;
	return (
		<UPlotChart
			data={data}
			series={series}
			xTime
			height={height}
			yFormat={axisVitals}
			yMin={null}
			isLive={!isCompleted}
			syncKey={syncKey}
			annotations={annotations}
		/>
	);
}
