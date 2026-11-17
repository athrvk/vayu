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
 * The live Duration card states the run's plan (#3568).
 *
 * `MetricsView` hands the card the configured duration through the derived
 * bundle; the card's own cases (`ModeStatsRow.live.test.tsx`) start from a
 * bundle that already carries it, so only the real view guards the wiring.
 *
 * Mutation check: drop `plannedDurationSeconds: runDurationSeconds` from the
 * live bundle in `MetricsView.tsx` and the planned case reddens (the card falls
 * back to the measured duration, a dash while the run is live).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatSeconds } from "@/lib/format-number";
import type { DisplayMetrics } from "../types";
import { tick } from "../utils/liveDistributions.testkit";
import MetricsView from "./MetricsView";

function durationCardText(runDurationSeconds: number | undefined): string {
	const history = [tick(1), tick(5)];
	render(
		<TooltipProvider>
			<MetricsView
				metrics={history[1] as DisplayMetrics}
				historicalMetrics={history}
				mode="constant_concurrency"
				concurrency={10}
				runDurationSeconds={runDurationSeconds}
			/>
		</TooltipProvider>
	);
	const eyebrow = screen.getAllByText("Duration").find((el) => el.tagName === "P");
	return eyebrow?.parentElement?.textContent ?? "";
}

describe("MetricsView live Duration card", () => {
	it("shows the configured duration and the time left, not a dash", () => {
		const card = durationCardText(15);

		expect(card).toContain(`Duration${formatSeconds(15)}`);
		expect(card).toContain(`${formatSeconds(10)} left`);
	});

	it("keeps the measured reading for a run with no configured duration", () => {
		const card = durationCardText(undefined);

		expect(card).not.toContain("left");
		expect(card).toContain("cleanup overhead");
	});
});
