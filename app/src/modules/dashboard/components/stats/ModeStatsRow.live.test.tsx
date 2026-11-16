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
 * What the live Row 4 says that a finished one does not (#3568): the requests on
 * the wire in the two closed-loop modes, and the planned duration with its time
 * left in place of the Duration card's dead live reading.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { formatSeconds } from "@/lib/format-number";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DashboardDerived } from "../../types";
import { ModeStatsRow } from "./ModeStatsRow";

function renderRow(d: Partial<DashboardDerived>) {
	const { container } = render(
		<TooltipProvider>
			<ModeStatsRow
				d={
					{
						isCompleted: false,
						totalRequests: 10,
						failedRequests: 0,
						backpressure: 0,
						elapsedSeconds: 0,
						...d,
					} as DashboardDerived
				}
			/>
		</TooltipProvider>
	);
	return container;
}

describe("in flight on the live closed-loop rows", () => {
	// Mutation checked: drop `sub={liveInFlightSub(d)}` from either card and its
	// case reddens; drop the `isCompleted` guard and the finished case reddens.
	it.each(["constant_concurrency", "iterations"] as const)(
		"%s: a live bundle reads its backpressure as N in flight",
		(mode) => {
			const row = renderRow({ mode, backpressure: 10 });
			expect(row.textContent).toContain("10 in flight");
		}
	);

	it.each(["constant_concurrency", "iterations"] as const)(
		"%s: a finished bundle says nothing about in flight",
		(mode) => {
			// `reportToDerived` hardcodes backpressure 0; "0 in flight" would be a claim nobody measured.
			const row = renderRow({ mode, isCompleted: true, backpressure: 0, testDuration: 30 });
			expect(row.textContent).not.toContain("in flight");
		}
	);

	it("constant_rps keeps its backpressure sub-line, in its own words", () => {
		const row = renderRow({ mode: "constant_rps", backpressure: 7, peakConcurrency: 9 });
		expect(row.textContent).toContain("backpressure 7");
		expect(row.textContent).not.toContain("in flight 7");
	});
});

describe("the live Duration card", () => {
	function durationCard(d: Partial<DashboardDerived>) {
		const row = renderRow({ mode: "constant_rps", ...d });
		const eyebrow = Array.from(row.querySelectorAll("p")).find((el) =>
			el.textContent?.startsWith("Duration")
		);
		return eyebrow?.parentElement?.textContent ?? "";
	}

	// Mutation checked: drop the planned-duration branch and the first case reddens
	// (the card reads "-" with its cleanup overhead); drop the `isCompleted` guard and
	// the finished case reddens.
	it("states the plan and the time left of it while the run is live", () => {
		const card = durationCard({ plannedDurationSeconds: 60, elapsedSeconds: 45 });
		expect(card).toContain(`Duration${formatSeconds(60)}`);
		expect(card).toContain(`${formatSeconds(15)} left`);
		expect(card).not.toContain("cleanup");
	});

	it("never counts below zero once the plan has been passed", () => {
		expect(durationCard({ plannedDurationSeconds: 15, elapsedSeconds: 18 })).toContain(
			`${formatSeconds(0)} left`
		);
	});

	it("keeps the old live reading for a run with no planned duration", () => {
		const card = durationCard({ plannedDurationSeconds: undefined });
		expect(card).toContain("cleanup overhead");
		expect(card).not.toContain("left");
	});

	it("leaves a finished run's card on its measured duration and overheads", () => {
		const card = durationCard({
			isCompleted: true,
			plannedDurationSeconds: 60,
			testDuration: 61,
			setupOverhead: 0.03,
			cleanupOverhead: 0.05,
		});
		expect(card).toContain("setup 30ms / cleanup 50ms");
		expect(card).not.toContain("left");
	});
});
