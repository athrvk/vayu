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
 * The Samples tab's link to `GET /runs/:id/samples` (#174). The captured bodies
 * are deliberately not part of the report payload - the report is polled and
 * the samples page is not - so the tab asks for them only once a row is open,
 * and joins what comes back to its row by result id.
 *
 * Mutation-check: pass `true` as the query's `enabled` argument in
 * `SamplesTab.tsx` and the first case fails; look the body up by `number`
 * instead of `sample.id` and the second fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import SamplesTab from "./SamplesTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport, RunSamplesResponse } from "@/types";

// The response body mounts Monaco via CodeEditor; stub it so an expanded
// sample renders in jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const getRunSamples = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: (...a: unknown[]) => getRunSamples(...a) },
}));

/** Two rows, ids 7 and 9, in that order of time. */
function makeReport(): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1,
		},
		summary: {
			totalRequests: 2,
			successfulRequests: 2,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 2,
		},
		latency: { min: 5, max: 5, avg: 5, p50: 5, p90: 5, p95: 5, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		results: [
			{
				id: 7,
				timestamp: 1_700_000_000_000,
				statusCode: 200,
				statusText: "OK",
				latencyMs: 5,
			},
			{
				id: 9,
				timestamp: 1_700_000_000_001,
				statusCode: 201,
				statusText: "Created",
				latencyMs: 6,
			},
		],
	};
}

/** Only the second row (id 9) has a captured exchange. */
function samplesPage(): RunSamplesResponse {
	return {
		data: [
			{
				resultId: 9,
				response: {
					headers: { "content-type": "application/json" },
					body: '{"id":9}',
					bodyBytes: 8,
				},
			},
		],
		pagination: { total: 1, limit: 100, offset: 0, hasMore: false, returned: 1 },
	};
}

const renderTab = () => {
	const report = makeReport();
	return render(
		withQueryClient(<SamplesTab report={report} derived={reportToDerived(report)} />)
	);
};

beforeEach(() => {
	getRunSamples.mockReset();
	getRunSamples.mockResolvedValue(samplesPage());
});

describe("SamplesTab captured samples (#174)", () => {
	it("does not fetch captured bodies until a sample is expanded", async () => {
		renderTab();
		expect(getRunSamples).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /200 OK/ }));
		await waitFor(() => expect(getRunSamples).toHaveBeenCalledWith("run_1"));
	});

	it("renders a body on the row whose result id carries it, and on no other", async () => {
		renderTab();
		fireEvent.click(screen.getByRole("button", { name: /201 Created/ }));
		expect(await screen.findByRole("tab", { name: /Headers/ })).toBeInTheDocument();

		// Only one row is open at a time, so this closes row #2. Row #1 (id 7) has nothing in the page: a join on the row's position
		// would hand it row #2's body.
		fireEvent.click(screen.getByRole("button", { name: /200 OK/ }));
		await waitFor(() => expect(getRunSamples).toHaveBeenCalled());
		expect(screen.queryByRole("tab", { name: /Headers/ })).toBeNull();
	});
});
