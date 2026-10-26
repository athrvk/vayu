/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { RunReport } from "@/types";
import { runSloMs } from "./runSloMs";

type Check = NonNullable<RunReport["thresholdValidation"]>["checks"][number];

const check = (metric: string, limit: number, extra: Partial<Check> = {}): Check => ({
	metric,
	limit,
	actual: limit,
	passed: true,
	...extra,
});

function report(parts: { capacitySloMs?: number; checks?: Check[] }): RunReport {
	return {
		...(parts.capacitySloMs !== undefined && {
			capacity: { sloMs: parts.capacitySloMs },
		}),
		...(parts.checks && {
			thresholdValidation: {
				checks: parts.checks,
				passed: parts.checks.length,
				failed: 0,
				verdict: "passed",
			},
		}),
	} as unknown as RunReport;
}

describe("runSloMs", () => {
	it("is the capacity run's own sloMs", () => {
		expect(runSloMs(report({ capacitySloMs: 250 }))).toBe(250);
	});

	it("is the limit of the p99 budget on a run without a capacity section", () => {
		expect(runSloMs(report({ checks: [check("latencyP99Ms", 350)] }))).toBe(350);
	});

	it("counts a p99 check that recorded no measurement", () => {
		const unevaluated = check("latencyP99Ms", 350, { evaluated: false, actual: undefined });
		expect(runSloMs(report({ checks: [unevaluated] }))).toBe(350);
	});

	it("ignores every other budget", () => {
		const checks = [
			check("latencyP50Ms", 20),
			check("latencyP95Ms", 90),
			check("maxErrorRatePct", 1),
			check("latencyP99Ms", 350),
		];
		expect(runSloMs(report({ checks }))).toBe(350);
		expect(runSloMs(report({ checks: checks.slice(0, 3) }))).toBeUndefined();
	});

	it("lets the capacity budget win over a p99 check", () => {
		expect(runSloMs(report({ capacitySloMs: 250, checks: [check("latencyP99Ms", 350)] }))).toBe(
			250
		);
	});

	it("is undefined for a run that declared neither", () => {
		expect(runSloMs(report({}))).toBeUndefined();
		expect(runSloMs(report({ checks: [] }))).toBeUndefined();
	});
});
