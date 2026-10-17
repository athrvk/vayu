/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

// The formatters build their Intl.NumberFormat at module load, so the locale is
// pinned before the import below runs rather than left to the host.
const restoreIntl = vi.hoisted(() => {
	const Real = Intl.NumberFormat;
	class EnUsNumberFormat extends Real {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super("en-US", options);
		}
	}
	Intl.NumberFormat = EnUsNumberFormat as typeof Intl.NumberFormat;
	return () => {
		Intl.NumberFormat = Real;
	};
});

afterAll(restoreIntl);

import {
	formatLatency,
	formatLatencyParts,
	formatMs,
	formatPercent,
	formatRate,
} from "./format-number";

describe("formatMs and formatRate: two decimals under 10, whole numbers above", () => {
	const cases: Array<[string, number | null | undefined, string]> = [
		["a fraction of a millisecond", 0.04, "0.04"],
		["a loopback p99", 2.2749, "2.27"],
		["a trailing zero drops", 2.5, "2.5"],
		["a whole value under 10", 4, "4"],
		["just under the 10 boundary rounds up", 9.996, "10"],
		["the boundary", 10, "10"],
		["rounds above 10", 12.6, "13"],
		["a thousands separator", 1234, "1,234"],
		["a large rate", 12345.6, "12,346"],
		["zero", 0, "0"],
		["a negative value takes the same digits", -2.2749, "-2.27"],
		["NaN", NaN, "0"],
		["Infinity", Infinity, "0"],
		["null", null, "0"],
		["undefined", undefined, "0"],
	];

	it.each(cases)("%s", (_name, input, expected) => {
		expect(formatMs(input)).toBe(expected);
		expect(formatRate(input)).toBe(expected);
	});
});

describe("formatMs and formatLatency: a measured sub-0.01 ms value is never 0", () => {
	const cases: Array<[number | null | undefined, string, string]> = [
		[0.0004, "<0.01", "<0.01ms"],
		[0.0099, "<0.01", "<0.01ms"],
		[0.01, "0.01", "0.01ms"],
		[0.42, "0.42", "0.42ms"],
		[2.8631, "2.86", "2.86ms"],
		[9.99, "9.99", "9.99ms"],
		[10, "10", "10ms"],
		[999, "999", "999ms"],
		[999.6, "1,000", "1.00s"],
		[1000, "1,000", "1.00s"],
		[12345.6, "12,346", "12.35s"],
		[0, "0", "0ms"],
		[null, "0", "0ms"],
		[undefined, "0", "0ms"],
	];

	it.each(cases)("%s", (input, digits, withUnit) => {
		expect(formatMs(input)).toBe(digits);
		expect(formatLatency(input)).toBe(withUnit);
	});

	it("leaves a sub-0.01 rate to the plain digits rule", () => {
		expect(formatRate(0.0004)).toBe("0");
	});
});

describe("formatPercent: one decimal, always", () => {
	const cases: Array<[number | null | undefined, string]> = [
		[99.95, "100.0"],
		[100, "100.0"],
		[99.94, "99.9"],
		[0, "0.0"],
		[0.04, "0.0"],
		[1234.56, "1,234.6"],
		[NaN, "0.0"],
		[null, "0.0"],
		[undefined, "0.0"],
	];

	it.each(cases)("%s", (input, expected) => {
		expect(formatPercent(input)).toBe(expected);
	});
});

describe("formatLatencyParts: the value and its unit for a tile with a slot of its own", () => {
	const cases: Array<[number | null | undefined, string, "ms" | "s"]> = [
		[0.0004, "<0.01", "ms"],
		[2.2749, "2.27", "ms"],
		[999, "999", "ms"],
		[999.6, "1.00", "s"],
		[1234, "1.23", "s"],
		[12345.6, "12.35", "s"],
		[0, "0", "ms"],
		[null, "0", "ms"],
		[undefined, "0", "ms"],
	];

	it.each(cases)("%s", (input, value, unit) => {
		expect(formatLatencyParts(input)).toEqual({ value, unit });
	});

	it("is what formatLatency prints, joined", () => {
		for (const [input] of cases) {
			const { value, unit } = formatLatencyParts(input);
			expect(formatLatency(input)).toBe(`${value}${unit}`);
		}
	});
});
