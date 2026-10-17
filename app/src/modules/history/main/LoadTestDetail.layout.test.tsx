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
 * Where LoadTestDetail puts things (#2271): the fixed header is the breadcrumb
 * row and the tab strip, and everything else the report says about the run
 * scrolls with the body. Pixels are not testable in jsdom; which container a
 * piece of text lives in is.
 *
 * Mutation check: put the config box (or the request bar) back above the tab
 * strip and the header case reddens; drop `runContext` from either scroll
 * container and the body cases redden.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const URL = "https://api.test/ping";

function report(): RunReport {
	return {
		metadata: {
			runId: "run_open",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: URL,
			requestMethod: "GET",
			configuration: {
				mode: "constant_rps",
				duration: "3s",
				concurrency: 20,
				targetRps: 200,
				timeout: 5000,
				dataRowCount: 12,
				dataFileName: "users.csv",
				httpVersion: "http2",
			},
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 195,
			httpVersionDowngraded: 40,
		},
		latency: { min: 1, max: 120, avg: 10, p50: 8, p90: 20, p95: 30, p99: 90, p999: 100 },
		statusCodes: { "200": 600 },
		errors: { total: 0, withDetails: 0, types: {} },
		auth: { refreshes: [{ atSeconds: 60 }], refreshFailures: 0 },
	};
}

function run(over: Partial<Run> = {}): Run {
	return {
		id: "run_open",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_010_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: URL, method: "GET" },
		...over,
	} as Run;
}

const emptyPage = {
	data: [],
	pagination: { total: 0, limit: 50, offset: 0, hasMore: false, returned: 0 },
};

const baselinePage = {
	data: [run({ id: "run_baseline", baseline: true })],
	pagination: { total: 1, limit: 1, offset: 0, hasMore: false, returned: 1 },
};

beforeEach(() => {
	vi.clearAllMocks();
	useTabsStore.setState({ compareRunTarget: null });
	mocked.getRun.mockResolvedValue(run());
	mocked.listRuns.mockResolvedValue(baselinePage);
	mocked.getRunReport.mockResolvedValue(report());
	mocked.getRunTimeSeries.mockResolvedValue(emptyPage as never);
	mocked.getRunMonitorSeries.mockResolvedValue(emptyPage as never);
});

function renderDetail(shown: RunReport = report()) {
	const view = render(withQueryClient(<LoadTestDetail report={shown} runId="run_open" />));
	const root = view.container.firstElementChild as HTMLElement;
	return {
		// The fixed strip above the tabs, and the one container that scrolls.
		header: root.firstElementChild as HTMLElement,
		body: () => root.querySelector<HTMLElement>('[data-slot="scroll-area"]')!,
	};
}

describe("LoadTestDetail's fixed header", () => {
	it("holds the breadcrumb row and nothing the report says about the run", async () => {
		const { header } = renderDetail();
		await screen.findByText("vs baseline");

		expect(within(header).getByRole("navigation", { name: "Run location" })).toBeVisible();
		expect(await within(header).findByRole("button", { name: "Compare" })).toBeVisible();

		expect(within(header).queryByText(URL)).toBeNull();
		expect(within(header).queryByText("Test config")).toBeNull();
		expect(within(header).queryByText("vs baseline")).toBeNull();
		expect(within(header).queryByText(/Access token refreshed/)).toBeNull();
		expect(within(header).queryByText("P99 latency")).toBeNull();
	});

	it("leaves the tab strip outside the scrolling body", () => {
		const { body } = renderDetail();

		const overview = screen.getByRole("tab", { name: /overview/i });
		expect(body().contains(overview)).toBe(false);
	});
});

describe("LoadTestDetail's scrolling body", () => {
	it("carries the request, config, baseline strip and auth note above the tab panel", async () => {
		const { body } = renderDetail();
		await screen.findByText("vs baseline");

		const inBody = within(body());
		expect(inBody.getByText(URL)).toBeVisible();
		expect(inBody.getByText("Test config")).toBeVisible();
		expect(inBody.getByText("vs baseline")).toBeVisible();
		expect(inBody.getByText("Access token refreshed at 1m 0s")).toBeVisible();
	});

	it("keeps the block on every tab", async () => {
		const { body } = renderDetail();

		fireEvent.mouseDown(screen.getByRole("tab", { name: /performance/i }), { button: 0 });

		await waitFor(() =>
			expect(screen.getByRole("tab", { name: /performance/i })).toHaveAttribute(
				"data-state",
				"active"
			)
		);
		expect(within(body()).getByText(URL)).toBeVisible();
		expect(within(body()).getByText("Test config")).toBeVisible();
	});

	it("keeps the block, scrolling with the comparison, when comparing", async () => {
		const { body } = renderDetail();
		await screen.findByText("vs baseline");

		fireEvent.click(await screen.findByRole("button", { name: "Compare" }));
		await screen.findByRole("heading", { name: "Compare runs" });

		expect(screen.queryByRole("tab", { name: /overview/i })).toBeNull();
		const inBody = within(body());
		expect(inBody.getByText(URL)).toBeVisible();
		expect(inBody.getByText("Test config")).toBeVisible();
		expect(inBody.getByText("Access token refreshed at 1m 0s")).toBeVisible();
	});

	it("puts the three key metrics at the top of Overview, not in the header", () => {
		const { header, body } = renderDetail();

		for (const label of ["P99 latency", "Total requests", "Success rate"]) {
			expect(within(header).queryByText(label)).toBeNull();
		}
		expect(within(body()).getByText("Success rate")).toBeVisible();
		expect(within(body()).getAllByText("P99 latency")).not.toHaveLength(0);
	});
});

describe("the Test config box", () => {
	it("opens on one line of the defining settings, with the rest closed", () => {
		renderDetail();

		expect(screen.getByText("Mode:")).toBeVisible();
		expect(screen.getByText("Virtual users:")).toBeVisible();
		expect(screen.getByText("Duration:")).toBeVisible();
		expect(screen.getByText("Protocol:")).toBeVisible();

		const details = screen.getByRole("button", { name: "Details" });
		expect(details).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Target RPS:")).toBeNull();
		expect(screen.queryByText("Data:")).toBeNull();
		expect(screen.queryByText("Timeout:")).toBeNull();
	});

	it("reveals target rate, data and timeout under Details, and closes again", () => {
		renderDetail();
		const details = screen.getByRole("button", { name: "Details" });

		fireEvent.click(details);

		expect(details).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Target RPS:")).toBeVisible();
		expect(screen.getByText("Data:")).toBeVisible();
		expect(screen.getByText("12 rows · users.csv")).toBeVisible();
		expect(screen.getByText("Timeout:")).toBeVisible();
		expect(screen.getByText("5000ms")).toBeVisible();

		fireEvent.click(details);

		expect(details).toHaveAttribute("aria-expanded", "false");
	});

	it("offers no Details when the run recorded nothing for them", () => {
		const bare = report();
		bare.metadata!.configuration = { mode: "constant_rps", duration: "3s" };
		renderDetail(bare);

		expect(screen.getByText("Test config")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
	});

	it("keeps the not-negotiated warning on the line while Details is closed", () => {
		renderDetail();

		expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute(
			"aria-expanded",
			"false"
		);
		expect(screen.getByText(/not negotiated/i)).toBeVisible();
	});
});
