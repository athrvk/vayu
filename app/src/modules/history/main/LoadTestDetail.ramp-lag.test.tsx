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
 * A finished ramp_up run's concurrency card reports its ramp lag from the
 * stored per-tick series (#2870): the report carries no per-tick concurrency,
 * so `LoadTestDetail` fills `rampDeviationPct` from `buildRampOverlay`.
 *
 * Mutation check: drop `rampDeviationPct` from the bundle `LoadTestDetail`
 * derives and the finished card prints no "lag" clause, so the first case
 * reddens.
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

/**
 * 1 -> 30 virtual users over 30 s, achieved = the second's index. The plan is
 * 1 + 29t/30, so the gap is 1 - t/30 for t < 30 and 0 at t = 30: a mean of
 * 14.5 / 30 users over 30 s, which is 1.6% of the 30-user target.
 */
function rampTicks(): LoadTestMetrics[] {
	return Array.from({ length: 30 }, (_, i) => {
		const second = i + 1;
		return {
			timestamp: second * 1000,
			elapsed_seconds: second,
			requests_completed: second * 10,
			requests_failed: 0,
			current_rps: 10,
			current_concurrency: second,
			latency_p50_ms: 20,
			latency_p95_ms: 40,
			latency_p99_ms: 60,
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
				rampUpDuration: "30s",
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

function serveSeries(data: LoadTestMetrics[]) {
	mocked.getRunTimeSeries.mockResolvedValue({
		data,
		bucketed: false,
		ticksPerBucket: 1,
		pagination: {
			total: data.length,
			limit: 5000,
			offset: 0,
			hasMore: false,
			returned: data.length,
		},
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocked.getRun.mockResolvedValue({ id: "run_ramp", type: "load", status: "completed" } as never);
	mocked.listRuns.mockResolvedValue(emptyPage as never);
	mocked.getRunMonitorSeries.mockResolvedValue(emptyPage as never);
});

describe("ramp lag on a stored ramp_up run", () => {
	it("reads the deviation from the stored series under the Peak virtual users title", async () => {
		serveSeries(rampTicks());

		render(withQueryClient(<LoadTestDetail report={report()} runId="run_ramp" />));

		const subtitle = await screen.findByText(/targeting/);
		await vi.waitFor(() => expect(subtitle.textContent).toContain("lag 1.6%"));
		expect(subtitle.textContent).toMatch(/^targeting 30 over \S+ ramp · lag 1\.6%$/);
		expect(screen.getAllByText("Peak virtual users").length).toBeGreaterThan(0);
		expect(screen.queryByText("Active virtual users")).toBeNull();
	});

	it("prints no lag clause when the run stored no series", async () => {
		serveSeries([]);

		render(withQueryClient(<LoadTestDetail report={report()} runId="run_ramp" />));

		const subtitle = await screen.findByText(/targeting/);
		await vi.waitFor(() => expect(mocked.getRunTimeSeries).toHaveBeenCalled());
		expect(subtitle.textContent).toMatch(/^targeting 30 over \S+ ramp$/);
		expect(subtitle.textContent).not.toContain("lag");
		expect(subtitle.textContent).not.toContain("%");
	});
});
