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
