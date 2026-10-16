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
 * The report route returns a failures-first selection of the rows a run stored,
 * and says how many it stored beside it (issue #2210). The tab states the gap
 * only when the engine reports one: a report without the pair is an older
 * engine, and a pair that agrees means every stored row is on screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import SamplesTab from "./SamplesTab";
import { withQueryClient } from "@/test/query-wrapper";
import { stubNumberLocale } from "@/test/number-locale";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

function makeReport(counts: Pick<RunReport, "resultsStored" | "resultsCap">): RunReport {
	return {
		metadata: {
			runId: "r1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 60_000,
			configuration: { mode: "constant_rps", duration: "60s", targetRps: 50 },
		},
		summary: {
			totalRequests: 3_000,
			successfulRequests: 2_990,
			failedRequests: 10,
			errorRate: 0,
			totalDurationSeconds: 60,
			avgRps: 50,
		},
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		results: [
			{ timestamp: 1_700_000_000_000, statusCode: 500, latencyMs: 2 },
			{ timestamp: 1_700_000_000_001, statusCode: 200, latencyMs: 2 },
		],
		...counts,
	};
}

vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: vi.fn() },
}));

const renderTab = (counts: Pick<RunReport, "resultsStored" | "resultsCap">) => {
	const report = makeReport(counts);
	return render(
		withQueryClient(<SamplesTab report={report} derived={reportToDerived(report)} />)
	);
};

describe("SamplesTab stored count", () => {
	let restoreLocale: () => void;
	beforeEach(() => {
		restoreLocale = stubNumberLocale("en-US");
	});
	afterEach(() => restoreLocale());

	it("says how many rows the run stored when the engine cut the list", () => {
		renderTab({ resultsStored: 4_812, resultsCap: 100 });

		expect(screen.getByText("2 of 4,812 stored")).toBeInTheDocument();
		expect(screen.getByText("2 samples shown")).toBeInTheDocument();
	});

	it("says nothing extra when every stored row is on screen", () => {
		renderTab({ resultsStored: 100, resultsCap: 100 });

		expect(screen.queryByText(/stored/)).not.toBeInTheDocument();
	});

	it("says nothing from a report that predates the stored count", () => {
		renderTab({});

		expect(screen.queryByText(/stored/)).not.toBeInTheDocument();
		expect(screen.getByText("2 samples shown")).toBeInTheDocument();
	});
});
