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
 * A failed load run the engine could not fully record (#2895) carries
 * `summary.summaryMissing` (the counts are not whole-run totals) or
 * `summary.partial` (the last saved tick's counts), and its report omits
 * `latency` (#2938). The Overview says so: "not recorded" where a count would
 * pass for a measurement, "-" where the latency is absent.
 *
 * Mutation-check: revert the `reportToDerived` guard on `report.latency` and the
 * flagged cases throw; revert `formatLatencyOrDash` and the P99 tile reads 0ms.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

type Flags = Pick<RunReport["summary"], "partial" | "summaryMissing">;

/** A flagged run omits `latency`; pass one only for a run that recorded it. */
function makeReport(
	flags: Flags,
	counts: { total: number; failed: number },
	latency?: RunReport["latency"]
): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "failed",
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "20s", targetRps: 50 },
		},
		summary: {
			totalRequests: counts.total,
			successfulRequests: counts.total - counts.failed,
			failedRequests: counts.failed,
			errorRate: counts.total > 0 ? (counts.failed / counts.total) * 100 : 0,
			totalDurationSeconds: 3,
			avgRps: 0,
			...flags,
		},
		latency,
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

/** The P99 latency tile, which sits beside its label. */
function p99Tile(): HTMLElement {
	return screen.getByText("P99 latency").parentElement!.parentElement!;
}

function renderTab(report: RunReport) {
	return render(
		withQueryClient(
			<OverviewTab
				report={report}
				runId={report.metadata?.runId ?? ""}
				derived={reportToDerived(report)}
				anomalies={[]}
			/>
		)
	);
}

describe("OverviewTab unrecorded figures", () => {
	it("says the counts were not recorded and draws none of them for a run with no summary", async () => {
		renderTab(makeReport({ summaryMissing: true }, { total: 0, failed: 0 }));

		expect(await screen.findByText("Counts were not recorded")).toBeInTheDocument();
		expect(screen.getByText(/The run ended before the totals were saved/)).toBeInTheDocument();
		// Total requests and success rate say "not recorded"; the absent P99 is "-".
		expect(screen.getAllByText("not recorded")).toHaveLength(2);
		expect(within(p99Tile()).getByText("-")).toBeInTheDocument();
		expect(screen.queryByText("0ms")).toBeNull();
		expect(screen.queryByText("0.0%")).toBeNull();
		// The cards under the tiles would each draw a measured-looking 0.
		expect(screen.queryByText("Error rate")).toBeNull();
		// The tile's own label is the only "Total requests" left.
		expect(screen.getAllByText("Total requests")).toHaveLength(1);
	});

	it("keeps the last saved counts and marks only the latency for a partial run", async () => {
		renderTab(makeReport({ partial: true }, { total: 1_234, failed: 234 }));

		expect(await screen.findByText("Counts are partial")).toBeInTheDocument();
		expect(screen.getByText(/these are the last figures it recorded/)).toBeInTheDocument();
		expect(screen.getByText("1,234")).toBeInTheDocument();
		expect(screen.getByText("81.0%")).toBeInTheDocument();
		// Only the latency is unrecorded: the counts above are the last tick's.
		expect(screen.queryByText("not recorded")).toBeNull();
		expect(within(p99Tile()).getByText("-")).toBeInTheDocument();
		expect(screen.queryByText("0ms")).toBeNull();
		expect(screen.queryByText("Error rate")).toBeNull();
	});

	it("shows neither notice nor placeholder for a run that recorded its summary", async () => {
		const latency = { min: 1, max: 90, avg: 20, p50: 18, p90: 40, p95: 60, p99: 87 };
		renderTab(makeReport({}, { total: 1_234, failed: 234 }, latency));

		// The glance under the tiles is drawn too; the tiles alone are not unique text.
		expect(await screen.findByText("Error rate")).toBeInTheDocument();
		expect(screen.queryByText("Counts were not recorded")).toBeNull();
		expect(screen.queryByText("Counts are partial")).toBeNull();
		expect(screen.queryByText("not recorded")).toBeNull();
		expect(within(p99Tile()).getByText("87ms")).toBeInTheDocument();
		expect(screen.getAllByText("1,234").length).toBeGreaterThan(0);
	});
});
