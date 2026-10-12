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
 * A failed time-series fetch reaches the Performance tab (#1944), and does not
 * turn the auto-paging effect into a retry loop.
 *
 * `HistoricalChartsSection.test.tsx` pins what the section draws for a failure;
 * this pins the wiring above it: which call each Retry makes (the first page
 * starts over, a later page resumes where it failed) and that a failed page is
 * not re-requested on its own. TanStack does not retry a failed
 * `fetchNextPage`, and the effect that pages through the series fires whenever
 * `hasNextPage` is true and nothing is fetching - which is also the state right
 * after a failed page.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { LoadTestMetrics, RunReport } from "@/types";
import LoadTestDetail from "./LoadTestDetail";

const series = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	fetchNextPage: vi.fn(),
	refetch: vi.fn(),
}));

vi.mock("@/queries/runs", () => ({
	useRunTimeSeriesQuery: () => ({
		isLoading: false,
		isFetchingNextPage: false,
		fetchNextPage: series.fetchNextPage,
		refetch: series.refetch,
		...series.state,
	}),
	useRunMonitorSeriesQuery: () => ({
		data: undefined,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	}),
	useRunQuery: () => ({ data: undefined }),
	useBaselineRunQuery: () => ({ data: undefined }),
	useRunReportQuery: () => ({ data: undefined }),
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

const ERROR_TITLE = "Couldn't load the time-series data";

/** One loaded page of a longer series: a single tick, so the charts stay out of the tree. */
const firstPageOnly = {
	pages: [
		{
			data: [{ timestamp: 0, elapsed_seconds: 0 } as LoadTestMetrics],
			pagination: { total: 2500, limit: 1000, offset: 0, hasMore: true, returned: 1 },
		},
	],
};

function openPerformanceTab() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={REPORT} runId="run_1" />
			</TooltipProvider>
		</QueryClientProvider>
	);
	// Radix switches tabs on mousedown, not on a synthesised click.
	fireEvent.mouseDown(screen.getByRole("tab", { name: /performance/i }));
}

beforeEach(() => {
	series.fetchNextPage.mockClear();
	series.refetch.mockClear();
	series.state = {};
});

describe("a run whose time-series fetch failed", () => {
	it("starts over with refetch when no page ever loaded", () => {
		series.state = {
			data: undefined,
			isError: true,
			error: new Error("Failed to fetch"),
			hasNextPage: false,
		};

		openPerformanceTab();

		expect(screen.getByText(ERROR_TITLE)).toBeTruthy();
		expect(screen.getByText("Failed to fetch")).toBeTruthy();
		expect(screen.queryByText(/Insufficient data points/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.refetch).toHaveBeenCalledTimes(1);
		expect(series.fetchNextPage).not.toHaveBeenCalled();
	});

	it("resumes at the failed page when earlier pages loaded", () => {
		series.state = {
			data: firstPageOnly,
			isError: true,
			error: new Error("Failed to fetch"),
			hasNextPage: true,
		};

		openPerformanceTab();

		// The effect must not have re-requested the failed page on its own.
		expect(series.fetchNextPage).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(series.fetchNextPage).toHaveBeenCalledTimes(1);
		expect(series.refetch).not.toHaveBeenCalled();
	});

	it("keeps paging on its own while the query is healthy", () => {
		series.state = { data: firstPageOnly, isError: false, error: null, hasNextPage: true };

		openPerformanceTab();

		expect(series.fetchNextPage).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(ERROR_TITLE)).toBeNull();
	});
});
