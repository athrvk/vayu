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
import { useClientSettingsStore } from "@/stores";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "../../types";
import { notCrossed, type Breakpoint } from "../../utils/computeBreakpoint";
import { reportToDerived } from "../../utils/reportToDerived";
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
		const text = renderStat(notCrossed(200, "run")).textContent;
		expect(text).toContain("not crossed");
		expect(text).toContain("SLO 200ms");
	});

	it("reads the SLO off the breakpoint, so a later settings change cannot rewrite it", () => {
		expect(renderStat(notCrossed(350, "run")).textContent).toContain("SLO 350ms");
	});

	it("names the Settings threshold, not an SLO, when the run declared none (#2939)", () => {
		const text = renderStat(notCrossed(200, "settings")).textContent;
		expect(text).toContain("not crossed");
		expect(text).toContain("Settings 200ms");
		expect(text).not.toContain("SLO");
	});

	// A stored capacity run reaches the stat through `reportToDerived`; the
	// Settings SLO (200ms) must not be the line it names (#2816).
	it("names a capacity run's own SLO, not the Settings one", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 200 });
		const report = {
			metadata: { configuration: { mode: "capacity" } },
			summary: {},
			latency: {},
			capacity: { sloMs: 50, stopReason: "plateau", levels: [] },
		} as unknown as RunReport;
		const text = renderStat(reportToDerived(report).breakpoint).textContent;
		expect(text).toContain("not crossed");
		expect(text).toContain("SLO 50ms");
		expect(text).not.toContain("SLO 200ms");
	});

	it("shows the concurrency once the SLO was crossed, with no SLO line", () => {
		const text = renderStat({
			crossed: true,
			concurrency: 1450,
			timeSeconds: 6,
			p99Ms: 227,
			sloMs: 200,
			sloSource: "run",
			atRunStart: false,
		}).textContent;
		expect(text).toContain("1,450");
		expect(text).not.toContain("not crossed");
		expect(text).not.toContain("SLO");
	});

	it("shows a dash, not a verdict, when no SLO was ever judged", () => {
		const text = renderStat(notCrossed(null, "run")).textContent;
		expect(text).toContain("-");
		expect(text).not.toContain("not crossed");
	});

	it("falls back to a bare 'not crossed' when the SLO is 0", () => {
		const text = renderStat(notCrossed(0, "run")).textContent;
		expect(text).toContain("not crossed");
		expect(text).not.toContain("SLO");
	});
});
