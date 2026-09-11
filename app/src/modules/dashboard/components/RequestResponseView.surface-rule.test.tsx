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
 * Issue #1650: the dashboard's live sample list predates the history Samples
 * tab's `divide-y` / `border-b` strip and shares its bug - both sit in a bare
 * `Card` (`border bg-card`), which declares no `--rule`, so the dividers fell
 * back to `--border` and vanished in dark. `border-rule` alone proves
 * nothing without the declared surface above it, so the strip's wrapper is
 * asserted against `surface-card`, not just against the token.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { withQueryClient } from "@/test/query-wrapper";
import RequestResponseView from "./RequestResponseView";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: vi.fn() },
}));

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
			{ timestamp: 1_700_000_000_000, statusCode: 200, statusText: "OK", latencyMs: 5 },
			{ timestamp: 1_700_000_001_000, statusCode: 200, statusText: "OK", latencyMs: 6 },
		],
	};
}

const renderView = () => render(withQueryClient(<RequestResponseView report={makeReport()} />));

describe("RequestResponseView declares the surface its dividers read", () => {
	it("the strip's wrapper sits under a declared surface-card, not just a border token", () => {
		const { container } = renderView();
		const stripWrapper = container.querySelector(".divide-y");

		expect(stripWrapper, "expected a divide-y strip wrapper").toBeTruthy();
		expect(stripWrapper!.className).toMatch(/\bdivide-rule\b/);
		expect(
			stripWrapper!.closest(".surface-card"),
			"the divide-y strip must sit under a surface-card, or its rule colour silently reverts to --border"
		).not.toBeNull();
	});

	it("each row reads the same rule colour", () => {
		const { container } = renderView();
		const rows = Array.from(container.querySelectorAll(".border-b"));

		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(row.className).toMatch(/\bborder-rule\b/);
		}
	});
});
