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
 * A run's comment is not part of the report body (#2270).
 *
 * It was the "Note:" line at the bottom of the "Test config" box. It now sits
 * under the run's title, in the header that owns it (`HistoryDetail`, and the
 * dashboard's header for a run opened from there), so the report must neither
 * keep a second copy nor open a box with nothing in it for a run whose only
 * config is a comment.
 *
 * Mutation check: put the `Note:` block back and the first case reddens; put
 * `config.comment` back in the box's gate and the second reddens.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { render } from "@/test/render-with-tooltips";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

function renderWithClient(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function report(configuration: NonNullable<RunReport["metadata"]>["configuration"]): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration,
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

describe("LoadTestDetail and the run's comment", () => {
	it("does not draw the comment, with or without the old Note label", () => {
		renderWithClient(
			<LoadTestDetail
				report={report({
					mode: "constant_rps",
					duration: "3s",
					comment: "after the cache fix",
				})}
				runId="r"
			/>
		);

		expect(screen.getByText("Test config")).toBeInTheDocument();
		expect(screen.queryByText(/after the cache fix/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Note/)).not.toBeInTheDocument();
	});

	it("opens no config box for a run whose only configuration is a comment", () => {
		renderWithClient(
			<LoadTestDetail report={report({ comment: "after the cache fix" })} runId="r" />
		);

		expect(screen.queryByText("Test config")).not.toBeInTheDocument();
	});
});
