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

/*
 * `comparability` (issue #2162): one case per code, the boundary of the one
 * rule with a threshold, and the absences that must stay silent. Each expected
 * entry is spelled out, so a rule that returned a different message, a
 * different value or nothing at all fails here and not only in the conformance
 * test, which would pass if both implementations broke the same way.
 */
describe("comparability", () => {
	type Part = Record<string, unknown>;
	const report = (
		configuration: Part = {},
		metadata: Part = {},
		summary: Part = {}
	): Record<string, unknown> => ({
		metadata: { status: "completed", configuration, ...metadata },
		summary,
	});
	const codes = (a: Record<string, unknown>, b: Record<string, unknown>) =>
		compareReports("a", "b", a, b).comparability.map((w) => w.code);

	const CASES: {
		name: string;
		base: Record<string, unknown>;
		target: Record<string, unknown>;
		expected: { code: string; message: string; base: string; target: string };
	}[] = [
		{
			name: "run_type, named as the app names each kind of run",
			base: report({}, { runType: "load" }),
			target: report({}, { runType: "scenario" }),
			expected: {
				code: "run_type",
				message: "Run types differ, so these figures measure different things.",
				base: "Load test",
				target: "Collection run",
			},
		},
		{
			name: "mode",
			base: report({ mode: "constant_rps" }),
			target: report({ mode: "constant_concurrency" }),
			expected: {
				code: "mode",
				message: "Test mode differs.",
				base: "constant_rps",
				target: "constant_concurrency",
			},
		},
		{
			name: "concurrency",
			base: report({ concurrency: 10 }),
			target: report({ concurrency: 50 }),
			expected: {
				code: "concurrency",
				message: "Virtual users differ.",
				base: "10",
				target: "50",
			},
		},
		{
			name: "concurrency of a ramp reads the start level and the ramp time",
			base: report({
				mode: "ramp_up",
				concurrency: 50,
				startConcurrency: 1,
				rampUpDuration: "10s",
			}),
			target: report({
				mode: "ramp_up",
				concurrency: 50,
				startConcurrency: 25,
				rampUpDuration: "10s",
			}),
			expected: {
				code: "concurrency",
				message: "Virtual users differ.",
				base: "1 to 50, ramp 10s",
				target: "25 to 50, ramp 10s",
			},
		},
		{
			name: "target_rps",
			base: report({ targetRps: 100 }),
			target: report({ targetRps: 400 }),
			expected: {
				code: "target_rps",
				message: "Target request rate differs.",
				base: "100 rps",
				target: "400 rps",
			},
		},
		{
			name: "duration, with the status of a run that did not finish",
			base: report({}, {}, { testDuration: 20.004 }),
			target: report({}, { status: "stopped" }, { testDuration: 3.04 }),
			expected: {
				code: "duration",
				message: "Run durations differ by more than 2x.",
				base: "20 s",
				target: "3 s, stopped",
			},
		},
		{
			name: "status",
			base: report(),
			target: report({}, { status: "stopped" }),
			expected: {
				code: "status",
				message: "Run status differs.",
				base: "Completed",
				target: "Stopped",
			},
		},
		{
			name: "http_version",
			base: report({ httpVersion: "http1.1" }),
			target: report({ httpVersion: "http2" }),
			expected: {
				code: "http_version",
				message: "HTTP version differs.",
				base: "http1.1",
				target: "http2",
			},
		},
		{
			name: "data_file, by content hash",
			base: report({ dataFileName: "users.csv", dataFileHash: "aaaaaaaa11112222" }),
			target: report({ dataFileName: "users.csv", dataFileHash: "bbbbbbbb33334444" }),
			expected: {
				code: "data_file",
				message: "Data file differs.",
				base: "users.csv (aaaaaaaa)",
				target: "users.csv (bbbbbbbb)",
			},
		},
		{
			name: "data_file, none against one",
			base: report(),
			target: report({ dataFileHash: "bbbbbbbb33334444" }),
			expected: {
				code: "data_file",
				message: "Data file differs.",
				base: "none",
				target: "bbbbbbbb",
			},
		},
		{
			name: "request, by method",
			base: report({}, { requestMethod: "GET", requestUrl: "https://api.test/a" }),
			target: report({}, { requestMethod: "POST", requestUrl: "https://api.test/a" }),
			expected: {
				code: "request",
				message: "Request differs.",
				base: "GET https://api.test/a",
				target: "POST https://api.test/a",
			},
		},
		{
			name: "request, by url, which never carries a query, fragment or userinfo",
			base: report(
				{},
				{ requestMethod: "GET", requestUrl: "https://u:p@ss@api.test/a?token=s3cret" }
			),
			target: report({}, { requestMethod: "GET", requestUrl: "https://api.test/b#frag" }),
			expected: {
				code: "request",
				message: "Request differs.",
				base: "GET https://api.test/a",
				target: "GET https://api.test/b",
			},
		},
		{
			name: "compression",
			base: report({ acceptEncoding: false }),
			target: report({ acceptEncoding: true }),
			expected: {
				code: "compression",
				message:
					"Compression negotiation differs, so byte and latency figures are not directly comparable.",
				base: "not negotiated",
				target: "negotiated",
			},
		},
		{
			name: "expect_continue, refused against allowed",
			base: report({ expectContinue: false }),
			target: report({ expectContinue: true }),
			expected: {
				code: "expect_continue",
				message:
					"Expect: 100-continue handling differs, so large-body latency figures are not directly comparable.",
				base: "not allowed",
				target: "allowed",
			},
		},
		{
			name: "expect_continue, allowed against refused",
			base: report({ expectContinue: true }),
			target: report({ expectContinue: false }),
			expected: {
				code: "expect_continue",
				message:
					"Expect: 100-continue handling differs, so large-body latency figures are not directly comparable.",
				base: "allowed",
				target: "not allowed",
			},
		},
		{
			name: "expect_continue, a run recorded before the key against one that allowed it",
			base: report(),
			target: report({ expectContinue: true }),
			expected: {
				code: "expect_continue",
				message:
					"Expect: 100-continue handling differs, so large-body latency figures are not directly comparable.",
				base: "not allowed",
				target: "allowed",
			},
		},
	];

	// Filtered to the case's own code: a stopped run also trips `status`, and the
	// pair as a whole is pinned by the ordering test below.
	test.each(CASES)("$name", ({ base, target, expected }) => {
		const entries = compareReports("a", "b", base, target).comparability;
		expect(entries.filter((w) => w.code === expected.code)).toEqual([expected]);
	});

	test("a pair that differs in nothing yields an empty list", () => {
		const same = report(
			{
				mode: "constant_concurrency",
				concurrency: 10,
				httpVersion: "http2",
				dataFileHash: "aaaaaaaa11112222",
				acceptEncoding: true,
				expectContinue: true,
			},
			{ requestMethod: "GET", requestUrl: "https://api.test/a" },
			{ testDuration: 20 }
		);
		const cmp = compareReports("a", "b", same, structuredClone(same));
		expect(cmp.comparability).toEqual([]);
		expect(cmp.compressionNegotiationDiffers).toBe(false);
	});

	test("a query-only difference is the same request", () => {
		const a = report({}, { requestMethod: "GET", requestUrl: "https://api.test/a?page=1" });
		const b = report({}, { requestMethod: "GET", requestUrl: "https://api.test/a?page=2" });
		expect(codes(a, b)).toEqual([]);
	});

	test("the compression flag and its entry say the same thing", () => {
		const negotiated = report({ acceptEncoding: true });
		const plain = report();
		expect(compareReports("a", "b", plain, negotiated).compressionNegotiationDiffers).toBe(
			true
		);
		expect(codes(plain, negotiated)).toEqual(["compression"]);
		expect(compareReports("a", "b", plain, plain).compressionNegotiationDiffers).toBe(false);
	});

	describe("duration threshold", () => {
		const durations = (b: number, t: number) =>
			codes(report({}, {}, { testDuration: b }), report({}, {}, { testDuration: t }));

		test("exactly 2x is the same experiment, just above it is not", () => {
			expect(durations(10, 20)).toEqual([]);
			expect(durations(20, 10)).toEqual([]);
			expect(durations(10, 20.1)).toEqual(["duration"]);
			expect(durations(20.1, 10)).toEqual(["duration"]);
		});

		test("a missing or zero duration is unknown, never a difference", () => {
			expect(codes(report({}, {}, { testDuration: 20 }), report())).toEqual([]);
			expect(durations(0, 20)).toEqual([]);
			expect(durations(20, 0)).toEqual([]);
			expect(durations(Number.NaN, 20)).toEqual([]);
		});
	});

	describe("run_type", () => {
		const typed = (runType: string) => report({}, { runType });

		test("a send reads as Send, and a type the app does not name as written", () => {
			const entries = compareReports(
				"a",
				"b",
				typed("design"),
				typed("replay")
			).comparability;
			expect(entries.map((w) => [w.code, w.base, w.target])).toEqual([
				["run_type", "Send", "replay"],
			]);
		});

		test("two runs of one type, or a type on one side only, say nothing", () => {
			expect(codes(typed("scenario"), typed("scenario"))).toEqual([]);
			expect(codes(typed("load"), report())).toEqual([]);
		});
	});

	describe("once both reports carry runType, a config field on one side only differs", () => {
		const load = (configuration: Part = {}) => report(configuration, { runType: "load" });

		test("virtual users and a target rate recorded on one side show the other as not recorded", () => {
			const entries = compareReports(
				"a",
				"b",
				load({ mode: "constant_rps" }),
				load({ mode: "constant_rps", concurrency: 100, targetRps: 50 })
			).comparability;
			expect(entries).toEqual([
				{
					code: "concurrency",
					message: "Virtual users differ.",
					base: "not recorded",
					target: "100",
				},
				{
					code: "target_rps",
					message: "Target request rate differs.",
					base: "not recorded",
					target: "50 rps",
				},
			]);
		});

		test("a mode recorded on one side is a difference too, whichever side lacks it", () => {
			const entries = compareReports(
				"a",
				"b",
				load({ mode: "iterations" }),
				load()
			).comparability;
			expect(entries).toEqual([
				{
					code: "mode",
					message: "Test mode differs.",
					base: "iterations",
					target: "not recorded",
				},
			]);
		});

		test("runType on one side only keeps the field unknown", () => {
			expect(codes(report(), load({ mode: "iterations", concurrency: 5 }))).toEqual([]);
		});

		test("http_version still treats auto, or no version, as unknown", () => {
			expect(codes(load({ httpVersion: "auto" }), load({ httpVersion: "http2" }))).toEqual(
				[]
			);
			expect(codes(load(), load({ httpVersion: "http2" }))).toEqual([]);
		});
	});

	describe("what a report with no runType does not carry is unknown, not a difference", () => {
		test("a field on one side only says nothing, except a data file", () => {
			const bare = report();
			const full = report(
				{ mode: "iterations", concurrency: 5, targetRps: 9, httpVersion: "http2" },
				{ requestMethod: "GET", requestUrl: "https://api.test/a" }
			);
			expect(codes(bare, full)).toEqual([]);
		});

		test("http_version treats auto as unknown on either side", () => {
			expect(
				codes(report({ httpVersion: "auto" }), report({ httpVersion: "http2" }))
			).toEqual([]);
			expect(
				codes(report({ httpVersion: "http1.1" }), report({ httpVersion: "auto" }))
			).toEqual([]);
			expect(codes(report({ httpVersion: "auto" }), report({ httpVersion: "auto" }))).toEqual(
				[]
			);
		});

		test("a report without metadata, or with a malformed one, never throws", () => {
			const malformed = [
				{},
				{ metadata: null },
				{ metadata: "x" },
				{ metadata: { configuration: 3 } },
			];
			for (const a of malformed) {
				for (const b of malformed)
					expect(compareReports("a", "b", a, b).comparability).toEqual([]);
			}
		});
	});

	test("entries come out in one fixed order, whatever the report's key order", () => {
		const base = report(
			{
				acceptEncoding: false,
				expectContinue: false,
				mode: "constant_rps",
				concurrency: 10,
				targetRps: 100,
			},
			{ requestMethod: "GET", runType: "load" },
			{ testDuration: 20 }
		);
		const target = report(
			{
				concurrency: 50,
				mode: "constant_concurrency",
				targetRps: 400,
				acceptEncoding: true,
				expectContinue: true,
			},
			{ status: "stopped", requestMethod: "POST", runType: "design" },
			{ testDuration: 3 }
		);
		expect(codes(base, target)).toEqual([
			"run_type",
			"mode",
			"concurrency",
			"target_rps",
			"duration",
			"status",
			"request",
			"compression",
			"expect_continue",
		]);
	});
});
