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

function seed(mode: "running" | "completed") {
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

	it("reveals the history drawer from the first segment", () => {
		seed("completed");
		useLayoutStore.setState({ drawerOpen: false, drawerView: "collections" });
		render(<LoadTestDashboard />);

		screen.getByRole("button", { name: "History" }).click();

		expect(useLayoutStore.getState().drawerView).toBe("history");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
