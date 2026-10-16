/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

// The shared formatters build their Intl.NumberFormat at module load, so the
// locale is pinned before the import below runs rather than left to the host.
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

import { axisMs, fmtMs, fmtPct, fmtRate } from "./formatters";

describe("the chart value formatters", () => {
	it("draw a missing value as a dash, not 0", () => {
		for (const fmt of [fmtMs, fmtRate, fmtPct]) {
			expect(fmt(null)).toBe("-");
			expect(fmt(undefined)).toBe("-");
		}
	});

	it("keep the millisecond digits of the rest of the app", () => {
		expect(fmtMs(2.2749)).toBe("2.27ms");
		expect(fmtMs(108)).toBe("108ms");
	});

	it("switch to seconds from 1000 ms", () => {
		expect(fmtMs(999)).toBe("999ms");
		expect(fmtMs(1234)).toBe("1.23s");
	});

	it("never draw a measured sub-0.01 ms value as 0", () => {
		expect(fmtMs(0.0004)).toBe("<0.01ms");
		expect(fmtMs(0)).toBe("0ms");
	});

	it("format a rate and a percentage by the shared digits", () => {
		expect(fmtRate(12345.6)).toBe("12,346/s");
		expect(fmtPct(99.94)).toBe("99.9%");
	});
});

describe("axisMs", () => {
	const label = (splits: number[]) => splits.map((v) => axisMs(v, splits));

	it("suffixes every tick and picks the decimals from the spacing", () => {
		expect(label([0, 0.5, 1, 1.5, 2, 2.5, 3])).toEqual([
			"0ms",
			"0.5ms",
			"1ms",
			"1.5ms",
			"2ms",
			"2.5ms",
			"3ms",
		]);
		expect(label([0, 0.25, 0.5])).toEqual(["0ms", "0.25ms", "0.5ms"]);
		expect(label([0, 20, 40, 60])).toEqual(["0ms", "20ms", "40ms", "60ms"]);
	});

	it("never repeats a label between neighbouring ticks", () => {
		for (const splits of [
			[0, 0.5, 1, 1.5, 2, 2.5, 3],
			[0, 0.2, 0.4, 0.6000000000000001, 0.8],
			[0, 1000, 2000],
			[0, 500, 1000, 1500, 2000],
			[0, 0.001, 0.002],
		]) {
			const labels = label(splits);
			expect(new Set(labels).size).toBe(labels.length);
		}
	});

	it("moves the whole axis to seconds once any tick reaches 1000 ms", () => {
		expect(label([0, 1000, 2000])).toEqual(["0s", "1s", "2s"]);
		expect(label([0, 500, 1000, 1500])).toEqual(["0s", "0.5s", "1s", "1.5s"]);
		expect(label([0, 200, 400, 600, 800])).toEqual(["0ms", "200ms", "400ms", "600ms", "800ms"]);
	});

	it("labels a lone value without a tick array", () => {
		expect(axisMs(0.4)).toBe("0.4ms");
		expect(axisMs(2500)).toBe("2.5s");
	});
});
