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
 * The history Samples tab is the second surface listing a bounded sample, and
 * the one a user reaches when reading a finished run rather than watching a
 * live one. Wiring the note into the dashboard alone would leave this list
 * still implying it holds everything the run produced - the half-wired shape
 * CLAUDE.md warns about.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SamplesTab from "./SamplesTab";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

function makeReport(sampling?: RunReport["sampling"]): RunReport {
	return {
		metadata: {
			runId: "r1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 60_000,
			configuration: { mode: "constant_rps", duration: "60s", targetRps: 50_000 },
		},
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
		results: [
			{ timestamp: 1_700_000_000_000, statusCode: 200, statusText: "OK", latencyMs: 2 },
		],
		sampling,
	};
}

const renderTab = (sampling?: RunReport["sampling"]) => {
	const report = makeReport(sampling);
	return render(<SamplesTab report={report} derived={reportToDerived(report)} />);
};

describe("SamplesTab retention", () => {
	it("says how much the bounded stores displaced", () => {
		renderTab({
			errorsDropped: 0,
			successTracesDropped: 29_000,
			slowTracesDropped: 500,
			responseSamplesDropped: 0,
		});

		expect(screen.getByText(/29,500 further samples were displaced/)).toBeInTheDocument();
	});

	it("stays quiet when nothing was displaced", () => {
		renderTab({
			errorsDropped: 0,
			successTracesDropped: 0,
			slowTracesDropped: 0,
			responseSamplesDropped: 0,
		});

		expect(screen.queryByText(/Bounded retention/)).not.toBeInTheDocument();
	});

	it("counts what it shows rather than claiming a capture total", () => {
		renderTab();
		expect(screen.getByText("1 samples shown")).toBeInTheDocument();
	});
});
