/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { niceYMax, projectY, HDR_DIMS } from "../../utils/chartGeometry";

const HDR_X_MARKS: Array<{ pct: number; label: string }> = [
	{ pct: 0, label: "0%" },
	{ pct: 50, label: "50%" },
	{ pct: 90, label: "90%" },
	{ pct: 95, label: "95%" },
	{ pct: 99, label: "99%" },
	{ pct: 99.9, label: "99.9%" },
];

interface PercentilePoint {
	pct: number; // 0..100
	value: number; // latency ms
}

/** Log-scale percentile mapping: 0% → 0, 99.99% → 1.
 *  Uses log10(1 / (1 - p/100)) ramp so the tail dominates. */
function pctToX(pct: number): number {
	const p = Math.min(99.99, Math.max(0, pct));
	if (p === 0) return 0;
	const numerator = Math.log10(1 / (1 - p / 100));
	const maxNumerator = Math.log10(1 / (1 - 99.99 / 100)); // = 4
	return numerator / maxNumerator;
}

/** HDR percentile plot — sourced from finalReport.latency. */
export function HdrPercentilePlot({ report }: { report: RunReport | null }) {
	if (!report?.latency) return null;
	const { latency } = report;

	const points: PercentilePoint[] = [];
	const push = (pct: number, value: number | undefined) => {
		if (value !== undefined && value >= 0) points.push({ pct, value });
	};
	push(0, latency.min);
	push(50, latency.p50);
	push(75, latency.p75);
	push(90, latency.p90);
	push(95, latency.p95);
	push(99, latency.p99);
	push(99.9, latency.p999);
	push(99.99, latency.max);

	if (points.length < 3) return null;

	const { VW, VH, PL, PR, PT, PB } = HDR_DIMS;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;

	const maxV = niceYMax(
		points.map((p) => p.value),
		{ floor: 1, headroom: 1.08 }
	);
	const toX = (pct: number) => PL + pctToX(pct) * IW;
	const toY = (v: number) => projectY(v, maxV, PT, IH);

	const path = points
		.map((p, i) => `${i === 0 ? "M" : "L"}${toX(p.pct).toFixed(1)},${toY(p.value).toFixed(1)}`)
		.join(" ");
	const area = `${path} L${toX(points[points.length - 1].pct).toFixed(1)},${PT + IH} L${toX(points[0].pct).toFixed(1)},${PT + IH} Z`;

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = maxV * f;
		return {
			y: toY(v),
			label: v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`,
		};
	});

	const markers: Array<{ pct: number; value?: number; label: string; color: string }> = [
		{ pct: 50, value: latency.p50, label: "p50", color: "hsl(var(--success))" },
		{ pct: 95, value: latency.p95, label: "p95", color: "hsl(var(--warning))" },
		{ pct: 99, value: latency.p99, label: "p99", color: "hsl(var(--destructive))" },
	];

	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 200, display: "block" }}>
			{/* y grid */}
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t, i) => (
					<line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>
			<g fill="hsl(var(--subtle-foreground))" fontSize="9" fontFamily="JetBrains Mono">
				{yTicks.map((t, i) => (
					<text key={i} x={PL - 4} y={t.y + 3} textAnchor="end">
						{t.label}
					</text>
				))}
			</g>

			{/* curve area + line */}
			<path d={area} fill="hsl(var(--primary) / 0.10)" />
			<path
				d={path}
				fill="none"
				stroke="hsl(var(--primary))"
				strokeWidth="1.8"
				strokeLinejoin="round"
				strokeLinecap="round"
			/>

			{/* percentile markers */}
			{markers.map(
				(m) =>
					m.value !== undefined && (
						<g key={m.label}>
							<line
								x1={toX(m.pct)}
								x2={toX(m.pct)}
								y1={PT}
								y2={PT + IH}
								stroke={m.color}
								strokeDasharray="2 3"
								opacity={0.7}
							/>
							<circle cx={toX(m.pct)} cy={toY(m.value)} r={3} fill={m.color} />
							<rect
								x={toX(m.pct) - 22}
								y={4}
								width={44}
								height={12}
								rx={2}
								fill={m.color}
								fillOpacity={0.15}
								stroke={m.color}
								strokeOpacity={0.4}
							/>
							<text
								x={toX(m.pct)}
								y={12.5}
								fontSize="9"
								fill={m.color}
								textAnchor="middle"
								fontFamily="JetBrains Mono"
								fontWeight={700}
							>
								{m.label} {Math.round(m.value)}
							</text>
						</g>
					)
			)}

			{/* x labels */}
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="9"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{HDR_X_MARKS.map((m, i) => (
					<text key={i} x={toX(m.pct)} y={VH - 6}>
						{m.label}
					</text>
				))}
			</g>
		</svg>
	);
}

/**
 * Skeleton HDR plot — same dimensions as the real plot, drawn during live so
 * the card doesn't pop in height when the final report arrives.
 */
export function SkeletonHdrPlot({ message }: { message: string }) {
	const { VW, VH, PL, PR, PT, PB } = HDR_DIMS;
	const IW = VW - PL - PR;
	const skelToX = (pct: number) => PL + pctToX(pct) * IW;
	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f, i) => ({
		y: PT + (1 - f) * (VH - PT - PB),
		key: i,
	}));
	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 200, display: "block" }}>
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t) => (
					<line key={t.key} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="9"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{HDR_X_MARKS.map((m, i) => (
					<text key={i} x={skelToX(m.pct)} y={VH - 6}>
						{m.label}
					</text>
				))}
			</g>
			<text
				x={VW / 2}
				y={VH / 2}
				fontSize="11"
				fill="hsl(var(--muted-foreground))"
				textAnchor="middle"
				fontFamily="Space Grotesk, system-ui, sans-serif"
				fontStyle="italic"
			>
				{message}
			</text>
		</svg>
	);
}
