/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import type { Marker } from "./plugins";
import type { ColorRole } from "./uplotTheme";

/** Log-scale percentile → 0..1 x position (tail dominates), mirroring the old plot. */
export function pctToX(pct: number): number {
	const p = Math.min(99.99, Math.max(0, pct));
	if (p === 0) return 0;
	return Math.log10(1 / (1 - p / 100)) / Math.log10(1 / (1 - 99.99 / 100));
}

/** The percentile at an x position: the inverse of `pctToX`, for the hover readout. */
export function xToPctLabel(x: number): string {
	const span = Math.log10(1 / (1 - 99.99 / 100));
	const pct = 100 * (1 - Math.pow(10, -Math.min(1, Math.max(0, x)) * span));
	return `${Math.round(pct * 100) / 100}%`;
}

interface HdrMarkerSpec {
	label: "p50" | "p95" | "p99";
	pct: number;
	/** The role while the value is within the SLO (or no SLO is known). */
	role: ColorRole;
	/** The role once the value is past the SLO; absent means the marker never judges. */
	pastSloRole?: ColorRole;
}

// Which percentile a marker is says nothing about whether the run was slow, so
// the status roles are only ever taken past the SLO, as the history latency
// tiles do (#2263, #2245). The resting roles match `LatencyPercentilesChart`.
const HDR_MARKERS: HdrMarkerSpec[] = [
	{ label: "p50", pct: 50, role: "muted" },
	{ label: "p95", pct: 95, role: "categorical-2", pastSloRole: "warning" },
	{ label: "p99", pct: 99, role: "categorical", pastSloRole: "destructive" },
];

/** The vertical p50/p95/p99 markers for the HDR distribution, in ms against `sloMs`. */
export function hdrPercentileMarkers(
	latency: RunReport["latency"] | undefined,
	sloMs?: number
): Marker[] {
	if (!latency) return [];
	const markers: Marker[] = [];
	for (const { label, pct, role, pastSloRole } of HDR_MARKERS) {
		const value = latency[label];
		if (value == null) continue;
		const past = pastSloRole !== undefined && sloMs !== undefined && value > sloMs;
		markers.push({
			orient: "vertical",
			value: pctToX(pct),
			role: past ? pastSloRole : role,
			label,
		});
	}
	return markers;
}
