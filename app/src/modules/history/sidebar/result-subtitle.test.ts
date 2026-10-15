/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { resultSubtitle } from "./result-subtitle";

describe("resultSubtitle", () => {
	it.each([
		[{ rps: 485.2, p95Ms: 42, errorRate: 0 }, "485 req/s · p95 42 ms · 0.0% errors"],
		[{ rps: 12400, p95Ms: 1500, errorRate: 15.14 }, "12,400 req/s · p95 1.50 s · 15.1% errors"],
		[{ rps: 4.25 }, "4.3 req/s"],
		[{ p95Ms: 42, errorRate: 2 }, "p95 42 ms · 2.0% errors"],
		[{ errorRate: 0.01 }, "<0.1% errors"],
		[{ verdict: "passed" as const }, null],
		[{}, null],
	])("%j reads %j", (summary, line) => {
		expect(resultSubtitle(summary)).toBe(line);
	});
});
