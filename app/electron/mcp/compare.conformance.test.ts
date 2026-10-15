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
		// The shape the MCP path actually receives: `GET /runs/:id/report` is
		// read raw there, and the engine's `std::map<int, size_t>` serializes as
		// an array of pairs. The renderer's transformer folds it to a record
		// first, so the two sides see different shapes for the same report -
		// which is precisely why both have to read both.
		name: "engine-raw status codes, as arrays of [code, count] pairs",
		base: {
			latency: { p50: 10, p90: 18, p95: 20, p99: 40, avg: 12, max: 100 },
			summary: { avgRps: 100, throughput: 99, errorRate: 0.5, totalRequests: 6000 },
			statusCodes: [
				[200, 5970],
				[500, 30],
			],
		},
		target: {
			latency: { p50: 15, p90: 27, p95: 30, p99: 80, avg: 18, max: 200 },
			summary: { avgRps: 90, throughput: 88, errorRate: 2.0, totalRequests: 5400 },
			statusCodes: [
				[200, 5292],
				[429, 8],
				[500, 100],
			],
		},
	},
	{
		// One side transformed, one side raw - what a comparison between a
		// report the renderer cached and one the tool fetched looks like.
		name: "a raw base against a transformed target",
		base: { statusCodes: [[200, 10]] },
		target: { statusCodes: { "200": 12 } },
	},
	{
		// Pairs that are not pairs: an index key with a tuple value would be a
		// status code the run never saw.
		name: "malformed entries in the array form",
		base: { statusCodes: [[200, 10], "500", [], [404], [301, "many"]] },
		target: { statusCodes: [] },
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
	{
		// A baseline pinned before loadNegotiateCompression's default flipped
		// (issue #1488) against a run recorded after: the base carries no
		// `acceptEncoding` at all, which must read the same as an explicit
		// `false`, not as "unknown".
		name: "a pre-#1488 baseline against a run that negotiated compression",
		base: { metadata: { configuration: { mode: "constant_rps" } } },
		target: { metadata: { configuration: { acceptEncoding: true } } },
	},
	{
		// The pair #2162 was filed for: a short, stopped, 50-user run against a
		// pinned 20 s, 10-user one.
		name: "a stopped 50-user run against a completed 10-user baseline (mode, users, duration, status)",
		base: {
			metadata: {
				status: "completed",
				configuration: { mode: "constant_concurrency", concurrency: 10 },
			},
			summary: { testDuration: 20.004, avgRps: 100 },
		},
		target: {
			metadata: {
				status: "stopped",
				configuration: { mode: "ramp_up", concurrency: 50, startConcurrency: 5 },
			},
			summary: { testDuration: 3.04, avgRps: 40 },
		},
	},
	{
		name: "every comparability rule at once, so the order is pinned",
		base: {
			metadata: {
				status: "completed",
				requestMethod: "GET",
				requestUrl: "https://api.test/a",
				configuration: {
					mode: "constant_rps",
					concurrency: 10,
					targetRps: 100,
					httpVersion: "http1.1",
					dataFileHash: "aaaaaaaa11112222",
					acceptEncoding: false,
				},
			},
			summary: { testDuration: 20 },
		},
		target: {
			metadata: {
				status: "failed",
				requestMethod: "POST",
				requestUrl: "https://api.test/b",
				configuration: {
					mode: "ramp_up",
					concurrency: 50,
					startConcurrency: 2,
					rampUpDuration: "10s",
					targetRps: 400,
					httpVersion: "http2",
					dataFileName: "users.csv",
					dataFileHash: "bbbbbbbb33334444",
					acceptEncoding: true,
				},
			},
			summary: { testDuration: 3 },
		},
	},
	{
		name: "durations just above 2x",
		base: { summary: { testDuration: 10 } },
		target: { summary: { testDuration: 20.1 } },
	},
	{
		name: "durations at exactly 2x",
		base: { summary: { testDuration: 10 } },
		target: { summary: { testDuration: 20 } },
	},
	{
		name: "a zero duration against a real one",
		base: { summary: { testDuration: 0 } },
		target: { summary: { testDuration: 20 } },
	},
	{
		name: "a field on one side only, which is unknown and not a difference",
		base: {},
		target: {
			metadata: {
				requestMethod: "GET",
				configuration: { mode: "iterations", concurrency: 5, httpVersion: "http2" },
			},
			summary: { testDuration: 5 },
		},
	},
	{
		name: "auto against a pinned HTTP version, and a data file against none",
		base: { metadata: { configuration: { httpVersion: "auto" } } },
		target: {
			metadata: { configuration: { httpVersion: "http2", dataFileHash: "bbbbbbbb33334444" } },
		},
	},
	{
		name: "a request url carrying a credential in its query and userinfo",
		base: { metadata: { requestUrl: "https://u:pw@api.test/a?token=s3cret" } },
		target: { metadata: { requestUrl: "https://api.test/b#frag" } },
	},
	{
		name: "reports with a null metadata and a malformed one",
		base: { metadata: null, summary: { testDuration: 10 } },
		target: { metadata: { configuration: 3 }, summary: { testDuration: 10 } },
	},
	{
		name: "no metadata on either side",
		base: { summary: { avgRps: 1 } },
		target: { summary: { avgRps: 1 } },
	},
];

describe("run comparison mirror", () => {
	test.each(CASES)("$name diffs identically on both sides", ({ base, target }) => {
		expect(mainCompare("run_base", "run_target", base, target)).toEqual(
			rendererCompare("run_base", "run_target", base, target)
		);
	});

	/*
	 * Equality alone cannot catch this one: dropping the array form again would
	 * leave *both* sides reporting an empty mix, and an empty mix equals an
	 * empty mix. So the merged counts are pinned as values, on both sides.
	 */
	test("engine-raw pairs merge into real counts, not an empty mix", () => {
		const base = {
			statusCodes: [
				[200, 5970],
				[500, 30],
			],
		};
		const target = {
			statusCodes: [
				[200, 5292],
				[429, 8],
				[500, 100],
			],
		};
		const expected = {
			"200": { base: 5970, target: 5292 },
			"429": { base: 0, target: 8 },
			"500": { base: 30, target: 100 },
		};

		expect(mainCompare("a", "b", base, target).statusCodes).toEqual(expected);
		expect(rendererCompare("a", "b", base, target).statusCodes).toEqual(expected);
	});

	/*
	 * Equality alone (the test.each above) already proves the two sides agree,
	 * but not that either computed the *right* answer - two implementations
	 * that both always returned `false` would agree forever. Pin the value.
	 */
	test("compressionNegotiationDiffers reads a real difference, and an absent key as false", () => {
		const negotiated = { metadata: { configuration: { acceptEncoding: true } } };
		const notNegotiated = { metadata: { configuration: { acceptEncoding: false } } };
		const preIssue = { metadata: { configuration: { mode: "once" } } };

		for (const compare of [mainCompare, rendererCompare]) {
			expect(compare("a", "b", negotiated, notNegotiated).compressionNegotiationDiffers).toBe(
				true
			);
			expect(compare("a", "b", negotiated, negotiated).compressionNegotiationDiffers).toBe(
				false
			);
			// Absent reads as false, same as an explicit false - not "unknown".
			expect(compare("a", "b", preIssue, notNegotiated).compressionNegotiationDiffers).toBe(
				false
			);
			expect(compare("a", "b", preIssue, negotiated).compressionNegotiationDiffers).toBe(
				true
			);
		}
	});

	/*
	 * Same reasoning as above: two implementations that both returned `[]` for
	 * every pair would agree forever. The pair #2162 was filed for is pinned as
	 * values, on both sides, in the order the strip renders them.
	 */
	test("comparability names what differs, with both values, in a fixed order", () => {
		const { base, target } = CASES.find((c) => c.name.startsWith("a stopped 50-user"))!;
		const expected = [
			{
				code: "mode",
				message: "Test mode differs.",
				base: "constant_concurrency",
				target: "ramp_up",
			},
			{
				code: "concurrency",
				message: "Virtual users differ.",
				base: "10",
				target: "5 to 50",
			},
			{
				code: "duration",
				message: "Run durations differ by more than 2x.",
				base: "20 s",
				target: "3 s, stopped",
			},
			{
				code: "status",
				message: "Run status differs.",
				base: "Completed",
				target: "Stopped",
			},
		];

		expect(mainCompare("a", "b", base, target).comparability).toEqual(expected);
		expect(rendererCompare("a", "b", base, target).comparability).toEqual(expected);
	});

	test("comparability is empty for a like-for-like pair and for reports with no metadata", () => {
		const same = {
			metadata: { status: "completed", configuration: { mode: "once", concurrency: 1 } },
			summary: { testDuration: 10 },
		};

		for (const compare of [mainCompare, rendererCompare]) {
			expect(compare("a", "b", same, same).comparability).toEqual([]);
			expect(compare("a", "b", {}, {}).comparability).toEqual([]);
			expect(compare("a", "b", { metadata: null }, { metadata: "x" }).comparability).toEqual(
				[]
			);
		}
	});

	test("the duration threshold is strict: exactly 2x passes, just above warns", () => {
		const at = (seconds: number) => ({ summary: { testDuration: seconds } });

		for (const compare of [mainCompare, rendererCompare]) {
			expect(compare("a", "b", at(10), at(20)).comparability).toEqual([]);
			expect(compare("a", "b", at(10), at(20.1)).comparability.map((w) => w.code)).toEqual([
				"duration",
			]);
		}
	});

	test("a malformed pair is dropped rather than keyed by its index", () => {
		const report = { statusCodes: [[200, 10], "500", [], [404], [301, "many"]] };

		const expected = { "200": { base: 10, target: 0 }, "301": { base: 0, target: 0 } };
		expect(mainCompare("a", "b", report, {}).statusCodes).toEqual(expected);
		expect(rendererCompare("a", "b", report, {}).statusCodes).toEqual(expected);
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
