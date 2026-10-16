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
 * Where the dashboard sits (#1691).
 *
 * The compact header names the run; nothing said what the screen *is*, and the
 * live view and the finished report look alike at a glance. The crumb carries
 * both facts: the place it was reached from, and which of the two states this
 * is. The finished run is History's report (#2220), so its crumb is the one
 * History draws for the same run.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { useDashboardStore, useLayoutStore } from "@/stores";
import type { RunReport } from "@/types";
import LoadTestDashboard from "./index";

// The screen's own children reach the engine, uPlot and the toast store; their
// suites cover them. What is under test here is the one line above them.
vi.mock("./components", () => ({
	DashboardHeader: () => null,
	MetricsView: () => null,
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
	},
}));

const crumb = () => screen.getByRole("navigation", { name: "Run location" });

function reportFor(status: "completed" | "failed" | "stopped"): RunReport {
	return {
		metadata: { runId: "run_1", runType: "load", status, startTime: 0, endTime: 1 },
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 1,
		},
		latency: { min: 1, max: 1, avg: 1, p50: 1, p90: 1, p95: 1, p99: 1 },
		statusCodes: { "200": 1 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

function seed(mode: "running" | "completed" | "failed" | "stopped", withReport: boolean) {
	useDashboardStore.setState({
		currentRunId: "run_1",
		mode,
		isStreaming: mode === "running",
		finalReport: withReport && mode !== "running" ? reportFor(mode) : null,
	});
}

const renderDashboard = () => render(withQueryClient(<LoadTestDashboard />));

describe("the dashboard's crumb line", () => {
	it("distinguishes the live run from the finished report", () => {
		seed("running", false);
		const { unmount } = renderDashboard();
		expect(crumb().textContent).toBe("HistoryLive load test");
		unmount();

		seed("completed", true);
		renderDashboard();
		expect(crumb().textContent).toBe("HistoryLoad test run");
	});

	it("lays a failed run out as the finished report, not the live view (#1932)", () => {
		seed("failed", true);
		renderDashboard();
		expect(crumb().textContent).toBe("HistoryLoad test run");
	});

	it("lays a stopped run out as the finished report once its report is here (#2136)", () => {
		seed("stopped", true);
		renderDashboard();
		expect(crumb().textContent).toBe("HistoryLoad test run");
	});

	it("keeps the live layout for a stopped run until its report arrives (#2136)", () => {
		seed("stopped", false);
		renderDashboard();
		expect(crumb().textContent).toBe("HistoryLive load test");
	});

	it("reveals the history drawer from the first segment of either crumb", () => {
		for (const [mode, withReport] of [
			["running", false],
			["completed", true],
		] as const) {
			seed(mode, withReport);
			useLayoutStore.setState({ drawerOpen: false, drawerView: "collections" });
			const { unmount } = renderDashboard();

			screen.getByRole("button", { name: "History" }).click();

			expect(useLayoutStore.getState().drawerView).toBe("history");
			expect(useLayoutStore.getState().drawerOpen).toBe(true);
			unmount();
		}
	});
});
