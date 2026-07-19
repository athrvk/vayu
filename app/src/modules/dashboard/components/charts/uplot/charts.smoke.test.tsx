/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Smoke tests for the centralized uPlot charts. The old SVG charts were
 * snapshot-locked; Canvas output isn't meaningfully snapshottable, so we instead
 * assert each chart mounts and unmounts cleanly over the shared mocked canvas
 * context (jsdom), and that the <2-point guards return null. Rendering fidelity
 * is validated visually (Playwright), and data-shaping in buildData.test.ts.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics, RunReport } from "@/types";
import {
	LatencyPercentilesChart,
	LatencyBreakdownChart,
	RequestRateChart,
	ConnectionsChart,
	ErrorRateChart,
	ResponseTimeVsConcurrencyChart,
	StatusCodesOverTimeChart,
	HdrPercentileChart,
} from "./index";

function series(n: number): LoadTestMetrics[] {
	return Array.from({ length: n }, (_, i) => ({
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: i * 2,
		current_rps: 100 + i * 10,
		current_concurrency: i * 20,
		latency_p50_ms: 20 + i,
		latency_p95_ms: 40 + i * 3,
		latency_p99_ms: 80 + i * 8,
		avg_latency_ms: 25 + i,
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		send_rate: 110 + i * 10,
		throughput: 100 + i * 9,
		avg_queue_wait_ms: i * 0.5,
		status_codes: { "200": i * 90, "404": i * 5, "500": i * 3 },
	}));
}

const history = series(6);
const report: RunReport = {
	latency: { min: 5, avg: 25, p50: 20, p75: 30, p90: 45, p95: 60, p99: 120, p999: 200, max: 240 },
} as RunReport;

describe("centralized uPlot charts — smoke", () => {
	it("renders every chart without throwing", () => {
		const cases = [
			<LatencyPercentilesChart key="a" history={history} />,
			<LatencyBreakdownChart key="b" history={history} />,
			<RequestRateChart key="c" history={history} targetRps={500} />,
			<ConnectionsChart key="d" history={history} />,
			<ErrorRateChart key="e" history={history} />,
			<ResponseTimeVsConcurrencyChart key="f" history={history} />,
			<StatusCodesOverTimeChart key="g" history={history} />,
			<HdrPercentileChart key="h" report={report} />,
		];
		for (const node of cases) {
			const { unmount } = render(node);
			unmount();
		}
		expect(true).toBe(true);
	});

	it("renders the ramp overlay (secondary axis) branch", () => {
		const { container, unmount } = render(
			<RequestRateChart
				history={history}
				targetRps={400}
				rampOverlay={{
					points: history.map((m) => ({
						time: m.elapsed_seconds,
						configured: m.current_concurrency,
						achieved: m.current_concurrency - 5,
					})),
					target: 100,
					peakAchieved: 95,
					rampDeviationPct: 8,
				}}
				breakpoint={{ crossed: true, concurrency: 60, timeSeconds: 3, p99Ms: 104 }}
			/>
		);
		expect(container.querySelector("div")).not.toBeNull();
		unmount();
	});

	it("returns null below 2 points", () => {
		const { container } = render(<LatencyPercentilesChart history={series(1)} />);
		expect(container.innerHTML).toBe("");
	});
});
