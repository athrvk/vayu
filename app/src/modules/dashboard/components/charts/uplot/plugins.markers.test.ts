/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the markers plugin puts a vertical marker's label. A recording context
 * stands in for the canvas, as in `plugins.annotations.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type uPlot from "uplot";
import { markersPlugin, type Marker } from "./plugins";
import type { UplotTheme, ColorRole } from "./uplotTheme";

const BBOX = { left: 40, top: 10, width: 400, height: 200 };
const CANVAS_WIDTH = 450;
const LABEL_WIDTH = 48;

function draw(marker: Marker, cx: number) {
	const texts: { x: number; align: string }[] = [];
	const state = { textAlign: "left" };
	const ctx = {
		save: () => {},
		restore: () => {},
		beginPath: () => {},
		moveTo: () => {},
		lineTo: () => {},
		stroke: () => {},
		setLineDash: () => {},
		measureText: () => ({ width: LABEL_WIDTH }),
		fillText: (_text: string, x: number) => texts.push({ x, align: state.textAlign }),
		canvas: { width: CANVAS_WIDTH },
		font: "",
		get textAlign() {
			return state.textAlign;
		},
		set textAlign(v: string) {
			state.textAlign = v;
		},
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
	} as unknown as CanvasRenderingContext2D;
	const theme = { color: (role: ColorRole) => role } as unknown as UplotTheme;
	const u = { ctx, bbox: BBOX, valToPos: () => cx } as unknown as uPlot;
	(markersPlugin(() => [marker], theme).hooks.draw as (u: uPlot) => void)(u);
	return texts;
}

const marker: Marker = { orient: "vertical", value: 1, label: "This run", role: "info" };

describe("markersPlugin vertical label", () => {
	it("sits to the right of the line when it fits", () => {
		expect(draw(marker, 100)).toEqual([{ x: 104, align: "left" }]);
	});

	it("flips to the left of the line at the right edge, where it would be clipped", () => {
		expect(draw(marker, BBOX.left + BBOX.width)).toEqual([{ x: 436, align: "right" }]);
	});
});

describe("markersPlugin horizontal marker off the visible y range", () => {
	const BOTTOM = BBOX.top + BBOX.height;

	/** Draw `m` at canvas-pixel `cy`, recording the line it strokes and the label it writes. */
	function drawAt(m: Marker, cy: number, measure: (text: string) => number = () => LABEL_WIDTH) {
		const lines: number[] = [];
		const labels: { text: string; x: number; y: number }[] = [];
		const ctx = {
			save: () => {},
			restore: () => {},
			beginPath: () => {},
			moveTo: (_x: number, y: number) => lines.push(y),
			lineTo: () => {},
			stroke: () => {},
			setLineDash: () => {},
			measureText: (text: string) => ({ width: measure(text) }),
			fillText: (text: string, x: number, y: number) => labels.push({ text, x, y }),
			canvas: { width: CANVAS_WIDTH },
			font: "",
			textAlign: "left",
			fillStyle: "",
			strokeStyle: "",
			lineWidth: 0,
		} as unknown as CanvasRenderingContext2D;
		const theme = { color: (role: ColorRole) => role } as unknown as UplotTheme;
		const u = { ctx, bbox: BBOX, valToPos: () => cy } as unknown as uPlot;
		(markersPlugin(() => [m], theme).hooks.draw as (u: uPlot) => void)(u);
		return { lines, labels };
	}

	const slo: Marker = { orient: "horizontal", value: 500, label: "SLO 500ms", role: "subtle" };

	it("draws an in-range marker where it is, with its own label", () => {
		const { lines, labels } = drawAt(slo, 100);
		expect(lines).toEqual([100]);
		expect(labels).toEqual([{ text: "SLO 500ms", x: BBOX.left + BBOX.width - 4, y: 96 }]);
	});

	it("pins a marker above the range to the top edge and says so", () => {
		const { lines, labels } = drawAt(slo, BBOX.top - 300);
		expect(lines).toEqual([BBOX.top]);
		expect(labels.map((l) => l.text)).toEqual(["SLO 500ms (above range)"]);
		// The label hangs below a line on the top edge, not above it off the plot.
		expect(labels[0].y).toBeGreaterThan(BBOX.top);
	});

	it("pins a marker below the range to the bottom edge and says so", () => {
		const { lines, labels } = drawAt(slo, BOTTOM + 300);
		expect(lines).toEqual([BOTTOM]);
		expect(labels.map((l) => l.text)).toEqual(["SLO 500ms (below range)"]);
		expect(labels[0].y).toBeLessThan(BOTTOM);
	});

	it("shortens the label to fit the plot, keeping the direction", () => {
		const { labels } = drawAt(slo, BBOX.top - 300, (text) => text.length * 20);
		expect(labels).toHaveLength(1);
		expect(labels[0].text.endsWith("… (above range)")).toBe(true);
		expect(labels[0].text.length * 20).toBeLessThanOrEqual(BBOX.width - 8);
	});

	it("still skips a vertical marker that the zoom has moved off the plot", () => {
		const v: Marker = { orient: "vertical", value: 1, label: "SLO", role: "info" };
		expect(draw(v, BBOX.left - 50)).toEqual([]);
		expect(draw(v, BBOX.left + BBOX.width + 50)).toEqual([]);
	});
});
