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
 * A run flagged `summary.summaryMissing` (no counts, no latency) or
 * `summary.partial` (counts of the last saved tick, no latency) measured
 * nothing there (#2895), and its report omits `latency` (#2938). The compare view judges each side on its
 * own (#2904): the flagged run's cell reads "not recorded" and the change reads
 * "-", never a delta against the zero, whichever side of the table the flagged
 * run is on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunComparisonView from "./RunComparisonView";
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

/** A recorded run whose figures are all `n`-based, so a row says which side it came from. */
function recorded(n: number): RunReport {
	return {
		metadata: { runId: "r", runType: "load", status: "completed", startTime: 0, endTime: 1000 },
		summary: {
			totalRequests: n * 100,
			successfulRequests: n * 100,
			failedRequests: 0,
			errorRate: n,
			totalDurationSeconds: 10,
			avgRps: n * 10,
			throughput: n * 10,
		},
		latency: { min: 1, max: n * 9, avg: n, p50: n, p90: n * 2, p95: n * 3, p99: n * 4 },
		statusCodes: { "200": n * 100 },
		errors: { total: 0, withDetails: 0, types: {} },
	} as RunReport;
}

/**
 * What the engine writes for a run it could not record: the flag, zero counts
 * and no `latency`. `partial` keeps the last tick's counts (600 requests,
 * 3 rps); `summaryMissing` keeps nothing.
 */
function flagged(flag: Flag): RunReport {
	const base = recorded(0);
	delete base.latency;
	const counts =
		flag === "partial"
			? { totalRequests: 600, successfulRequests: 600, errorRate: 0.5, avgRps: 30 }
			: {};
	return {
		...base,
		summary: { ...base.summary, ...counts, [flag]: true },
	} as RunReport;
}

function run(id: string, over: Partial<Run> = {}): Run {
	return {
		id,
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

const POOL: Run[] = [run("run_open"), run("run_other", { baseline: true })];

function page(rows: Run[]) {
	return {
		data: rows,
		pagination: {
			total: rows.length,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: rows.length,
			nextBefore: null,
		},
	};
}

function renderCompare(open: RunReport, other: RunReport) {
	mocked.listRuns.mockImplementation(async (params = {}) =>
		page(POOL.filter((r) => !params.baseline || r.baseline === true))
	);
	mocked.getRun.mockImplementation(async (id: string) => POOL.find((r) => r.id === id)!);
	mocked.getRunReport.mockImplementation(async () => other);
	render(
		withQueryClient(
			<RunComparisonView report={open} runId="run_open" requestId="req_1" onClose={vi.fn()} />
		)
	);
}

/** [compared run, this run, change] of a row. */
async function row(name: RegExp): Promise<string[]> {
	const found = await screen.findByRole("row", { name });
	return within(found)
		.getAllByRole("cell")
		.slice(1)
		.map((cell) => cell.textContent ?? "");
}

const LATENCY_ROWS = [
	/P50 latency/,
	/P90 latency/,
	/P95 latency/,
	/P99 latency/,
	/Average latency/,
	/Max latency/,
];
const COUNT_ROWS = [/^Throughput/, /Response rate/, /Error rate/, /Total requests/];

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RunComparisonView with a run the engine did not fully record (#2904)", () => {
	describe.each(["summaryMissing", "partial"] as const)("%s", (flag) => {
		it("reads the compared run's unrecorded latency as not recorded, with no delta", async () => {
			renderCompare(recorded(2), flagged(flag));

			for (const name of LATENCY_ROWS) {
				const [compared, open, change] = await row(name);
				expect(compared).toBe("not recorded");
				expect(open).not.toBe("not recorded");
				expect(change).toBe("-");
			}
		});

		it("reads this run's unrecorded latency as not recorded, with no delta", async () => {
			renderCompare(flagged(flag), recorded(2));

			for (const name of LATENCY_ROWS) {
				const [compared, open, change] = await row(name);
				expect(compared).not.toBe("not recorded");
				expect(open).toBe("not recorded");
				expect(change).toBe("-");
			}
		});
	});

	it("reads every figure of a compared run with no summary as not recorded", async () => {
		renderCompare(recorded(2), flagged("summaryMissing"));

		for (const name of COUNT_ROWS) {
			const [compared, open, change] = await row(name);
			expect(compared).toBe("not recorded");
			expect(open).not.toBe("not recorded");
			expect(change).toBe("-");
		}
	});

	it("reads every figure of this run with no summary as not recorded", async () => {
		renderCompare(flagged("summaryMissing"), recorded(2));

		for (const name of COUNT_ROWS) {
			const [compared, open, change] = await row(name);
			expect(compared).not.toBe("not recorded");
			expect(open).toBe("not recorded");
			expect(change).toBe("-");
		}
	});

	it("keeps a partial run's last-saved counts and diffs them", async () => {
		renderCompare(recorded(2), flagged("partial"));

		const [compared, open, change] = await row(/Total requests/);
		expect(compared).toBe("600");
		expect(open).toBe("200");
		expect(change).toContain("-66.7%");
	});

	it("diffs the figures of two recorded runs as before", async () => {
		renderCompare(recorded(2), recorded(1));

		const [compared, open, change] = await row(/P99 latency/);
		expect([compared, open]).toEqual(["4ms", "8ms"]);
		expect(change).toContain("+100.0%");
	});
});
