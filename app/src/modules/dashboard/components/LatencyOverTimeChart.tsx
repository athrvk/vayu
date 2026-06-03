/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LatencyPoint } from "../utils/metricsTransforms";
import { niceYMax, projectY } from "../utils/chartGeometry";

/**
 * Per-tick latency over the run, split into wire time (what curl saw) and the
 * generator-side queue-wait gap. Identity: latency = wire + queue wait. When
 * the amber gap grows, the generator is the bottleneck. Mirrors the geometry
 * of ThroughputOverTimeChart.
 */
export function LatencyOverTimeChart({
	data,
	isCompleted,
}: {
	data: LatencyPoint[];
	isCompleted: boolean;
}) {
	if (data.length < 2) return null;

	const VW = 1080;
	const VH = 240;
	const PL = 56;
	const PR = 12;
	const PT = 16;
	const PB = 28;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;

	const yMax = niceYMax(data.map((d) => d.latencyMs), { floor: 1, headroom: 1.15 });

	const toX = (i: number) => PL + (i / (data.length - 1)) * IW;
	const toY = (v: number) => projectY(v, yMax, PT, IH);

	const ptsLatency = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.latencyMs).toFixed(1)}`);
	const ptsWire = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.wireMs).toFixed(1)}`);

	// Amber gap: latency line (left->right) then wire line (right->left), closed.
	const gapPath = `M${ptsLatency.join(" L")} L${[...ptsWire].reverse().join(" L")} Z`;

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = yMax * f;
		return { y: toY(v), label: v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}` };
	});

	const xCount = Math.min(8, data.length);
	const xStride = Math.max(1, Math.floor((data.length - 1) / (xCount - 1)));
	const xLabels: Array<{ x: number; label: string }> = [];
	for (let i = 0; i < data.length; i += xStride) {
		xLabels.push({ x: toX(i), label: `${data[i].time.toFixed(1)}s` });
	}
	const lastIdx = data.length - 1;
	if (xLabels[xLabels.length - 1]?.label !== `${data[lastIdx].time.toFixed(1)}s`) {
		xLabels.push({ x: toX(lastIdx), label: `${data[lastIdx].time.toFixed(1)}s` });
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

			<path d={gapPath} fill="hsl(var(--warning) / 0.25)" />

			<polyline
				fill="none"
				stroke="hsl(var(--info))"
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
				points={ptsWire.join(" ")}
			/>
			<polyline
				fill="none"
				stroke="hsl(var(--primary))"
				strokeWidth="1.8"
				strokeLinejoin="round"
				strokeLinecap="round"
				points={ptsLatency.join(" ")}
			/>

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

			{!isCompleted && (
				<circle
					cx={toX(lastIdx)}
					cy={toY(data[lastIdx].latencyMs)}
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
