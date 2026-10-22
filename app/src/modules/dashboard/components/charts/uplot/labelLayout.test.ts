/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { layoutChartLabels, type LabelExtent } from "./labelLayout";

const LANE_HEIGHT = 12;
const MAX_LANES = 2;

const label = (x: number, width = 60): LabelExtent => ({ x, width });

describe("layoutChartLabels", () => {
	it("puts a label that overlaps an earlier one in the next lane", () => {
		const slots = layoutChartLabels([label(100), label(100)], LANE_HEIGHT, MAX_LANES);

		expect(slots[0]).toEqual({ lane: 0, offset: 0 });
		expect(slots[1]).toEqual({ lane: 1, offset: LANE_HEIGHT });
	});

	it("drops a third label that fits neither lane", () => {
		const slots = layoutChartLabels(
			[label(100), label(110), label(120)],
			LANE_HEIGHT,
			MAX_LANES
		);

		expect(slots.map((s) => s?.lane)).toEqual([0, 1, undefined]);
		expect(slots[2]).toBeNull();
	});

	it("lets labels that are far apart share the first lane", () => {
		const slots = layoutChartLabels([label(0), label(200), label(400)], LANE_HEIGHT, MAX_LANES);

		expect(slots.map((s) => s?.lane)).toEqual([0, 0, 0]);
	});

	it("keeps a label in the lane of a neighbour it merely touches, but not one inside the gap", () => {
		const touching = layoutChartLabels([label(0, 50), label(50)], LANE_HEIGHT, MAX_LANES);
		expect(touching[1]?.lane).toBe(0);

		const tooClose = layoutChartLabels([label(0, 50), label(54)], LANE_HEIGHT, MAX_LANES, 6);
		expect(tooClose[1]?.lane).toBe(1);

		const clear = layoutChartLabels([label(0, 50), label(56)], LANE_HEIGHT, MAX_LANES, 6);
		expect(clear[1]?.lane).toBe(0);
	});

	it("compares drawn extents, so a flipped right-edge label clears a neighbour its anchor would hit", () => {
		// Both anchored at x=500. Left-anchored, the pair would overlap; the second
		// is flipped to extend leftwards from its anchor, so it ends where the first
		// begins.
		const anchored = layoutChartLabels([label(500), label(500)], LANE_HEIGHT, MAX_LANES);
		expect(anchored[1]?.lane).toBe(1);

		const flipped = layoutChartLabels([label(500), label(500 - 60)], LANE_HEIGHT, MAX_LANES);
		expect(flipped[1]?.lane).toBe(0);
	});

	it("takes the lane from the earlier item when two contest it, and a later one moves down", () => {
		const slots = layoutChartLabels([label(0), label(10), label(300)], LANE_HEIGHT, MAX_LANES);

		expect(slots.map((s) => s?.lane)).toEqual([0, 1, 0]);
	});

	it("lays out nothing for no labels", () => {
		expect(layoutChartLabels([], LANE_HEIGHT, MAX_LANES)).toEqual([]);
	});

	it("drops the overlapping label when only one lane is allowed", () => {
		const single = layoutChartLabels([label(0), label(10)], LANE_HEIGHT, 1);
		expect(single).toEqual([{ lane: 0, offset: 0 }, null]);
	});

	it("keeps three labels at one moment on a 60s chart from overlapping: two anomalies a second apart and a breakpoint", () => {
		// 60s across 600px: a second is 10px, and each label is wider than that.
		const pxPerSecond = 10;
		const items = [
			label(30 * pxPerSecond + 4, 90), // breakpoint marker at 30s
			label(30 * pxPerSecond + 4, 110), // anomaly at 30s
			label(31 * pxPerSecond + 4, 110), // anomaly at 31s
		];

		const slots = layoutChartLabels(items, LANE_HEIGHT, MAX_LANES);
		const drawn = items.filter((_, i) => slots[i]);

		expect(drawn.length).toBeGreaterThan(0);
		expect(drawn.length).toBeLessThan(items.length);
		for (const lane of [0, 1]) {
			const inLane = items.filter((_, i) => slots[i]?.lane === lane);
			for (let a = 0; a < inLane.length; a++) {
				for (let b = a + 1; b < inLane.length; b++) {
					const overlap =
						inLane[a].x < inLane[b].x + inLane[b].width &&
						inLane[b].x < inLane[a].x + inLane[a].width;
					expect(overlap).toBe(false);
				}
			}
		}
	});
});
