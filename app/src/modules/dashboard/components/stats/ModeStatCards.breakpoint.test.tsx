/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DashboardDerived } from "../../types";
import { notCrossed, type Breakpoint } from "../../utils/computeBreakpoint";
import { BreakpointStat } from "./ModeStatCards";

function renderStat(breakpoint: Breakpoint) {
	const d = { breakpoint } as DashboardDerived;
	return render(
		<TooltipProvider>
			<BreakpointStat d={d} />
		</TooltipProvider>
	).container;
}

describe("BreakpointStat", () => {
	it("names the SLO an uncrossed run never reached, rather than a bare dash", () => {
		const text = renderStat(notCrossed(200)).textContent;
		expect(text).toContain("not crossed");
		expect(text).toContain("SLO 200 ms");
		expect(text).not.toContain("-");
	});

	it("reads the SLO off the breakpoint, so a later settings change cannot rewrite it", () => {
		expect(renderStat(notCrossed(350)).textContent).toContain("SLO 350 ms");
	});

	it("shows the concurrency once the SLO was crossed, with no SLO line", () => {
		const text = renderStat({
			crossed: true,
			concurrency: 1450,
			timeSeconds: 6,
			p99Ms: 227,
			sloMs: 200,
		}).textContent;
		expect(text).toContain("1,450");
		expect(text).not.toContain("not crossed");
		expect(text).not.toContain("SLO");
	});

	it.each([null, 0])("falls back to a bare 'not crossed' when the SLO is %s", (sloMs) => {
		const text = renderStat(notCrossed(sloMs)).textContent;
		expect(text).toContain("not crossed");
		expect(text).not.toContain("SLO");
	});
});
