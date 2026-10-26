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
	formatByteRateParts,
	formatLatency,
	formatLatencyOrDash,
	formatLatencyParts,
	formatLatencyPartsOrDash,
	formatMs,
	formatOneDecimal,
	formatPercent,
	formatRate,
	formatSeconds,
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

describe("formatLatencyOrDash and formatLatencyPartsOrDash: an absent latency is not a 0", () => {
	const cases: Array<[string, number | null | undefined, string, string, string]> = [
		["null", null, "-", "-", ""],
		["undefined", undefined, "-", "-", ""],
		["NaN", NaN, "-", "-", ""],
		["a measured zero", 0, "0ms", "0", "ms"],
		["a measured value", 87, "87ms", "87", "ms"],
		["seconds", 1234, "1.23s", "1.23", "s"],
	];

	it.each(cases)("%s", (_name, input, text, value, unit) => {
		expect(formatLatencyOrDash(input)).toBe(text);
		expect(formatLatencyPartsOrDash(input)).toEqual({ value, unit });
	});

	it("leaves formatLatency's own reading of an absent value alone", () => {
		expect(formatLatency(undefined)).toBe("0ms");
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

describe("formatOneDecimal: a mean count with one decimal", () => {
	const cases: Array<[number | null | undefined, string]> = [
		[4.2, "4.2"],
		[10, "10.0"],
		[0, "0.0"],
		[4.25, "4.3"],
		[1234.56, "1,234.6"],
		[NaN, "0.0"],
		[null, "0.0"],
		[undefined, "0.0"],
	];

	it.each(cases)("%s", (input, expected) => {
		expect(formatOneDecimal(input)).toBe(expected);
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

describe("formatSeconds: formatLatency under a minute, grouped whole seconds above", () => {
	it("prints a sub-second span in milliseconds", () => {
		expect(formatSeconds(0.4)).toBe("400ms");
	});

	it("reads a span under a minute exactly as formatLatency reads it", () => {
		expect(formatSeconds(4.2)).toBe(formatLatency(4200));
		expect(formatSeconds(4.2)).toBe("4.20s");
		expect(formatSeconds(59)).toBe(formatLatency(59000));
	});

	it("switches to whole seconds at a minute", () => {
		expect(formatSeconds(60)).toBe("60s");
		expect(formatSeconds(75.4)).toBe("75s");
		expect(formatSeconds(3600)).toBe("3,600s");
	});

	it("reads a missing value as formatLatency does", () => {
		for (const missing of [undefined, null, NaN, Infinity]) {
			expect(formatSeconds(missing)).toBe(formatLatency(missing));
		}
		expect(formatSeconds(0)).toBe("0ms");
	});
});

describe("formatByteRateParts: KB/s below 0.1 MB/s, MB/s from there, decimal units", () => {
	const cases: Array<[string, number | null | undefined, string, "KB/s" | "MB/s"]> = [
		["a steady 4.4 KB/s", 4400, "4.4", "KB/s"],
		["the reading that rounded to 0.01 MB/s", 5300, "5.3", "KB/s"],
		["1000 bytes is a kilobyte, not 1024", 1000, "1", "KB/s"],
		["tens of KB/s take whole numbers", 45_600, "46", "KB/s"],
		["the boundary", 100_000, "0.1", "MB/s"],
		["a megabyte rate", 2_500_000, "2.5", "MB/s"],
		["tens of MB/s take whole numbers", 12_600_000, "13", "MB/s"],
		["zero", 0, "0", "KB/s"],
		["NaN", NaN, "0", "KB/s"],
		["null", null, "0", "KB/s"],
		["undefined", undefined, "0", "KB/s"],
	];

	it.each(cases)("%s", (_name, input, value, unit) => {
		expect(formatByteRateParts(input)).toEqual({ value, unit });
	});
});
