/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { formatPercent } from "@/lib/format-number";
import { formatValue } from "./run-comparison-format";

describe("formatValue", () => {
	it("draws a latency through formatLatency, unit unspaced", () => {
		expect(formatValue("latency.p95", 42)).toBe("42ms");
		expect(formatValue("latency.p99", 1234)).toBe("1.23s");
	});

	it("switches a negative latency delta to seconds where a positive one does", () => {
		expect(formatValue("latency.p95", -1500)).toBe("-1.50s");
		expect(formatValue("latency.p95", -300)).toBe("-300ms");
	});

	it("draws the error rate through formatPercent, one decimal", () => {
		expect(formatValue("summary.errorRate", 1)).toBe(`${formatPercent(1)}%`);
		expect(formatValue("summary.errorRate", 1)).toMatch(/^1[.,]0%$/);
	});
});
