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
import { HeroRow } from "./HeroRow";
import { ThroughputCard } from "./ThroughputCard";

const text = (ui: React.ReactElement) =>
	render(<TooltipProvider>{ui}</TooltipProvider>).container.textContent;

describe("ThroughputCard mean iteration (#3570)", () => {
	it("prints the iteration time it is handed", () => {
		expect(text(<ThroughputCard throughput={361} meanIterationTime={83} />)).toContain(
			"mean iteration 83ms"
		);
	});

	it("prints - for an unknown iteration time, not a measured 0", () => {
		expect(text(<ThroughputCard throughput={361} />)).toContain("mean iteration -");
	});
});

// Mutation checked: hand the card `d.meanLatency` in HeroRow and the first case fails.
describe("HeroRow iterations hero reads the iteration time, not the request latency (#3570)", () => {
	const derived = (meanIterationTime?: number) =>
		({
			mode: "iterations",
			isCompleted: true,
			throughput: 361,
			meanLatency: 27,
			meanIterationTime,
			totalRequests: 1200,
			failedRequests: 0,
			httpErrors: 0,
			noResponse: 0,
			statusCodes: {},
			requestsSent: 1200,
			requestsExpected: 1200,
			currentRps: 361,
		}) as DashboardDerived;

	const heroText = (d: DashboardDerived) =>
		render(
			<TooltipProvider>
				<HeroRow d={d} />
			</TooltipProvider>
		).container.textContent;

	it("shows a sequence's pass time beside its 27 ms request latency", () => {
		expect(heroText(derived(83))).toContain("mean iteration 83ms");
	});

	it("shows - for a sequence with no pass time", () => {
		expect(heroText(derived(undefined))).toContain("mean iteration -");
	});

	it("shows a single request's latency where the bundle makes the two one figure", () => {
		expect(heroText(derived(27))).toContain("mean iteration 27ms");
	});
});
