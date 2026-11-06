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
 * A streaming load run's live view shows what its streams have delivered so far
 * (issue #3236): events received, events per second, streams open and, once a
 * stream has finished with a timed first event, the time to first event. The
 * panel is keyed on the frames carrying `stream_events`, so an ordinary load
 * run never draws a "0 events/sec" it did not measure. A collection load run with
 * a streaming step (#3304) is gated the same way, whatever else its frames carry.
 *
 * Mutation-check: gate the panel on anything but `stream_events` (render it
 * unconditionally) and the plain-run case fails; read the first-event tile off
 * the newest frame and the non-gate-last case fails; coerce an absent figure to 0
 * and the absent-tile cases fail.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LiveScenarioProgress, LoadTestMetrics } from "@/types";
import type { DisplayMetrics } from "../types";
import { tick } from "../utils/liveDistributions.testkit";

vi.mock("./charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("./charts/uplot")>()),
	HdrPercentileChart: () => null,
}));

const MetricsView = (await import("./MetricsView")).default;

function renderView(history: LoadTestMetrics[]) {
	const metrics = history[history.length - 1] as DisplayMetrics;
	return render(
		<TooltipProvider>
			<MetricsView
				metrics={metrics}
				historicalMetrics={history}
				mode="constant_concurrency"
				concurrency={10}
			/>
		</TooltipProvider>
	);
}

// The figure a tile prints, found by its caption: the same numbers (0.0, 8)
// appear on other cards of the view.
const tile = (label: string) => screen.getByText(label).previousElementSibling?.textContent;

const stream = (elapsed: number, extra: Partial<LoadTestMetrics> = {}) =>
	tick(elapsed, { stream_events: 1200, events_per_second: 340.5, streams_open: 8, ...extra });

describe("MetricsView stream panel", () => {
	it("shows the events so far, events/sec and open streams of a streaming frame", async () => {
		renderView([stream(1), stream(2)]);

		expect(await screen.findByText("events so far")).toBeTruthy();
		expect(tile("events so far")).toBe("1,200");
		expect(tile("events/sec")).toBe("340.5");
		expect(tile("streams open")).toBe("8");
	});

	it("draws a measured zero rate, because a stream run that has not delivered yet is still one", async () => {
		renderView([stream(1, { stream_events: 0, events_per_second: 0, streams_open: 0 })]);

		expect(await screen.findByText("events so far")).toBeTruthy();
		expect(tile("events so far")).toBe("0");
		expect(tile("events/sec")).toBe("0.0");
		expect(tile("streams open")).toBe("0");
	});

	it("draws no panel for a run whose frames carry no stream keys", async () => {
		renderView([tick(1, { current_rps: 100 }), tick(2, { current_rps: 100 })]);

		// The hero row is the proof the view rendered at all.
		expect(await screen.findByText("Error rate")).toBeTruthy();
		expect(screen.queryByText("Stream events")).toBeNull();
		expect(screen.queryByText("events/sec")).toBeNull();
		expect(screen.queryByText("events so far")).toBeNull();
	});

	// A collection load run (#3304): the gate frame carries the `scenario` block
	// beside the stream keys, and the frames between gates carry the stream keys alone.
	describe("a collection load run", () => {
		const SCENARIO: LiveScenarioProgress = {
			iterations: 12,
			iterationsCompleted: 9,
			iterationsAbandoned: 0,
			stepsExecuted: 30,
			steps: [
				{ index: 0, name: "Log in", executed: 12, errors: 0 },
				{ index: 1, name: "Subscribe", executed: 12, errors: 0 },
			],
		};

		it("draws the stream card beside the sequence panel, from a frame carrying both", async () => {
			renderView([stream(2, { scenario: SCENARIO })]);

			expect(await screen.findByText("events so far")).toBeTruthy();
			expect(tile("events so far")).toBe("1,200");
			expect(tile("events/sec")).toBe("340.5");
			expect(tile("streams open")).toBe("8");
			expect(screen.getByText("SEQUENCE")).toBeTruthy();
		});

		it("keeps the card on the plain stream frames that follow a gate frame", async () => {
			renderView([stream(2, { scenario: SCENARIO }), stream(2.1, { stream_events: 1500 })]);

			expect(await screen.findByText("events so far")).toBeTruthy();
			expect(tile("events so far")).toBe("1,500");
			expect(screen.getByText("SEQUENCE")).toBeTruthy();
		});

		it("draws a measured zero rate before any step has delivered an event", async () => {
			renderView([
				stream(2, {
					scenario: SCENARIO,
					stream_events: 0,
					events_per_second: 0,
					streams_open: 0,
				}),
			]);

			expect(await screen.findByText("events so far")).toBeTruthy();
			expect(tile("events so far")).toBe("0");
			expect(tile("events/sec")).toBe("0.0");
			expect(tile("streams open")).toBe("0");
		});

		it("draws no card for a collection whose frames carry no stream keys", async () => {
			renderView([
				tick(2, { scenario: SCENARIO, current_rps: 100 }),
				tick(2.1, { current_rps: 100 }),
			]);

			// The sequence panel is the proof this is a collection run that rendered.
			expect(await screen.findByText("SEQUENCE")).toBeTruthy();
			expect(screen.queryByText("Stream events")).toBeNull();
			expect(screen.queryByText("events so far")).toBeNull();
			expect(screen.queryByText("events/sec")).toBeNull();
			expect(screen.queryByText("streams open")).toBeNull();
		});
	});

	it("takes the time to first event from the latest gate frame, past plain frames after it", async () => {
		renderView([
			stream(1, {
				stream_time_to_first_event: { p50: 10, p95: 30, p99: 40, max: 50, count: 2 },
			}),
			stream(2, {
				stream_time_to_first_event: { p50: 120, p95: 800, p99: 900, max: 950, count: 9 },
			}),
			stream(2.1),
		]);

		expect(await screen.findByText("first event p50 / p95")).toBeTruthy();
		expect(tile("first event p50 / p95")).toBe("120ms / 800ms");
	});

	it("omits the first-event tile until a stream has delivered a timed event", async () => {
		renderView([stream(1), stream(2)]);

		expect(await screen.findByText("events so far")).toBeTruthy();
		expect(screen.queryByText(/first event/)).toBeNull();
	});
});
