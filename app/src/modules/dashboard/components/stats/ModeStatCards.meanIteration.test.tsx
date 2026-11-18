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
import { MeanIterTimeStat } from "./ModeStatCards";

function statText(d: Partial<DashboardDerived>) {
	return render(
		<TooltipProvider>
			<MeanIterTimeStat d={d as DashboardDerived} />
		</TooltipProvider>
	).container.textContent;
}

// Mutation checked: read `d.meanLatency` in MeanIterTimeStat and the first case
// fails (27 for 83) and the "-" case fails (27 for -).
describe("MeanIterTimeStat (#3570)", () => {
	it("reads a sequence's pass time, not the request latency beside it", () => {
		const text = statText({ meanLatency: 27, meanIterationTime: 83 });
		expect(text).toContain("83");
		expect(text).not.toContain("27");
	});

	it("reads a single request's latency where the bundle sets the two equal", () => {
		expect(statText({ meanLatency: 27, meanIterationTime: 27 })).toContain("27");
	});

	it("reads - for a sequence with no pass time", () => {
		const text = statText({ meanLatency: 27, meanIterationTime: undefined });
		expect(text).toContain("-");
		expect(text).not.toContain("27");
	});
});
