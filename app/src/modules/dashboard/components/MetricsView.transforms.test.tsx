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
 * Each series transform runs once per flush, not once per layer (#1152).
 *
 * MetricsView used to build the latency, percentile and status series in its
 * own memos purely to read `.length` for a card's render gate, while the chart
 * inside that card built the identical series again from the identical array -
 * so the three heaviest transforms were paid twice on every store commit, ~2Hz
 * for the life of a run. The gates now ask a predicate; the chart that plots a
 * series is the only place it is built. Spying on the module is the only way to
 * see that, since both copies produced the same numbers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMetrics, MetricsViewProps } from "../types";
import type { LoadTestMetrics } from "@/types";

const spies = vi.hoisted(() => ({
	buildLatencyChartData: vi.fn(),
	buildPercentileChartData: vi.fn(),
	buildStatusOverTime: vi.fn(),
}));

vi.mock("../utils/metricsTransforms", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/metricsTransforms")>();
	return {
		...actual,
		buildLatencyChartData: (...args: Parameters<typeof actual.buildLatencyChartData>) => {
			spies.buildLatencyChartData(...args);
			return actual.buildLatencyChartData(...args);
		},
		buildPercentileChartData: (...args: Parameters<typeof actual.buildPercentileChartData>) => {
			spies.buildPercentileChartData(...args);
			return actual.buildPercentileChartData(...args);
		},
		buildStatusOverTime: (...args: Parameters<typeof actual.buildStatusOverTime>) => {
			spies.buildStatusOverTime(...args);
			return actual.buildStatusOverTime(...args);
		},
	};
});

const MetricsView = (await import("./MetricsView")).default;

/** Ticks that make all three cards render: two 0.5s buckets, p99 and statuses. */
function history(n: number): LoadTestMetrics[] {
	return Array.from({ length: n }, (_, i) => ({
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
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		status_codes: { "200": i * 90, "500": i * 3 },
	}));
}

const metrics: DisplayMetrics = {
	requests_completed: 500,
	requests_failed: 4,
	current_rps: 120,
	latency_p50_ms: 22,
	latency_p95_ms: 48,
	latency_p99_ms: 96,
	avg_latency_ms: 27,
	bytes_sent: 5000,
	bytes_received: 25000,
} as DisplayMetrics;

function props(ticks: LoadTestMetrics[]): MetricsViewProps {
	return {
		metrics,
		historicalMetrics: ticks,
		isCompleted: false,
		finalReport: null,
		// Not ramp_up: that mode swaps the percentile card for the scatter, and
		// the percentile transform is one of the three under test here.
		mode: "constant_concurrency",
		concurrency: 10,
	};
}

function renderView(ticks: LoadTestMetrics[]) {
	return render(
		<TooltipProvider>
			<MetricsView {...props(ticks)} />
		</TooltipProvider>
	);
}

describe("MetricsView series transforms", () => {
	beforeEach(() => {
		spies.buildLatencyChartData.mockClear();
		spies.buildPercentileChartData.mockClear();
		spies.buildStatusOverTime.mockClear();
	});

	it("builds each series exactly once per flush", () => {
		const { rerender } = renderView(history(6));

		// Once each: inside the chart that plots it. A gate that rebuilt the
		// series to read its length would make each of these 2.
		expect(spies.buildLatencyChartData).toHaveBeenCalledTimes(1);
		expect(spies.buildPercentileChartData).toHaveBeenCalledTimes(1);
		expect(spies.buildStatusOverTime).toHaveBeenCalledTimes(1);

		// A flush: the store hands down a new array on every batch.
		rerender(
			<TooltipProvider>
				<MetricsView {...props(history(7))} />
			</TooltipProvider>
		);

		expect(spies.buildLatencyChartData).toHaveBeenCalledTimes(2);
		expect(spies.buildPercentileChartData).toHaveBeenCalledTimes(2);
		expect(spies.buildStatusOverTime).toHaveBeenCalledTimes(2);
	});

	it("renders the three cards whose gates those transforms used to build", () => {
		// The counts above would also hold if a card had silently stopped
		// rendering - then the transform would run zero times, not twice.
		const { getByText } = renderView(history(6));
		expect(getByText("Latency over time")).toBeTruthy();
		expect(getByText("Response time percentiles over time")).toBeTruthy();
		expect(getByText("Status codes over time")).toBeTruthy();
	});

	it("builds nothing while a run has one bucket of ticks", () => {
		// Both layers agreed on this before; the gates keep it true, so an early
		// flush costs no transform at all.
		renderView([]);
		expect(spies.buildLatencyChartData).not.toHaveBeenCalled();
		expect(spies.buildPercentileChartData).not.toHaveBeenCalled();
		expect(spies.buildStatusOverTime).not.toHaveBeenCalled();
	});
});
