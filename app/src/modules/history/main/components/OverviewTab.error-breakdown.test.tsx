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
 * The report's error summary names the engine's two kinds of error (issue
 * #2124) beside the total, and the total is the same number the hero card
 * prints.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import type { SampleDestination } from "../sample-filter";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

const report: RunReport = {
	metadata: {
		runId: "run_1",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 60_000,
		configuration: { mode: "constant_rps", duration: "60s", targetRps: 50 },
	},
	summary: {
		totalRequests: 100,
		successfulRequests: 83,
		failedRequests: 17,
		httpErrorRequests: 15,
		noResponseRequests: 2,
		errorRate: 17,
		totalDurationSeconds: 60,
		avgRps: 2,
	},
	latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
	statusCodes: { "200": 83, "500": 15, "0": 2 },
	errors: { total: 17, withDetails: 2, types: { timeout: 2 } },
};

describe("report error summary", () => {
	it("Overview prints HTTP errors and No response beside the total", () => {
		render(
			withQueryClient(
				<OverviewTab
					report={report}
					runId="run_1"
					derived={reportToDerived(report)}
					anomalies={[]}
				/>
			)
		);

		const summary = screen.getByText("Error summary").closest<HTMLElement>(".enter-fade")!;
		expect(within(summary).getByText("HTTP errors").nextSibling?.textContent).toBe("15");
		expect(within(summary).getByText("No response").nextSibling?.textContent).toBe("2");
		expect(summary.textContent).toContain("17 (17.00%)");
		expect(within(summary).getByText("Timeout").nextSibling?.textContent).toBe("2");
	});

	it("Overview lists the status codes an HTTP-only run failed with", () => {
		const httpOnly: RunReport = {
			...report,
			errors: { total: 15, withDetails: 0, types: {}, byStatusCode: { "500": 15 } },
		};
		render(
			withQueryClient(
				<OverviewTab
					report={httpOnly}
					runId="run_1"
					derived={reportToDerived(httpOnly)}
					anomalies={[]}
				/>
			)
		);

		const summary = screen.getByText("Error summary").closest<HTMLElement>(".enter-fade")!;
		expect(within(summary).getByText("HTTP 500").nextSibling?.textContent).toBe("15");
	});
});

describe("requests cancelled by Stop (issue #2136)", () => {
	/** A run the user stopped with a healthy target: cancelled requests, no errors. */
	const stopped = (cancelledRequests: number | undefined): RunReport => ({
		...report,
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "stopped",
			startTime: 0,
			endTime: 60_000,
		},
		summary: {
			...report.summary,
			successfulRequests: 100,
			failedRequests: 0,
			httpErrorRequests: 0,
			noResponseRequests: 0,
			errorRate: 0,
			cancelledRequests,
		},
		statusCodes: { "200": 100 },
		errors: { total: 0, withDetails: 0, types: {} },
	});

	const overview = (r: RunReport) =>
		render(
			withQueryClient(
				<OverviewTab report={r} runId="run_1" derived={reportToDerived(r)} anomalies={[]} />
			)
		);

	it("says so for a run with no errors", () => {
		overview(stopped(12));

		const line = screen.getByText("12 requests cancelled by Stop");
		expect(line.className).toContain("text-muted-foreground");
		expect(line.className).not.toContain("destructive");
		expect(screen.queryByText("Error summary")).toBeNull();
	});

	it("counts one request in the singular", () => {
		overview(stopped(1));
		expect(screen.getByText("1 request cancelled by Stop")).toBeTruthy();
	});

	it("draws nothing for zero or an engine that predates the count", () => {
		const { unmount } = overview(stopped(0));
		expect(screen.queryByText(/cancelled by Stop/)).toBeNull();
		unmount();

		overview(stopped(undefined));
		expect(screen.queryByText(/cancelled by Stop/)).toBeNull();
	});

	// A natural end's drain deadline is stored as an error of type "cancelled"
	// (nobody asked for it); the fallback sentence-casing already reads "Cancelled".
	it("labels a drain-deadline cancellation as an error type, Cancelled", () => {
		overview({
			...report,
			errors: { total: 17, withDetails: 2, types: { cancelled: 2 } },
		});

		expect(screen.getByText("Cancelled")).toBeTruthy();
		expect(screen.queryByText("cancelled")).toBeNull();
	});

	it("does not print a nonzero error rate as 0.00% beside its count", () => {
		overview({
			...report,
			summary: { ...report.summary, totalRequests: 1_000_000, errorRate: 0.0001 },
			errors: { total: 1, withDetails: 1, types: {} },
		});

		const summary = screen.getByText("Error summary").closest<HTMLElement>(".enter-fade")!;
		expect(summary.textContent).toContain("1 (<0.01%)");
	});
});

describe("error rows open the Samples tab (issue #2213)", () => {
	// In time order: #1 200, #2 500 (internal_error), #3 0 (timeout), #4 500.
	const withSamples: RunReport = {
		...report,
		errors: {
			total: 17,
			withDetails: 2,
			types: { timeout: 2, ssl_error: 1 },
			byStatusCode: { "500": 15, "0": 2, "404": 3 },
		},
		results: [
			{ timestamp: 4000, statusCode: 500, latencyMs: 4 },
			{ timestamp: 1000, statusCode: 200, latencyMs: 1 },
			{
				timestamp: 3000,
				statusCode: 0,
				latencyMs: 3,
				trace: { error_type: "timeout" },
			},
			{
				timestamp: 2000,
				statusCode: 500,
				latencyMs: 2,
				trace: { error_type: "internal_error" },
			},
		],
	};

	const overview = (onOpenSample?: (d: SampleDestination) => void) =>
		render(
			withQueryClient(
				<OverviewTab
					report={withSamples}
					runId="run_1"
					derived={reportToDerived(withSamples)}
					anomalies={[]}
					onOpenSample={onOpenSample}
				/>
			)
		);

	it("draws plain text when nothing is listening", () => {
		overview();

		const summary = screen.getByText("Error summary").closest<HTMLElement>(".enter-fade")!;
		expect(within(summary).queryAllByRole("button")).toHaveLength(0);
	});

	it("hands over the first sample of a status and the chip that shows it", () => {
		const onOpenSample = vi.fn();
		overview(onOpenSample);

		fireEvent.click(screen.getByRole("button", { name: /HTTP 500/ }));
		expect(onOpenSample).toHaveBeenLastCalledWith({ filter: "5xx", number: 2 });

		fireEvent.click(screen.getByRole("button", { name: /No response \(status 0\)/ }));
		expect(onOpenSample).toHaveBeenLastCalledWith({ filter: "no-response", number: 3 });
	});

	it("hands over the first sample of an error type on the Errors chip", () => {
		const onOpenSample = vi.fn();
		overview(onOpenSample);

		fireEvent.click(screen.getByRole("button", { name: /Timeout/ }));

		expect(onOpenSample).toHaveBeenCalledOnce();
		expect(onOpenSample).toHaveBeenCalledWith({ filter: "errors", number: 3 });
	});

	it("disables a row no loaded sample backs, and says so", () => {
		const onOpenSample = vi.fn();
		overview(onOpenSample);

		for (const name of [/HTTP 404/, /SSL error/]) {
			const row = screen.getByRole("button", { name });
			expect(row).toBeDisabled();
			expect(row).toHaveTextContent("No sample of this was kept");
			fireEvent.click(row);
		}
		expect(onOpenSample).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /HTTP 500/ })).toBeEnabled();
	});

	it("does not count the synthetic test-validation row as a sample", () => {
		const validationRow = {
			timestamp: 500,
			statusCode: 0,
			latencyMs: 0,
			trace: { error_type: "script_error", failures: ["a: failed"] },
		};
		const r: RunReport = {
			...withSamples,
			errors: { ...withSamples.errors!, types: { script_error: 1 } },
			results: [validationRow, ...withSamples.results!],
		};
		render(
			withQueryClient(
				<OverviewTab
					report={r}
					runId="run_1"
					derived={reportToDerived(r)}
					anomalies={[]}
					onOpenSample={vi.fn()}
				/>
			)
		);

		expect(screen.getByRole("button", { name: /Script error/ })).toBeDisabled();
	});
});
