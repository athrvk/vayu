/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a scenario load run's pooled latency says about itself (#2823).
 *
 * Mutation-check: take the `<=` guard out of `slowestStepP99` and the tie case
 * fails; compare `<` the wrong way round and the slowest case fails; return
 * `true` for an empty `steps` array from `isPooledReport` and the design-mode
 * case fails.
 */

import { describe, it, expect } from "vitest";
import type { RunReport, RunScenarioStepStat } from "@/types";
import {
	isPooledReport,
	pooledCaption,
	pooledLatencyOf,
	pooledTitle,
	slowestStepP99,
} from "./pooledLatency";

function step(index: number, name: string, p99: number): RunScenarioStepStat {
	return {
		index,
		name,
		requestId: `req_${index}`,
		method: "GET",
		executed: 10,
		errors: 0,
		latency: { min: 1, p50: 2, p95: 3, p99, max: p99 },
	};
}

describe("slowestStepP99", () => {
	it("returns the step with the highest p99, with its name", () => {
		const steps = [step(0, "Log in", 12), step(1, "List orders", 90), step(2, "Log out", 4)];
		expect(slowestStepP99(steps)).toEqual({ ms: 90, name: "List orders" });
	});

	it("keeps the earlier step on a tie", () => {
		expect(slowestStepP99([step(0, "A", 5), step(1, "B", 5)])).toEqual({ ms: 5, name: "A" });
	});

	it("falls back to the request id for an unnamed step", () => {
		expect(slowestStepP99([step(0, "", 5)])).toEqual({ ms: 5, name: "req_0" });
	});

	it("is undefined with no steps", () => {
		expect(slowestStepP99([])).toBeUndefined();
		expect(slowestStepP99(undefined)).toBeUndefined();
	});
});

describe("pooledCaption", () => {
	it("names the slowest step and its p99", () => {
		expect(pooledCaption({ ms: 90, name: "List orders" })).toBe(
			"All steps pooled - slowest step: List orders, p99 90ms"
		);
	});

	it("says only that the steps are pooled where the slowest is not known", () => {
		expect(pooledCaption(undefined)).toBe("All steps pooled");
	});
});

describe("pooledTitle", () => {
	it("appends (all steps) for a pooled figure and leaves any other title alone", () => {
		expect(pooledTitle("Latency distribution", true)).toBe("Latency distribution (all steps)");
		expect(pooledTitle("Latency distribution", false)).toBe("Latency distribution");
	});
});

describe("isPooledReport / pooledLatencyOf", () => {
	const withScenario = (steps?: RunScenarioStepStat[]) =>
		({ scenario: { steps } }) as unknown as RunReport;

	it("is true for a scenario load run's report, with the slowest step", () => {
		const report = withScenario([step(0, "A", 3), step(1, "B", 8)]);
		expect(isPooledReport(report)).toBe(true);
		expect(pooledLatencyOf(report)).toEqual({ slowestStep: { ms: 8, name: "B" } });
	});

	it("is false for a single-request report and for a scenario section with no step breakdown", () => {
		for (const report of [{} as RunReport, withScenario(undefined), withScenario([])]) {
			expect(isPooledReport(report)).toBe(false);
			expect(pooledLatencyOf(report)).toBeUndefined();
		}
	});
});
