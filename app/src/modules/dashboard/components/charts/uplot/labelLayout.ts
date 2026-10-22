/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where each of a chart's overlay labels goes so that none draws over another
 * (#2696). Pure: the caller measures the text, applies any right-edge flip and
 * draws; this decides only the lane.
 */

/** The horizontal extent a label actually occupies once anchored, in canvas pixels. */
export interface LabelExtent {
	/** Left edge of the drawn text; for a right-anchored label, the anchor minus its width. */
	x: number;
	width: number;
}

export interface LabelSlot {
	lane: number;
	/** Distance below the first lane's baseline, `lane * laneHeight`. */
	offset: number;
}

/**
 * One slot per item, in order. Each label takes the first lane whose earlier
 * labels it clears by `gap`; earlier items therefore win the contested lanes.
 * `null` means no lane within `maxLanes` was free: the label is not drawn, and
 * the caller's rule or band still is.
 */
export function layoutChartLabels(
	items: readonly LabelExtent[],
	laneHeight: number,
	maxLanes: number,
	gap = 0
): (LabelSlot | null)[] {
	const lanes: LabelExtent[][] = Array.from({ length: maxLanes }, () => []);
	return items.map((item) => {
		const lane = lanes.findIndex((placed) => placed.every((p) => !overlaps(p, item, gap)));
		if (lane < 0) return null;
		lanes[lane].push(item);
		return { lane, offset: lane * laneHeight };
	});
}

function overlaps(a: LabelExtent, b: LabelExtent, gap: number): boolean {
	return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap;
}
