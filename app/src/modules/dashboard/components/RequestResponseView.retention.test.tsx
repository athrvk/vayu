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
 * Wiring guard for the retention counts.
 *
 * The engine reporting how much each bounded store thinned away is worth
 * nothing until a surface displays it - "written but never read" is this
 * codebase's most repeated defect, and a field added to `RunReport` that no
 * component renders is exactly that shape. Two lists in this file draw from
 * bounded stores (the sampled requests, and the responses test validation was
 * run against), so both are checked here rather than trusting one to stand in
 * for the other.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import RequestResponseView from "./RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import type { RunReport } from "@/types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function makeReport(sampling?: RunReport["sampling"]): RunReport {
	return {
		summary: {
			totalRequests: 3_000_000,
			successfulRequests: 3_000_000,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 60,
			avgRps: 50_000,
		},
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		testValidation: {
			samplesTested: 1_000,
			testsPassed: 1_000,
			testsFailed: 0,
			successRate: 100,
		},
		results: [
			{ timestamp: 1_700_000_000_000, statusCode: 200, statusText: "OK", latencyMs: 2 },
		],
		sampling,
	};
}

const renderReport = (sampling?: RunReport["sampling"]) =>
	render(
		withQueryClient(
			<TooltipProvider>
				<RequestResponseView report={makeReport(sampling)} />
			</TooltipProvider>
		)
	);

describe("RequestResponseView retention", () => {
	it("tells the reader the sampled list is a sample, not the whole run", () => {
		renderReport({
			errorsDropped: 0,
			successTracesDropped: 29_000,
			slowTracesDropped: 0,
			responseSamplesDropped: 0,
		});

		expect(screen.getByText(/29,000 further samples were displaced/)).toBeInTheDocument();
	});

	it("says the same for the responses validation graded", () => {
		renderReport({
			errorsDropped: 0,
			successTracesDropped: 0,
			slowTracesDropped: 0,
			responseSamplesDropped: 2_999_000,
		});

		expect(screen.getByText(/2,999,000 further responses were displaced/)).toBeInTheDocument();
	});

	it("stays silent on a run that retained everything", () => {
		renderReport({
			errorsDropped: 0,
			successTracesDropped: 0,
			slowTracesDropped: 0,
			responseSamplesDropped: 0,
		});

		expect(screen.queryByText(/Bounded retention/)).not.toBeInTheDocument();
	});

	// The badge counts what is on screen. `results` is capped at 100 by the
	// report route regardless of retention, so "captured" overstated it even
	// before the stores were bounded.
	it("labels the badge by what is shown rather than what was captured", () => {
		renderReport();
		expect(screen.getByText("1 shown")).toBeInTheDocument();
		expect(screen.queryByText(/captured/)).not.toBeInTheDocument();
	});
});
