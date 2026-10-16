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

import { formatMs, formatPercent, formatRate } from "./format-number";

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
