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
 * A finished run on the dashboard is History's report for that run (#2220).
 *
 * The dashboard used to draw its own report, and it disagreed with History on
 * numbers and labels for the same run. Now a run with a report - completed,
 * failed or stopped - renders `LoadTestDetail`, and only a run without one
 * keeps the live `MetricsView`.
 *
 * Mutation check: render `MetricsView` for a finished run again (the pre-#2220
 * branch in `index.tsx`) and the finished cases redden. Hand the live header an
 * `exportRunId` and the Export cases redden: the engine exports only a finished
 * run (#2139).
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { useDashboardStore } from "@/stores";
import LoadTestDetail from "@/modules/history/main/LoadTestDetail";
import type { RunReport } from "@/types";
import LoadTestDashboard from "./index";

const headerProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./components", () => ({
	DashboardHeader: (props: Record<string, unknown>) => {
		headerProps.push(props);
		return null;
	},
	MetricsView: () => <div data-testid="live-metrics" />,
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
	},
}));

type FinishedStatus = "completed" | "failed" | "stopped";

function reportFor(status: FinishedStatus): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status,
			startTime: 0,
			endTime: 1000,
			requestUrl: "https://api.test/ping",
			requestMethod: "GET",
		},
		summary: {
			totalRequests: 10,
			successfulRequests: 10,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 10,
		},
		latency: { min: 1, max: 2, avg: 1, p50: 1, p90: 1, p95: 1, p99: 2 },
		statusCodes: { "200": 10 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

const tabNames = () => screen.queryAllByRole("tab").map((tab) => tab.textContent);

/** The tab set History draws for the same report, read off the real component. */
function historyTabs(report: RunReport): (string | null)[] {
	const { unmount } = render(withQueryClient(<LoadTestDetail report={report} runId="run_1" />));
	const names = tabNames();
	unmount();
	return names;
}

function renderDashboard(
	mode: "running" | FinishedStatus,
	finalReport: RunReport | null,
	isStreaming = false
) {
	useDashboardStore.setState({ currentRunId: "run_1", mode, isStreaming, finalReport });
	return render(withQueryClient(<LoadTestDashboard />));
}

describe("the dashboard's finished run", () => {
	it.each<FinishedStatus>(["completed", "failed", "stopped"])(
		"renders History's report for a %s run",
		(status) => {
			const report = reportFor(status);
			const expected = historyTabs(report);
			expect(expected.length).toBeGreaterThan(0);

			renderDashboard(status, report);

			expect(tabNames()).toEqual(expected);
			expect(screen.getByRole("tab", { name: "Sampled requests" })).toBeInTheDocument();
			expect(screen.queryByTestId("live-metrics")).toBeNull();
			// One report header, not the dashboard's plus History's.
			expect(screen.getAllByRole("navigation", { name: "Run location" })).toHaveLength(1);
		}
	);

	it("drops a stale stream error once the report is on screen", () => {
		// A remount's status check can land the report while the error from a
		// dropped stream is still set; Reconnect on a finished run does nothing.
		useDashboardStore.setState({ error: "stream dropped" });
		renderDashboard("completed", reportFor("completed"));

		expect(screen.queryByText("Lost the live metrics stream")).toBeNull();
		expect(screen.getByRole("tab", { name: "Sampled requests" })).toBeInTheDocument();
		useDashboardStore.setState({ error: null });
	});

	it("still shows the stream error while there is no report", () => {
		useDashboardStore.setState({ error: "stream dropped" });
		renderDashboard("running", null, true);

		expect(screen.getByText("Lost the live metrics stream")).toBeInTheDocument();
		useDashboardStore.setState({ error: null });
	});

	it("keeps the live metrics, and no tab bar, for a running run", () => {
		renderDashboard("running", null, true);

		expect(screen.getByTestId("live-metrics")).toBeInTheDocument();
		expect(tabNames()).toEqual([]);
	});

	it("keeps the live metrics for a finished run whose report has not arrived", () => {
		// The report fetch and its Retry live on the live view; a report-less
		// finished run must not land on an empty report.
		renderDashboard("completed", null);

		expect(screen.getByTestId("live-metrics")).toBeInTheDocument();
		expect(tabNames()).toEqual([]);
	});
});

describe("the header's Export target", () => {
	const lastHeader = () => headerProps[headerProps.length - 1];

	it("names the finished run, with the report's URL and method for its baseline", () => {
		renderDashboard("completed", reportFor("completed"));

		expect(lastHeader()).toMatchObject({
			exportRunId: "run_1",
			exportRequestUrl: "https://api.test/ping",
			exportRequestMethod: "GET",
		});
	});

	it.each([
		["a streaming run", "running", true],
		["a finished run whose report has not arrived", "completed", false],
	] as const)("is not handed to the header for %s", (_name, mode, isStreaming) => {
		renderDashboard(mode, null, isStreaming);

		expect(lastHeader().exportRunId).toBeUndefined();
	});
});
