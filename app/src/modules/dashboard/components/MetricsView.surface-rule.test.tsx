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
 * Issue #1891: the dashboard's cards painted `bg-card` with no surface class
 * and drew their inner dividers on `border-border`, which is the same colour
 * as `--card` in dark, so every rule inside a card was absent. A card now
 * declares `bg-card surface-card` and its dividers say `border-rule`.
 *
 * `border-rule` alone proves nothing: under no declared surface it falls back
 * to the invisible default. So this renders a ramp-up run that reaches every
 * divider the live view can draw (ramp footer, HDR footer, timing footer) and
 * asserts the declarations. The phase-percentile and stream-event dividers are
 * the finished report's, guarded by `PerformanceTab.surface-rule.test.tsx`.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LoadTestMetrics } from "@/types";
import type { DisplayMetrics, MetricsViewProps } from "../types";
import { LATENCY, PHASES } from "../utils/liveDistributions.testkit";
import MetricsView from "./MetricsView";

const SURFACE = ".surface-card, .surface-sunken";

// The "i" chip is a bg-accent disc whose outline is a caller decision
// (`ui/info-chip`): no border token reads on --accent, so the disc is seen by
// its fill and `border-rule` would not change that.
const INFO_CHIP = '[aria-label="More information"]';

function tick(i: number): LoadTestMetrics {
	return {
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: i * 2,
		current_rps: 100 + i * 10,
		current_concurrency: 10 + i * 5,
		latency_p50_ms: 20 + i,
		latency_p95_ms: 40 + i * 3,
		latency_p99_ms: 80 + i * 8,
		avg_latency_ms: 25 + i,
		avg_queue_wait_ms: i * 0.5,
		current_send_rate: 105 + i * 10,
		window_avg_latency_ms: 25 + i,
		window_avg_queue_wait_ms: i * 0.5,
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		status_codes: { "200": i * 90, "500": i * 3 },
	};
}

const props: MetricsViewProps = {
	metrics: {
		requests_completed: 500,
		requests_failed: 4,
		current_rps: 120,
		latency_p50_ms: 22,
		latency_p95_ms: 48,
		latency_p99_ms: 96,
		avg_latency_ms: 27,
		bytes_sent: 5000,
		bytes_received: 25000,
	} as DisplayMetrics,
	// The last tick is a gate frame, so Row 3 draws its footers (HDR and timing).
	historicalMetrics: Array.from({ length: 6 }, (_, i) =>
		i === 5 ? { ...tick(i), cumulative_latency: LATENCY, cumulative_phases: PHASES } : tick(i)
	),
	mode: "ramp_up",
	rampConfig: { rampUpDurationSeconds: 10, startConcurrency: 1, targetConcurrency: 100 },
};

// `classList`, not `className`: an SVG node's `className` is not a string.
const has = (el: Element, token: string) => el.classList.contains(token);
const classAttr = (el: Element) => el.getAttribute("class");

function renderView() {
	return render(
		<TooltipProvider>
			<MetricsView {...props} />
		</TooltipProvider>
	).container;
}

describe("MetricsView declares the surface its dividers read", () => {
	it("every border-rule sits under a declared surface", () => {
		const rules = Array.from(renderView().querySelectorAll(".border-rule"));

		// Ramp footer, HDR footer and timing footer: a render that reached none
		// of them would pass the loop below having checked nothing.
		expect(rules.length).toBeGreaterThanOrEqual(3);
		for (const rule of rules) {
			expect(
				rule.closest(SURFACE),
				`border-rule under no surface: ${classAttr(rule)}`
			).not.toBeNull();
		}
	});

	it("every bg-card block declares surface-card and keeps border-border to its own edge", () => {
		const cards = Array.from(renderView().querySelectorAll(".bg-card"));

		expect(cards.length).toBeGreaterThanOrEqual(13);
		for (const card of cards) {
			expect(
				has(card, "surface-card"),
				`bg-card without surface-card: ${classAttr(card)}`
			).toBe(true);
			const inner = Array.from(card.querySelectorAll("*")).filter(
				(el) => has(el, "border-border") && !el.matches(INFO_CHIP)
			);
			expect(inner.map(classAttr), "a rule inside a card must say border-rule").toEqual([]);
		}
	});
});
