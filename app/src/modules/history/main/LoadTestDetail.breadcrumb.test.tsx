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
 * Where a run report sits (#1691).
 *
 * A report opens from the History drawer and said nothing about it: the header
 * names the run, never the place. The crumb's first segment *reveals* that list
 * rather than toggling it, which is the distinction `revealDrawerView` exists
 * for - a crumb pressed from here must always end with the list on screen, and
 * `activateDrawerView` would close it when the drawer was already there.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

const report: RunReport = {
	metadata: {
		runId: "r",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 1000,
		requestUrl: "http://127.0.0.1:8080/x",
		requestMethod: "GET",
	},
	summary: {
		totalRequests: 1,
		successfulRequests: 1,
		failedRequests: 0,
		errorRate: 0,
		totalDurationSeconds: 1,
		avgRps: 1,
	},
	latency: {
		min: 1,
		max: 1,
		avg: 1,
		median: 1,
		p50: 1,
		p75: 1,
		p90: 1,
		p95: 1,
		p99: 1,
		p999: 1,
	},
	statusCodes: { "200": 1 },
	errors: { total: 0, withDetails: 0, types: {} },
};

function renderReport() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={report} runId="r" />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

describe("the run report's crumb line", () => {
	it("says History, then what kind of run this is", () => {
		renderReport();

		const crumb = screen.getByRole("navigation", { name: "Run location" });
		expect(crumb.textContent).toBe("HistoryLoad test run");
	});

	it("reveals the history drawer from the first segment", () => {
		useLayoutStore.setState({ drawerOpen: false, drawerView: "collections" });
		renderReport();

		screen.getByRole("button", { name: "History" }).click();

		expect(useLayoutStore.getState().drawerView).toBe("history");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
