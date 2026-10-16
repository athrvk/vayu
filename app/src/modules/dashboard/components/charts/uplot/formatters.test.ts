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

import { fmtMs, fmtPct, fmtRate } from "./formatters";

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

	it("format a rate and a percentage by the shared digits", () => {
		expect(fmtRate(12345.6)).toBe("12,346/s");
		expect(fmtPct(99.94)).toBe("99.9%");
	});
});
