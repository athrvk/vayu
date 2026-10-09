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
 * LoadTestDetail's "Test config" row names the data set a run bound (#1940).
 * The rows are never stored; the report's `dataRowCount` is the whole record.
 *
 * Mutation check: remove the `Data:` entry from `LoadTestDetail` and the
 * shown-count cases redden.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

function report(dataRowCount: number | undefined): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration: { mode: "constant_rps", duration: "3s", targetRps: 200, dataRowCount },
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 195,
		},
		latency: {
			min: 100,
			max: 130,
			avg: 101,
			median: 101,
			p50: 101,
			p75: 101,
			p90: 102,
			p95: 103,
			p99: 108,
			p999: 120,
		},
		statusCodes: { "200": 600 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

function mount(dataRowCount: number | undefined) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={report(dataRowCount)} runId="r" />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

describe("LoadTestDetail data row count", () => {
	it("shows how many rows the run bound", () => {
		mount(12);

		expect(screen.getByText("Data:")).toBeInTheDocument();
		expect(screen.getByText("12 rows")).toBeInTheDocument();
	});

	it("uses the singular for one row", () => {
		mount(1);

		expect(screen.getByText("1 row")).toBeInTheDocument();
	});

	it.each([
		["absent", undefined],
		["zero", 0],
	])("omits the entry when the count is %s", (_label, count) => {
		mount(count);

		expect(screen.queryByText("Data:")).toBeNull();
	});
});
