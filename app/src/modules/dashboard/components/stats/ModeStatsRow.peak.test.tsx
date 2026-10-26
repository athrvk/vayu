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
import { notCrossed } from "../../utils/computeBreakpoint";
import { ModeStatsRow } from "./ModeStatsRow";

// Each mode that draws the peak card, under the label it gets there.
const PEAK_CARDS = [
	{ mode: "constant_rps", label: "Peak in-flight requests" },
	{ mode: "ramp_up", label: "Peak virtual users" },
] as const;

function peakValue(mode: DashboardDerived["mode"], label: string, peakConcurrency?: number) {
	const { container } = render(
		<TooltipProvider>
			<ModeStatsRow
				d={
					{
						mode,
						isCompleted: true,
						testDuration: 30,
						totalRequests: 10,
						failedRequests: 0,
						backpressure: 0,
						breakpoint: notCrossed(null, "settings"),
						peakConcurrency,
					} as DashboardDerived
				}
			/>
		</TooltipProvider>
	);
	const eyebrow = Array.from(container.querySelectorAll("p")).find((el) =>
		el.textContent?.startsWith(label)
	);
	expect(eyebrow).toBeDefined();
	return eyebrow?.nextElementSibling?.textContent ?? "";
}

describe("Peak concurrency stat (#2963)", () => {
	// Mutation checked: `formatNumber(d.peakConcurrency ?? 0)` in place of
	// `orDash` renders "0" for the unrecorded case.
	it.each(PEAK_CARDS)("$mode: an unrecorded peak reads -, not 0", ({ mode, label }) => {
		expect(peakValue(mode, label, undefined)).toBe("-");
	});

	it.each(PEAK_CARDS)("$mode: a recorded peak reads as its count", ({ mode, label }) => {
		expect(peakValue(mode, label, 12)).toBe("12");
	});
});
