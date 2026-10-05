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
 * The cursor tooltip writes series labels as text.
 *
 * A custom metric's name is whatever a script passed, an imported
 * collection's script included, and it becomes a series label. The plugin's
 * hooks are driven directly with the few uPlot fields they read, the way
 * `plugins.annotations.test.ts` drives the annotations plugin, because jsdom
 * cannot move a real chart's cursor.
 *
 * Mutation check: build the rows as an HTML string again and assign it to
 * `tip.innerHTML`, and the label's `<img>` and `<b>` become elements.
 */

import { describe, it, expect } from "vitest";
import type uPlot from "uplot";
import { tooltipPlugin } from "./plugins";
import type { UplotTheme } from "./uplotTheme";

const MARKUP_LABEL = '<img src="x" onerror="window.__ran=1"><b>bold</b> metric';

function hoveredPlot(label: string) {
	const over = document.createElement("div");
	const plot = {
		over,
		cursor: { idx: 0, left: 10, top: 10 },
		data: [[1.5], [42]],
		series: [{}, { label, stroke: "red", show: true }],
	};
	return { over, plot: plot as unknown as uPlot };
}

function hover(label: string) {
	const { over, plot } = hoveredPlot(label);
	const plugin = tooltipPlugin({ theme: { font: "12px sans-serif" } as UplotTheme });
	const hooks = plugin.hooks as {
		init: (u: uPlot) => void;
		setCursor: (u: uPlot) => void;
	};
	hooks.init(plot);
	hooks.setCursor(plot);
	const tip = over.querySelector<HTMLDivElement>(".vayu-chart-tooltip");
	if (!tip) throw new Error("the tooltip was not mounted");
	return tip;
}

describe("tooltipPlugin", () => {
	it("renders a series label containing markup as that literal text", () => {
		const tip = hover(MARKUP_LABEL);

		expect(tip.textContent).toContain(MARKUP_LABEL);
		expect(tip.querySelector("img, b")).toBeNull();
		// The x label row, then one series row: name (swatch + text) and value.
		expect(tip.querySelectorAll("*")).toHaveLength(5);
		expect(tip.textContent).toContain("42");
	});

	it("keeps the row layout and the series swatch colour", () => {
		const tip = hover("rps");
		const [xRow, seriesRow] = Array.from(tip.children) as HTMLElement[];

		expect(xRow.textContent).toBe("1.5s");
		expect(seriesRow.style.display).toBe("flex");
		const swatch = seriesRow.querySelector("span > span") as HTMLElement;
		expect(swatch.style.background).toBe("red");
		expect(seriesRow.lastElementChild?.textContent).toBe("42");
		expect(seriesRow.lastElementChild instanceof HTMLElement).toBe(true);
		expect((seriesRow.lastElementChild as HTMLElement).style.fontWeight).toBe("600");
	});
});
