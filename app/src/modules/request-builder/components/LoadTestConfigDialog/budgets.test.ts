/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The budget draft's two rules: what it refuses, and what it sends.
 *
 * Both exist to keep one thing from happening - a budget the user typed that
 * the run is never judged against. A dropped field would be silent, and an
 * empty `thresholds` object is a 400 the user would meet as "failed to start"
 * rather than as the field they left half-filled.
 */

import { describe, it, expect } from "vitest";
import {
	BUDGET_FIELDS,
	budgetError,
	buildThresholds,
	emptyBudgetDraft,
	type BudgetDraft,
} from "./budgets";

const draft = (values: Partial<BudgetDraft> = {}): BudgetDraft => ({
	...emptyBudgetDraft(),
	...values,
});

describe("budget validation", () => {
	it("accepts a draft with nothing declared - budgets are opt-in", () => {
		expect(budgetError(emptyBudgetDraft())).toBeNull();
		expect(buildThresholds(emptyBudgetDraft())).toBeUndefined();
	});

	it("accepts blank fields beside declared ones", () => {
		const d = draft({ latencyP99Ms: "50" });
		expect(budgetError(d)).toBeNull();
		expect(buildThresholds(d)).toEqual({ latencyP99Ms: 50 });
	});

	it("rejects a latency budget of zero, which nothing can meet", () => {
		expect(budgetError(draft({ latencyP50Ms: "0" }))).toMatch(/p50/i);
		expect(budgetError(draft({ latencyP95Ms: "-5" }))).toMatch(/p95/i);
	});

	it("accepts a zero error-rate budget, which is a real ask", () => {
		// The one inclusive floor: "no request may fail". Treating it like the
		// latency fields would make the strictest budget the unsayable one.
		expect(budgetError(draft({ maxErrorRatePct: "0" }))).toBeNull();
		expect(buildThresholds(draft({ maxErrorRatePct: "0" }))).toEqual({ maxErrorRatePct: 0 });
	});

	it("rejects an error rate outside 0-100", () => {
		expect(budgetError(draft({ maxErrorRatePct: "101" }))).toMatch(/error rate/i);
		expect(budgetError(draft({ maxErrorRatePct: "-1" }))).toMatch(/error rate/i);
	});

	it("rejects a throughput floor of zero", () => {
		expect(budgetError(draft({ minThroughputRps: "0" }))).toMatch(/throughput/i);
	});

	it("rejects text rather than sending NaN", () => {
		expect(budgetError(draft({ latencyP99Ms: "fast" }))).toMatch(/number/i);
	});

	it("names the offending budget, since five fields share one message slot", () => {
		const message = budgetError(draft({ latencyP99Ms: "50", minThroughputRps: "-1" }));
		expect(message).toMatch(/throughput/i);
		expect(message).not.toMatch(/p99/i);
	});
});

describe("the payload the dialog builds", () => {
	it("sends every declared budget under the engine's own key", () => {
		expect(
			buildThresholds(
				draft({
					latencyP50Ms: "20",
					latencyP95Ms: "40",
					latencyP99Ms: "50",
					maxErrorRatePct: "0.1",
					minThroughputRps: "10000",
				})
			)
		).toEqual({
			latencyP50Ms: 20,
			latencyP95Ms: 40,
			latencyP99Ms: 50,
			maxErrorRatePct: 0.1,
			minThroughputRps: 10000,
		});
	});

	it("omits the object entirely rather than sending an empty one", () => {
		// An empty `thresholds` is a 400 from POST /runs, which the user would
		// meet as "the run would not start" with no field to blame.
		expect(buildThresholds(draft({ latencyP99Ms: "   " }))).toBeUndefined();
	});

	it("keys every field to a real threshold, so none can be typed and dropped", () => {
		// The table drives the fields, the validation and the payload; a key
		// that is not in RunThresholds would render a control and send nothing.
		const built = buildThresholds(
			draft(Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, "1"])) as BudgetDraft)
		);
		expect(Object.keys(built ?? {})).toHaveLength(BUDGET_FIELDS.length);
	});
});
