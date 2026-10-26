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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	BUDGETS_EXPLAINER,
	BUDGET_FIELDS,
	CUSTOM_BUDGET_STATS,
	MAX_CUSTOM_METRIC_NAME_LENGTH,
	budgetError,
	buildThresholds,
	customBudgetRowError,
	customBudgetsError,
	emptyBudgetDraft,
	emptyCustomBudgetRow,
	summariseBudgets,
	type BudgetDraft,
	type CustomBudgetDraft,
} from "./budgets";

const draft = (values: Partial<BudgetDraft> = {}): BudgetDraft => ({
	...emptyBudgetDraft(),
	...values,
});

const customRow = (values: Partial<CustomBudgetDraft> = {}): CustomBudgetDraft => ({
	...emptyCustomBudgetRow(),
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

	it("accepts a zero assertion-failure-rate budget, the same real ask as the error rate", () => {
		expect(budgetError(draft({ maxAssertionFailureRatePct: "0" }))).toBeNull();
		expect(buildThresholds(draft({ maxAssertionFailureRatePct: "0" }))).toEqual({
			maxAssertionFailureRatePct: 0,
		});
	});

	it("rejects an assertion failure rate outside 0-100", () => {
		expect(budgetError(draft({ maxAssertionFailureRatePct: "101" }))).toMatch(
			/assertion failure rate/i
		);
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

/**
 * `custom.<name>.<stat>` rows (issue #1579). The engine checks the key's shape
 * and the value's sign and nothing else - it does not know whether the name is
 * one this run records - so these mirror exactly that, and no more: a stricter
 * client rule would refuse a budget the engine would have accepted.
 */
describe("custom metric budget rows", () => {
	it("treats an untouched row as an unused slot, not a mistake", () => {
		expect(customBudgetRowError(emptyCustomBudgetRow())).toBeUndefined();
		expect(customBudgetsError([emptyCustomBudgetRow(), emptyCustomBudgetRow()])).toBeNull();
	});

	it("accepts a name and a ceiling", () => {
		expect(
			customBudgetRowError(customRow({ name: "checkout_ttfb", stat: "p95", value: "120" }))
		).toBeUndefined();
		// Zero is a real ask here for the same reason it is on the error rate:
		// "this metric never rises above nothing" is a budget, not a typo.
		expect(customBudgetRowError(customRow({ name: "retries", value: "0" }))).toBeUndefined();
	});

	it("refuses half a budget rather than dropping the half that was typed", () => {
		expect(customBudgetRowError(customRow({ value: "120" }))).toMatch(/needs the name/i);
		expect(customBudgetRowError(customRow({ name: "checkout_ttfb" }))).toMatch(
			/must be a number/i
		);
	});

	it("refuses a name longer than metric.record could have recorded", () => {
		const name = "m".repeat(MAX_CUSTOM_METRIC_NAME_LENGTH + 1);
		expect(customBudgetRowError(customRow({ name, value: "1" }))).toMatch(/at most 100/i);
		expect(
			customBudgetRowError(
				customRow({ name: name.slice(0, MAX_CUSTOM_METRIC_NAME_LENGTH), value: "1" })
			)
		).toBeUndefined();
	});

	it("refuses a negative ceiling and text, naming the budget it means", () => {
		expect(customBudgetRowError(customRow({ name: "ttfb", stat: "p99", value: "-1" }))).toMatch(
			/custom\.ttfb\.p99 must be zero or greater/i
		);
		expect(
			customBudgetRowError(customRow({ name: "ttfb", stat: "p99", value: "fast" }))
		).toMatch(/custom\.ttfb\.p99 must be a number/i);
	});

	it("refuses two rows that would collapse into one key", () => {
		// Same name, same stat, two values: the payload is an object, so the
		// second would silently overwrite the first - a budget typed and never
		// judged, the failure this whole file exists to prevent.
		expect(
			customBudgetsError([
				customRow({ name: "ttfb", stat: "p95", value: "100" }),
				customRow({ name: "ttfb", stat: "p95", value: "200" }),
			])
		).toMatch(/declared twice/i);
		// The same metric under two stats is two budgets, not a duplicate.
		expect(
			customBudgetsError([
				customRow({ name: "ttfb", stat: "p95", value: "100" }),
				customRow({ name: "ttfb", stat: "max", value: "200" }),
			])
		).toBeNull();
	});

	it("reads the name as typed once trimmed, in the message and in the key", () => {
		expect(customBudgetRowError(customRow({ name: "  ttfb  ", value: "-1" }))).toMatch(
			/custom\.ttfb\.p50/
		);
		expect(
			buildThresholds(emptyBudgetDraft(), false, [
				customRow({ name: "  ttfb  ", value: "5" }),
			])
		).toEqual({ "custom.ttfb.p50": 5 });
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
					maxAssertionFailureRatePct: "1",
				})
			)
		).toEqual({
			latencyP50Ms: 20,
			latencyP95Ms: 40,
			latencyP99Ms: 50,
			maxErrorRatePct: 0.1,
			minThroughputRps: 10000,
			maxAssertionFailureRatePct: 1,
		});
	});

	it("folds failRun in only alongside a declared budget", () => {
		expect(buildThresholds(draft({ latencyP99Ms: "50" }), true)).toEqual({
			latencyP99Ms: 50,
			failRun: true,
		});
		expect(buildThresholds(draft({ latencyP99Ms: "50" }), false)).toEqual({
			latencyP99Ms: 50,
		});
		// No budget declared - the engine rejects `{ failRun: true }` alone the
		// same way it rejects `{}`, so the flag must not turn an empty draft
		// into a non-empty payload.
		expect(buildThresholds(emptyBudgetDraft(), true)).toBeUndefined();
	});

	it("omits the object entirely rather than sending an empty one", () => {
		// An empty `thresholds` is a 400 from POST /runs, which the user would
		// meet as "the run would not start" with no field to blame.
		expect(buildThresholds(draft({ latencyP99Ms: "   " }))).toBeUndefined();
	});

	it("folds a custom row in beside the fixed keys", () => {
		expect(
			buildThresholds(draft({ latencyP99Ms: "50" }), false, [
				customRow({ name: "checkout_ttfb", stat: "p95", value: "120" }),
			])
		).toEqual({ latencyP99Ms: 50, "custom.checkout_ttfb.p95": 120 });
	});

	// Mutation check: commenting out `buildThresholds`'s custom-rows fold-in
	// loop reds this case and the three below it (4 of 4) - confirming they
	// actually exercise the fold, not just its absence.

	it("sends a custom budget under the engine's own key shape, stat included", () => {
		for (const stat of CUSTOM_BUDGET_STATS) {
			expect(
				buildThresholds(emptyBudgetDraft(), false, [
					customRow({ name: "m", stat, value: "1" }),
				])
			).toEqual({ [`custom.m.${stat}`]: 1 });
		}
	});

	it("counts a custom budget as a declared one, for failRun and for the empty case", () => {
		// The engine rejects `{ failRun: true }` alone; a custom budget is a
		// budget, so the flag has something to judge and rides along.
		expect(
			buildThresholds(emptyBudgetDraft(), true, [
				customRow({ name: "checkout_ttfb", stat: "max", value: "300" }),
			])
		).toEqual({ "custom.checkout_ttfb.max": 300, failRun: true });
	});

	it("skips a half-filled or blank custom row rather than sending a broken key", () => {
		// The UI refuses these (see `customBudgetRowError`); what this pins is
		// that nothing reaches the payload as `custom..p50` or as `NaN` if it
		// somehow does.
		expect(
			buildThresholds(emptyBudgetDraft(), false, [emptyCustomBudgetRow()])
		).toBeUndefined();
		expect(
			buildThresholds(emptyBudgetDraft(), false, [customRow({ name: "ttfb" })])
		).toBeUndefined();
		expect(
			buildThresholds(emptyBudgetDraft(), false, [customRow({ value: "10" })])
		).toBeUndefined();
	});

	it("leaves the six-key payload exactly as it was when custom rows are present", () => {
		// The issue's own acceptance criterion: the addition regresses nothing.
		const fixed = draft({ maxErrorRatePct: "0.1", minThroughputRps: "1000" });
		expect(buildThresholds(fixed, true, [emptyCustomBudgetRow()])).toEqual(
			buildThresholds(fixed, true)
		);
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

describe("summariseBudgets", () => {
	it("says no budget is active for an empty draft", () => {
		expect(summariseBudgets(emptyBudgetDraft())).toBe("No budgets");
	});

	it("names a lone fixed budget, with its unit", () => {
		expect(summariseBudgets(draft({ latencyP99Ms: "200" }))).toBe(
			"1 budget active - p99 latency at most 200 ms"
		);
		expect(summariseBudgets(draft({ maxErrorRatePct: "0.5" }))).toBe(
			"1 budget active - Error rate at most 0.5%"
		);
	});

	it("names a lone custom budget by its engine key", () => {
		expect(
			summariseBudgets(emptyBudgetDraft(), [
				customRow({ name: "cart", stat: "p95", value: "5" }),
			])
		).toBe("1 budget active - custom.cart.p95 at most 5");
	});

	it("counts fixed fields and custom rows together", () => {
		expect(
			summariseBudgets(draft({ latencyP99Ms: "200", maxErrorRatePct: "1" }), [
				customRow({ name: "cart", value: "5" }),
			])
		).toBe("3 budgets active");
	});

	it("ignores blank fields and custom rows the payload would drop", () => {
		expect(
			summariseBudgets(draft({ latencyP99Ms: "  " }), [
				customRow({ name: "cart" }),
				customRow({ value: "5" }),
			])
		).toBe("No budgets");
	});

	it("counts exactly what buildThresholds would send", () => {
		const fixed = draft({ latencyP50Ms: "10", minThroughputRps: "5" });
		const rows = [customRow({ name: "a", value: "1" }), customRow({ name: "b" })];
		expect(Object.keys(buildThresholds(fixed, false, rows) ?? {})).toHaveLength(3);
		expect(summariseBudgets(fixed, rows)).toBe("3 budgets active");
	});
});

describe("the budgets explainer", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const sources = [
		join(here, "BudgetsSection.tsx"),
		join(here, "../../../collections/RunCollectionDialog.tsx"),
	].map((path) => ({ path, text: readFileSync(path, "utf8") }));

	it("does not refer to a history the user may not have", () => {
		expect(BUDGETS_EXPLAINER.length).toBeGreaterThan(0);
		expect(BUDGETS_EXPLAINER).not.toMatch(/as before/i);
	});

	it("is the one copy both dialogs render", () => {
		for (const { path, text } of sources) {
			expect(text.length, `${path} was read empty`).toBeGreaterThan(0);
			expect(text, path).toContain("{BUDGETS_EXPLAINER}");
			expect(text, path).not.toMatch(/judged against whatever you declare/i);
		}
	});

	it("tells the user where the p99 value comes from and what clearing it does", () => {
		const p99 = BUDGET_FIELDS.find((field) => field.key === "latencyP99Ms");
		expect(p99?.seededHint).toContain("Settings › Dashboard › p99 threshold");
		expect(p99?.seededHint).toMatch(/clear it to run without a latency budget/i);
	});
});
