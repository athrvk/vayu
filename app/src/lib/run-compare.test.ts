/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's side of the run diff. The deltas are covered through the MCP
 * mirror (`electron/mcp/compare.test.ts`) and pinned equal to this file by
 * `compare.conformance.test.ts`; what only this file can lose is the
 * `comparability` list the vs-baseline strip renders, so it is asserted here
 * value for value rather than trusted to the conformance test, which would pass
 * if both implementations broke the same way.
 */

import { describe, expect, test } from "vitest";
import { compareReports } from "./run-compare";

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

	describe("what a report does not carry is unknown, not a difference", () => {
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
			{ acceptEncoding: false, mode: "constant_rps", concurrency: 10, targetRps: 100 },
			{ requestMethod: "GET" },
			{ testDuration: 20 }
		);
		const target = report(
			{ concurrency: 50, mode: "constant_concurrency", targetRps: 400, acceptEncoding: true },
			{ status: "stopped", requestMethod: "POST" },
			{ testDuration: 3 }
		);
		expect(codes(base, target)).toEqual([
			"mode",
			"concurrency",
			"target_rps",
			"duration",
			"status",
			"request",
			"compression",
		]);
	});
});
