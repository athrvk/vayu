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
 * A failed time-series fetch reaches the Performance tab (#1944), and its Retry
 * reads the series again; the series is one request (#2547), so there is no
 * page to resume at. The server-vitals series still pages, and a failed page of
 * it must not turn the auto-paging effect into a retry loop (#2062).
 *
 * `HistoricalChartsSection.test.tsx` pins what the section draws for a failure;
 * this pins the wiring above it: which call each Retry makes (the first page
 * starts over, a later page resumes where it failed) and that a failed page is
 * not re-requested on its own. TanStack does not retry a failed
 * `fetchNextPage`, and the effect that pages through the vitals fires whenever
 * `hasNextPage` is true and nothing is fetching - which is also the state right
 * after a failed page.
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
	fetchMoreMonitor: vi.fn(),
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
		isFetchingNextPage: false,
		fetchNextPage: series.fetchMoreMonitor,
		refetch: series.refetchMonitor,
		hasNextPage: false,
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
	series.fetchMoreMonitor.mockClear();
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
		expect(screen.queryByText(/Insufficient data points/)).toBeNull();
		expect(series.refetch).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.refetch).toHaveBeenCalledTimes(1);
	});
});

/** One loaded page of a longer vitals series. */
const firstMonitorPage = {
	pages: [
		{
			data: [{ timestamp: 0, series: { cpu: 1 } }],
			pagination: { total: 2500, limit: 1000, offset: 0, hasMore: true, returned: 1 },
		},
	],
};

describe("a run whose server-vitals fetch failed", () => {
	it("is not re-requested on its own, and Try again resumes at the failed page", () => {
		series.monitorState = {
			data: firstMonitorPage,
			isError: true,
			error: new Error("Failed to fetch"),
			hasNextPage: true,
		};

		openPerformanceTab(MONITORED_REPORT);

		expect(series.fetchMoreMonitor).not.toHaveBeenCalled();
		expect(screen.getByText(MONITOR_ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText(/Failed to fetch/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.fetchMoreMonitor).toHaveBeenCalledTimes(1);
		expect(series.refetchMonitor).not.toHaveBeenCalled();
	});

	it("starts over with refetch when no page ever loaded, naming the missing data", () => {
		series.monitorState = { data: undefined, isError: true, error: null, hasNextPage: false };

		openPerformanceTab(MONITORED_REPORT);

		expect(screen.getByText(/The engine returned no server-vitals data\./)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.refetchMonitor).toHaveBeenCalledTimes(1);
		expect(series.fetchMoreMonitor).not.toHaveBeenCalled();
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
			hasNextPage: false,
		};

		openPerformanceTab(MONITORED_REPORT);

		expect(screen.getByText(ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText(MONITOR_ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText(/vitals down/)).toBeTruthy();
	});

	it("keeps paging on its own while the query is healthy", () => {
		series.monitorState = { data: firstMonitorPage, isError: false, hasNextPage: true };

		openPerformanceTab(MONITORED_REPORT);

		expect(series.fetchMoreMonitor).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(MONITOR_ERROR_TITLE)).toBeNull();
	});
});
