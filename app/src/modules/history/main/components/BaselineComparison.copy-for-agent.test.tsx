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
 * "Copy comparison for agent" on the vs-baseline strip (#2047).
 *
 * The two runs arrive in different shapes: the baseline is a list row
 * (`GET /runs?baseline=true`, a `summary`), the open run a loaded one
 * (`GET /runs/:id`, a `configSnapshot` and no summary). Both go through
 * `runReferenceInput`, so the open run here is a run of an unsaved request
 * whose url only its snapshot holds - the strip has to find its baseline from
 * that url before it can draw at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import BaselineComparison from "./BaselineComparison";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import { formatInstant } from "@/lib/time-value";
import { useToastStore } from "@/stores";
import type { Run, RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: { getRun: vi.fn(), listRuns: vi.fn(), getRunReport: vi.fn() },
}));

const mocked = vi.mocked(apiService);

const SENTINEL = "s3cr3t-sentinel";
const URL = `https://api.example.test/checkout?token=${SENTINEL}`;
const BASE_START = 1_750_000_000_000;
const TARGET_START = 1_750_100_000_000;

function report(p99: number): RunReport {
	return {
		metadata: { runId: "r", runType: "load", status: "completed", startTime: 0, endTime: 1 },
		summary: {
			totalRequests: 10,
			successfulRequests: 10,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 10,
		},
		latency: { min: 1, max: 90, avg: 10, p50: 8, p90: 20, p95: 30, p99 },
		statusCodes: { "200": 10 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

const loadedTarget: Run = {
	id: "run_target",
	type: "load",
	status: "completed",
	startTime: TARGET_START,
	endTime: TARGET_START + 1000,
	requestId: null,
	environmentId: null,
	configSnapshot: {
		url: URL,
		method: "POST",
		requestName: "Checkout",
		headers: { Authorization: `Bearer ${SENTINEL}` },
		auth: { mode: "bearer", bearer: { token: SENTINEL } },
		variables: { apiKey: SENTINEL },
	},
};

const baselineRow: Run = {
	id: "run_baseline",
	type: "load",
	status: "completed",
	startTime: BASE_START,
	endTime: BASE_START + 1000,
	requestId: null,
	environmentId: null,
	baseline: true,
	summary: { url: URL, method: "POST" },
};

const writeText = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
	mocked.getRun.mockResolvedValue(loadedTarget);
	mocked.listRuns.mockResolvedValue({
		data: [baselineRow],
		pagination: {
			total: 1,
			limit: 20,
			offset: 0,
			hasMore: false,
			returned: 1,
			nextBefore: null,
		},
	});
	mocked.getRunReport.mockResolvedValue(report(50));
});

describe("Copy comparison for agent", () => {
	it("copies both runs' lines, the open run's from its snapshot, and says so", async () => {
		render(withQueryClient(<BaselineComparison report={report(100)} runId="run_target" />));

		fireEvent.click(await screen.findByRole("button", { name: "Copy comparison for agent" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).toBe(
			[
				"Vayu run comparison base (run_baseline) target (run_target)",
				`Vayu run "POST /checkout" (run_baseline) - load test, POST /checkout, ${formatInstant(BASE_START, "datetime")}, completed`,
				`Vayu run "Checkout" (run_target) - load test, POST /checkout, ${formatInstant(TARGET_START, "datetime")}, completed`,
			].join("\n")
		);
		expect(copied).not.toContain(SENTINEL);
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});
});
