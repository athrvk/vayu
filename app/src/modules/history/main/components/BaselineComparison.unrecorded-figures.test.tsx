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
 * The vs-baseline strip when the *pinned baseline* is a run the engine did not
 * fully record (#2904). The open run's own flags are covered in
 * `BaselineComparison.test.tsx`. A baseline figure that was not recorded is
 * not "no baseline value" and not a 0 to measure against: the open run's real
 * figure is shown and the change reads "baseline not recorded".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import BaselineComparison from "./BaselineComparison";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { Run, RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		getRun: vi.fn(),
		listRuns: vi.fn(),
		getRunReport: vi.fn(),
	},
}));

const mocked = vi.mocked(apiService);

type Flag = "summaryMissing" | "partial";

/** A flagged run omits `latency` (#2938), as the engine does; `p99` is read only without a flag. */
function report(over: { p99: number; avgRps: number; errorRate: number; flag?: Flag }): RunReport {
	const latency = { min: 1, max: 90, avg: 10, p50: 8, p90: 20, p95: 30, p99: over.p99 };
	return {
		metadata: { runId: "r", runType: "load", status: "completed", startTime: 0, endTime: 1000 },
		summary: {
			totalRequests: 1000,
			successfulRequests: 1000,
			failedRequests: 0,
			errorRate: over.errorRate,
			totalDurationSeconds: 10,
			avgRps: over.avgRps,
			...(over.flag ? { [over.flag]: true } : {}),
		},
		...(over.flag ? {} : { latency }),
		statusCodes: { "200": 1000 },
		errors: { total: 0, withDetails: 0, types: {} },
	} as RunReport;
}

function run(over: Partial<Run> = {}): Run {
	return {
		id: "run_target",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_010_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...over,
	} as Run;
}

function renderStrip(baseline: RunReport) {
	mocked.getRun.mockResolvedValue(run());
	mocked.listRuns.mockResolvedValue({
		data: [run({ id: "run_baseline", baseline: true })],
		pagination: {
			total: 1,
			limit: 1,
			offset: 0,
			hasMore: false,
			returned: 1,
			nextBefore: null,
		},
	});
	mocked.getRunReport.mockResolvedValue(baseline);
	render(
		withQueryClient(
			<BaselineComparison
				report={report({ p99: 50, avgRps: 100, errorRate: 2 })}
				runId="run_target"
			/>
		)
	);
}

/** The cell a headline label sits in, as text, once the strip has drawn. */
async function cell(label: string): Promise<HTMLElement> {
	await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());
	return screen.getByText(label).parentElement!;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("BaselineComparison with a baseline the engine did not fully record (#2904)", () => {
	it("reads every figure of a baseline with no summary as not recorded, with no delta", async () => {
		renderStrip(report({ p99: 0, avgRps: 0, errorRate: 0, flag: "summaryMissing" }));

		for (const [label, value] of [
			["P99 latency", "50ms"],
			["Throughput (whole run, drain included)", "100 rps"],
			["Error rate", "2.0%"],
		]) {
			const c = within(await cell(label));
			expect(c.getByText(value)).toBeInTheDocument();
			expect(c.getByText("baseline not recorded")).toBeInTheDocument();
			expect(c.queryByText(/^[+-]|vs no baseline/)).not.toBeInTheDocument();
		}
	});

	it("reads only a crash-reconciled baseline's latency as not recorded", async () => {
		renderStrip(report({ p99: 0, avgRps: 50, errorRate: 1, flag: "partial" }));

		const p99 = within(await cell("P99 latency"));
		expect(p99.getByText("50ms")).toBeInTheDocument();
		expect(p99.getByText("baseline not recorded")).toBeInTheDocument();
		expect(p99.queryByText(/^[+-]/)).not.toBeInTheDocument();

		// Its counts are the last tick's and stay a baseline: 50 -> 100 is +100%.
		const rps = within(await cell("Throughput (whole run, drain included)"));
		expect(rps.getByText("+100.0%")).toBeInTheDocument();
		expect(rps.queryByText("baseline not recorded")).not.toBeInTheDocument();
	});
});
