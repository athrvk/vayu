/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { niceYMax, projectY, TIME_SERIES_DIMS } from "../../utils/chartGeometry";
import type { RampOverlay } from "../../utils/metricsTransforms";

export interface ThroughputPoint {
	time: number;
	rps: number;
	sendRate: number;
}

/**
 * Throughput over time — send rate (dispatched) vs throughput (received), with
 * an optional configured target reference line and an optional ramp_up
 * concurrency overlay on a secondary axis.
 */
export function ThroughputOverTimeChart({
	data,
	targetRps,
	isCompleted,
	rampOverlay,
}: {
	data: ThroughputPoint[];
	targetRps?: number;
	isCompleted: boolean;
	rampOverlay?: RampOverlay | null;
}) {
	if (data.length < 2) return null;

	const { VW, VH, PL, PR, PT, PB } = TIME_SERIES_DIMS;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;

	const yMax = niceYMax([...data.map((d) => Math.max(d.rps, d.sendRate)), targetRps ?? 0], {
		floor: 1,
		headroom: 1.15,
	});

	const toX = (i: number) => PL + (i / (data.length - 1)) * IW;
	const toY = (v: number) => projectY(v, yMax, PT, IH);

	const ptsRps = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.rps).toFixed(1)}`).join(" ");
	const ptsSend = data
		.map((d, i) => `${toX(i).toFixed(1)},${toY(d.sendRate).toFixed(1)}`)
		.join(" ");

	const baselineY = PT + IH;
	const areaRps = `M${PL},${baselineY} L${ptsRps} L${toX(data.length - 1).toFixed(1)},${baselineY}Z`;

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = yMax * f;
		return {
			y: toY(v),
			label: v >= 1000 ? `${(v / 1000).toFixed(0)}k` : Math.round(v).toString(),
		};
	});

	// Up to 8 x-axis labels
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

	const targetY = targetRps !== undefined && targetRps > 0 ? toY(targetRps) : null;

	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 220, display: "block" }}>
			{/* horizontal grid */}
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t, i) => (
					<line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>

			{/* y labels */}
			<g fill="hsl(var(--subtle-foreground))" fontSize="10" fontFamily="JetBrains Mono">
				{yTicks.map((t, i) => (
					<text key={i} x={PL - 6} y={t.y + 3.5} textAnchor="end">
						{t.label}
					</text>
				))}
			</g>

			{/* target reference line */}
			{targetY !== null && (
				<>
					<line
						x1={PL}
						x2={VW - PR}
						y1={targetY}
						y2={targetY}
						stroke="hsl(var(--subtle-foreground))"
						strokeDasharray="4 4"
					/>
					<g>
						<rect
							x={VW - PR - 58}
							y={targetY - 7}
							width={58}
							height={13}
							rx={2}
							fill="hsl(var(--accent))"
							stroke="hsl(var(--border))"
						/>
						<text
							x={VW - PR - 29}
							y={targetY + 3}
							fontSize="9.5"
							fill="hsl(var(--muted-foreground))"
							textAnchor="middle"
							fontFamily="JetBrains Mono"
						>
							target {targetRps}
						</text>
					</g>
				</>
			)}

			{/* send rate line */}
			<polyline
				fill="none"
				stroke="hsl(var(--info))"
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
				points={ptsSend}
			/>

			{/* throughput area + line */}
			<path d={areaRps} fill="hsl(var(--primary) / 0.14)" />
			<polyline
				fill="none"
				stroke="hsl(var(--primary))"
				strokeWidth="1.8"
				strokeLinejoin="round"
				strokeLinecap="round"
				points={ptsRps}
			/>

			{/* x labels */}
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

			{/* live dot at end of throughput line */}
			{!isCompleted && (
				<circle
					cx={toX(lastIdx)}
					cy={toY(data[lastIdx].rps)}
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

			{/* ramp_up concurrency overlay — right Y-axis */}
			{rampOverlay &&
				rampOverlay.points.length > 1 &&
				(() => {
					const cMax = niceYMax([rampOverlay.target], { floor: 1, headroom: 1.15 });
					const n = rampOverlay.points.length;
					const cx = (i: number) => PL + (i / (n - 1)) * IW;
					const cy = (v: number) => projectY(v, cMax, PT, IH);
					const conf = rampOverlay.points.map(
						(p, i) => `${cx(i).toFixed(1)},${cy(p.configured).toFixed(1)}`
					);
					const ach = rampOverlay.points.map(
						(p, i) => `${cx(i).toFixed(1)},${cy(p.achieved).toFixed(1)}`
					);
					const lagPath = `M${conf.join(" L")} L${[...ach].reverse().join(" L")} Z`;
					const rTicks = [0, 0.5, 1.0].map((f) => ({
						y: cy(cMax * f),
						label: `${Math.round(cMax * f)}`,
					}));
					return (
						<g>
							<g
								fill="hsl(var(--subtle-foreground))"
								fontSize="10"
								fontFamily="JetBrains Mono"
								textAnchor="start"
							>
								{rTicks.map((t, i) => (
									<text key={i} x={VW - PR + 4} y={t.y + 3.5}>
										{t.label}
									</text>
								))}
							</g>
							<path d={lagPath} fill="hsl(var(--warning) / 0.25)" />
							<polyline
								fill="none"
								stroke="hsl(var(--subtle-foreground))"
								strokeWidth="1.5"
								strokeDasharray="4 4"
								points={conf.join(" ")}
							/>
							<polyline
								fill="none"
								stroke="hsl(var(--success))"
								strokeWidth="1.8"
								strokeLinejoin="round"
								strokeLinecap="round"
								points={ach.join(" ")}
							/>
						</g>
					);
				})()}
		</svg>
	);
}
