/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { StatusPoint } from "../../utils/metricsTransforms";
import { niceYMax } from "../../utils/chartGeometry";
import { TimeSeriesChart } from "./TimeSeriesChart";

/** Stack order, bottom → top, with the status-tier color token for each band. */
const BANDS: Array<{ key: keyof StatusPoint; color: string }> = [
	{ key: "c2xx", color: "hsl(var(--success))" },
	{ key: "c3xx", color: "hsl(var(--primary))" },
	{ key: "c4xx", color: "hsl(var(--warning))" },
	{ key: "c5xx", color: "hsl(var(--destructive))" },
	{ key: "cErr", color: "hsl(var(--destructive) / 0.5)" },
];

/**
 * Per-interval status-class composition over the run, as stacked areas. A burst
 * of 4xx/5xx (or connection errors) appears as a colored band rising out of the
 * otherwise-green 2xx field. Uses the shared TimeSeriesChart frame; renders one
 * filled area per class, stacked.
 */
export function StatusCodesOverTimeChart({ data }: { data: StatusPoint[] }) {
	if (data.length < 2) return null;

	const total = (d: StatusPoint) => d.c2xx + d.c3xx + d.c4xx + d.c5xx + d.cErr;
	const yMax = niceYMax(data.map(total), { floor: 1, headroom: 1.15 });

	return (
		<TimeSeriesChart times={data.map((d) => d.time)} yMax={yMax}>
			{({ toX, toY }) => {
				// Running cumulative top for each point as we stack bands upward.
				const cumTop = data.map(() => 0);
				return (
					<>
						{BANDS.map(({ key, color }) => {
							// Top edge = cumTop + this band; bottom edge = cumTop (pre-add).
							const topPts = data.map((d, i) => {
								const bottom = cumTop[i];
								const top = bottom + (d[key] as number);
								cumTop[i] = top;
								return { x: toX(i), yTop: toY(top), yBot: toY(bottom) };
							});
							const forward = topPts.map(
								(p) => `${p.x.toFixed(1)},${p.yTop.toFixed(1)}`
							);
							const backward = [...topPts]
								.reverse()
								.map((p) => `${p.x.toFixed(1)},${p.yBot.toFixed(1)}`);
							return (
								<polygon
									key={String(key)}
									points={[...forward, ...backward].join(" ")}
									fill={color}
									fillOpacity={0.85}
									stroke={color}
									strokeWidth="0.75"
								/>
							);
						})}
					</>
				);
			}}
		</TimeSeriesChart>
	);
}
