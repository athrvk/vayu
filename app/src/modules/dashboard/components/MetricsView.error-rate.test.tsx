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
 * Where the Error rate card's inputs come from (issue #2124). The card read
 * the status map from the final report only, so its bar was empty for the
 * whole run; the live tick carries that map and now fills it. A finished run's
 * card reads the report's distribution through `reportToDerived` (#2220).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMetrics, MetricsViewProps } from "../types";
import MetricsView from "./MetricsView";

const baseMetrics: DisplayMetrics = {
	requests_completed: 100,
	requests_failed: 15,
	current_rps: 120,
	latency_p50_ms: 22,
	latency_p95_ms: 48,
	latency_p99_ms: 96,
	avg_latency_ms: 27,
	bytes_sent: 5000,
	bytes_received: 25000,
};

function renderCard(overrides: Partial<MetricsViewProps>) {
	render(
		<TooltipProvider>
			<MetricsView
				metrics={baseMetrics}
				historicalMetrics={[]}
				mode="constant_concurrency"
				concurrency={10}
				{...overrides}
			/>
		</TooltipProvider>
	);
	const card = screen.getByText("Error rate").closest<HTMLElement>(".surface-card")!;
	const bar = card.querySelector<HTMLElement>(".h-2")!;
	return {
		card,
		widths: Array.from(bar.children).map((c) => parseFloat((c as HTMLElement).style.width)),
	};
}

describe("MetricsView error rate card", () => {
	it("fills the bar from the live tick's status map during the run", () => {
		const { card, widths } = renderCard({
			metrics: {
				...baseMetrics,
				http_errors: 15,
				no_response: 0,
				status_codes: { "200": 85, "500": 15 },
			},
		});

		expect(screen.getByText("15.0").getAttribute("style")).toContain("destructive-text");
		expect(widths[0]).toBeCloseTo(85);
		expect(widths[2]).toBeCloseTo(15);
		expect(card.textContent).toContain("HTTP errors 15");
	});

	it("reads a tick stored without the split as all HTTP errors", () => {
		// An older engine records requests_failed only; a zero HTTP errors line
		// beside a non-zero rate would say the errors were not HTTP ones.
		const { card } = renderCard({
			metrics: { ...baseMetrics, status_codes: { "200": 85, "500": 15 } },
		});

		expect(card.textContent).toContain("HTTP errors 15");
		expect(card.textContent).toContain("No response 0");
	});
});
