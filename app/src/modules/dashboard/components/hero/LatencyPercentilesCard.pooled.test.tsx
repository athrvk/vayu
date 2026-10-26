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
 * The hero latency card of a scenario load run says its figures pool every
 * step (#2823), from a finished report and from a live frame alike; a
 * single-request run's card is unchanged.
 *
 * Mutation-check: drop the `pooledLatency &&` guard and the single-request case
 * fails; drop `pooledLatency` from `HeroRow`'s props and the derived case fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { HeroRow } from "./HeroRow";
import { LatencyPercentilesCard } from "./LatencyPercentilesCard";
import type { DashboardDerived } from "../../types";

function renderCard(
	pooledLatency?: React.ComponentProps<typeof LatencyPercentilesCard>["pooledLatency"]
) {
	return render(
		<TooltipProvider>
			<LatencyPercentilesCard
				p95={30}
				p99={90}
				meanLatency={10}
				medianLatency={8}
				pooledLatency={pooledLatency}
			/>
		</TooltipProvider>
	);
}

describe("LatencyPercentilesCard pooled caption", () => {
	it("names the slowest step where the producer knows it", () => {
		renderCard({ slowestStep: { ms: 90, name: "List orders" } });

		expect(
			screen.getByText("All steps pooled - slowest step: List orders, p99 90ms")
		).toBeTruthy();
	});

	it("says only that the steps are pooled live, where steps carry no latency", () => {
		renderCard({});

		expect(screen.getByText("All steps pooled")).toBeTruthy();
	});

	it("draws no caption for a single-request run", () => {
		renderCard();

		expect(screen.queryByText(/pooled/i)).toBeNull();
	});
});

describe("HeroRow", () => {
	const row = (pooledLatency?: DashboardDerived["pooledLatency"]) =>
		({
			mode: "constant_rps",
			isCompleted: false,
			currentRps: 0,
			avgQueueWaitMs: 0,
			totalRequests: 10,
			failedRequests: 0,
			httpErrors: 0,
			noResponse: 0,
			statusCodes: {},
			requestsExpected: 0,
			requestsSent: 10,
			peakConcurrency: 0,
			currentConcurrency: 0,
			backpressure: 0,
			p99Latency: 90,
			meanLatency: 10,
			medianLatency: 8,
			p95Latency: 30,
			elapsedSeconds: 1,
			droppedRequests: 0,
			skippedRequests: 0,
			stalledMs: 0,
			showDropped: false,
			breakpoint: {
				crossed: false,
				concurrency: null,
				timeSeconds: null,
				p99Ms: null,
				sloMs: 200,
				atRunStart: false,
			},
			pooledLatency,
		}) satisfies DashboardDerived;

	it("hands the derived bundle's qualifier to the latency card", () => {
		render(
			<TooltipProvider>
				<HeroRow d={row({ slowestStep: { ms: 90, name: "List orders" } })} />
			</TooltipProvider>
		);

		expect(
			screen.getByText("All steps pooled - slowest step: List orders, p99 90ms")
		).toBeTruthy();
	});
});
