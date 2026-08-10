/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * The mid-run OAuth 2.0 refresh note in LoadTestDetail's header (#478).
 *
 * The wording is unit-tested in auth-refresh-note.test.ts; what this file adds
 * is that the pane actually draws it - a note computed and never rendered is
 * this codebase's most repeated defect, and no source scan can see it.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { ReactElement } from "react";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

function renderWithClient(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);
}

function report(auth?: RunReport["auth"]): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration: { mode: "constant_rps", duration: "2h" },
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 7200,
			avgRps: 0.08,
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
		auth,
	};
}

describe("LoadTestDetail auth-refresh note", () => {
	it("says when the run's token was refreshed", () => {
		renderWithClient(
			<LoadTestDetail
				report={report({ refreshes: [{ atSeconds: 3600 }], refreshFailures: 0 })}
				runId="r"
			/>
		);

		expect(screen.getByText("Access token refreshed at 1h 0m")).toBeInTheDocument();
	});

	// The case that explains a 401 storm: the run kept going on a credential it
	// could not renew, so the reason has to reach the reader.
	it("names the reason a refresh failed", () => {
		renderWithClient(
			<LoadTestDetail
				report={report({
					refreshes: [],
					refreshFailures: 1,
					lastError: "oauth2_provider_error: invalid_grant",
				})}
				runId="r"
			/>
		);

		expect(
			screen.getByText("1 refresh failure - oauth2_provider_error: invalid_grant")
		).toBeInTheDocument();
	});

	it("stays quiet for a run that could not refresh at all", () => {
		renderWithClient(<LoadTestDetail report={report(undefined)} runId="r" />);

		expect(screen.queryByText(/refresh/i)).not.toBeInTheDocument();
	});

	it("stays quiet for a watched run that never needed a refresh", () => {
		renderWithClient(
			<LoadTestDetail report={report({ refreshes: [], refreshFailures: 0 })} runId="r" />
		);

		expect(screen.queryByText(/refresh/i)).not.toBeInTheDocument();
	});
});
