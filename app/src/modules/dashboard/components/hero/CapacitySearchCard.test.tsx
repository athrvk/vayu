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
 * The capacity hero card names the level being searched, never "N of 100
 * active" (#2929), and `HeroRow` mounts it for capacity only.
 *
 * Mutation check: render `ConcurrencyUtilCard` for capacity again in
 * `HeroRow` and the "names the level" and "result" cases redden.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DashboardDerived } from "../../types";
import { HeroRow } from "./HeroRow";

function derived(over: Partial<DashboardDerived>): DashboardDerived {
	return {
		mode: "capacity",
		isCompleted: false,
		totalRequests: 100,
		failedRequests: 0,
		httpErrors: 0,
		noResponse: 0,
		statusCodes: {},
		requestsExpected: 0,
		requestsSent: 100,
		peakConcurrency: 33,
		currentConcurrency: 33,
		configuredConcurrency: 100,
		backpressure: 0,
		currentRps: 0,
		avgQueueWaitMs: 0,
		elapsedSeconds: 10,
		droppedRequests: 0,
		skippedRequests: 0,
		stalledMs: 0,
		showDropped: false,
		breakpoint: { crossed: false, sloMs: null, sloSource: "settings" },
		...over,
	} as unknown as DashboardDerived;
}

function text(d: DashboardDerived): string {
	const { container } = render(
		<TooltipProvider>
			<HeroRow d={d} />
		</TooltipProvider>
	);
	return container.textContent ?? "";
}

describe("capacity hero card", () => {
	it("names the level being measured and the levels judged live", () => {
		const out = text(
			derived({ liveCapacity: { level: 33, levelElapsedMs: 3000, levelsJudged: 9 } })
		);
		expect(out).toContain("33virtual users");
		expect(out).toContain("3s into this level");
		expect(out).toContain("9 levels judged");
		expect(out).not.toContain("utilisation");
		expect(out).not.toContain("active");
	});

	it("says it is starting before the first level opens", () => {
		const out = text(
			derived({ liveCapacity: { level: 0, levelElapsedMs: 0, levelsJudged: 0 } })
		);
		expect(out).toContain("starting");
	});

	it("reads the report once the run is over, with the ceiling as a bound", () => {
		const out = text(
			derived({
				isCompleted: true,
				capacity: {
					sloMs: 200,
					stopReason: "slo_exceeded",
					maxHealthyConcurrency: 41,
					kneeConcurrency: 51,
					levels: [],
				},
			})
		);
		expect(out).toContain("41virtual users held");
		expect(out).toContain("gave out at 51 of up to 100 virtual users");
	});

	it("does not claim a held level when the first level already failed", () => {
		const out = text(
			derived({
				isCompleted: true,
				capacity: {
					sloMs: 200,
					stopReason: "slo_exceeded",
					kneeConcurrency: 1,
					levels: [],
				},
			})
		);
		expect(out).toContain("noneheld its budgets");
	});

	it("leaves a constant-concurrency run on the utilisation card", () => {
		const out = text(derived({ mode: "constant_concurrency", avgInFlight: 4 }));
		expect(out).toContain("utilisation");
		expect(out).not.toContain("Searching");
	});
});
