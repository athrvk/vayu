/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the two run-comparison implementations honest.
 *
 * `electron/mcp/compare.ts` backs the MCP `compare_runs` tool;
 * `src/lib/run-compare.ts` backs the history view's vs-baseline strip. They are
 * the same diff, written twice, because the process boundary forbids sharing a
 * source file in either direction: the main process emits with
 * `rootDir: "electron"` and cannot compile a file from `src/` (TS6059), and the
 * renderer cannot import one from `electron/`, which is a referenced composite
 * project (TS6305; excluding a file from that project to dodge it is TS6307).
 *
 * Drift here would be quiet and expensive - an agent and the UI reporting
 * different verdicts on the same pair of runs - so this file is where the two
 * meet, the way `data-changed.conformance.test.ts` and
 * `variable-resolution.conformance.test.ts` do for their own mirrors. It
 * reaches across the boundary the way `tools.test.ts` already reaches for
 * `@/constants`: a test may, production code may not.
 *
 * The fixtures below are the contract. A case added here fails whichever side
 * forgot it.
 */

import { describe, expect, test } from "vitest";
import { compareReports as mainCompare, deltaVerdict as mainVerdict } from "./compare.js";
import {
	compareReports as rendererCompare,
	deltaVerdict as rendererVerdict,
	type MetricDelta,
} from "@/lib/run-compare";

/**
 * Every shape the diff has to survive, not only the happy one: a regression, an
 * improvement, a run missing whole sections, a zero base (no percentage is
 * definable), and status-code maps that do not overlap.
 */
const CASES: { name: string; base: Record<string, unknown>; target: Record<string, unknown> }[] = [
	{
		name: "a clean regression",
		base: {
			latency: { p50: 10, p90: 18, p95: 20, p99: 40, avg: 12, max: 100 },
			summary: { avgRps: 100, throughput: 99, errorRate: 0.5, totalRequests: 6000 },
			statusCodes: { "200": 5970, "500": 30 },
		},
		target: {
			latency: { p50: 15, p90: 27, p95: 30, p99: 80, avg: 18, max: 200 },
			summary: { avgRps: 90, throughput: 88, errorRate: 2.0, totalRequests: 5400 },
			statusCodes: { "200": 5292, "500": 108 },
		},
	},
	{
		name: "an improvement in both directions",
		base: {
			latency: { p50: 20, p90: 30, p95: 40, p99: 90, avg: 25, max: 300 },
			summary: { avgRps: 80, throughput: 78, errorRate: 3, totalRequests: 4000 },
			statusCodes: { "200": 3880, "503": 120 },
		},
		target: {
			latency: { p50: 9, p90: 14, p95: 19, p99: 35, avg: 11, max: 120 },
			summary: { avgRps: 140, throughput: 138, errorRate: 0, totalRequests: 7000 },
			statusCodes: { "200": 7000 },
		},
	},
	{
		name: "a target report missing every section",
		base: {
			latency: { p50: 10, p90: 18, p95: 20, p99: 40, avg: 12, max: 100 },
			summary: { avgRps: 100, throughput: 99, errorRate: 0.5, totalRequests: 6000 },
			statusCodes: { "200": 6000 },
		},
		target: {},
	},
	{
		name: "a zero base, where no percentage is definable",
		base: {
			latency: { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, max: 0 },
			summary: { avgRps: 0, throughput: 0, errorRate: 0, totalRequests: 0 },
			statusCodes: {},
		},
		target: {
			latency: { p50: 5, p90: 6, p95: 7, p99: 8, avg: 5, max: 9 },
			summary: { avgRps: 50, throughput: 49, errorRate: 1, totalRequests: 500 },
			statusCodes: { "200": 495, "429": 5 },
		},
	},
	{
		name: "values that are not numbers at all",
		base: {
			latency: { p50: "10", p99: null, avg: Number.NaN },
			summary: { avgRps: Number.POSITIVE_INFINITY, errorRate: 1 },
			statusCodes: { "200": "many" },
		},
		target: { latency: 7, summary: null, statusCodes: null },
	},
];

describe("run comparison mirror", () => {
	test.each(CASES)("$name diffs identically on both sides", ({ base, target }) => {
		expect(mainCompare("run_base", "run_target", base, target)).toEqual(
			rendererCompare("run_base", "run_target", base, target)
		);
	});

	test("both sides label the same metrics with the same direction", () => {
		const main = mainCompare("a", "b", CASES[0].base, CASES[0].target);
		const renderer = rendererCompare("a", "b", CASES[0].base, CASES[0].target);
		const directions = (cmp: {
			latency: MetricDelta[];
			throughput: MetricDelta[];
			reliability: MetricDelta[];
		}) =>
			[...cmp.latency, ...cmp.throughput, ...cmp.reliability].map(
				(m) => `${m.metric}:${m.direction}`
			);

		// Non-empty, or two empty lists would agree while proving nothing.
		expect(directions(main).length).toBeGreaterThan(0);
		expect(directions(main)).toEqual(directions(renderer));
	});

	test("both sides read a delta the same way", () => {
		const cases: MetricDelta[] = [
			{
				metric: "latency.p99",
				base: 10,
				target: 20,
				delta: 10,
				pctChange: 100,
				direction: "lower-is-better",
			},
			{
				metric: "latency.p99",
				base: 20,
				target: 10,
				delta: -10,
				pctChange: -50,
				direction: "lower-is-better",
			},
			{
				metric: "summary.avgRps",
				base: 10,
				target: 20,
				delta: 10,
				pctChange: 100,
				direction: "higher-is-better",
			},
			{
				metric: "summary.avgRps",
				base: 20,
				target: 10,
				delta: -10,
				pctChange: -50,
				direction: "higher-is-better",
			},
			{
				metric: "summary.totalRequests",
				base: 10,
				target: 90,
				delta: 80,
				pctChange: 800,
				direction: "neutral",
			},
			{
				metric: "latency.p50",
				base: 10,
				target: 10,
				delta: 0,
				pctChange: 0,
				direction: "lower-is-better",
			},
			{
				metric: "latency.max",
				base: null,
				target: 5,
				delta: null,
				pctChange: null,
				direction: "lower-is-better",
			},
		];

		expect(cases.map(mainVerdict)).toEqual(cases.map(rendererVerdict));
		// And that the shared reading is the *right* one, not merely a shared
		// mistake: a rise in latency is a regression, a rise in RPS is not.
		expect(cases.map(mainVerdict)).toEqual([
			"regressed",
			"improved",
			"improved",
			"regressed",
			"unchanged",
			"unchanged",
			"unknown",
		]);
	});
});
