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
import { ModeStatsRow } from "./ModeStatsRow";

// Both DurationStat render sites: the default branch (constant_rps) and the
// constant_concurrency branch.
const DURATION_MODES = ["constant_rps", "constant_concurrency"] as const;

function durationSub(d: Partial<DashboardDerived>, mode: (typeof DURATION_MODES)[number]) {
	const { container } = render(
		<TooltipProvider>
			<ModeStatsRow
				d={
					{
						mode,
						testDuration: 30,
						totalRequests: 10,
						failedRequests: 0,
						...d,
					} as DashboardDerived
				}
			/>
		</TooltipProvider>
	);
	const eyebrow = Array.from(container.querySelectorAll("p")).find((el) =>
		el.textContent?.startsWith("Duration")
	);
	return eyebrow?.parentElement?.lastElementChild?.textContent ?? "";
}

describe("Duration card overheads (#2894)", () => {
	it.each(DURATION_MODES)("%s: shows setup and cleanup, each from its own key", (mode) => {
		// Mutation checked: binding cleanup to `setupOverhead` shows 30ms twice.
		expect(durationSub({ setupOverhead: 0.03, cleanupOverhead: 0.05 }, mode)).toBe(
			"setup 30ms / cleanup 50ms"
		);
	});

	it.each(DURATION_MODES)(
		"%s: a run stored before setup was measured shows cleanup only, never a setup or a 0",
		(mode) => {
			// Mutation checked: binding cleanup to `setupOverhead` (the old key)
			// renders a dash here instead of 500ms; dropping the undefined guard
			// renders "setup -".
			const sub = durationSub({ setupOverhead: undefined, cleanupOverhead: 0.5 }, mode);
			expect(sub).toBe("cleanup overhead 500ms");
			expect(sub).not.toMatch(/setup|\b0\b/);
		}
	);

	it.each(DURATION_MODES)("%s: a missing cleanup reads as a dash", (mode) => {
		expect(durationSub({ setupOverhead: 0.03, cleanupOverhead: undefined }, mode)).toBe(
			"setup 30ms / cleanup -"
		);
	});
});
