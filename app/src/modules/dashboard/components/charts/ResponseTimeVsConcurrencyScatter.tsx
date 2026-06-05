/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo } from "react";
import type { LoadTestMetrics } from "@/types";
import { niceYMax, projectY, TIME_SERIES_DIMS } from "../../utils/chartGeometry";
import { computeBreakpoint, DEFAULT_SLO_MS } from "../../utils/computeBreakpoint";

/** One scatter dot: the concurrency in flight and the p99 latency at one tick. */
export interface ScatterPoint {
	concurrency: number;
	p99: number;
}

/**
 * Response time vs concurrency — a scatter of per-tick (concurrency, p99) for
 * ramp_up runs. X is value-scaled by concurrency (anchored at 0) so the flat-left
 * headroom region, the elbow (breakpoint), and the steep-right saturation region
 * read against the origin. An amber vertical line marks where p99 first crossed
 * the SLO. Shares TIME_SERIES_DIMS geometry/tokens with the time-series charts.
 */
export function ResponseTimeVsConcurrencyScatter({
	data,
	isCompleted,
}: {
	data: LoadTestMetrics[];
	isCompleted: boolean;
}) {
	const points: ScatterPoint[] = useMemo(
		() => data.map((m) => ({ concurrency: m.current_concurrency, p99: m.latency_p99_ms ?? 0 })),
		[data]
	);
	// Full history (not a sliced window) so the first SLO crossing isn't dropped
	// on long runs — keeps this line aligned with the Saturation card / Breakpoint stat.
	const breakpoint = useMemo(() => computeBreakpoint(data), [data]);

	if (points.length < 2) return null;

	const { VW, VH, PL, PR, PT, PB } = TIME_SERIES_DIMS;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;

	const xMax = niceYMax(
		points.map((p) => p.concurrency),
		{ floor: 1, headroom: 1.15 }
	);
	const yMax = niceYMax(
		points.map((p) => p.p99),
		{ floor: 1, headroom: 1.15 }
	);

	const toX = (c: number) => PL + (xMax <= 0 ? 0 : (c / xMax) * IW);
	const toY = (v: number) => projectY(v, yMax, PT, IH);

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = yMax * f;
		return { y: toY(v), label: v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}` };
	});

	const xTicks = [0, 0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = xMax * f;
		return { x: toX(v), label: `${Math.round(v)}` };
	});

	const last = points[points.length - 1];

	// Amber vertical line at the breakpoint concurrency (only once crossed).
	const bpX =
		breakpoint.crossed && breakpoint.concurrency !== null ? toX(breakpoint.concurrency) : null;
	// Inset the label so it doesn't clip the right edge when the crossing is near peak.
	const bpLabelRight = bpX !== null && bpX > VW - PR - 96;

	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 220, display: "block" }}>
			{/* horizontal grid */}
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t, i) => (
					<line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>

			{/* y labels (p99 ms) */}
			<g fill="hsl(var(--subtle-foreground))" fontSize="10" fontFamily="JetBrains Mono">
				{yTicks.map((t, i) => (
					<text key={i} x={PL - 6} y={t.y + 3.5} textAnchor="end">
						{t.label}
					</text>
				))}
			</g>

			{/* x labels (concurrency) */}
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="10"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{xTicks.map((t, i) => (
					<text key={i} x={t.x} y={VH - 8}>
						{t.label}
					</text>
				))}
			</g>

			{/* SLO breakpoint — amber vertical line + label */}
			{bpX !== null && (
				<>
					<line
						x1={bpX}
						x2={bpX}
						y1={PT}
						y2={PT + IH}
						stroke="hsl(var(--warning))"
						strokeWidth="1.5"
						strokeDasharray="4 4"
					/>
					<g>
						<rect
							x={bpLabelRight ? bpX - 72 : bpX + 4}
							y={PT + 2}
							width={68}
							height={13}
							rx={2}
							fill="hsl(var(--accent))"
							stroke="hsl(var(--border))"
						/>
						<text
							x={bpLabelRight ? bpX - 38 : bpX + 38}
							y={PT + 11.5}
							fontSize="9.5"
							fill="hsl(var(--muted-foreground))"
							textAnchor="middle"
							fontFamily="JetBrains Mono"
						>
							SLO {DEFAULT_SLO_MS}ms
						</text>
					</g>
				</>
			)}

			{/* scatter dots — one per tick */}
			<g fill="hsl(var(--primary))">
				{points.map((p, i) => (
					<circle
						key={i}
						cx={toX(p.concurrency)}
						cy={toY(p.p99)}
						r={2.6}
						fillOpacity={0.7}
					/>
				))}
			</g>

			{/* live dot at the most recent tick */}
			{!isCompleted && (
				<circle
					cx={toX(last.concurrency)}
					cy={toY(last.p99)}
					r={3.5}
					fill="hsl(var(--primary))"
				>
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
