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
 * The report's way into the compare view (#2164): a header action, and the
 * store target a History row's "Compare with…" sets for a run that is opened
 * (or already open) on screen.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import { useTabsStore } from "@/stores";
import type { Run, RunReport } from "@/types";
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

const REPORT = {
	metadata: {
		runId: "run_open",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 1000,
		requestUrl: "https://api.test/ping",
		requestMethod: "GET",
	},
	summary: {
		totalRequests: 74,
		successfulRequests: 74,
		failedRequests: 0,
		errorRate: 0,
		totalDurationSeconds: 7.4,
		avgRps: 10,
	},
	latency: { min: 1, max: 120, avg: 10, p50: 8, p90: 20, p95: 30, p99: 90 },
	statusCodes: { "200": 74 },
	errors: { total: 0, withDetails: 0, types: {} },
} as unknown as RunReport;

function run(over: Partial<Run> = {}): Run {
	return {
		id: "run_open",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_010_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.test/ping", method: "GET" },
		...over,
	} as Run;
}

const emptyPage = {
	data: [],
	pagination: { total: 0, limit: 50, offset: 0, hasMore: false, returned: 0, nextBefore: null },
};

function renderDetail() {
	return render(withQueryClient(<LoadTestDetail report={REPORT} runId="run_open" />));
}

const compareButton = () => screen.queryByRole("button", { name: "Compare" });

beforeEach(() => {
	vi.clearAllMocks();
	useTabsStore.setState({ compareRunTarget: null });
	mocked.getRun.mockResolvedValue(run());
	mocked.listRuns.mockResolvedValue(emptyPage);
	mocked.getRunTimeSeries.mockResolvedValue(emptyPage as never);
	mocked.getRunMonitorSeries.mockResolvedValue(emptyPage as never);
});

describe("LoadTestDetail's compare entry", () => {
	it("opens the compare view from the header and returns to the report tabs", async () => {
		renderDetail();

		fireEvent.click(await screen.findByRole("button", { name: "Compare" }));

		expect(await screen.findByRole("heading", { name: "Compare runs" })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: /overview/i })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Back to report" }));

		expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Compare runs" })).not.toBeInTheDocument();
	});

	it("offers no Compare for a run with no saved request to find its siblings by", async () => {
		mocked.getRun.mockResolvedValue(run({ requestId: null }));
		renderDetail();

		await waitFor(() => expect(mocked.getRun).toHaveBeenCalled());
		// Let the run row land in the cache, so its absence of a request is what
		// is asserted and not a render that simply came first.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await screen.findByRole("tab", { name: /overview/i });
		expect(compareButton()).toBeNull();
	});

	it("opens on the comparison when a History row asked for it, once", async () => {
		useTabsStore.setState({ compareRunTarget: "run_open" });
		renderDetail();

		expect(await screen.findByRole("heading", { name: "Compare runs" })).toBeInTheDocument();
		expect(useTabsStore.getState().compareRunTarget).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Back to report" }));
		expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
	});

	it("opens on the comparison when the request arrives for a report already on screen", async () => {
		renderDetail();
		await screen.findByRole("button", { name: "Compare" });

		act(() => useTabsStore.getState().openRunComparison("run_open"));

		expect(await screen.findByRole("heading", { name: "Compare runs" })).toBeInTheDocument();
		expect(useTabsStore.getState().compareRunTarget).toBeNull();
	});

	it("leaves another run's request alone", async () => {
		useTabsStore.setState({ compareRunTarget: "run_elsewhere" });
		renderDetail();

		await screen.findByRole("button", { name: "Compare" });
		expect(screen.queryByRole("heading", { name: "Compare runs" })).not.toBeInTheDocument();
		expect(useTabsStore.getState().compareRunTarget).toBe("run_elsewhere");
	});
});
