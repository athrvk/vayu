/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { afterAll, describe, it, expect, vi } from "vitest";

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

import { resultSubtitle } from "./result-subtitle";

describe("resultSubtitle", () => {
	it.each([
		[{ rps: 485.2, p95Ms: 42, errorRate: 0 }, "485 req/s · p95 42ms · 0.0% errors"],
		[{ rps: 12400, p95Ms: 1500, errorRate: 15.14 }, "12,400 req/s · p95 1.50s · 15.1% errors"],
		[{ rps: 4.25 }, "4.25 req/s"],
		[{ p95Ms: 42, errorRate: 2 }, "p95 42ms · 2.0% errors"],
		[{ errorRate: 0.01 }, "<0.1% errors"],
		[{ verdict: "passed" as const }, null],
		[{}, null],
	])("%j reads %j", (summary, line) => {
		expect(resultSubtitle(summary)).toBe(line);
	});
});
