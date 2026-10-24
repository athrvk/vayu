/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { stubNumberLocale } from "@/test/number-locale";

// The formatters build their Intl.NumberFormat at module load, so the locale is
// pinned before the import below runs rather than left to the host. The
// assertion count goes through `toLocaleString`, which that pin does not reach,
// so each case stubs it too.
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

import { resultSubtitle } from "./result-subtitle";

describe("resultSubtitle", () => {
	let restoreLocale: () => void;
	beforeEach(() => {
		restoreLocale = stubNumberLocale("en-US");
	});
	afterEach(() => restoreLocale());

	it.each([
		[{ rps: 485.2, p95Ms: 42, errorRate: 0 }, "485 req/s · p95 42ms · 0.0% errors"],
		[{ rps: 12400, p95Ms: 1500, errorRate: 15.14 }, "12,400 req/s · p95 1.50s · 15.1% errors"],
		[{ rps: 4.25 }, "4.25 req/s"],
		[{ p95Ms: 42, errorRate: 2 }, "p95 42ms · 2.0% errors"],
		[{ errorRate: 0.01 }, "<0.1% errors"],
		[
			{ rps: 41.2, p95Ms: 63, errorRate: 0, assertionsPassed: 0, assertionsFailed: 4580 },
			"41 req/s · p95 63ms · 0.0% errors · 4,580 assertions failed",
		],
		[{ errorRate: 0, assertionsFailed: 1 }, "0.0% errors · 1 assertion failed"],
		[{ errorRate: 0, assertionsPassed: 10, assertionsFailed: 0 }, "0.0% errors"],
		[{ assertionsFailed: 3 }, "3 assertions failed"],
		[{ verdict: "passed" as const }, null],
		[{}, null],
	])("%j reads %j", (summary, line) => {
		expect(resultSubtitle(summary)).toBe(line);
	});
});
