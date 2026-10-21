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
 * A long run's History page reads its series in one downsampled request
 * (#2547), where it used to page in every stored tick: a 24 h soak was 18
 * requests of 5,000 raw ticks, held for half an hour. The server vitals read
 * the same way (#2611).
 *
 * The engine is stubbed as it answers: a `maxPoints` read folds the stored
 * series (`foldLikeEngine`, `foldLikeEngineMonitor`), a `limit`/`offset` read
 * is a raw page with `hasMore`. So a pane that went back to paging would be
 * served pages and keep asking, which is what the call assertions catch.
 *
 * Mutation check: restore the `useInfiniteQuery` read and the auto-paging
 * effect in `LoadTestDetail` and the 86,400-tick case reddens on the call's
 * arguments and count, and the monitored case does the same for the vitals;
 * drop `ticksPerBucket` from the props it hands the Performance tab and its
 * note case reddens, and drop `monitorTicksPerBucket` and the vitals note case
 * does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import { HISTORY_SERIES_MAX_POINTS } from "@/config/network";
import {
	foldLikeEngine,
	foldLikeEngineMonitor,
	storedMonitorSamples,
	storedTicks,
} from "@/modules/dashboard/utils/downsample.testkit";
import type { LoadTestMetrics, MonitorSample, RunReport } from "@/types";
import type { MonitorSeriesResponse, TimeSeriesResponse } from "../types";
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

// The charts are not the subject, and a canvas per chart over ~2,000 points
// is render cost every run would pay; what reaches them is.
vi.mock("@/modules/dashboard/components/charts/uplot", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	const stub = (name: string) => () => <div data-testid={name} />;
	return {
		...actual,
		RequestRateChart: stub("rate-chart"),
		ConnectionsChart: stub("connections-chart"),
		StatusCodesOverTimeChart: stub("status-chart"),
		ServerVitalsChart: stub("vitals-chart"),
		CustomMetricsChart: stub("custom-chart"),
		LatencyPercentilesChart: stub("percentile-chart"),
		ResponseTimeVsConcurrencyChart: stub("scatter-chart"),
		HdrPercentileChart: stub("hdr-chart"),
	};
});

const mocked = vi.mocked(apiService);

const DAY_SECONDS = 86_400;

/** A p99 ten times its baseline for five minutes, mid-run. */
const spiked = (s: number) => (s >= 40_000 && s < 40_300 ? { p99: 500 } : {});

function report(seconds: number, monitoredSamples = 0): RunReport {
	return {
		metadata: {
			runId: "run_long",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: seconds * 1000,
			requestUrl: "https://api.test/ping",
			requestMethod: "GET",
		},
		summary: {
			totalRequests: seconds * 100,
			failedRequests: 0,
			requestsPerSecond: 100,
			testDuration: seconds,
			errorRate: 0,
		},
		latency: { min: 1, max: 500, avg: 13, p50: 10, p95: 25, p99: 50 },
		monitor: { samples: monitoredSamples, failures: 0, series: {} },
	} as unknown as RunReport;
}

const emptyPage = {
	data: [],
	pagination: { total: 0, limit: 50, offset: 0, hasMore: false, returned: 0 },
};

/** The engine's two answers to `GET /runs/:id/metrics` over `ticks`. */
function serveLikeEngine(ticks: LoadTestMetrics[]) {
	mocked.getRunTimeSeries.mockImplementation(async (_id, options = {}) => {
		if (options.maxPoints !== undefined) return foldLikeEngine(ticks, options.maxPoints);
		const limit = options.limit ?? 5000;
		const offset = options.offset ?? 0;
		const data = ticks.slice(offset, offset + limit);
		return {
			data,
			pagination: {
				total: ticks.length,
				limit,
				offset,
				hasMore: offset + limit < ticks.length,
				returned: data.length,
			},
		} satisfies TimeSeriesResponse;
	});
}

/** The engine's two answers to `GET /runs/:id/monitor` over `samples`. */
function serveMonitorLikeEngine(samples: MonitorSample[]) {
	mocked.getRunMonitorSeries.mockImplementation(async (_id, options = {}) => {
		if (options.maxPoints !== undefined)
			return foldLikeEngineMonitor(samples, options.maxPoints);
		const limit = options.limit ?? 5000;
		const offset = options.offset ?? 0;
		const data = samples.slice(offset, offset + limit);
		return {
			data,
			pagination: {
				total: samples.length,
				limit,
				offset,
				hasMore: offset + limit < samples.length,
				returned: data.length,
			},
		} satisfies MonitorSeriesResponse;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocked.getRun.mockResolvedValue({ id: "run_long", type: "load", status: "completed" } as never);
	mocked.listRuns.mockResolvedValue(emptyPage as never);
	mocked.getRunMonitorSeries.mockResolvedValue(emptyPage as never);
});

function openPerformanceTab() {
	fireEvent.mouseDown(screen.getByRole("tab", { name: /performance/i }), { button: 0 });
}

describe("a 24 h run's History page", () => {
	it("asks once for the downsampled series and never pages, and still names the spike", async () => {
		serveLikeEngine(storedTicks(DAY_SECONDS, spiked));

		render(withQueryClient(<LoadTestDetail report={report(DAY_SECONDS)} runId="run_long" />));

		// The detector ran over the buckets: the five-minute spike spans several.
		expect(await screen.findByText("Latency spike")).toBeTruthy();
		expect(screen.getByText(/p99 10\.0x baseline/)).toBeTruthy();

		openPerformanceTab();
		expect(await screen.findByText(/Each point covers 44\.00s of this run/)).toBeTruthy();
		expect(screen.getByTestId("rate-chart")).toBeTruthy();

		expect(mocked.getRunTimeSeries).toHaveBeenCalledTimes(1);
		expect(mocked.getRunTimeSeries).toHaveBeenCalledWith("run_long", {
			maxPoints: HISTORY_SERIES_MAX_POINTS,
		});
		const answer = await mocked.getRunTimeSeries.mock.results[0].value;
		expect(answer.bucketed).toBe(true);
		expect(answer.data.length).toBeLessThanOrEqual(HISTORY_SERIES_MAX_POINTS);
		expect(answer.pagination.total).toBe(DAY_SECONDS);
		// This run scraped nothing, so there is no vitals read at all.
		expect(mocked.getRunMonitorSeries).not.toHaveBeenCalled();
	});
});

describe("a run short enough to arrive raw", () => {
	it("charts every tick with no bucket note, from the same single request", async () => {
		serveLikeEngine(storedTicks(600));

		render(withQueryClient(<LoadTestDetail report={report(600)} runId="run_long" />));
		openPerformanceTab();

		expect(await screen.findByTestId("rate-chart")).toBeTruthy();
		expect(screen.queryByText(/Each point covers/)).toBeNull();
		await waitFor(() => expect(mocked.getRunTimeSeries).toHaveBeenCalledTimes(1));
		const answer = await mocked.getRunTimeSeries.mock.results[0].value;
		expect(answer).toMatchObject({ bucketed: false, ticksPerBucket: 1 });
		expect(answer.data).toHaveLength(600);
	});
});

describe("a 24 h run that scraped server vitals", () => {
	// A scrape every fifth second: 17,280 of them, nine to a bucket.
	const SCRAPE_MS = 5000;
	const SCRAPES = (DAY_SECONDS * 1000) / SCRAPE_MS;

	it("asks once for the downsampled vitals, never pages, and says what a point is", async () => {
		serveLikeEngine(storedTicks(DAY_SECONDS));
		serveMonitorLikeEngine(storedMonitorSamples(SCRAPES, SCRAPE_MS));

		render(
			withQueryClient(
				<LoadTestDetail report={report(DAY_SECONDS, SCRAPES)} runId="run_long" />
			)
		);
		openPerformanceTab();

		const chart = await screen.findByTestId("vitals-chart");
		const card = chart.closest("div[class*='enter-fade']") as HTMLElement;
		expect(within(card).getByText(/Each point covers 9 scrapes/)).toBeTruthy();

		expect(mocked.getRunMonitorSeries).toHaveBeenCalledTimes(1);
		expect(mocked.getRunMonitorSeries).toHaveBeenCalledWith("run_long", {
			maxPoints: HISTORY_SERIES_MAX_POINTS,
		});
		const answer = await mocked.getRunMonitorSeries.mock.results[0].value;
		expect(answer.bucketed).toBe(true);
		expect(answer.pagination.total).toBe(SCRAPES);
	});

	it("draws no vitals note for a run whose scrapes arrive raw", async () => {
		serveLikeEngine(storedTicks(600));
		serveMonitorLikeEngine(storedMonitorSamples(120, SCRAPE_MS));

		render(withQueryClient(<LoadTestDetail report={report(600, 120)} runId="run_long" />));
		openPerformanceTab();

		expect(await screen.findByTestId("vitals-chart")).toBeTruthy();
		expect(screen.queryByText(/Each point covers/)).toBeNull();
		expect(mocked.getRunMonitorSeries).toHaveBeenCalledTimes(1);
		const answer = await mocked.getRunMonitorSeries.mock.results[0].value;
		expect(answer).toMatchObject({ bucketed: false, ticksPerBucket: 1 });
	});
});
