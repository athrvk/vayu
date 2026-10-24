/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type uPlot from "uplot";

/**
 * Tick spacing for an axis that counts things (requests in flight, virtual
 * users). uPlot's own increments include 0.5 and 0.25, which on a scale of 0 to
 * 2 place ticks a rounding formatter then prints as "2 2 1 1 0" (#2858).
 */
const WHOLE_INCRS = Array.from({ length: 12 }, (_, exp) =>
	[1, 2, 5].map((m) => m * 10 ** exp)
).flat();

/**
 * Whole-number ticks only. Inside a span of 1 no whole number but the floor
 * fits, so the ticks are the scale's two ends and the label formatter writes
 * the fractional one in full (`axisCount`) rather than rounding it onto the
 * floor's label.
 */
function wholeNumberSplits(
	_u: uPlot,
	_axisIdx: number,
	scaleMin: number,
	scaleMax: number,
	foundIncr: number
): number[] {
	if (scaleMax - scaleMin < 1) return [scaleMin, scaleMax];
	const ticks: number[] = [];
	for (let v = Math.ceil(scaleMin / foundIncr) * foundIncr; v <= scaleMax; v += foundIncr) {
		ticks.push(v);
	}
	return ticks;
}

/** The `incrs` and `splits` of an axis that only ever ticks on whole numbers. */
export const WHOLE_NUMBER_TICKS: Pick<uPlot.Axis, "incrs" | "splits"> = {
	incrs: WHOLE_INCRS,
	splits: wholeNumberSplits,
};
