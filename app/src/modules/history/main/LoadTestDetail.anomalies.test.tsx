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
 * The Events list on a stored run (issue #477).
 *
 * `detectAnomalies` has its own tests; what this pins is the wiring, which is
 * where this kind of feature usually dies: the detector runs over the *fetched
 * per-tick series* (not the report, which has no windows in it), and its result
 * reaches the Overview tab in words. A run with no findings must grow no card at
 * all - an "Events (0)" heading would point the reader at the one thing with
 * nothing to say.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { ReactElement } from "react";
import type { LoadTestMetrics, RunReport } from "@/types";
import LoadTestDetail from "./LoadTestDetail";

const series = vi.hoisted(() => ({ current: [] as LoadTestMetrics[] }));

vi.mock("@/queries/runs", () => ({
	useRunTimeSeriesQuery: () => ({
		data: {
			pages: [
				{
					data: series.current,
					pagination: {
						total: series.current.length,
						limit: 1000,
						offset: 0,
						hasMore: false,
						returned: series.current.length,
					},
				},
			],
		},
		isLoading: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	}),
	// Server vitals are a separate query on this pane; these runs scrape nothing.
	useRunMonitorSeriesQuery: () => ({
		data: undefined,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	}),
	// So is the header's vs-baseline strip. Nothing here pins a run, and a
	// strip with no baseline draws nothing - which is the state these cases
	// render in.
	useRunQuery: () => ({ data: undefined }),
	useBaselineRunQuery: () => ({ data: undefined }),
	useRunReportQuery: () => ({ data: undefined }),
}));

function renderDetail(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);
}

const REPORT = {
	metadata: {
		runId: "run_1",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 40_000,
		requestUrl: "https://api.test/ping",
		requestMethod: "GET",
	},
	summary: {
		totalRequests: 20_000,
		failedRequests: 0,
		requestsPerSecond: 500,
		testDuration: 40,
		errorRate: 0,
	},
	latency: { min: 1, max: 480, avg: 110, p50: 100, p95: 130, p99: 120 },
} as unknown as RunReport;

/** A steady run, mildly drifting - the shape a healthy target produces. */
function ticks(over: (i: number) => Partial<LoadTestMetrics> = () => ({})): LoadTestMetrics[] {
	return Array.from({ length: 40 }, (_, i) => ({
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 500,
		requests_failed: 0,
		current_rps: 500,
		current_concurrency: 50,
		latency_p50_ms: 90 + i,
		latency_p95_ms: 95 + i,
		latency_p99_ms: 100 + i,
		avg_latency_ms: 92 + i,
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		...over(i),
	}));
}

beforeEach(() => {
	series.current = [];
});

describe("a stored run's Events list", () => {
	it("names the window a mid-run spike lived in", () => {
		series.current = ticks((i) => (i === 20 || i === 21 ? { latency_p99_ms: 480 } : {}));

		renderDetail(<LoadTestDetail report={REPORT} runId="run_1" />);

		expect(screen.getByText("Events")).toBeTruthy();
		expect(screen.getByText("Latency spike")).toBeTruthy();
		expect(screen.getByText(/p99 4\.3x baseline/)).toBeTruthy();
		// The window, not just the fact - "when" is the question the summary
		// cannot answer.
		expect(screen.getByText("20.0s - 21.0s")).toBeTruthy();
	});

	it("shows nothing for a clean run", () => {
		series.current = ticks();

		renderDetail(<LoadTestDetail report={REPORT} runId="run_1" />);

		expect(screen.queryByText("Events")).toBeNull();
		expect(screen.queryByText("Latency spike")).toBeNull();
	});

	it("shows nothing when the run has no stored series at all", () => {
		// Runs recorded before per-tick persistence, and any run whose series
		// failed to load: the detector has nothing to read, so the tab reads
		// exactly as it did before this feature existed.
		renderDetail(<LoadTestDetail report={REPORT} runId="run_1" />);

		expect(screen.queryByText("Events")).toBeNull();
	});
});
