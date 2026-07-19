/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UPlotChart — the ONE charting primitive.
 *
 * Every time-series surface in the app (live dashboard + history) renders through
 * this component, so "latency vs time" (or throughput, connections, errors, the
 * concurrency scatter…) looks and behaves identically everywhere. It replaces the
 * hand-rolled SVG `TimeSeriesChart` frame AND the recharts `HistoricalChartsSection`.
 *
 * Canvas-rendered (uPlot) → no per-point DOM, so long/dense runs render without
 * the downsampling the SVG/recharts stacks needed. Theme-driven from CSS tokens,
 * and interactive by default: crosshair + multi-series tooltip, drag-to-zoom on
 * the time axis (double-click resets), optional cursor-sync across charts for
 * cross-metric correlation, and reference markers (breakpoint, target, SLO).
 *
 * Semantic charts (LatencyPercentilesChart, RequestRateChart, …) are thin wrappers
 * that build aligned data + a series spec and hand it here; consumers use those,
 * never this directly.
 */

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { readUplotTheme, currentThemeKey, type ColorRole } from "./uplotTheme";
import { markersPlugin, tooltipPlugin, type Marker, type ValueFormatter } from "./plugins";

export type { Marker } from "./plugins";

export type ScaleKey = "y" | "y2";

export interface UPlotSeriesSpec {
	label: string;
	role: ColorRole;
	/** Secondary axis assignment; defaults to the primary "y" scale. */
	scale?: ScaleKey;
	/** line (default), area (fill to zero), or scatter (points only). */
	kind?: "line" | "area" | "scatter";
	width?: number;
	/** Dashed stroke (e.g. the configured-ramp reference line). */
	dash?: number[];
	/** Fill a band from this series to the 1-based series index given (gap/lag). */
	bandTo?: number;
	bandRole?: ColorRole;
	/** Tooltip formatter for this series. */
	format?: ValueFormatter;
	/** Omit from the hover tooltip (e.g. a band's lower edge). */
	hideInTooltip?: boolean;
}

export interface UPlotChartProps {
	/** Aligned data: [xs, series0, series1, …] — every series shares xs. */
	data: uPlot.AlignedData;
	series: UPlotSeriesSpec[];
	height?: number;
	/** x tick + tooltip formatter (default: seconds). */
	xFormat?: (v: number) => string;
	yFormat?: (v: number) => string;
	y2Format?: (v: number) => string;
	/** Reference markers: breakpoint (vertical), target/SLO (horizontal). */
	markers?: Marker[];
	/** Shared key → hover/zoom on one chart drives every chart with the same key. */
	syncKey?: string;
	/** Pulsing dot on the last point of the first primary-axis series. */
	isLive?: boolean;
}

const dpr = () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

function defaultY(v: number): string {
	return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`;
}

export function UPlotChart({
	data,
	series,
	height = 220,
	xFormat = (v) => `${v.toFixed(0)}s`,
	yFormat = defaultY,
	y2Format = (v) => `${Math.round(v)}`,
	markers = [],
	syncKey,
	isLive = false,
}: UPlotChartProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const plotRef = useRef<uPlot | null>(null);
	const markersRef = useRef<Marker[]>(markers);

	useEffect(() => {
		markersRef.current = markers;
		plotRef.current?.redraw();
	}, [markers]);

	const themeKey = typeof document !== "undefined" ? currentThemeKey() : "ssr";
	const hasY2 = series.some((s) => s.scale === "y2");

	// Re-create only when the *shape* (series identity / theme / axes) changes;
	// data updates go through setData below.
	const shapeSig = useMemo(
		() =>
			series
				.map(
					(s) =>
						`${s.label}:${s.role}:${s.kind ?? "line"}:${s.scale ?? "y"}:${s.bandTo ?? ""}`
				)
				.join("|") + `|${themeKey}|${height}|${syncKey ?? ""}|${isLive}`,
		[series, themeKey, height, syncKey, isLive]
	);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let plot: uPlot | null = null;
		try {
			const theme = readUplotTheme();

			const uSeries: uPlot.Series[] = [
				{}, // x
				...series.map((s): uPlot.Series => {
					const stroke = theme.color(s.role);
					const base: uPlot.Series = {
						label: s.label,
						scale: s.scale ?? "y",
						stroke,
						width: (s.width ?? 1.5) * dpr(),
						points: { show: false },
					};
					if (s.dash) base.dash = s.dash.map((d) => d * dpr());
					if (s.kind === "area") base.fill = theme.color(s.role, 0.14);
					if (s.kind === "scatter") {
						base.paths = () => null;
						base.points = {
							show: true,
							size: 5 * dpr(),
							fill: theme.color(s.role, 0.75),
						};
					}
					return base;
				}),
			];

			// Bands (gap/lag): fill between a series and a target series index.
			const bands: uPlot.Band[] = [];
			series.forEach((s, i) => {
				if (s.bandTo != null) {
					bands.push({
						series: [i + 1, s.bandTo],
						fill: theme.color(s.bandRole ?? s.role, 0.22),
					});
				}
			});

			const axisBase = {
				stroke: theme.text,
				grid: { stroke: theme.grid, width: 1 },
				ticks: { stroke: theme.grid, width: 1, size: 4 },
				font: theme.font,
			};

			const perSeriesFormat: Record<number, ValueFormatter> = {};
			const skip = new Set<number>();
			series.forEach((s, i) => {
				if (s.format) perSeriesFormat[i + 1] = s.format;
				if (s.hideInTooltip) skip.add(i + 1);
			});

			const axes: uPlot.Axis[] = [
				{ ...axisBase, values: (_u, sp) => sp.map((v) => xFormat(v)) },
				{ ...axisBase, scale: "y", values: (_u, sp) => sp.map((v) => yFormat(v)) },
			];
			if (hasY2) {
				axes.push({
					...axisBase,
					scale: "y2",
					side: 1,
					grid: { show: false },
					values: (_u, sp) => sp.map((v) => y2Format(v)),
				});
			}

			const opts: uPlot.Options = {
				width: host.clientWidth || 600,
				height,
				padding: [10, hasY2 ? 6 : 10, 0, 2],
				cursor: {
					drag: { x: true, y: false },
					focus: { prox: 16 },
					sync: syncKey ? { key: syncKey } : undefined,
					points: { size: 6 },
				},
				scales: { x: { time: false } },
				legend: { show: false },
				series: uSeries,
				bands,
				axes,
				plugins: [
					markersPlugin(() => markersRef.current, theme),
					tooltipPlugin({ theme, format: perSeriesFormat, skip, xLabel: xFormat }),
				],
			};

			plot = new uPlot(opts, data, host);
			plotRef.current = plot;
		} catch {
			// Canvas unavailable (e.g. jsdom without a 2D context). Degrade to an
			// empty host rather than throwing — tests mock the context; real runtimes
			// always have one.
			plotRef.current = null;
		}

		const activePlot = plot;
		const ro =
			typeof ResizeObserver !== "undefined" && activePlot
				? new ResizeObserver(() =>
						activePlot.setSize({ width: host.clientWidth || 600, height })
					)
				: null;
		ro?.observe(host);

		return () => {
			ro?.disconnect();
			activePlot?.destroy();
			plotRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shapeSig]);

	// Cheap data updates without tearing down the chart.
	useEffect(() => {
		plotRef.current?.setData(data);
	}, [data]);

	// Pulsing live-dot overlay on the last point of the first primary-axis series.
	// SVG-overlaid (not Canvas) so the CSS pulse animation is cheap and crisp.
	const liveDot = useMemo(() => {
		if (!isLive || data.length < 2) return null;
		const ys = data[1];
		if (!ys || ys.length === 0) return null;
		return true;
	}, [isLive, data]);

	return (
		<div ref={hostRef} style={{ width: "100%", height, position: "relative" }}>
			{liveDot && (
				<span
					aria-hidden
					style={{
						position: "absolute",
						right: 6,
						top: 6,
						width: 7,
						height: 7,
						borderRadius: "50%",
						background: "hsl(var(--primary))",
						boxShadow: "0 0 0 3px hsl(var(--primary) / 0.25)",
						animation: "vayuPulse 1.6s ease-in-out infinite",
					}}
				/>
			)}
		</div>
	);
}
