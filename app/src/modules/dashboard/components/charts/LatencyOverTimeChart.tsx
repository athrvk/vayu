/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LatencyPoint } from "../../utils/metricsTransforms";
import { niceYMax } from "../../utils/chartGeometry";
import { TimeSeriesChart } from "./TimeSeriesChart";

/**
 * Per-tick latency over the run, split into wire time (what curl saw) and the
 * generator-side queue-wait gap. Identity: latency = wire + queue wait. When
 * the amber gap grows, the generator is the bottleneck. Uses the shared
 * TimeSeriesChart frame; renders the gap fill + wire/latency lines as series.
 */
export function LatencyOverTimeChart({
	data,
	isCompleted,
}: {
	data: LatencyPoint[];
	isCompleted: boolean;
}) {
	if (data.length < 2) return null;

	const yMax = niceYMax(
		data.map((d) => d.latencyMs),
		{ floor: 1, headroom: 1.15 }
	);

	return (
		<TimeSeriesChart
			times={data.map((d) => d.time)}
			yMax={yMax}
			liveDot={
				isCompleted
					? undefined
					: { value: data[data.length - 1].latencyMs, color: "hsl(var(--primary))" }
			}
		>
			{({ toX, toY }) => {
				const ptsLatency = data.map(
					(d, i) => `${toX(i).toFixed(1)},${toY(d.latencyMs).toFixed(1)}`
				);
				const ptsWire = data.map(
					(d, i) => `${toX(i).toFixed(1)},${toY(d.wireMs).toFixed(1)}`
				);
				// Amber gap: latency line (left->right) then wire line (right->left), closed.
				const gapPath = `M${ptsLatency.join(" L")} L${[...ptsWire].reverse().join(" L")} Z`;
				return (
					<>
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
					</>
				);
			}}
		</TimeSeriesChart>
	);
}
