/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The arithmetic of the collection tree's window (#2543): which rows a viewport
 * needs mounted, and how much list the rows it skips stand for.
 *
 * Every length here is in spacing units (`--spacing`), the unit the rows are
 * sized in. The rows' heights are not one constant - the gap above a row
 * depends on its depth, and the new-folder form is taller - so positions are a
 * prefix sum over each row's stride rather than an index times a pitch.
 */

/** `offsets[i]` is where row `i`'s stride starts; `offsets[count]` is the list's height. */
export function rowOffsets(strides: readonly number[]): number[] {
	const offsets = [0];
	for (const stride of strides) offsets.push(offsets[offsets.length - 1] + stride);
	return offsets;
}

/** The row whose stride holds `y`, clamped to the list; `-1` for an empty one. */
export function rowAt(offsets: readonly number[], y: number): number {
	let low = 0;
	let high = offsets.length - 2;
	if (high < 0) return -1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (offsets[mid] <= y) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** Rows `start` (inclusive) to `end` (exclusive). */
export interface RowRange {
	start: number;
	end: number;
}

/** The rows between `top` and `top + height`, widened by `overscan` rows each way. */
export function visibleRange(
	offsets: readonly number[],
	top: number,
	height: number,
	overscan: number
): RowRange {
	const count = offsets.length - 1;
	if (count <= 0) return { start: 0, end: 0 };
	return {
		start: Math.max(0, rowAt(offsets, top) - overscan),
		end: Math.min(count, rowAt(offsets, top + height) + 1 + overscan),
	};
}

/** A run of rows to mount, or a run to stand in for with one spacer. */
export interface RowSegment extends RowRange {
	kind: "rows" | "gap";
}

/**
 * The list as it is rendered: the range and every pinned row mounted, in
 * order, and a gap for each run between them. A pinned row far outside the
 * range is a run of its own, with a gap on either side, so every row keeps the
 * offset it would have with the whole list mounted.
 */
export function mountedSegments(
	count: number,
	range: RowRange,
	pinned: readonly number[]
): RowSegment[] {
	const runs: RowRange[] = [range, ...pinned.map((index) => ({ start: index, end: index + 1 }))]
		.filter((run) => run.start >= 0 && run.end <= count && run.start < run.end)
		.sort((a, b) => a.start - b.start);

	const segments: RowSegment[] = [];
	let cursor = 0;
	for (const run of runs) {
		const last = segments[segments.length - 1];
		if (last && run.start <= last.end) {
			// Overlapping or touching the run before it: one run, not two.
			last.end = Math.max(last.end, run.end);
			cursor = last.end;
			continue;
		}
		if (run.start > cursor) segments.push({ kind: "gap", start: cursor, end: run.start });
		segments.push({ kind: "rows", start: run.start, end: run.end });
		cursor = run.end;
	}
	if (cursor < count) segments.push({ kind: "gap", start: cursor, end: count });
	return segments;
}

/**
 * The scroll position that brings `[top, bottom)` into a viewport of `height`
 * now scrolled to `current`, moving it as little as possible: `current` when
 * the span is already in view, its top edge when it is above, its bottom edge
 * when it is below.
 */
export function nearestScrollTop(
	current: number,
	height: number,
	top: number,
	bottom: number
): number {
	if (top < current) return top;
	if (bottom > current + height) return Math.min(top, bottom - height);
	return current;
}
