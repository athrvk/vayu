/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which of the dialog's budgets the user did not type this time (#2194). The budgets are one global
 * memo plus a Settings p99 seed, so a field can open with a number the user never saw on this
 * request; these say which fields and from where, for the notice. Pure, to test without rendering.
 */

import type { LoadTestConfig } from "@/types";
import {
	BUDGET_FIELDS,
	budgetFieldsFor,
	customBudgetKey,
	describeCustomBudget,
	describeFixedBudget,
	isDeclaredCustomBudget,
	type BudgetDraft,
	type BudgetKey,
	type CustomBudgetDraft,
} from "./budgets";

/** `memo`: the last Start wrote it. `slo`: the Dashboard's p99 threshold seeded it. */
export type CarriedSource = "memo" | "slo";

/** What a restore filled in, as the dialog opened. */
export interface CarriedBudgets {
	fixed: Partial<Record<BudgetKey, CarriedSource>>;
	/** Ids of the custom rows the memo restored. */
	customIds: string[];
}

/** Written beside the budgets on Start so a later dialog can name where they came from. */
export interface BudgetsOrigin {
	requestName: string;
}

export const NO_CARRIED: CarriedBudgets = { fixed: {}, customIds: [] };

const isBlank = (value: string | undefined) => (value ?? "").trim() === "";

/** The one budget Settings seeds on a first run: the Dashboard's p99 threshold. */
export const SLO_SEEDED_KEY = "latencyP99Ms" satisfies BudgetKey;

/**
 * Whether the Settings p99 seed is dormant for this run. A capacity search climbs past the limit on
 * purpose and `latencyP99Ms` is judged over every level, so a verdict on the seed would read how
 * far the search climbed (#2816). A stream's latency is its whole duration, which the per-request
 * threshold was never set against (#3772). A typed or memo-carried p99 is the user's and travels.
 */
export function isUnsentSeed(
	mode: LoadTestConfig["mode"],
	streaming: boolean,
	fixed: CarriedBudgets["fixed"]
): boolean {
	return (mode === "capacity" || streaming) && fixed[SLO_SEEDED_KEY] === "slo";
}

/**
 * The carried set limited to fields this run can declare. The memo is global, so a stream budget
 * from a streaming request returns on one that does not stream, where it is neither shown nor sent;
 * it is not carried, and the notice must not name a budget the run will not judge.
 */
export function carriedForRun(carried: CarriedBudgets, streaming: boolean): CarriedBudgets {
	const fixed: CarriedBudgets["fixed"] = {};
	for (const { key } of budgetFieldsFor(streaming)) {
		const source = carried.fixed[key];
		if (source) fixed[key] = source;
	}
	return { ...carried, fixed };
}

/** The carried set as this run will send it: the dormant seed is not carried, it is not there. */
export function withoutUnsentSeed(
	carried: CarriedBudgets,
	mode: LoadTestConfig["mode"],
	streaming: boolean
): CarriedBudgets {
	if (!isUnsentSeed(mode, streaming, carried.fixed)) return carried;
	const { [SLO_SEEDED_KEY]: _seed, ...fixed } = carried.fixed;
	return { ...carried, fixed };
}

/** The budgets Start sends: the draft with the run's dormant seed blanked. */
export function budgetsToSend(
	budgets: BudgetDraft,
	mode: LoadTestConfig["mode"],
	streaming: boolean,
	fixed: CarriedBudgets["fixed"] | undefined
): BudgetDraft {
	if (!isUnsentSeed(mode, streaming, fixed ?? {})) return budgets;
	return { ...budgets, [SLO_SEEDED_KEY]: "" };
}

/**
 * The budgets the memo keeps, without a dormant seed: a written p99 restores as the user's own
 * (`memo`), so the next capacity or stream run would send what this one withheld.
 */
export function budgetsToRemember(
	budgets: BudgetDraft,
	mode: LoadTestConfig["mode"],
	streaming: boolean,
	fixed: CarriedBudgets["fixed"]
): Partial<BudgetDraft> {
	if (!isUnsentSeed(mode, streaming, fixed)) return budgets;
	const { [SLO_SEEDED_KEY]: _seed, ...rest } = budgets;
	return rest;
}

/**
 * The fields the restore filled from somewhere other than the user: a non-blank memo value is
 * `memo`; a p99 the memo never recorded is the `slo` seed. A blank memo value is a declined budget.
 */
export function findCarriedBudgets(
	saved: Partial<BudgetDraft> | undefined,
	savedCustom: readonly CustomBudgetDraft[]
): CarriedBudgets {
	const fixed: CarriedBudgets["fixed"] = {};
	for (const { key } of BUDGET_FIELDS) {
		if (!isBlank(saved?.[key])) fixed[key] = "memo";
	}
	if (saved?.[SLO_SEEDED_KEY] === undefined) fixed[SLO_SEEDED_KEY] = "slo";

	return {
		fixed,
		customIds: savedCustom.filter(isDeclaredCustomBudget).map((row) => row.id),
	};
}

/** Carried fields untouched since opening; an edit (clearing included) makes a field the user's. */
export function stillCarried(
	carried: CarriedBudgets,
	initial: { budgets: BudgetDraft; customBudgets: readonly CustomBudgetDraft[] },
	current: { budgets: BudgetDraft; customBudgets: readonly CustomBudgetDraft[] }
): CarriedBudgets {
	const fixed: CarriedBudgets["fixed"] = {};
	for (const { key } of BUDGET_FIELDS) {
		const source = carried.fixed[key];
		const unchanged = current.budgets[key] === initial.budgets[key];
		if (source && unchanged && !isBlank(current.budgets[key])) fixed[key] = source;
	}

	const startedWith = new Map(initial.customBudgets.map((row) => [row.id, row]));
	const customIds = current.customBudgets
		.filter((row) => carried.customIds.includes(row.id))
		.filter((row) => sameCustomRow(row, startedWith.get(row.id)))
		.map((row) => row.id);

	return { fixed, customIds };
}

function sameCustomRow(a: CustomBudgetDraft, b: CustomBudgetDraft | undefined): boolean {
	return !!b && a.name === b.name && a.stat === b.stat && a.value === b.value;
}

/**
 * The carried fields' `thresholds` keys for `POST /runs` (#2195). Both sources count: the user
 * typed neither for this run. A key is named whether or not it reaches `thresholds`;
 * `buildLoadTestConfig` drops those that do not.
 */
export function carriedThresholdKeys(
	carried: CarriedBudgets,
	customBudgets: readonly CustomBudgetDraft[]
): string[] {
	const fixed = Object.keys(carried.fixed);
	const custom = customBudgets
		.filter((row) => carried.customIds.includes(row.id))
		.map((row) => customBudgetKey(row.name.trim(), row.stat));
	return [...fixed, ...custom];
}

/** The draft with exactly the carried fields blanked and the carried rows dropped. */
export function clearCarried(
	carried: CarriedBudgets,
	budgets: BudgetDraft,
	customBudgets: readonly CustomBudgetDraft[]
): { budgets: BudgetDraft; customBudgets: CustomBudgetDraft[] } {
	const cleared = { ...budgets };
	for (const key of Object.keys(carried.fixed) as BudgetKey[]) cleared[key] = "";
	return {
		budgets: cleared,
		customBudgets: customBudgets.filter((row) => !carried.customIds.includes(row.id)),
	};
}

/** Whether Start would write budgets that differ from the ones the dialog opened with. */
export function budgetsChanged(
	initial: { budgets: BudgetDraft; customBudgets: readonly CustomBudgetDraft[] },
	current: { budgets: BudgetDraft; customBudgets: readonly CustomBudgetDraft[] }
): boolean {
	const fixedDiffers = BUDGET_FIELDS.some(
		({ key }) => initial.budgets[key] !== current.budgets[key]
	);
	if (fixedDiffers) return true;
	if (initial.customBudgets.length !== current.customBudgets.length) return true;
	return current.customBudgets.some(
		(row, index) =>
			row.id !== initial.customBudgets[index].id ||
			!sameCustomRow(row, initial.customBudgets[index])
	);
}

/** Where the memo's budgets came from when the memo does not say. */
export const UNNAMED_ORIGIN = "your last load test";

export const SLO_SOURCE_NOTE = "(from Settings › Dashboard › p99 threshold)";

/**
 * The notice's sentence, or null when nothing carried is left. A memo value names the request that
 * set it; a lone SLO seed is carried from no run, so it says what it is.
 */
export function describeCarried(
	carried: CarriedBudgets,
	budgets: BudgetDraft,
	customBudgets: readonly CustomBudgetDraft[],
	origin: BudgetsOrigin | undefined
): string | null {
	const items: string[] = [];
	let fromMemo = false;
	for (const field of BUDGET_FIELDS) {
		const source = carried.fixed[field.key];
		if (!source) continue;
		fromMemo ||= source === "memo";
		const text = describeFixedBudget(field, budgets[field.key]);
		items.push(source === "slo" ? `${text} ${SLO_SOURCE_NOTE}` : text);
	}
	for (const row of customBudgets) {
		if (!carried.customIds.includes(row.id)) continue;
		fromMemo = true;
		items.push(describeCustomBudget(row));
	}
	if (items.length === 0) return null;

	const lead = fromMemo
		? `Budgets carried over from ${origin ? `"${origin.requestName}"` : UNNAMED_ORIGIN}`
		: "Budgets prefilled";
	return `${lead}: ${items.join(", ")}. They will judge this run.`;
}
