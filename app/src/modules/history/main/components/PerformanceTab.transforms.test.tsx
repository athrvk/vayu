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
 * The Performance tab builds no series it does not plot (#1190).
 *
 * It used to build the whole percentile series in its own memo purely to read
 * `.some((d) => d.p99 > 0)` for the card's render gate, while
 * `LatencyPercentilesChart` built the identical series again from the identical
 * array - so a loaded run's ticks were transformed twice on every render of the
 * tab. This is the same smell #1152 removed from the live dashboard, and the
 * rule the dashboard README now states ("A chart card's render gate asks a
 * predicate, not a series"). Spying on the module is the only way to see it,
 * since both copies produced the same numbers.
 *
 * `runId` is left off so `HistoricalChartsSection` stays out of the tree, as
 * `MonitorSummary.test.tsx` does - it plots no percentiles, so it would only
 * add uPlot canvases to what is a transform-count assertion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics, RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

const spies = vi.hoisted(() => ({
	buildPercentileChartData: vi.fn(),
}));

vi.mock("@/modules/dashboard/utils/metricsTransforms", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/modules/dashboard/utils/metricsTransforms")>();
	return {
		...actual,
		buildPercentileChartData: (...args: Parameters<typeof actual.buildPercentileChartData>) => {
			spies.buildPercentileChartData(...args);
			return actual.buildPercentileChartData(...args);
		},
	};
});

const PerformanceTab = (await import("./PerformanceTab")).default;

/** Ticks spanning several 0.5s buckets, so the chart has something to draw. */
function ticks(n: number, p99: (i: number) => number): LoadTestMetrics[] {
	return Array.from({ length: n }, (_, i) => ({
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: i * 2,
		current_rps: 100 + i * 10,
		current_concurrency: 10 + i * 5,
		latency_p50_ms: 20 + i,
		latency_p95_ms: 40 + i * 3,
		latency_p99_ms: p99(i),
		avg_latency_ms: 25 + i,
		avg_queue_wait_ms: i * 0.5,
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		status_codes: { "200": i * 90 },
	}));
}

const withLatency = (n: number) => ticks(n, (i) => 80 + i * 8);
/** A run that completed nothing: every tick reports a zero p99. */
const withoutLatency = (n: number) => ticks(n, () => 0);

const REPORT = {
	metadata: { runId: "run_1", runType: "load", status: "completed" },
	summary: {
		totalRequests: 100,
		failedRequests: 0,
		requestsPerSecond: 10,
		testDuration: 10,
		errorRate: 0,
	},
	latency: { min: 1, max: 9, avg: 4, p50: 4, p90: 7, p95: 8, p99: 9 },
} as unknown as RunReport;

function derivedFor(mode: string): DashboardDerived {
	return { mode, targetRps: 0 } as unknown as DashboardDerived;
}

function renderTab(timeSeries: LoadTestMetrics[], mode = "constant_concurrency") {
	return render(
		<PerformanceTab
			report={REPORT}
			derived={derivedFor(mode)}
			timeSeries={timeSeries}
			monitorSamples={[]}
		/>
	);
}

describe("PerformanceTab percentile series", () => {
	beforeEach(() => {
		spies.buildPercentileChartData.mockClear();
	});

	it("builds the percentile series once - inside the chart that plots it", () => {
		const { rerender } = renderTab(withLatency(6));

		// A gate that rebuilt the series to test it would make this 2.
		expect(spies.buildPercentileChartData).toHaveBeenCalledTimes(1);

		rerender(
			<PerformanceTab
				report={REPORT}
				derived={derivedFor("constant_concurrency")}
				timeSeries={withLatency(7)}
				monitorSamples={[]}
			/>
		);

		expect(spies.buildPercentileChartData).toHaveBeenCalledTimes(2);
	});

	it("still shows the percentile card for a run whose ticks carry a p99", () => {
		// The count above would also hold if the card had silently stopped
		// rendering - then the transform would run zero times, not twice.
		const { getByText } = renderTab(withLatency(6));
		expect(getByText("Response Time Percentiles Over Time")).toBeTruthy();
	});

	it("builds nothing, and hides the card, when no tick reports a p99", () => {
		const { queryByText } = renderTab(withoutLatency(6));
		expect(queryByText("Response Time Percentiles Over Time")).toBeNull();
		expect(spies.buildPercentileChartData).not.toHaveBeenCalled();
	});

	it("builds nothing on a ramp_up run, which plots the scatter instead", () => {
		// The sharpest form of "no series it does not plot": this mode swaps in
		// `ResponseTimeVsConcurrencyChart`, which builds no percentile series at
		// all - so the only remaining caller would be a gate.
		const { getByText } = renderTab(withLatency(6), "ramp_up");
		expect(getByText("Response Time vs Concurrency")).toBeTruthy();
		expect(spies.buildPercentileChartData).not.toHaveBeenCalled();
	});
});
