/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The chart tooltip is built from text, never markup (#1780): series labels
 * include custom-metric names a script chose, and an imported collection can
 * fill one with HTML.
 *
 * The plugin's hooks are driven directly with the few uPlot fields they read,
 * because jsdom cannot move a real chart's cursor. Mutation check: build the
 * rows as an HTML string and assign it to `tip.innerHTML`, and the label's
 * `<img>` and `<b>` become elements.
 */

import { describe, it, expect } from "vitest";
import type uPlot from "uplot";
import { tooltipPlugin, type Annotation } from "./plugins";
import type { UplotTheme } from "./uplotTheme";

const THEME = { font: "12px sans-serif" } as unknown as UplotTheme;

function hoverWithLabel(label: string): HTMLElement {
	const over = document.createElement("div");
	const u = {
		over,
		cursor: { idx: 0, left: 10, top: 10 },
		data: [[1], [5]],
		series: [{}, { label, stroke: "red" }],
	} as unknown as uPlot;
	const plugin = tooltipPlugin({ theme: THEME });
	(plugin.hooks.init as (u: uPlot) => void)(u);
	(plugin.hooks.setCursor as (u: uPlot) => void)(u);
	return over.querySelector(".vayu-chart-tooltip") as HTMLElement;
}

describe("tooltipPlugin", () => {
	it("renders a label containing markup as text and creates no elements from it", () => {
		const tip = hoverWithLabel("<img src=x onerror=alert(1)>");
		expect(tip.querySelector("img")).toBeNull();
		expect(tip.textContent).toContain("<img src=x onerror=alert(1)>");
	});

	it("creates exactly the tooltip's own elements, none from a label's markup", () => {
		const label = '<img src="x" onerror="window.__ran=1"><b>bold</b> metric';
		const tip = hoverWithLabel(label);
		expect(tip.textContent).toContain(label);
		expect(tip.querySelector("img, b")).toBeNull();
		// The x label row, then one series row: name (swatch + text) and value.
		expect(tip.querySelectorAll("*")).toHaveLength(5);
	});

	it("keeps the row layout and the series swatch colour", () => {
		const tip = hoverWithLabel("rps");
		const [xRow, seriesRow] = Array.from(tip.children) as HTMLElement[];
		expect(xRow.textContent).toBe("1.0s");
		expect(seriesRow.style.display).toBe("flex");
		const swatch = seriesRow.querySelector("span > span") as HTMLElement;
		expect(swatch.style.background).toBe("red");
		const value = seriesRow.lastElementChild as HTMLElement;
		expect(value.textContent).toBe("5");
		expect(value.style.fontWeight).toBe("600");
	});

	it("shows the label and the formatted value for an ordinary series", () => {
		const tip = hoverWithLabel("rps");
		expect(tip.textContent).toContain("rps");
		expect(tip.textContent).toContain("5");
	});

	describe("tipValues", () => {
		/** Three stacked series plotting 9, 9, 9 (running totals) over one x. */
		function hoverStack(opts: Parameters<typeof tooltipPlugin>[0]): HTMLElement {
			const over = document.createElement("div");
			const u = {
				over,
				cursor: { idx: 0, left: 10, top: 10 },
				data: [[1], [9], [9], [9]],
				series: [
					{},
					{ label: "2xx", stroke: "a" },
					{ label: "3xx", stroke: "b" },
					{ label: "err", stroke: "c" },
				],
			} as unknown as uPlot;
			const plugin = tooltipPlugin(opts);
			(plugin.hooks.init as (u: uPlot) => void)(u);
			(plugin.hooks.setCursor as (u: uPlot) => void)(u);
			return over.querySelector(".vayu-chart-tooltip") as HTMLElement;
		}
		const rowsOf = (tip: HTMLElement) =>
			Array.from(tip.children)
				.slice(1)
				.map((r) => r.textContent);

		it("prints the series' own values, not the plotted ones, and drops zero rows", () => {
			const tip = hoverStack({ theme: THEME, tipValues: () => ({ 1: [9], 2: [0], 3: [0] }) });
			expect(rowsOf(tip)).toEqual(["2xx9"]);
		});

		it("keeps a non-zero own value in every row that has one", () => {
			const tip = hoverStack({ theme: THEME, tipValues: () => ({ 1: [6], 2: [3], 3: [0] }) });
			expect(rowsOf(tip)).toEqual(["2xx6", "3xx3"]);
		});

		it("keeps the first row of an interval where every own value is zero", () => {
			const tip = hoverStack({ theme: THEME, tipValues: () => ({ 1: [0], 2: [0], 3: [0] }) });
			expect(rowsOf(tip)).toEqual(["2xx0"]);
		});

		it("leaves a series without tipValues on the plotted value, zero or not", () => {
			// 3xx has no entry, so its plotted 9 prints even beside zeroed neighbours.
			const tip = hoverStack({ theme: THEME, tipValues: () => ({ 1: [0], 3: [0] }) });
			expect(rowsOf(tip)).toEqual(["3xx9"]);
		});

		it("prints every series' plotted value when no tipValues is given", () => {
			expect(rowsOf(hoverStack({ theme: THEME }))).toEqual(["2xx9", "3xx9", "err9"]);
		});

		it("reads tipValues at hover time, so a later setData is seen without a rebuild", () => {
			let current: Record<number, (number | null)[]> = { 1: [1] };
			const over = document.createElement("div");
			const u = {
				over,
				cursor: { idx: 0, left: 10, top: 10 },
				data: [[1], [9]],
				series: [{}, { label: "2xx", stroke: "a" }],
			} as unknown as uPlot;
			const plugin = tooltipPlugin({ theme: THEME, tipValues: () => current });
			(plugin.hooks.init as (u: uPlot) => void)(u);
			const hover = plugin.hooks.setCursor as (u: uPlot) => void;
			hover(u);
			const tip = over.querySelector(".vayu-chart-tooltip") as HTMLElement;
			expect(rowsOf(tip)).toEqual(["2xx1"]);
			current = { 1: [4] };
			hover(u);
			expect(rowsOf(tip)).toEqual(["2xx4"]);
		});

		it("adds the caption as a second line under the time header", () => {
			const tip = hoverStack({ theme: THEME, caption: "responses / 0.5 s" });
			expect(tip.children[0].textContent).toBe("1.0s");
			expect(tip.children[1].textContent).toBe("responses / 0.5 s");
		});
	});
});

describe("tooltipPlugin annotation hover", () => {
	const COLOURED = {
		font: "12px sans-serif",
		color: (role: string) => (role === "warning" ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)"),
	} as unknown as UplotTheme;
	/** One second per 10px. */
	const px = (seconds: number) => seconds * 10;

	const WINDOW: Annotation = {
		startSeconds: 5,
		endSeconds: 12,
		label: "p99 4.3x baseline for 7s",
		role: "warning",
	};
	const SLEEP: Annotation = {
		startSeconds: 20,
		endSeconds: 20,
		label: "host slept 40s",
		role: "warning",
	};

	/** Hover CSS-pixel `left` and return the tooltip's rows as text. */
	function hoverAt(left: number, annotations: Annotation[]): HTMLElement {
		const over = document.createElement("div");
		const u = {
			over,
			cursor: { idx: 0, left, top: 10 },
			data: [[1], [5]],
			series: [{}, { label: "rps", stroke: "red" }],
			valToPos: (v: number) => px(v),
		} as unknown as uPlot;
		const plugin = tooltipPlugin({ theme: COLOURED, annotations: () => annotations });
		(plugin.hooks.init as (u: uPlot) => void)(u);
		(plugin.hooks.setCursor as (u: uPlot) => void)(u);
		return over.querySelector(".vayu-chart-tooltip") as HTMLElement;
	}
	const texts = (tip: HTMLElement) => Array.from(tip.children, (r) => r.textContent);

	it("names the band the cursor is inside", () => {
		expect(texts(hoverAt(px(8), [WINDOW]))).toEqual(["1.0s", "rps5", WINDOW.label]);
	});

	it("names nothing off the band", () => {
		expect(texts(hoverAt(px(30), [WINDOW]))).toEqual(["1.0s", "rps5"]);
	});

	it("reaches an instant from a few pixels either side, not from far away", () => {
		expect(texts(hoverAt(px(20) + 3, [SLEEP]))).toContain(SLEEP.label);
		expect(texts(hoverAt(px(20) - 3, [SLEEP]))).toContain(SLEEP.label);
		expect(texts(hoverAt(px(20) + 20, [SLEEP]))).not.toContain(SLEEP.label);
	});

	it("skips an annotation with no label", () => {
		const unlabelled: Annotation = { ...WINDOW, label: "" };
		expect(texts(hoverAt(px(8), [unlabelled]))).toEqual(["1.0s", "rps5"]);
	});

	it("lists every annotation under the cursor", () => {
		const overlapping: Annotation = { ...WINDOW, label: "error burst", startSeconds: 7 };
		const tip = hoverAt(px(8), [WINDOW, overlapping]);
		expect(texts(tip).slice(2)).toEqual([WINDOW.label, "error burst"]);
	});

	it("shows the label as text, never markup", () => {
		const hostile: Annotation = { ...WINDOW, label: "<img src=x onerror=alert(1)>" };
		const tip = hoverAt(px(8), [hostile]);
		expect(tip.querySelector("img")).toBeNull();
		expect(tip.textContent).toContain(hostile.label);
	});

	it("colours the swatch by the annotation's role", () => {
		const tip = hoverAt(px(8), [WINDOW]);
		const swatch = tip.lastElementChild?.firstElementChild as HTMLElement;
		expect(swatch.style.background).toBe("rgb(255, 0, 0)");
	});
});
