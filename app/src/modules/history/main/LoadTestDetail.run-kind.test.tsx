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
 * The "Test config" box words a run by its kind (#3570): the mode "Fixed
 * passes" and a "Passes" count for a collection run, "Fixed request count" and
 * "Requests" for a single request. `LoadTestDetail` is the one place that
 * decides which it is.
 *
 * Mutation check: stop passing `isCollectionRun` to `RunConfigSummary` and the
 * collection case reads "Fixed request count" and "Requests".
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

function report(over: Partial<RunReport>): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration: { mode: "iterations", concurrency: 10, iterations: 400 },
		},
		summary: {
			totalRequests: 1200,
			successfulRequests: 1200,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 361,
		},
		latency: {
			min: 1,
			max: 40,
			avg: 27,
			median: 27,
			p50: 27,
			p75: 28,
			p90: 30,
			p95: 31,
			p99: 35,
			p999: 39,
		},
		statusCodes: { "200": 1200 },
		errors: { total: 0, withDetails: 0, types: {} },
		...over,
	};
}

function summaryText(r: RunReport) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { container } = render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={r} runId="r" />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return container.textContent ?? "";
}

describe("LoadTestDetail run kind in the Test config box", () => {
	it("words a collection run's mode and count as passes", () => {
		const base = report({});
		const text = summaryText({
			...base,
			metadata: {
				...base.metadata!,
				scenario: { collectionId: "col_1", stepCount: 3 },
			},
		} as RunReport);

		expect(text).toContain("Mode:Fixed passes");
		expect(text).toContain("Passes:400");
	});

	it("words a single request's mode and count as requests", () => {
		const text = summaryText(report({}));

		expect(text).toContain("Mode:Fixed request count");
		expect(text).toContain("Requests:400");
	});
});
