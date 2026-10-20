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
 * The cases are the contract, and they are shared with the engine:
 * `engine/tests/fixtures/run-compare-conformance.json` holds each pair of
 * reports with `compareReports`' recorded answer, and the run-report export's
 * C++ comparison (`engine/src/core/run_compare.cpp`) replays the same file. A
 * case added there fails whichever of the three sides answers it differently.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { compareReports as mainCompare, deltaVerdict as mainVerdict } from "./compare.js";
import {
	compareReports as rendererCompare,
	deltaVerdict as rendererVerdict,
	type MetricDelta,
	type RunComparison,
} from "@/lib/run-compare";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

type Report = Record<string, unknown>;

const [fixturePath] = ENGINE_READING_GUARDS.runCompare.paths.map(fromRepoRoot);
const CASES = (
	JSON.parse(readFileSync(fixturePath, "utf8")) as {
		cases: {
			name: string;
			base: Report;
			target: Report;
			expected: Omit<RunComparison, "baseRunId" | "targetRunId">;
		}[];
	}
).cases;

const caseNamed = (prefix: string) => {
	const found = CASES.find((c) => c.name.startsWith(prefix));
	if (!found) throw new Error(`no fixture case starts with "${prefix}"`);
	return found;
};

describe("run comparison mirror", () => {
	test("read a non-empty fixture", () => {
		expect(CASES.length).toBeGreaterThan(0);
	});

	test.each(CASES)(
		"$name diffs to the recorded answer on both sides",
		({ base, target, expected }) => {
			const answer = { baseRunId: "run_base", targetRunId: "run_target", ...expected };
			expect(mainCompare("run_base", "run_target", base, target)).toEqual(answer);
			expect(rendererCompare("run_base", "run_target", base, target)).toEqual(answer);
		}
	);

	// JSON has no spelling for NaN or Infinity, so this case cannot live in the
	// shared fixture; only the two TypeScript sides can be handed one.
	test("non-finite numbers diff identically on both sides", () => {
		const base = {
			latency: { p50: 10, avg: Number.NaN },
			summary: { avgRps: Number.POSITIVE_INFINITY, testDuration: Number.NaN },
			statusCodes: { "200": Number.NaN },
		};
		const target = { latency: { p50: 12, avg: 3 }, summary: { avgRps: 5, testDuration: 20 } };
		expect(mainCompare("a", "b", base, target)).toEqual(
			rendererCompare("a", "b", base, target)
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
	 * #2516: a run that let libcurl add `Expect: 100-continue` and one that did
	 * not are not the same experiment. Pinned as a value on both sides, with an
	 * absent key reading as "not allowed" and no effect on the compression flag.
	 */
	test("comparability names an Expect: 100-continue difference, an absent key reading as not allowed", () => {
		const allowed = { metadata: { configuration: { expectContinue: true } } };
		const refused = { metadata: { configuration: { expectContinue: false } } };
		const preIssue = { metadata: { configuration: { mode: "once" } } };
		const entry = (base: string, target: string) => [
			{
				code: "expect_continue",
				message:
					"Expect: 100-continue handling differs, so large-body latency figures are not directly comparable.",
				base,
				target,
			},
		];

		for (const compare of [mainCompare, rendererCompare]) {
			const refusedToAllowed = compare("a", "b", refused, allowed);
			expect(refusedToAllowed.comparability).toEqual(entry("not allowed", "allowed"));
			expect(refusedToAllowed.compressionNegotiationDiffers).toBe(false);
			expect(compare("a", "b", allowed, refused).comparability).toEqual(
				entry("allowed", "not allowed")
			);
			expect(compare("a", "b", preIssue, allowed).comparability).toEqual(
				entry("not allowed", "allowed")
			);
			expect(compare("a", "b", preIssue, refused).comparability).toEqual([]);
			expect(compare("a", "b", allowed, allowed).comparability).toEqual([]);
		}
	});

	/*
	 * Same reasoning as above: two implementations that both returned `[]` for
	 * every pair would agree forever. The pair #2162 was filed for is pinned as
	 * values, on both sides, in the order the strip renders them.
	 */
	test("comparability names what differs, with both values, in a fixed order", () => {
		const { base, target } = caseNamed("a stopped 50-user");
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
		const { base, target } = caseNamed("a clean regression");
		const main = mainCompare("a", "b", base, target);
		const renderer = rendererCompare("a", "b", base, target);
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
