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
import type { Breakpoint } from "../../utils/computeBreakpoint";
import { P99AtPeakStat } from "./ModeStatCards";

const crossedAt19: Breakpoint = {
	crossed: true,
	concurrency: 19,
	timeSeconds: 19,
	p99Ms: 203,
	sloMs: 200,
	atRunStart: false,
};

function renderStat(d: Partial<DashboardDerived>) {
	return render(
		<TooltipProvider>
			<P99AtPeakStat d={d as DashboardDerived} />
		</TooltipProvider>
	).container.textContent;
}

describe("P99AtPeakStat", () => {
	it("shows the peak-load reading, not the breakpoint tick's p99", () => {
		// S7-shaped: crossed the SLO at 19 virtual users (203 ms), 292 ms at 30.
		const text = renderStat({ breakpoint: crossedAt19, p99AtPeakMs: 292, p99Latency: 150 });
		expect(text).toContain("292");
		expect(text).not.toContain("203");
	});

	it("falls back to the run's p99 so far while no tick at the peak has a reading", () => {
		const text = renderStat({
			breakpoint: crossedAt19,
			p99AtPeakMs: undefined,
			p99Latency: 150,
		});
		expect(text).toContain("150");
		expect(text).not.toContain("203");
	});
});
