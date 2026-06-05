/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { PercentilePoint } from "../../utils/metricsTransforms";
import { niceYMax } from "../../utils/chartGeometry";
import { TimeSeriesChart } from "./TimeSeriesChart";

/**
 * Per-tick p50 / p95 / p99 latency over the run. p50 is what most users felt;
 * p99 is the tail. Heavy-tail divergence shows up as p99 climbing while p50
 * stays flat. Uses the shared TimeSeriesChart frame; renders three lines.
 */
export function PercentilesOverTimeChart({
	data,
	isCompleted,
}: {
	data: PercentilePoint[];
	isCompleted: boolean;
}) {
	if (data.length < 2) return null;

	const yMax = niceYMax(
		data.map((d) => d.p99),
		{ floor: 1, headroom: 1.15 }
	);

	return (
		<TimeSeriesChart
			times={data.map((d) => d.time)}
			yMax={yMax}
			liveDot={
				isCompleted
					? undefined
					: { value: data[data.length - 1].p99, color: "hsl(var(--destructive))" }
			}
		>
			{({ toX, toY }) => {
				const line = (sel: (d: PercentilePoint) => number) =>
					data.map((d, i) => `${toX(i).toFixed(1)},${toY(sel(d)).toFixed(1)}`).join(" ");
				return (
					<>
						<polyline
							fill="none"
							stroke="hsl(var(--success))"
							strokeWidth="1.5"
							strokeLinejoin="round"
							strokeLinecap="round"
							points={line((d) => d.p50)}
						/>
						<polyline
							fill="none"
							stroke="hsl(var(--warning))"
							strokeWidth="1.5"
							strokeLinejoin="round"
							strokeLinecap="round"
							points={line((d) => d.p95)}
						/>
						<polyline
							fill="none"
							stroke="hsl(var(--destructive))"
							strokeWidth="1.8"
							strokeLinejoin="round"
							strokeLinecap="round"
							points={line((d) => d.p99)}
						/>
					</>
				);
			}}
		</TimeSeriesChart>
	);
}
