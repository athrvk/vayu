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

	it("shows the label and the formatted value for an ordinary series", () => {
		const tip = hoverWithLabel("rps");
		expect(tip.textContent).toContain("rps");
		expect(tip.textContent).toContain("5");
	});
});
