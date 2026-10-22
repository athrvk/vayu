/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatRate } from "@/lib/format-number";
import type { ColorRole } from "./uplotTheme";

/** How a legend swatch is drawn: a stroke, a scatter point, or a translucent band fill. */
export type LegendShape = "line" | "dot" | "band";

/**
 * One thing a chart draws, named once. The chart module declares its entries
 * and builds its series from them, and the legend renders the same objects, so
 * a role changed in one place cannot leave the other behind (#2311).
 */
export interface LegendEntry {
	label: string;
	role: ColorRole;
	shape: LegendShape;
}

/**
 * What each time-series chart draws, by role. The series and the markers are built
 * from these entries and `MetricsView` and History render the same ones as their
 * legend (`ChartLegend`), so the two cannot disagree (#2311).
 */
export const THROUGHPUT_LEGEND = {
	// `categorical`, not `primary`: `--primary` tracks the user's accent theme,
	// so this series changed hue per scheme and could land on a neighbouring
	// semantic one. On `forest` the accent is 3% lightness from `--success`.
	throughput: { label: "throughput", role: "categorical", shape: "line" },
	sendRate: { label: "send rate", role: "info", shape: "line" },
	target: { label: "target", role: "subtle", shape: "line" },
	configured: { label: "configured", role: "subtle", shape: "line" },
	achieved: { label: "achieved", role: "success", shape: "line" },
} as const satisfies Record<string, LegendEntry>;

export const LATENCY_LEGEND = {
	average: { label: "average latency (incl. queue wait)", role: "categorical", shape: "line" },
	wire: { label: "wire time", role: "info", shape: "line" },
	queueWait: { label: "queue wait", role: "warning", shape: "band" },
} as const satisfies Record<string, LegendEntry>;

// Which percentile a line is carries no verdict, so none of these takes a
// status role: a healthy 3 ms p99 drawn red reads as failing (#2245).
// p99 keeps the violet it has on the scatter.
export const PERCENTILE_LEGEND = {
	p50: { label: "p50", role: "muted", shape: "line" },
	p95: { label: "p95", role: "categorical-2", shape: "line" },
	p99: { label: "p99", role: "categorical", shape: "line" },
} as const satisfies Record<string, LegendEntry>;

/**
 * What the scatter draws, by role (see `THROUGHPUT_LEGEND`). The SLO entry names
 * the horizontal threshold line; the vertical breakpoint marker is `warning`
 * and carries its own label.
 */
export const SCATTER_LEGEND = {
	// `categorical`, not `primary`: `--primary` tracks the user's accent theme,
	// so this series changed hue per scheme and could land on a neighbouring
	// semantic one. On `forest` the accent is 3% lightness from `--success`.
	p99: { label: "p99", role: "categorical", shape: "dot" },
	slo: { label: "SLO", role: "subtle", shape: "line" },
} as const satisfies Record<string, LegendEntry>;

// The key each card renders. Live (`MetricsView`) and History read these same
// lists, so a card cannot name a line its twin does not (#2697).
export const LATENCY_ENTRIES: readonly LegendEntry[] = Object.values(LATENCY_LEGEND);
export const PERCENTILE_ENTRIES: readonly LegendEntry[] = Object.values(PERCENTILE_LEGEND);
export const SCATTER_ENTRIES: readonly LegendEntry[] = Object.values(SCATTER_LEGEND);

/**
 * The throughput card's key: the send-rate entry only when the chart draws that
 * line, the target line only when it draws one, the ramp pair only on a ramp.
 */
export function throughputLegend(
	targetRps: number | undefined,
	hasRamp: boolean,
	hasSend: boolean
): LegendEntry[] {
	const { throughput, sendRate, target, configured, achieved } = THROUGHPUT_LEGEND;
	return [
		throughput,
		...(hasSend ? [sendRate] : []),
		...(targetRps && targetRps > 0
			? [{ ...target, label: `target ${formatRate(targetRps)} req/s` }]
			: []),
		...(hasRamp ? [configured, achieved] : []),
	];
}
