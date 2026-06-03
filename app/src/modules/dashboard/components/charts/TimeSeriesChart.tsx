/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared frame for the full-width time-series line charts (B6 simplify). Draws
 * the identical scaffold every such chart had inline — dashed horizontal grid,
 * y-axis value labels, time-based x-axis labels (up to 8), and the pulsing
 * live-dot — and hands the series renderer `toX`/`toY` for the data space via a
 * render prop. The series (lines, area/gap fills) stay in the caller, drawn
 * between the y-labels and x-labels (preserving z-order); the live-dot is drawn
 * last. Used by Latency and Percentiles charts. Throughput keeps its own SVG —
 * its target line and secondary-axis ramp overlay (drawn after the live-dot)
 * don't fit this frame.
 */

import { type ReactNode } from "react";
import { projectY, TIME_SERIES_DIMS } from "../../utils/chartGeometry";

/** Default y-axis tick label: seconds past 1000ms, whole ms below. */
function defaultYLabel(v: number): string {
	return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`;
}

export interface TimeSeriesHelpers {
	toX: (i: number) => number;
	toY: (v: number) => number;
}

export function TimeSeriesChart({
	times,
	yMax,
	yLabel = defaultYLabel,
	liveDot,
	children,
}: {
	/** Elapsed-seconds for each data point; its length drives x-scaling + labels. */
	times: number[];
	yMax: number;
	yLabel?: (v: number) => string;
	/** Pulsing dot at the last point; omit (undefined) when the run is complete. */
	liveDot?: { value: number; color: string };
	children: (h: TimeSeriesHelpers) => ReactNode;
}) {
	const { VW, VH, PL, PR, PT, PB } = TIME_SERIES_DIMS;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;
	const n = times.length;

	const toX = (i: number) => PL + (i / (n - 1)) * IW;
	const toY = (v: number) => projectY(v, yMax, PT, IH);

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = yMax * f;
		return { y: toY(v), label: yLabel(v) };
	});

	const xCount = Math.min(8, n);
	const xStride = Math.max(1, Math.floor((n - 1) / (xCount - 1)));
	const xLabels: Array<{ x: number; label: string }> = [];
	for (let i = 0; i < n; i += xStride) {
		xLabels.push({ x: toX(i), label: `${times[i].toFixed(1)}s` });
	}
	const lastIdx = n - 1;
	if (xLabels[xLabels.length - 1]?.label !== `${times[lastIdx].toFixed(1)}s`) {
		xLabels.push({ x: toX(lastIdx), label: `${times[lastIdx].toFixed(1)}s` });
	}

	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 220, display: "block" }}>
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t, i) => (
					<line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>
			<g fill="hsl(var(--subtle-foreground))" fontSize="10" fontFamily="JetBrains Mono">
				{yTicks.map((t, i) => (
					<text key={i} x={PL - 6} y={t.y + 3.5} textAnchor="end">
						{t.label}
					</text>
				))}
			</g>

			{children({ toX, toY })}

			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="10"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{xLabels.map((t, i) => (
					<text key={i} x={t.x} y={VH - 8}>
						{t.label}
					</text>
				))}
			</g>

			{liveDot && (
				<circle cx={toX(lastIdx)} cy={toY(liveDot.value)} r={3.5} fill={liveDot.color}>
					<animate
						attributeName="opacity"
						values="1;0.3;1"
						dur="1.6s"
						repeatCount="indefinite"
					/>
				</circle>
			)}
		</svg>
	);
}
