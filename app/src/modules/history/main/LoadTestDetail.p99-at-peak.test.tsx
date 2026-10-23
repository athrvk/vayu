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
 * A ramp_up run's History "p99 at peak" reads the stored per-tick series at the
 * run's peak load, not the report's overall p99 and not the breakpoint tick.
 *
 * Mutation check: drop `p99AtPeakMs` from the bundle `LoadTestDetail` derives
 * and the stat falls back to the report's 100 ms p99, so the first case
 * reddens; restore `d.breakpoint.p99Ms` in `P99AtPeakStat` and it reads 203.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { LoadTestMetrics, RunReport } from "@/types";
import LoadTestDetail from "./LoadTestDetail";

vi.mock("@/services/api", () => ({
	apiService: {
		getRun: vi.fn(),
		listRuns: vi.fn(),
		getRunReport: vi.fn(),
		getRunTimeSeries: vi.fn(),
		getRunMonitorSeries: vi.fn(),
	},
}));

const mocked = vi.mocked(apiService);

const emptyPage = {
	data: [],
	pagination: { total: 0, limit: 50, offset: 0, hasMore: false, returned: 0 },
};

/** 1 -> 30 virtual users over 30 s; p99 crosses the 200 ms SLO at 19 (203 ms), 292 ms at 30. */
function rampTicks(): LoadTestMetrics[] {
	return Array.from({ length: 30 }, (_, i) => {
		const vu = i + 1;
		const p99 = vu < 19 ? 60 + vu : 203 + (vu - 19) * (89 / 11);
		return {
			timestamp: vu * 1000,
			elapsed_seconds: vu,
			requests_completed: vu * 10,
			requests_failed: 0,
			current_rps: 10,
			current_concurrency: vu,
			latency_p50_ms: 20,
			latency_p95_ms: 40,
			latency_p99_ms: Math.round(p99),
			avg_latency_ms: 25,
			bytes_sent: 0,
			bytes_received: 0,
		};
	});
}

function report(): RunReport {
	return {
		metadata: {
			runId: "run_ramp",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 30_000,
			requestUrl: "https://api.test/ping",
			requestMethod: "GET",
			configuration: {
				mode: "ramp_up",
				concurrency: 30,
				startConcurrency: 1,
				duration: "30s",
			},
		},
		summary: {
			totalRequests: 3000,
			successfulRequests: 3000,
			failedRequests: 0,
			errorRate: 0,
			testDuration: 30,
			peakConcurrency: 30,
		},
		latency: { min: 1, max: 300, avg: 25, p50: 20, p95: 40, p99: 100 },
		statusCodes: { "200": 3000 },
	} as unknown as RunReport;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocked.getRun.mockResolvedValue({ id: "run_ramp", type: "load", status: "completed" } as never);
	mocked.listRuns.mockResolvedValue(emptyPage as never);
	mocked.getRunMonitorSeries.mockResolvedValue(emptyPage as never);
});

describe("p99 at peak on a stored ramp_up run", () => {
	it("reads the worst second at the peak load, not the breakpoint's or the report's p99", async () => {
		const ticks = rampTicks();
		mocked.getRunTimeSeries.mockResolvedValue({
			data: ticks,
			bucketed: false,
			ticksPerBucket: 1,
			pagination: { total: 30, limit: 5000, offset: 0, hasMore: false, returned: 30 },
		} as never);

		render(withQueryClient(<LoadTestDetail report={report()} runId="run_ramp" />));

		const label = await screen.findByText("p99 at peak");
		const card = label.parentElement as HTMLElement;
		// 292 ms at 30 virtual users; the breakpoint tick read 203 and the report 100.
		expect(await screen.findByText("292")).toBeTruthy();
		expect(card.textContent).not.toContain("203");
		expect(card.textContent).not.toContain("100");
	});
});
