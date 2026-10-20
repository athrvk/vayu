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
 * Which percentiles the hero latency card is fed on a live run (issue #2385):
 * the run so far, from the tick's `cumulative_p*_ms`, so its p95, p99 and
 * median cover the same span as the mean beside them - never the last ~100 ms
 * window the same tick carries in `latency_p*_ms`.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMetrics } from "../types";
import MetricsView from "./MetricsView";

const base: DisplayMetrics = {
	requests_completed: 500,
	requests_failed: 0,
	current_rps: 120,
	// The window: a quiet 100 ms.
	latency_p50_ms: 11,
	latency_p95_ms: 12,
	latency_p99_ms: 13,
	avg_latency_ms: 27,
	bytes_sent: 5000,
	bytes_received: 25000,
};

/**
 * The text of the hero latency card. Other cards print a p95 too, so it is the
 * one whose sub-line reads a mean or "awaiting samples".
 */
function latencyCardText(): string {
	const cards = screen
		.getAllByText("p95")
		.map((label) => label.closest("div.flex-col")?.textContent ?? "");
	const card = cards.find((text) => /mean|awaiting samples/.test(text));
	expect(card).toBeTruthy();
	return card!;
}

function renderCard(metrics: DisplayMetrics) {
	render(
		<TooltipProvider>
			<MetricsView
				metrics={metrics}
				historicalMetrics={[]}
				mode="constant_concurrency"
				concurrency={10}
			/>
		</TooltipProvider>
	);
}

describe("MetricsView latency hero card", () => {
	it("shows the run's cumulative percentiles, not the window's", () => {
		renderCard({
			...base,
			cumulative_p50_ms: 31,
			cumulative_p95_ms: 152,
			cumulative_p99_ms: 487,
		});
		const text = latencyCardText();
		expect(text).toContain("152");
		expect(text).toContain("487");
		expect(text).toContain("31");
		expect(text).not.toContain("13");
		expect(text).not.toContain("12");
	});

	it("reads awaiting samples while nothing has completed, not the window", () => {
		renderCard({
			...base,
			cumulative_p50_ms: null,
			cumulative_p95_ms: null,
			cumulative_p99_ms: null,
		});
		expect(latencyCardText()).toContain("awaiting samples");
	});

	it("falls back to the tick's own percentiles when it has no cumulative keys", () => {
		renderCard(base);
		const text = latencyCardText();
		expect(text).toContain("12");
		expect(text).toContain("13");
		expect(text).not.toContain("awaiting samples");
	});
});
