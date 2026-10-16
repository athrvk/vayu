/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which of the dialog's budgets the user did not type this time (issue #2194).
 *
 * The budgets are one global memo plus a p99 seed from Settings, so a field can
 * open filled with a number the user never saw on this request. These helpers
 * say which fields those are and where each came from, for the notice that
 * names them. Pure, so the rules are tested without rendering.
 */

import {
	BUDGET_FIELDS,
	describeCustomBudget,
	describeFixedBudget,
	isDeclaredCustomBudget,
	type BudgetDraft,
	type BudgetKey,
	type CustomBudgetDraft,
} from "./budgets";

/** `memo`: the last Start wrote it. `slo`: the Dashboard's SLO threshold seeded it. */
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

/** The one budget Settings seeds on a first run: the Dashboard's SLO threshold. */
export const SLO_SEEDED_KEY = "latencyP99Ms" satisfies BudgetKey;

/**
 * The fields the restore filled from somewhere other than the user: a non-blank
 * memo value is `memo`; a p99 the memo never recorded is the `slo` seed. A blank
 * memo value is a declined budget, not a carried one.
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

/**
 * The carried fields the user has not touched since the dialog opened. Editing a
 * field makes it theirs, so the notice stops claiming it; clearing it counts as
 * editing it.
 */
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

export const SLO_SOURCE_NOTE = "(from Settings > Dashboard > SLO threshold)";

/**
 * The notice's sentence, or null when nothing carried is left. A memo value is
 * attributed to the request that set it; a lone SLO seed is not "carried over"
 * from any run, so it says what it is instead.
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
