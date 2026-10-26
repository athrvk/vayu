/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { emptyBudgetDraft, type BudgetDraft, type CustomBudgetDraft } from "./budgets";
import {
	NO_CARRIED,
	type CarriedBudgets,
	budgetsChanged,
	budgetsToRemember,
	budgetsToSend,
	carriedThresholdKeys,
	clearCarried,
	describeCarried,
	findCarriedBudgets,
	isUnsentSeed,
	stillCarried,
	withoutUnsentSeed,
} from "./carried-budgets";

const draft = (values: Partial<BudgetDraft> = {}): BudgetDraft => ({
	...emptyBudgetDraft(),
	...values,
});
const row = (values: Partial<CustomBudgetDraft> = {}): CustomBudgetDraft => ({
	id: "c1",
	name: "cart",
	stat: "p95",
	value: "5",
	...values,
});

describe("findCarriedBudgets", () => {
	it("calls a p99 the memo never recorded the SLO seed", () => {
		expect(findCarriedBudgets(undefined, []).fixed).toEqual({ latencyP99Ms: "slo" });
	});

	it("calls a non-blank memo value carried from the memo, p99 included", () => {
		const { fixed } = findCarriedBudgets({ latencyP99Ms: "150", maxErrorRatePct: "2" }, []);
		expect(fixed).toEqual({ latencyP99Ms: "memo", maxErrorRatePct: "memo" });
	});

	it("does not carry a field the memo recorded as cleared", () => {
		// A cleared p99 is a decision, not a seed waiting to happen.
		expect(findCarriedBudgets({ latencyP99Ms: "", latencyP50Ms: "  " }, []).fixed).toEqual({});
	});

	it("carries the custom rows that name a metric and a ceiling", () => {
		const rows = [row({ id: "a" }), row({ id: "b", value: "" }), row({ id: "c", name: "" })];
		expect(findCarriedBudgets({ latencyP99Ms: "" }, rows).customIds).toEqual(["a"]);
	});
});

describe("stillCarried", () => {
	const initial = {
		budgets: draft({ latencyP99Ms: "150", maxErrorRatePct: "2" }),
		customBudgets: [row()],
	};
	const carried = findCarriedBudgets(initial.budgets, initial.customBudgets);

	it("keeps everything while the draft is as it opened", () => {
		expect(stillCarried(carried, initial, initial)).toEqual(carried);
	});

	it("drops a field the user edited, cleared or typed over, and keeps the rest", () => {
		const current = {
			...initial,
			budgets: draft({ latencyP99Ms: "90", maxErrorRatePct: "2" }),
		};
		expect(stillCarried(carried, initial, current).fixed).toEqual({ maxErrorRatePct: "memo" });

		const cleared = { ...initial, budgets: draft({ maxErrorRatePct: "2" }) };
		expect(stillCarried(carried, initial, cleared).fixed).toEqual({ maxErrorRatePct: "memo" });
	});

	it("drops a custom row that was edited or removed", () => {
		const edited = { ...initial, customBudgets: [row({ value: "9" })] };
		expect(stillCarried(carried, initial, edited).customIds).toEqual([]);
		const removed = { ...initial, customBudgets: [] };
		expect(stillCarried(carried, initial, removed).customIds).toEqual([]);
	});

	it("claims nothing for a row the user added", () => {
		const added = { ...initial, customBudgets: [row(), row({ id: "mine" })] };
		expect(stillCarried(carried, initial, added).customIds).toEqual(["c1"]);
	});
});

describe("clearCarried", () => {
	it("blanks exactly the carried fields and drops exactly the carried rows", () => {
		const carried = {
			fixed: { latencyP99Ms: "slo", maxErrorRatePct: "memo" },
			customIds: ["c1"],
		} as const;
		const result = clearCarried(
			{ fixed: { ...carried.fixed }, customIds: [...carried.customIds] },
			draft({ latencyP99Ms: "200", maxErrorRatePct: "2", minThroughputRps: "50" }),
			[row(), row({ id: "mine" })]
		);
		expect(result.budgets).toEqual(draft({ minThroughputRps: "50" }));
		expect(result.customBudgets.map((r) => r.id)).toEqual(["mine"]);
	});

	it("is a no-op for nothing carried", () => {
		const budgets = draft({ latencyP99Ms: "200" });
		expect(clearCarried(NO_CARRIED, budgets, []).budgets).toEqual(budgets);
	});
});

describe("carriedThresholdKeys", () => {
	it("names a fixed budget whichever source carried it", () => {
		// Mutation check: filtering to `memo` drops the SLO seed from the list.
		const carried = {
			fixed: { latencyP99Ms: "slo", maxErrorRatePct: "memo" },
			customIds: [],
		} as const;
		expect(carriedThresholdKeys({ fixed: { ...carried.fixed }, customIds: [] }, [])).toEqual([
			"latencyP99Ms",
			"maxErrorRatePct",
		]);
	});

	it("spells a carried custom row as the thresholds key, name trimmed", () => {
		const keys = carriedThresholdKeys({ fixed: {}, customIds: ["a"] }, [
			row({ id: "a", name: " cart ", stat: "p99" }),
			row({ id: "mine", name: "mine" }),
		]);
		expect(keys).toEqual(["custom.cart.p99"]);
	});

	it("is empty when nothing is carried", () => {
		expect(carriedThresholdKeys(NO_CARRIED, [row()])).toEqual([]);
	});
});

describe("budgetsChanged", () => {
	const base = { budgets: draft({ latencyP99Ms: "150" }), customBudgets: [row()] };

	it("is false for the same budgets", () => {
		expect(budgetsChanged(base, { budgets: { ...base.budgets }, customBudgets: [row()] })).toBe(
			false
		);
	});

	it("sees a changed fixed field, custom value, added row and removed row", () => {
		expect(budgetsChanged(base, { ...base, budgets: draft({ latencyP99Ms: "" }) })).toBe(true);
		expect(budgetsChanged(base, { ...base, customBudgets: [row({ value: "6" })] })).toBe(true);
		expect(budgetsChanged(base, { ...base, customBudgets: [row(), row({ id: "x" })] })).toBe(
			true
		);
		expect(budgetsChanged(base, { ...base, customBudgets: [] })).toBe(true);
	});
});

describe("describeCarried", () => {
	const budgets = draft({ latencyP99Ms: "150", maxErrorRatePct: "2" });

	it("names the request that set a memo value", () => {
		const carried = findCarriedBudgets(budgets, []);
		expect(describeCarried(carried, budgets, [], { requestName: "Orders" })).toBe(
			'Budgets carried over from "Orders": p99 latency at most 150 ms, Error rate at most 2%. They will judge this run.'
		);
	});

	it("falls back to the last load test without an origin", () => {
		const carried = findCarriedBudgets(budgets, []);
		expect(describeCarried(carried, budgets, [], undefined)).toContain(
			"carried over from your last load test"
		);
	});

	it("attributes a lone SLO seed to Settings, not to a past run", () => {
		const seeded = draft({ latencyP99Ms: "200" });
		const text = describeCarried(findCarriedBudgets(undefined, []), seeded, [], {
			requestName: "Orders",
		});
		expect(text).toBe(
			"Budgets prefilled: p99 latency at most 200 ms (from Settings › Dashboard › p99 threshold). They will judge this run."
		);
	});

	it("annotates only the seeded field when memo values sit beside it", () => {
		const mixed = draft({ latencyP50Ms: "80", latencyP99Ms: "200" });
		const carried = findCarriedBudgets({ latencyP50Ms: "80" }, []);
		expect(describeCarried(carried, mixed, [], undefined)).toBe(
			"Budgets carried over from your last load test: p50 latency at most 80 ms, p99 latency at most 200 ms (from Settings › Dashboard › p99 threshold). They will judge this run."
		);
	});

	it("lists carried custom rows by their engine key", () => {
		const rows = [row()];
		const carried = findCarriedBudgets({ latencyP99Ms: "" }, rows);
		expect(describeCarried(carried, draft(), rows, { requestName: "Orders" })).toBe(
			'Budgets carried over from "Orders": custom.cart.p95 at most 5. They will judge this run.'
		);
	});

	it("is null when nothing is carried", () => {
		expect(describeCarried(NO_CARRIED, draft(), [], undefined)).toBeNull();
	});
});

/**
 * The Settings p99 seed is withheld from a capacity search (issue #2816): the
 * engine judges the pooled histogram, which holds every over-budget level the
 * search climbed through on purpose.
 */
describe("the Settings p99 seed in Capacity discovery", () => {
	const SEED: CarriedBudgets["fixed"] = { latencyP99Ms: "slo" };
	const MEMO: CarriedBudgets["fixed"] = { latencyP99Ms: "memo" };
	const OTHER_MODES = ["constant_rps", "constant_concurrency", "ramp_up", "iterations"] as const;
	const seeded = draft({ latencyP99Ms: "500", maxErrorRatePct: "2" });

	describe("isUnsentSeed", () => {
		it("holds for a seed in capacity", () => {
			expect(isUnsentSeed("capacity", SEED)).toBe(true);
		});

		it("does not hold for a p99 the memo carried, or nothing carried", () => {
			expect(isUnsentSeed("capacity", MEMO)).toBe(false);
			expect(isUnsentSeed("capacity", {})).toBe(false);
		});

		it.each(OTHER_MODES)("does not hold in %s", (mode) => {
			expect(isUnsentSeed(mode, SEED)).toBe(false);
		});
	});

	describe("budgetsToSend", () => {
		it("blanks the seed and nothing else in capacity", () => {
			expect(budgetsToSend(seeded, "capacity", SEED)).toEqual(
				draft({ latencyP99Ms: "", maxErrorRatePct: "2" })
			);
		});

		it("keeps a memo or typed p99 in capacity", () => {
			expect(budgetsToSend(seeded, "capacity", MEMO)).toBe(seeded);
			expect(budgetsToSend(seeded, "capacity", {})).toBe(seeded);
			expect(budgetsToSend(seeded, "capacity", undefined)).toBe(seeded);
		});

		it.each(OTHER_MODES)("keeps the seed in %s", (mode) => {
			expect(budgetsToSend(seeded, mode, SEED)).toBe(seeded);
		});
	});

	describe("budgetsToRemember", () => {
		it("leaves the seed out of the memo, so it restores as a seed and not as the user's", () => {
			const kept = budgetsToRemember(seeded, "capacity", SEED);
			expect(kept).not.toHaveProperty("latencyP99Ms");
			expect(findCarriedBudgets(kept, []).fixed).toEqual({
				maxErrorRatePct: "memo",
				latencyP99Ms: "slo",
			});
		});

		it("writes a typed p99 as typed", () => {
			expect(budgetsToRemember(seeded, "capacity", {})).toBe(seeded);
		});

		it.each(OTHER_MODES)("writes the seed as it stands in %s", (mode) => {
			expect(budgetsToRemember(seeded, mode, SEED)).toBe(seeded);
		});
	});

	describe("withoutUnsentSeed", () => {
		const carried = findCarriedBudgets(undefined, []);

		it("takes the seed out of the carried set in capacity, so the notice does not name it", () => {
			const judged = withoutUnsentSeed(carried, "capacity");
			expect(judged.fixed).toEqual({});
			expect(describeCarried(judged, seeded, [], undefined)).toBeNull();
		});

		it("leaves a memo p99 and the other modes alone", () => {
			const memo = findCarriedBudgets({ latencyP99Ms: "150" }, []);
			expect(withoutUnsentSeed(memo, "capacity")).toBe(memo);
			expect(withoutUnsentSeed(carried, "ramp_up")).toBe(carried);
		});
	});
});
