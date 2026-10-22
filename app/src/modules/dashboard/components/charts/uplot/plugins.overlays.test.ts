/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The labels of markers and annotations share one layout (#2696): a recording
 * context stands in for the canvas, as in `plugins.annotations.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type uPlot from "uplot";
import { overlaysPlugin, type Annotation, type Marker } from "./plugins";
import type { UplotTheme, ColorRole } from "./uplotTheme";

/** 60s across a 600px plot, so one second is 10px. */
const BBOX = { left: 40, top: 10, width: 600, height: 200 };
const PX_PER_SECOND = 10;
const CHAR_WIDTH = 6;

interface Label {
	text: string;
	x: number;
	y: number;
	align: string;
}

function draw(markers: Marker[], annotations: Annotation[]) {
	const labels: Label[] = [];
	const rules: number[] = [];
	const bands: number[] = [];
	const state = { textAlign: "left" };
	const ctx = {
		save: () => {},
		restore: () => {},
		beginPath: () => {},
		moveTo: (x: number) => rules.push(x),
		lineTo: () => {},
		stroke: () => {},
		fillRect: (x: number) => bands.push(x),
		setLineDash: () => {},
		measureText: (text: string) => ({ width: text.length * CHAR_WIDTH }),
		fillText: (text: string, x: number, y: number) =>
			labels.push({ text, x, y, align: state.textAlign }),
		canvas: { width: BBOX.left + BBOX.width + 10 },
		get textAlign() {
			return state.textAlign;
		},
		set textAlign(v: string) {
			state.textAlign = v;
		},
		font: "",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
	} as unknown as CanvasRenderingContext2D;
	const theme = { color: (role: ColorRole) => role } as unknown as UplotTheme;
	const u = {
		ctx,
		bbox: BBOX,
		valToPos: (v: number) => BBOX.left + v * PX_PER_SECOND,
	} as unknown as uPlot;
	const plugin = overlaysPlugin(
		() => markers,
		() => annotations,
		theme
	);
	(plugin.hooks.draw as (u: uPlot) => void)(u);
	return { labels, rules, bands };
}

function extent(l: Label) {
	const width = l.text.length * CHAR_WIDTH;
	return l.align === "right"
		? { start: l.x - width, end: l.x }
		: { start: l.x, end: l.x + width };
}

function overlaps(a: Label, b: Label) {
	if (a.y !== b.y) return false;
	const ea = extent(a);
	const eb = extent(b);
	return ea.start < eb.end && eb.start < ea.end;
}

const breakpoint: Marker = {
	orient: "vertical",
	value: 30,
	label: "Breakpoint 120 VUs",
	role: "destructive",
};
const anomalyAt = (seconds: number, label: string): Annotation => ({
	startSeconds: seconds,
	endSeconds: seconds,
	label,
	role: "warning",
});

describe("overlaysPlugin shared label layout", () => {
	it("draws no two overlapping labels for two anomalies a second apart and a breakpoint at the same time", () => {
		const { labels, rules } = draw(
			[breakpoint],
			[anomalyAt(30, "first 503 response"), anomalyAt(31, "p99 4.3x baseline")]
		);

		// Every rule is drawn; only a label can be shed.
		expect(rules).toHaveLength(3);
		expect(labels.length).toBeGreaterThan(0);
		expect(labels.length).toBeLessThan(3);
		for (let a = 0; a < labels.length; a++) {
			for (let b = a + 1; b < labels.length; b++) {
				expect(overlaps(labels[a], labels[b])).toBe(false);
			}
		}
	});

	it("lets the marker take the first lane and an overlapping annotation the second", () => {
		const { labels } = draw([breakpoint], [anomalyAt(30, "first 503 response")]);

		expect(labels.map((l) => l.text)).toEqual([breakpoint.label, "first 503 response"]);
		expect(labels[1].y).toBeGreaterThan(labels[0].y);
	});

	it("keeps every label on one line when they are far apart", () => {
		const { labels } = draw(
			[{ ...breakpoint, value: 5 }],
			[anomalyAt(30, "first 503 response"), anomalyAt(55, "p99 spike")]
		);

		expect(labels).toHaveLength(3);
		expect(new Set(labels.map((l) => l.y)).size).toBe(1);
	});

	it("compares a right-edge marker's flipped extent, not its anchor", () => {
		// The marker sits at the plot's right edge and flips left. An annotation
		// whose label begins just right of the marker's line would collide with an
		// unflipped extent, and does not with the flipped one.
		const edge: Marker = { ...breakpoint, value: 60 };
		const { labels } = draw([edge], [anomalyAt(60, "late")]);

		const marker = labels.find((l) => l.text === edge.label);
		expect(marker?.align).toBe("right");
		expect(labels).toHaveLength(2);
		expect(new Set(labels.map((l) => l.y)).size).toBe(1);
	});

	it("does not give an annotation with no label a lane", () => {
		const { labels } = draw(
			[breakpoint],
			[anomalyAt(30, ""), anomalyAt(30.2, "first 503 response")]
		);

		expect(labels.map((l) => l.text)).toEqual([breakpoint.label, "first 503 response"]);
	});
});
