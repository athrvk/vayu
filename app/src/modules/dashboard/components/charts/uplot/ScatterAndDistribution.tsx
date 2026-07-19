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
import { useClientSettingsStore } from "@/stores";
import { UPlotChart, type UPlotSeriesSpec, type Marker } from "./UPlotChart";
import { pickConcurrency } from "./buildData";
import { axisMs, fmtMs } from "./formatters";

/**
 * Response time vs concurrency — a scatter of per-tick (concurrency, p99). The
 * flat-left headroom, the elbow (breakpoint) and the steep-right saturation read
 * against the origin. Amber marker at the SLO-crossing concurrency.
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
	/** Join a chart group's focus channel — hovering a time chart highlights the
	 *  dot for that tick, and hovering a dot moves the time charts' cursor. */
	syncKey?: string;
}) {
	const { data, focusTimes } = useMemo(() => {
		// uPlot needs x ascending; concurrency rises over a ramp, but sort to be safe.
		// Keep each point's timestamp aligned to the sorted order so the focus
		// channel can map a dot ↔ a moment in time.
		const pts = history
			.map((m) => ({
				c: pickConcurrency(m),
				p99: m.latency_p99_ms ?? 0,
				t: m.elapsed_seconds,
			}))
			.sort((a, b) => a.c - b.c);
		return {
			data: [pts.map((p) => p.c), pts.map((p) => p.p99)] as uPlot.AlignedData,
			focusTimes: pts.map((p) => p.t),
		};
	}, [history]);

	const series: UPlotSeriesSpec[] = [
		{ label: "p99", role: "primary", kind: "scatter", format: fmtMs },
	];

	const sloMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const markers = useMemo<Marker[]>(() => {
		const m: Marker[] = [
			{
				orient: "horizontal",
				value: sloMs,
				role: "subtle",
				label: `SLO ${sloMs}ms`,
			},
		];
		if (breakpoint?.crossed && breakpoint.concurrency != null) {
			m.push({
				orient: "vertical",
				value: breakpoint.concurrency,
				role: "warning",
				label: `~${breakpoint.concurrency} conc`,
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

/** Log-scale percentile → 0..1 x position (tail dominates), mirroring the old plot. */
function pctToX(pct: number): number {
	const p = Math.min(99.99, Math.max(0, pct));
	if (p === 0) return 0;
	return Math.log10(1 / (1 - p / 100)) / Math.log10(1 / (1 - 99.99 / 100));
}

const HDR_MARKS = [0, 50, 90, 95, 99, 99.9];

/** HDR percentile distribution — latency at each percentile, tail-weighted x. */
export function HdrPercentileChart({
	report,
	height,
}: {
	report: RunReport | null;
	height?: number;
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
		{ label: "latency", role: "primary", kind: "area", width: 1.8, format: fmtMs },
	];

	const markers = useMemo<Marker[]>(() => {
		const lat = report?.latency;
		if (!lat) return [];
		const out: Marker[] = [];
		if (lat.p50 != null)
			out.push({ orient: "vertical", value: pctToX(50), role: "success", label: "p50" });
		if (lat.p95 != null)
			out.push({ orient: "vertical", value: pctToX(95), role: "warning", label: "p95" });
		if (lat.p99 != null)
			out.push({ orient: "vertical", value: pctToX(99), role: "destructive", label: "p99" });
		return out;
	}, [report]);

	if (!data) return null;
	const xTickLabel = (x: number) => {
		// Map an x position back to the nearest labeled percentile for readability.
		const nearest = HDR_MARKS.reduce((a, b) =>
			Math.abs(pctToX(b) - x) < Math.abs(pctToX(a) - x) ? b : a
		);
		return `${nearest}%`;
	};

	return (
		<UPlotChart
			data={data}
			series={series}
			height={height ?? 200}
			xFormat={xTickLabel}
			yFormat={axisMs}
			isLive={false}
			markers={markers}
		/>
	);
}
