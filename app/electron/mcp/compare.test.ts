/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { compareReports } from "./compare.js";

describe("compareReports", () => {
	const base = {
		latency: { p50: 10, p95: 20, p99: 40, avg: 12, max: 100, p90: 18 },
		summary: { avgRps: 100, throughput: 99, errorRate: 0.5, totalRequests: 6000 },
		statusCodes: { "200": 5970, "500": 30 },
	};
	const target = {
		latency: { p50: 15, p95: 30, p99: 80, avg: 18, max: 200, p90: 27 },
		summary: { avgRps: 90, throughput: 88, errorRate: 2.0, totalRequests: 5400 },
		statusCodes: { "200": 5292, "500": 108 },
	};

	test("computes latency deltas with percentage change", () => {
		const cmp = compareReports("run_a", "run_b", base, target);
		const p99 = cmp.latency.find((m) => m.metric === "latency.p99")!;
		expect(p99.base).toBe(40);
		expect(p99.target).toBe(80);
		expect(p99.delta).toBe(40);
		expect(p99.pctChange).toBe(100);
	});

	test("captures error-rate regression", () => {
		const cmp = compareReports("run_a", "run_b", base, target);
		const errorRate = cmp.reliability.find((m) => m.metric === "summary.errorRate")!;
		expect(errorRate.delta).toBe(1.5);
	});

	test("merges status-code maps from both runs", () => {
		const cmp = compareReports("run_a", "run_b", base, target);
		expect(cmp.statusCodes["200"]).toEqual({ base: 5970, target: 5292 });
		expect(cmp.statusCodes["500"]).toEqual({ base: 30, target: 108 });
	});

	test("tolerates missing fields (null deltas, no throw)", () => {
		const cmp = compareReports("a", "b", {}, {});
		expect(cmp.latency.every((m) => m.base === null && m.target === null)).toBe(true);
		expect(cmp.statusCodes).toEqual({});
	});
});
