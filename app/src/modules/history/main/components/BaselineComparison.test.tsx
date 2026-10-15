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
 * The vs-baseline strip: the answer to "did this get slower than the run I
 * pinned?", and the one surface where a delta's *direction* becomes a colour.
 *
 * Two things are worth pinning and both are here. The colouring is
 * direction-aware, not sign-aware - latency up is red and throughput up is
 * green, from the same numbers - and the strip is absent rather than empty
 * whenever there is nothing to compare against, because a row of zeros would
 * claim "nothing changed" about runs that were never compared.
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

function report(over: {
	p99: number;
	avgRps: number;
	errorRate: number;
	acceptEncoding?: boolean;
	status?: string;
	testDuration?: number;
	configuration?: Record<string, unknown>;
}): RunReport {
	const configuration = {
		...over.configuration,
		...(over.acceptEncoding === undefined ? {} : { acceptEncoding: over.acceptEncoding }),
	};
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: over.status ?? "completed",
			startTime: 0,
			endTime: 1000,
			...(Object.keys(configuration).length === 0 ? {} : { configuration }),
		},
		summary: {
			totalRequests: 1000,
			successfulRequests: 1000,
			failedRequests: 0,
			errorRate: over.errorRate,
			totalDurationSeconds: 10,
			avgRps: over.avgRps,
			...(over.testDuration === undefined ? {} : { testDuration: over.testDuration }),
		},
		latency: { min: 1, max: 90, avg: 10, p50: 8, p90: 20, p95: 30, p99: over.p99 },
		statusCodes: { "200": 1000 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
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

/** The pinned run the strip should find, as `GET /runs?baseline=true` sends it. */
function baselinePage(rows: Run[]) {
	return {
		data: rows,
		pagination: {
			total: rows.length,
			limit: 1,
			offset: 0,
			hasMore: false,
			returned: rows.length,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("BaselineComparison", () => {
	it("colours each delta by the metric's direction, not by the sign", async () => {
		mocked.getRun.mockResolvedValue(run());
		mocked.listRuns.mockResolvedValue(
			baselinePage([run({ id: "run_baseline", baseline: true })])
		);
		// Everything rose: latency (worse), throughput (better), errors (worse).
		mocked.getRunReport.mockResolvedValue(report({ p99: 50, avgRps: 100, errorRate: 1 }));

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 100, avgRps: 150, errorRate: 3 })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());

		// The tone lives on the delta span inside the metric's cell; asserting
		// its presence by class is what makes this a colour test rather than a
		// text one.
		const cell = (label: string) => screen.getByText(label).parentElement!;

		// p99 100 vs 50: +100%, and up is worse for latency.
		expect(cell("P99 latency").querySelector(".text-status-error-text")).not.toBeNull();
		// avgRps 150 vs 100: +50%, and up is better for throughput. Same sign,
		// opposite verdict - which is the whole point of `direction`.
		expect(cell("Throughput").querySelector(".text-status-success-text")).not.toBeNull();
		expect(cell("Error rate").querySelector(".text-status-error-text")).not.toBeNull();
	});

	it("reads an improvement as one", async () => {
		mocked.getRun.mockResolvedValue(run());
		mocked.listRuns.mockResolvedValue(
			baselinePage([run({ id: "run_baseline", baseline: true })])
		);
		mocked.getRunReport.mockResolvedValue(report({ p99: 100, avgRps: 150, errorRate: 3 }));

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 50, avgRps: 100, errorRate: 1 })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());
		expect(
			screen
				.getByText("P99 latency")
				.parentElement!.querySelector(".text-status-success-text")
		).not.toBeNull();
		expect(screen.getByText("-50.0%")).toBeInTheDocument();
	});

	it("draws nothing when no run is pinned", async () => {
		mocked.getRun.mockResolvedValue(run());
		mocked.listRuns.mockResolvedValue(baselinePage([]));

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 50, avgRps: 100, errorRate: 1 })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(mocked.listRuns).toHaveBeenCalled());
		expect(screen.queryByText("vs baseline")).not.toBeInTheDocument();
		// And no report was fetched for a comparison that cannot happen.
		expect(mocked.getRunReport).not.toHaveBeenCalled();
	});

	it("draws nothing when the open run is itself the baseline", async () => {
		mocked.getRun.mockResolvedValue(run({ baseline: true }));
		mocked.listRuns.mockResolvedValue(
			baselinePage([run({ id: "run_target", baseline: true })])
		);

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 50, avgRps: 100, errorRate: 1 })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(mocked.listRuns).toHaveBeenCalled());
		expect(screen.queryByText("vs baseline")).not.toBeInTheDocument();
		expect(mocked.getRunReport).not.toHaveBeenCalled();
	});

	/*
	 * A run of an unsaved request has no `requestId`, so the pin is found by the
	 * url and method its row recorded - and the *exact* match happens here,
	 * because the engine's `q` is a substring search that over-matches by design.
	 */
	it("matches an unsaved request by url and method, exactly", async () => {
		mocked.getRun.mockResolvedValue(run({ requestId: null }));
		mocked.listRuns.mockResolvedValue(
			baselinePage([
				// Same url, wrong method.
				run({
					id: "wrong_method",
					summary: { url: "https://api.example.test/checkout", method: "GET" },
				} as Partial<Run>),
				// A longer url this one is merely a substring of.
				run({
					id: "substring",
					summary: { url: "https://api.example.test/checkout/confirm", method: "POST" },
				} as Partial<Run>),
				run({ id: "run_baseline", baseline: true }),
			])
		);
		mocked.getRunReport.mockResolvedValue(report({ p99: 50, avgRps: 100, errorRate: 1 }));

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 100, avgRps: 150, errorRate: 3 })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());
		expect(mocked.getRunReport).toHaveBeenCalledWith("run_baseline");
		expect(mocked.listRuns).toHaveBeenCalledWith(
			expect.objectContaining({ baseline: true, q: "https://api.example.test/checkout" })
		);
	});

	/*
	 * Issue #1488: a baseline pinned under a different compression-negotiation
	 * setting than the run it is compared against means the byte and latency
	 * deltas above are not a clean comparison, so the strip says so - as one
	 * entry of the comparability list (#2162).
	 */
	it("warns when the baseline and the open run negotiated compression differently", async () => {
		mocked.getRun.mockResolvedValue(run());
		mocked.listRuns.mockResolvedValue(
			baselinePage([run({ id: "run_baseline", baseline: true })])
		);
		// Baseline recorded before #1488 (no key at all) - reads as false.
		mocked.getRunReport.mockResolvedValue(report({ p99: 50, avgRps: 100, errorRate: 1 }));

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 50, avgRps: 100, errorRate: 1, acceptEncoding: true })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());
		expect(screen.getByText(/Compression negotiation differs/)).toHaveTextContent(
			"not negotiated vs negotiated."
		);
	});

	/*
	 * Issue #2162: the pair the strip was silent about - a short, stopped,
	 * 50-user run against a pinned 20 s, 10-user baseline. Every row names both
	 * values, so the reader sees what differs and not just that something does.
	 */
	it("lists what differs between the runs, with the baseline's value then this run's", async () => {
		mocked.getRun.mockResolvedValue(run());
		mocked.listRuns.mockResolvedValue(
			baselinePage([run({ id: "run_baseline", baseline: true })])
		);
		mocked.getRunReport.mockResolvedValue(
			report({
				p99: 50,
				avgRps: 100,
				errorRate: 1,
				testDuration: 20,
				configuration: { mode: "constant_concurrency", concurrency: 10 },
			})
		);

		render(
			withQueryClient(
				<BaselineComparison
					report={report({
						p99: 90,
						avgRps: 40,
						errorRate: 1,
						status: "stopped",
						testDuration: 3,
						configuration: { mode: "ramp_up", concurrency: 50 },
					})}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());
		const list = screen.getByRole("list", { name: "Comparability warnings" });
		const rows = within(list)
			.getAllByRole("listitem")
			.map((row) => row.textContent);
		expect(rows).toEqual([
			"Test mode differs. constant_concurrency vs ramp_up.",
			"Virtual users differ. 10 vs 50.",
			"Run durations differ by more than 2x. 20 s vs 3 s, stopped.",
			"Run status differs. Completed vs Stopped.",
		]);
		// The warning tone is the one the compression line always had, and it is
		// the text colour token: the bare fill is not a foreground.
		for (const row of within(list).getAllByRole("listitem")) {
			expect(row.className).toContain("text-status-warning-text");
		}
	});

	it("says nothing when the two runs are like for like", async () => {
		mocked.getRun.mockResolvedValue(run());
		mocked.listRuns.mockResolvedValue(
			baselinePage([run({ id: "run_baseline", baseline: true })])
		);
		const same = {
			testDuration: 20,
			acceptEncoding: true,
			configuration: { mode: "constant_concurrency", concurrency: 10 },
		};
		mocked.getRunReport.mockResolvedValue(
			report({ p99: 50, avgRps: 100, errorRate: 1, ...same })
		);

		render(
			withQueryClient(
				<BaselineComparison
					report={report({ p99: 60, avgRps: 90, errorRate: 1, ...same })}
					runId="run_target"
				/>
			)
		);

		await waitFor(() => expect(screen.getByText("vs baseline")).toBeInTheDocument());
		expect(
			screen.queryByRole("list", { name: "Comparability warnings" })
		).not.toBeInTheDocument();
		expect(screen.queryByText(/differs/)).not.toBeInTheDocument();
	});
});
