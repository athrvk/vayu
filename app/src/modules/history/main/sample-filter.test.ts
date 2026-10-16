/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where an Overview error row lands in the Samples tab (#2213): the first loaded
 * sample the row counts, numbered the way the tab numbers it, and the chip that
 * shows it.
 */

import { describe, it, expect } from "vitest";
import { locateSample, numberByTime, filterSamples } from "./sample-filter";
import type { SampleResult } from "../types";

function sample(ts: number, statusCode: number, extra: Partial<SampleResult> = {}): SampleResult {
	return { timestamp: ts, statusCode, latencyMs: 1, ...extra };
}

// In time order: 1 -> 200, 2 -> 404, 3 -> 503, 4 -> 301, 5 -> 0 (timeout),
// 6 -> 500, 7 -> 500, 8 -> 0 (no trace), 9 -> 429.
const ARRIVAL_ORDER: SampleResult[] = [
	sample(7, 500),
	sample(1, 200),
	sample(3, 503),
	sample(2, 404),
	sample(5, 0, { trace: { error_type: "timeout" } }),
	sample(4, 301),
	sample(6, 500, { trace: { error_type: "internal_error" } }),
	sample(8, 0),
	sample(9, 429),
];
const rows = numberByTime(ARRIVAL_ORDER);

describe("locateSample - status rows", () => {
	it.each([
		["500", "5xx", 6],
		["503", "5xx", 3],
		["404", "4xx", 2],
		["429", "4xx", 9],
		["0", "no-response", 5],
		["301", "all", 4],
		["200", "all", 1],
	])("HTTP %s opens the first sample with that code on the %s chip", (code, filter, number) => {
		expect(locateSample(rows, { kind: "status", code })).toEqual({ filter, number });
	});

	it("matches the exact code, not its class", () => {
		expect(locateSample(rows, { kind: "status", code: "502" })).toBeNull();
	});

	it("numbers the way the Samples tab does, not by report order", () => {
		// 500 is first in the report's list but seventh in time.
		const first500 = locateSample(rows, { kind: "status", code: "500" });
		expect(first500?.number).toBe(6);
		expect(rows[(first500?.number ?? 0) - 1].sample.timestamp).toBe(6);
	});

	it("is null for a run that kept no samples", () => {
		expect(locateSample([], { kind: "status", code: "500" })).toBeNull();
	});

	it("lands on a chip that shows the sample it found", () => {
		for (const code of ["500", "404", "0", "301", "200"]) {
			const found = locateSample(rows, { kind: "status", code });
			const shown = filterSamples(rows, found!.filter).map((r) => r.number);
			expect(shown).toContain(found!.number);
		}
	});
});

describe("locateSample - error-type rows", () => {
	it("opens the first sample whose trace carries the type, on the Errors chip", () => {
		expect(locateSample(rows, { kind: "errorType", key: "timeout" })).toEqual({
			filter: "errors",
			number: 5,
		});
		expect(locateSample(rows, { kind: "errorType", key: "internal_error" })).toEqual({
			filter: "errors",
			number: 6,
		});
	});

	it("never matches a sample with no trace", () => {
		const untraced = numberByTime([sample(1, 0), sample(2, 500)]);
		expect(locateSample(untraced, { kind: "errorType", key: "timeout" })).toBeNull();
	});

	it("is null for a type no loaded sample carries", () => {
		expect(locateSample(rows, { kind: "errorType", key: "ssl_error" })).toBeNull();
	});
});
