/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the annotations plugin actually puts on the canvas.
 *
 * jsdom has no layout and a stubbed 2D context, so a rendered chart can only be
 * asserted to have mounted - which would pass just as happily with a plugin that
 * drew nothing. The plugin is a pure function of (annotations, bbox, valToPos)
 * onto context calls, so it is driven directly here with a recording context
 * instead.
 */

import { describe, it, expect } from "vitest";
import type uPlot from "uplot";
import { annotationsPlugin, type Annotation } from "./plugins";
import type { UplotTheme, ColorRole } from "./uplotTheme";

interface DrawCall {
	op: string;
	args: number[];
}

const BBOX = { left: 40, top: 10, width: 400, height: 200 };
/** One second per 10px, starting at the plot's left edge. */
const SECONDS_TO_PX = (seconds: number) => BBOX.left + seconds * 10;

function fakePlot() {
	const calls: DrawCall[] = [];
	const dashes: number[][] = [];
	const record =
		(op: string) =>
		(...args: unknown[]) =>
			calls.push({ op, args: args.filter((a) => typeof a === "number") as number[] });

	const ctx = {
		save: record("save"),
		restore: record("restore"),
		beginPath: record("beginPath"),
		moveTo: record("moveTo"),
		lineTo: record("lineTo"),
		stroke: record("stroke"),
		fillRect: record("fillRect"),
		fillText: (_text: string, x: number, y: number) =>
			calls.push({ op: "fillText", args: [x, y] }),
		setLineDash: (d: number[]) => dashes.push(d),
		font: "",
		textAlign: "left",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
	} as unknown as CanvasRenderingContext2D;

	const theme: UplotTheme = {
		axis: "axis",
		grid: "grid",
		text: "text",
		font: "font",
		cursor: "cursor",
		color: (role: ColorRole, alpha?: number) => `${role}${alpha == null ? "" : `/${alpha}`}`,
	};

	const u = {
		ctx,
		bbox: BBOX,
		valToPos: (v: number) => SECONDS_TO_PX(v),
	} as unknown as uPlot;

	return { u, theme, calls, dashes };
}

function draw(annotations: Annotation[]) {
	const { u, theme, calls, dashes } = fakePlot();
	const plugin = annotationsPlugin(() => annotations, theme);
	const hook = plugin.hooks.draw as (u: uPlot) => void;
	hook(u);
	return { calls, dashes };
}

const WINDOW: Annotation = {
	startSeconds: 5,
	endSeconds: 12,
	label: "p99 4.3x baseline for 7s",
	role: "warning",
};

const INSTANT: Annotation = {
	startSeconds: 20,
	endSeconds: 20,
	label: "first 503 response",
	role: "destructive",
};

describe("annotationsPlugin", () => {
	it("fills a band spanning the window and labels it", () => {
		// The fixture is non-empty on purpose: a guard that reads an empty list
		// draws nothing and passes for the wrong reason.
		expect(WINDOW.endSeconds).toBeGreaterThan(WINDOW.startSeconds);

		const { calls } = draw([WINDOW]);

		const band = calls.find((c) => c.op === "fillRect");
		expect(band).toBeDefined();
		expect(band?.args).toEqual([SECONDS_TO_PX(5), BBOX.top, 70, BBOX.height]);
		expect(calls.some((c) => c.op === "fillText")).toBe(true);
	});

	it("draws an instant as a rule rather than a zero-width band", () => {
		const { calls, dashes } = draw([INSTANT]);

		expect(calls.some((c) => c.op === "fillRect")).toBe(false);
		expect(calls.filter((c) => c.op === "stroke")).toHaveLength(1);
		expect(calls.find((c) => c.op === "moveTo")?.args).toEqual([SECONDS_TO_PX(20), BBOX.top]);
		expect(dashes.some((d) => d.length > 0)).toBe(true);
	});

	it("clips a window that starts before the visible range instead of painting outside it", () => {
		// Drag-zoom moves the x range under a fixed bbox; an unclipped band would
		// paint over the axis labels to the left of the plot.
		const { calls } = draw([{ ...WINDOW, startSeconds: -30 }]);

		const band = calls.find((c) => c.op === "fillRect");
		expect(band?.args[0]).toBe(BBOX.left);
		expect(band?.args[2]).toBe(SECONDS_TO_PX(12) - BBOX.left);
	});

	it("draws nothing for a window scrolled out of view, or for no windows at all", () => {
		const offscreen = draw([{ ...WINDOW, startSeconds: 100, endSeconds: 120 }]);
		expect(offscreen.calls.some((c) => c.op === "fillRect")).toBe(false);
		expect(offscreen.calls.some((c) => c.op === "fillText")).toBe(false);

		const none = draw([]);
		expect(none.calls.filter((c) => c.op !== "save" && c.op !== "restore")).toEqual([]);
	});
});
