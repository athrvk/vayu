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
 * Per-test validation failures reach the report as `result.trace.failures`
 * (written by `validate_scripts` in run_manager.cpp) and were rendered nowhere:
 * the sampled row showed an opaque `ERR` chip and pass/fail counts, never which
 * assertion failed (issue #111).
 *
 * This expands a validation-failure sample and asserts each failure message is
 * on screen. Mutation-check: delete the `trace.failures` block in
 * RequestResponseView.tsx and the message assertions fail.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RequestResponseView from "./RequestResponseView";
import type { RunReport } from "@/types";

// ResponseBody mounts Monaco via CodeEditor; stub it so an expanded sample
// renders in jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function makeReportWithFailures(): RunReport {
	return {
		summary: {
			totalRequests: 1,
			successfulRequests: 0,
			failedRequests: 1,
			errorRate: 100,
			totalDurationSeconds: 1,
			avgRps: 1,
		},
		latency: { min: 5, max: 5, avg: 5, p50: 5, p90: 5, p95: 5, p99: 5 },
		statusCodes: {},
		errors: { total: 1, withDetails: 1, types: {} },
		results: [
			{
				timestamp: 1_700_000_000_000,
				statusCode: 0,
				latencyMs: 0,
				error: "Script validation failures",
				trace: {
					failures: [
						"status is 200: expected 404 to equal 200",
						"body has token: expected undefined to exist",
					],
					totalFailed: 2,
					totalPassed: 3,
				},
			},
		],
	};
}

describe("RequestResponseView renders per-test validation failures (#111)", () => {
	it("lists each failing test's message when a validation-failure row is expanded", () => {
		render(<RequestResponseView report={makeReportWithFailures()} />);

		// The row's error preview carries the summary text; expand it.
		fireEvent.click(screen.getByRole("button", { name: /Script validation failures/ }));

		expect(screen.getByText("status is 200: expected 404 to equal 200")).toBeTruthy();
		expect(screen.getByText("body has token: expected undefined to exist")).toBeTruthy();
		// The failed-count heading annotation.
		expect(screen.getByText(/Failed Tests/)).toBeTruthy();
	});

	it("does not render a Failed Tests block when the trace carries no failures", () => {
		const report = makeReportWithFailures();
		report.results![0].trace = { error_type: "ConnectionError" };
		report.results![0].error = "connection refused";
		render(<RequestResponseView report={report} />);

		fireEvent.click(screen.getByRole("button", { name: /connection refused/ }));

		expect(screen.queryByText(/Failed Tests/)).toBeNull();
	});
});
