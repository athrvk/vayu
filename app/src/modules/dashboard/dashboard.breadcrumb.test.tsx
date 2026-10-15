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
 * both facts: the place it was reached from, and which of the two states this is.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useDashboardStore, useLayoutStore } from "@/stores";
import LoadTestDashboard from "./index";

// The screen's own children reach the engine, uPlot and the toast store; their
// suites cover them. What is under test here is the one line above them.
vi.mock("./components", () => ({
	DashboardHeader: () => null,
	MetricsView: () => null,
	RequestResponseView: () => null,
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

function seed(mode: "running" | "completed" | "failed" | "stopped") {
	useDashboardStore.setState({ currentRunId: "run_1", mode, isStreaming: mode === "running" });
}

describe("the dashboard's crumb line", () => {
	it("distinguishes the live run from the finished report", () => {
		seed("running");
		const { unmount } = render(<LoadTestDashboard />);
		expect(crumb().textContent).toBe("HistoryLive load test");
		unmount();

		seed("completed");
		render(<LoadTestDashboard />);
		expect(crumb().textContent).toBe("HistoryLoad test report");
	});

	it("lays a failed run out as the finished report, not the live view (#1932)", () => {
		seed("failed");
		render(<LoadTestDashboard />);
		expect(crumb().textContent).toBe("HistoryLoad test report");
	});

	it("lays a stopped run out as the finished report once its report is here (#2136)", () => {
		seed("stopped");
		useDashboardStore.setState({
			finalReport: {
				metadata: { runId: "run_1", status: "stopped", startTime: 0, endTime: 1 },
				summary: {
					totalRequests: 1,
					successfulRequests: 1,
					failedRequests: 0,
					errorRate: 0,
				},
				latency: {
					p50: 1,
					p75: 1,
					p90: 1,
					p95: 1,
					p99: 1,
					p999: 1,
					avg: 1,
					min: 1,
					max: 1,
				},
			} as never,
		});
		render(<LoadTestDashboard />);
		expect(crumb().textContent).toBe("HistoryLoad test report");
	});

	it("keeps the live layout for a stopped run until its report arrives (#2136)", () => {
		seed("stopped");
		useDashboardStore.setState({ finalReport: null });
		render(<LoadTestDashboard />);
		expect(crumb().textContent).toBe("HistoryLive load test");
	});

	it("reveals the history drawer from the first segment", () => {
		seed("completed");
		useLayoutStore.setState({ drawerOpen: false, drawerView: "collections" });
		render(<LoadTestDashboard />);

		screen.getByRole("button", { name: "History" }).click();

		expect(useLayoutStore.getState().drawerView).toBe("history");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
