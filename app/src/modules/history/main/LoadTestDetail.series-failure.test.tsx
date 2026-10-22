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
 * A failed series fetch reaches the Performance tab (#1944), and its Retry reads
 * the series again. Both series are one request each (#2547, #2611), so there is
 * no page to resume at: a failed read is re-requested only by Try again, never
 * on its own.
 *
 * `HistoricalChartsSection.test.tsx` pins what the section draws for a failure;
 * this pins the wiring above it: which call each Retry makes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { RunReport } from "@/types";
import LoadTestDetail from "./LoadTestDetail";

const series = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	refetch: vi.fn(),
	monitorState: {} as Record<string, unknown>,
	refetchMonitor: vi.fn(),
}));

vi.mock("@/queries/runs", () => ({
	useRunTimeSeriesQuery: () => ({
		isLoading: false,
		refetch: series.refetch,
		...series.state,
	}),
	useRunMonitorSeriesQuery: () => ({
		data: undefined,
		refetch: series.refetchMonitor,
		...series.monitorState,
	}),
	useRunQuery: () => ({ data: undefined }),
	useBaselineRunQuery: () => ({ data: undefined }),
	useRunReportQuery: () => ({ data: undefined }),
	useRequestRunsQuery: () => ({ data: undefined }),
}));

const REPORT = {
	metadata: {
		runId: "run_1",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 1000,
		requestUrl: "https://api.test/ping",
		requestMethod: "GET",
	},
	summary: { totalRequests: 74, failedRequests: 0, requestsPerSecond: 10, testDuration: 7.4 },
	latency: { min: 1, max: 120, avg: 10, p50: 8, p95: 30, p99: 90 },
} as unknown as RunReport;

/** A run that recorded server vitals, so `LoadTestDetail` issues the monitor fetch. */
const MONITORED_REPORT = {
	...REPORT,
	monitor: { samples: 4, failures: 0, series: {} },
} as unknown as RunReport;

const ERROR_TITLE = "Couldn't load the time-series data";
const MONITOR_ERROR_TITLE = "Couldn't load the server vitals";

function openPerformanceTab(report: RunReport = REPORT) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={report} runId="run_1" />
			</TooltipProvider>
		</QueryClientProvider>
	);
	// Radix switches tabs on mousedown, not on a synthesised click.
	fireEvent.mouseDown(screen.getByRole("tab", { name: /performance/i }));
}

beforeEach(() => {
	series.refetch.mockClear();
	series.refetchMonitor.mockClear();
	series.state = {};
	series.monitorState = {};
});

describe("a run whose time-series fetch failed", () => {
	it("reads the series again on Try again", () => {
		series.state = {
			data: undefined,
			isError: true,
			error: new Error("Failed to fetch"),
		};

		openPerformanceTab();

		expect(screen.getByText(ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText("Failed to fetch")).toBeTruthy();
		expect(screen.queryByText(/Not enough data for charts yet/)).toBeNull();
		expect(series.refetch).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.refetch).toHaveBeenCalledTimes(1);
	});
});

describe("a run whose server-vitals fetch failed", () => {
	it("Try again reads the vitals again, once", () => {
		series.monitorState = {
			data: undefined,
			isError: true,
			error: new Error("Failed to fetch"),
		};

		openPerformanceTab(MONITORED_REPORT);

		expect(series.refetchMonitor).not.toHaveBeenCalled();
		expect(screen.getByText(MONITOR_ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText(/Failed to fetch/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.refetchMonitor).toHaveBeenCalledTimes(1);
	});

	it("names the missing data when the engine gave no message", () => {
		series.monitorState = { data: undefined, isError: true, error: null };

		openPerformanceTab(MONITORED_REPORT);

		expect(screen.getByText(/Vayu's engine returned no server-vitals data\./)).toBeTruthy();
	});

	it("shows beside a time series too short to chart, and beside a failed one", () => {
		series.state = {
			data: undefined,
			isError: true,
			error: new Error("series down"),
		};
		series.monitorState = {
			data: undefined,
			isError: true,
			error: new Error("vitals down"),
		};

		openPerformanceTab(MONITORED_REPORT);

		expect(screen.getByText(ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText(MONITOR_ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText(/vitals down/)).toBeTruthy();
	});

	it("draws no failure while the query is healthy", () => {
		series.monitorState = {
			data: { data: [{ timestamp: 0, series: { cpu: 1 } }] },
			isError: false,
		};

		openPerformanceTab(MONITORED_REPORT);

		expect(screen.queryByText(MONITOR_ERROR_TITLE)).toBeNull();
	});
});
