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
 * Issue #1650: the Samples tab's row dividers vanished in dark mode.
 *
 * `7c7b5a89` flattened each sample onto a `divide-y` / `border-b` strip inside
 * a bare `Card` (`border bg-card`), which declares no `--rule` - so the
 * dividers fell back to `--border`, indistinguishable from `--card` in dark
 * (the trap `border-rule` exists for, per `app/CLAUDE.md`'s Borders section).
 * `surface-card` is the load-bearing half of the fix: `border-rule` alone
 * proves nothing, since it silently reverts to the invisible default without
 * a declared surface above it.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import SamplesTab from "./SamplesTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: vi.fn() },
}));

function makeReport(): RunReport {
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
			totalRequests: 2,
			successfulRequests: 2,
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
			{ timestamp: 1_700_000_001_000, statusCode: 200, statusText: "OK", latencyMs: 3 },
		],
	};
}

function renderTab() {
	const report = makeReport();
	return render(
		withQueryClient(<SamplesTab report={report} derived={reportToDerived(report)} />)
	);
}

describe("SamplesTab declares the surface its dividers read", () => {
	it("the strip's wrapper sits under a declared surface-card, not just a border token", () => {
		const { container } = renderTab();
		const stripWrapper = container.querySelector(".divide-y");

		expect(stripWrapper, "expected a divide-y strip wrapper").toBeTruthy();
		expect(stripWrapper!.className).toMatch(/\bdivide-rule\b/);
		expect(
			stripWrapper!.closest(".surface-card"),
			"the divide-y strip must sit under a surface-card, or its rule colour silently reverts to --border"
		).not.toBeNull();
	});

	it("each row reads the same rule colour", () => {
		const { container } = renderTab();
		const rows = Array.from(container.querySelectorAll(".border-b"));

		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(row.className).toMatch(/\bborder-rule\b/);
		}
	});
});
