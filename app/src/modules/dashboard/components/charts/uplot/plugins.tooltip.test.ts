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
import { tooltipPlugin } from "./plugins";
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
});
