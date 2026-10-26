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
 * A scenario load run's P99 tile pools every step, and says which step set it
 * (#2823). A single-request run's tile is unchanged.
 *
 * Mutation-check: drop the `isPooledReport` condition in `pooledLatencyOf` (or
 * the `pooled &&` guard in `RunKeyMetrics`) and the single-request case fails;
 * read the first step instead of the slowest and the name case fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunReport, RunScenarioStepStat } from "@/types";
import RunKeyMetrics from "./RunKeyMetrics";

function step(index: number, name: string, p99: number): RunScenarioStepStat {
	return {
		index,
		name,
		requestId: `req_${index}`,
		method: "GET",
		executed: 40,
		errors: 0,
		latency: { min: 1, p50: 4, p95: 9, p99, max: p99 },
	};
}

function makeReport(steps?: RunScenarioStepStat[]): RunReport {
	return {
		metadata: { runId: "run_1", runType: "load", status: "completed" },
		summary: { totalRequests: 80, failedRequests: 0, requestsPerSecond: 10, testDuration: 8 },
		latency: { min: 1, max: 120, avg: 10, p50: 8, p90: 20, p95: 30, p99: 90 },
		...(steps ? { scenario: { steps } } : {}),
	} as unknown as RunReport;
}

describe("RunKeyMetrics pooled caption", () => {
	it("names the slowest step under a sequence's P99", () => {
		render(<RunKeyMetrics report={makeReport([step(0, "Log in", 12), step(1, "List", 90)])} />);

		expect(screen.getByText("All steps pooled - slowest step: List, p99 90ms")).toBeTruthy();
	});

	it("draws no caption for a single-request run", () => {
		render(<RunKeyMetrics report={makeReport()} />);

		expect(screen.getByText("P99 latency")).toBeTruthy();
		expect(screen.queryByText(/pooled/i)).toBeNull();
	});

	it("draws none for a scenario section with no step breakdown", () => {
		render(<RunKeyMetrics report={makeReport([])} />);

		expect(screen.queryByText(/pooled/i)).toBeNull();
	});
});
