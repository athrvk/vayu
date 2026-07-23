/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Guards the canonical engine route names after the /runs + /execute
 * consolidation (issue #83). The engine still serves the old paths as
 * deprecated aliases, so a stray revert here would not fail at runtime - only
 * this test catches it. Every renamed path is pinned to its canonical form and
 * asserted NOT to use a legacy one.
 */

import { describe, it, expect } from "vitest";
import { API_ENDPOINTS } from "./api-endpoints";

describe("API_ENDPOINTS canonical routes", () => {
	it("uses /execute and /runs for execution, not /request and /run", () => {
		expect(API_ENDPOINTS.EXECUTE_REQUEST).toBe("/execute");
		expect(API_ENDPOINTS.START_LOAD_TEST).toBe("/runs");
	});

	it("uses the /runs/:id family for run resources", () => {
		expect(API_ENDPOINTS.RUNS).toBe("/runs");
		expect(API_ENDPOINTS.RUN_BY_ID("r1")).toBe("/runs/r1");
		expect(API_ENDPOINTS.RUN_REPORT("r1")).toBe("/runs/r1/report");
		expect(API_ENDPOINTS.RUN_STOP("r1")).toBe("/runs/r1/stop");
	});

	it("uses /runs/:id/live for live SSE metrics", () => {
		expect(API_ENDPOINTS.METRICS_LIVE("r1")).toBe("/runs/r1/live");
		expect(API_ENDPOINTS.METRICS_LIVE("r1")).not.toContain("/metrics/live/");
	});

	it("uses /runs/:id/metrics for time-series JSON, with no format param", () => {
		const url = API_ENDPOINTS.STATS_TIME_SERIES("r1", 100, 50);
		expect(url).toBe("/runs/r1/metrics?limit=100&offset=50");
		expect(url).not.toContain("/stats/");
		expect(url).not.toContain("format=json");
	});

	it("pins none of the renamed paths to a legacy name", () => {
		const all = [
			API_ENDPOINTS.EXECUTE_REQUEST,
			API_ENDPOINTS.START_LOAD_TEST,
			API_ENDPOINTS.RUN_BY_ID("r1"),
			API_ENDPOINTS.RUN_REPORT("r1"),
			API_ENDPOINTS.RUN_STOP("r1"),
			API_ENDPOINTS.METRICS_LIVE("r1"),
			API_ENDPOINTS.STATS_TIME_SERIES("r1"),
		];
		for (const url of all) {
			expect(url).not.toMatch(/^\/run\//);
			expect(url).not.toMatch(/^\/stats\//);
			expect(url).not.toBe("/request");
			expect(url).not.toBe("/run");
		}
	});
});
