/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type uPlot from "uplot";

/** Space kept above the tallest point so a peak does not sit on the frame. */
const HEADROOM = 0.1;

/**
 * The y range of a chart whose scale starts at `yMin`.
 *
 * uPlot's own auto-range hugs the data, so a throughput series wandering between
 * 480 and 520 filled the whole height and read as a collapse. Pinning the floor
 * makes the plot's height mean the same thing on every chart.
 *
 * Data below `yMin` moves the floor down to it (with the same headroom) rather
 * than clipping the series. A flat or empty series would collapse the axis to a
 * point, so it gets a unit of span instead.
 */
export function baseRange(
	yMin: number,
	dataMin: number | null | undefined,
	dataMax: number | null | undefined
): [number, number] {
	if (dataMin == null || dataMax == null || !isFinite(dataMin) || !isFinite(dataMax)) {
		return [yMin, yMin + 1];
	}
	const floor = Math.min(yMin, dataMin);
	const span = dataMax - floor;
	if (span <= 0) {
		// Flat at the floor: all zeros, or a single value on `yMin`.
		return [dataMin < yMin ? dataMin - 1 : floor, dataMax + 1];
	}
	return [dataMin < yMin ? floor - span * HEADROOM : floor, dataMax + span * HEADROOM];
}

/** The `scales.<key>.range` for a chart on `yMin`; `null` keeps uPlot's auto-range. */
export function rangeFrom(yMin: number | null): uPlot.Range.Function | undefined {
	if (yMin == null) return undefined;
	return (_u, dataMin, dataMax) => baseRange(yMin, dataMin, dataMax);
}
