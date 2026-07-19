/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TimeSeriesUPlot — the SPIKE (N3) React wrapper around uPlot.
 *
 * This is the proposed single charting primitive to replace BOTH the hand-rolled
 * SVG charts and the recharts `HistoricalChartsSection`. It is Canvas-rendered
 * (no per-point DOM → no downsampling needed on long runs), theme-driven from CSS
 * tokens, and interactive by default: crosshair + multi-series tooltip, drag-to-
 * zoom on the time axis (double-click resets), optional cursor-sync across charts
 * for cross-metric correlation, and computed-insight annotations (e.g. the W1
 * capacity breakpoint).
 *
 * Lifecycle: create once on mount; `setData` on data change (cheap); `setSize`
 * via ResizeObserver; full re-create only when the theme flips or series identity
 * changes. Mirror of how the SVG `TimeSeriesChart` frame centralized scaffolding —
 * same goal, Canvas engine.
 */

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { readUplotTheme, currentThemeKey } from "./uplotTheme";
import { annotationsPlugin, tooltipPlugin, type Annotation, type ValueFormatter } from "./plugins";

export interface UplotSeriesDef {
	label: string;
	/** Semantic color role, resolved against the live theme. */
	role: "primary" | "success" | "warning" | "destructive" | "muted";
	/** Optional translucent area fill under the line. */
	fill?: "primary" | "destructive";
	width?: number;
	/** Tooltip formatter for this series' values. */
	format?: ValueFormatter;
}

export interface TimeSeriesUPlotProps {
	/** uPlot aligned data: [xs, series0, series1, …] (xs = elapsed seconds). */
	data: uPlot.AlignedData;
	series: UplotSeriesDef[];
	height?: number;
	/** y-axis tick formatter (defaults to ms/s like the SVG charts). */
	yFormat?: (v: number) => string;
	/** Vertical insight markers (breakpoint, ramp phases). */
	annotations?: Annotation[];
	/** Shared key → hovering/zooming one chart drives all charts with the same key. */
	syncKey?: string;
	/** When false, hides the pulsing "live" affordance (completed runs). */
	isLive?: boolean;
}

function defaultYFormat(v: number): string {
	return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`;
}

export function TimeSeriesUPlot({
	data,
	series,
	height = 220,
	yFormat = defaultYFormat,
	annotations = [],
	syncKey,
	isLive = false,
}: TimeSeriesUPlotProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const plotRef = useRef<uPlot | null>(null);
	// Latest annotations without forcing a chart re-create (read via closure in the
	// draw hook). Updated in an effect — never during render.
	const annoRef = useRef<Annotation[]>(annotations);

	useEffect(() => {
		annoRef.current = annotations;
		plotRef.current?.redraw();
	}, [annotations]);

	const themeKey = typeof document !== "undefined" ? currentThemeKey() : "ssr";

	// Re-create the chart only when the *shape* (series identity/theme) changes;
	// data updates go through setData below.
	const seriesSig = useMemo(
		() => series.map((s) => `${s.label}:${s.role}:${s.fill ?? ""}`).join("|"),
		[series]
	);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const theme = readUplotTheme();

		const uSeries: uPlot.Series[] = [
			{}, // x
			...series.map((s) => ({
				label: s.label,
				stroke: theme.series[s.role],
				width: (s.width ?? 1.5) * devicePixelRatio,
				fill: s.fill ? theme.fill[s.fill] : undefined,
				points: { show: false },
			})),
		];

		const axisBase: uPlot.Axis = {
			stroke: theme.text,
			grid: { stroke: theme.grid, width: 1 },
			ticks: { stroke: theme.grid, width: 1 },
			font: theme.font,
		};

		const perSeriesFormat: Record<number, ValueFormatter> = {};
		series.forEach((s, i) => {
			if (s.format) perSeriesFormat[i + 1] = s.format;
		});

		const opts: uPlot.Options = {
			width: host.clientWidth || 600,
			height,
			padding: [8, 8, 0, 0],
			cursor: {
				drag: { x: true, y: false }, // drag-to-zoom the time window
				focus: { prox: 16 },
				sync: syncKey ? { key: syncKey } : undefined,
				points: { size: 6 },
			},
			scales: { x: { time: false } },
			legend: { show: false },
			series: uSeries,
			axes: [
				{ ...axisBase, values: (_u, splits) => splits.map((v) => `${v.toFixed(0)}s`) },
				{ ...axisBase, values: (_u, splits) => splits.map((v) => yFormat(v)) },
			],
			plugins: [
				annotationsPlugin(() => annoRef.current),
				tooltipPlugin({ theme, format: perSeriesFormat }),
			],
		};

		const plot = new uPlot(opts, data, host);
		plotRef.current = plot;

		const ro = new ResizeObserver(() => {
			plot.setSize({ width: host.clientWidth || 600, height });
		});
		ro.observe(host);

		return () => {
			ro.disconnect();
			plot.destroy();
			plotRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [seriesSig, themeKey, height, syncKey, isLive]);

	// Cheap data updates without tearing down the chart.
	useEffect(() => {
		plotRef.current?.setData(data);
	}, [data]);

	return <div ref={hostRef} style={{ width: "100%", height }} />;
}
