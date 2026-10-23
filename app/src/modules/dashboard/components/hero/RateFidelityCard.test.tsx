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
 * The Rate fidelity card compares requests sent with requests owed over the
 * sending window (#2392). It used to divide cumulative completions by elapsed
 * time, so a run whose last responses arrived after the deadline read below
 * its target for the drain alone.
 *
 * Mutation-check: feed `liveRateFidelity` the tick's `throughput` and the
 * elapsed time (the old definition) and the past-the-deadline case reads 80%.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LoadTestMetrics } from "@/types";
import type { DisplayMetrics } from "../../types";
import MetricsView from "../MetricsView";
import { RateFidelityCard } from "./RateFidelityCard";

function tick(over: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 0,
		elapsed_seconds: 0,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		latency_p50_ms: 1,
		latency_p95_ms: 1,
		latency_p99_ms: 1,
		avg_latency_ms: 1,
		bytes_sent: 0,
		bytes_received: 0,
		...over,
	};
}

/** A constant_rps target of 100 req/s for 20 s, as the live view hands it over. */
function renderLive(latest: LoadTestMetrics) {
	render(
		<TooltipProvider>
			<MetricsView
				metrics={latest as DisplayMetrics}
				historicalMetrics={[latest]}
				mode="constant_rps"
				targetRps={100}
				runDurationSeconds={20}
			/>
		</TooltipProvider>
	);
	return screen.getByText("Rate fidelity").closest<HTMLElement>(".surface-card")!;
}

describe("Rate fidelity card on a live run", () => {
	it("reads 100% once every owed request is sent, though the drain runs past the duration", () => {
		// 2000 sent of the 2000 owed (100 req/s x 20 s). 25 s in, the drain has run
		// 5 s and completions (1600) lag - the old numerator and denominator.
		const card = renderLive(
			tick({
				elapsed_seconds: 25,
				requests_sent: 2000,
				requests_expected: 0,
				requests_completed: 1600,
				throughput: 64,
			})
		);

		expect(card.textContent).toContain("100.0");
		expect(card.textContent).toContain("actual 100 req/s");
	});

	it("measures against the elapsed time while the run is still sending", () => {
		// 10 s in, 1000 of the 1000 owed so far.
		const card = renderLive(
			tick({
				elapsed_seconds: 10,
				requests_sent: 1000,
				requests_completed: 400,
				throughput: 40,
			})
		);

		expect(card.textContent).toContain("100.0");
		expect(card.textContent).toContain("actual 100 req/s");
	});

	it("shows the shortfall of a generator that fell behind", () => {
		const card = renderLive(tick({ elapsed_seconds: 10, requests_sent: 900 }));

		expect(card.textContent).toContain("90.0");
		expect(card.querySelector("[style*='width']")).not.toBeNull();
	});

	it("draws the empty state before the run has a window to divide by", () => {
		const card = renderLive(tick({ elapsed_seconds: 0, requests_sent: 0 }));

		expect(card.textContent).toContain("0.0");
		expect(card.textContent).not.toContain("NaN");
		expect(card.textContent).not.toContain("Infinity");
		expect(card.querySelector("[style*='width']")).toBeNull();
	});
});

describe("RateFidelityCard", () => {
	const renderCard = (props: React.ComponentProps<typeof RateFidelityCard>) =>
		render(
			<TooltipProvider>
				<RateFidelityCard {...props} />
			</TooltipProvider>
		).container;

	it("prints the percentage it is handed instead of dividing the rates itself", () => {
		// 96/100 would read 96; the card is given the report's own 99.2.
		const out = renderCard({ targetRps: 100, actualRps: 96, achievement: 99.2 });

		expect(out.textContent).toContain("99.2");
	});

	it("has no bar and no number without an achievement", () => {
		const out = renderCard({ targetRps: 100, actualRps: 96 });

		expect(out.textContent).toContain("0.0");
		expect(out.querySelector("[style*='width']")).toBeNull();
	});

	it("states where a Stop ended the run beside the pace it is judged by", () => {
		const out = renderCard({
			targetRps: 50,
			actualRps: 50,
			achievement: 99.9,
			stoppedAt: { planSharePct: 50.067, plannedSeconds: 60 },
		});

		expect(screen.getByText("stopped at 50% of the planned 60s")).toBeInTheDocument();
		expect(out.querySelector("[style*='success-text']")?.textContent).toContain("99.9");
	});

	it("draws no stopped line without a Stop", () => {
		renderCard({ targetRps: 50, actualRps: 50, achievement: 99.9 });

		expect(screen.queryByText(/stopped at/)).toBeNull();
	});
});
