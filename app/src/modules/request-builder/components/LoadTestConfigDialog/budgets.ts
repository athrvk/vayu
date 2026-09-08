/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dialog's pass/fail budgets: what the fields are, when a draft is
 * unusable, and what payload it builds.
 *
 * Kept component-free so the rules can be tested without rendering, and kept in
 * one table because the same metrics drive the fields, the validation and
 * the payload - three hand-written lists would drift, and the way that failure
 * shows up is a budget the user typed and the engine never judged.
 *
 * The ranges mirror `engine/src/core/threshold_eval.cpp`. They are a courtesy,
 * not the gate: the engine rejects an out-of-range budget with a 400 whatever
 * this file thinks, and these exist so the user is told before the run rather
 * than after it fails to start.
 *
 * Beside that table is the one budget family no table can hold: a
 * `custom.<name>.<stat>` ceiling on a metric the plan records under a name only
 * the user knows (issue #1500). It is a free-text row rather than a picker of
 * recorded names because the engine itself checks only the key's *shape* - it
 * does not cross-check `<name>` against the run's `metric.record` elements, and
 * an unmatched name is simply `evaluated: false` in the report. MCP's
 * `thresholdsInput` made the same call for the same key family
 * (`electron/mcp/tools.ts`, `catchall`).
 */

import type { RunThresholdBudgets, RunThresholds } from "@/types";
import { generateId } from "@/lib/id";

/**
 * The fixed budgets, and only those: `RunThresholdBudgets` is the half of
 * `RunThresholds` that holds them, so this table cannot pick up `failRun` (a
 * flag over the budgets, rendered as its own switch) or a `custom.<name>.<stat>`
 * key (a free-text row, below), and a fixed budget added to the type without a
 * field here fails to compile.
 */
export type BudgetKey = keyof RunThresholdBudgets;

export interface BudgetField {
	key: BudgetKey;
	/** DOM id, so the label is associated rather than merely adjacent. */
	id: string;
	label: string;
	unit: string;
	min: number;
	/** Whether `min` is itself a legal budget - true only for the error rate. */
	minInclusive: boolean;
	max: number;
	hint?: string;
}

/** A day. Past it no request completes, so no ceiling above it is a budget. */
const MAX_LATENCY_MS = 86_400_000;

export const BUDGET_FIELDS: readonly BudgetField[] = [
	{
		key: "latencyP50Ms",
		id: "lt-budget-p50",
		label: "p50 latency at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
	},
	{
		key: "latencyP95Ms",
		id: "lt-budget-p95",
		label: "p95 latency at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
	},
	{
		key: "latencyP99Ms",
		id: "lt-budget-p99",
		label: "p99 latency at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
		hint: "Prefilled from the capacity SLO in Settings - clear it to run without a latency budget.",
	},
	{
		key: "maxErrorRatePct",
		id: "lt-budget-error-rate",
		label: "Error rate at most",
		unit: "%",
		// 0 is the one meaningful floor here: "no request may fail" is a real
		// budget, where a latency ceiling or a throughput floor of 0 is a typo.
		min: 0,
		minInclusive: true,
		max: 100,
		hint: "Counts every response outside 2xx/3xx, and the connection failures that never got one.",
	},
	{
		key: "minThroughputRps",
		id: "lt-budget-throughput",
		label: "Throughput at least",
		unit: "req/s",
		min: 0,
		minInclusive: false,
		max: 1_000_000_000,
	},
	{
		key: "maxAssertionFailureRatePct",
		id: "lt-budget-assertion-failure-rate",
		label: "Assertion failure rate at most",
		unit: "%",
		// Same reasoning as the error rate above: "no assertion may fail" is a
		// real budget.
		min: 0,
		minInclusive: true,
		max: 100,
		hint: "Counts every assert.* element and pm.test call this run made, inline or replayed.",
	},
];

/** What the user has typed, per budget. Blank means "not declared". */
export type BudgetDraft = Record<BudgetKey, string>;

export function emptyBudgetDraft(): BudgetDraft {
	return {
		latencyP50Ms: "",
		latencyP95Ms: "",
		latencyP99Ms: "",
		maxErrorRatePct: "",
		minThroughputRps: "",
		maxAssertionFailureRatePct: "",
	};
}

/**
 * The first budget the engine would reject, phrased for the dialog.
 *
 * Blank is always fine - budgets are opt-in, and clearing a field is how a user
 * declines one. Anything else must be a number in range: a value that is not
 * gets said out loud rather than dropped from the payload, because silently
 * sending four of the five budgets someone typed is the worse failure.
 */
export function budgetError(draft: BudgetDraft): string | null {
	for (const field of BUDGET_FIELDS) {
		const raw = draft[field.key].trim();
		if (raw === "") continue;

		const value = Number(raw);
		if (!Number.isFinite(value)) {
			return `${field.label} must be a number, or blank for no budget.`;
		}
		const underMin = field.minInclusive ? value < field.min : value <= field.min;
		if (underMin || value > field.max) {
			const lower = field.minInclusive ? `${field.min}` : `more than ${field.min}`;
			return `${field.label} must be ${lower} and at most ${field.max}${field.unit}, or blank for no budget.`;
		}
	}
	return null;
}

/**
 * The stats a `custom.<name>.<stat>` budget can read, exactly as
 * `threshold_eval.cpp`'s `custom_metric_stats()` lists them: a trend's
 * percentiles and `max`, plus `value` (a counter's running total, or a rate's
 * percentage) and `rate` (the same field, spelled for a rate metric).
 */
export const CUSTOM_BUDGET_STATS = ["p50", "p95", "p99", "max", "value", "rate"] as const;

export type CustomBudgetStat = (typeof CUSTOM_BUDGET_STATS)[number];

/**
 * `metric.record`'s own bound on a name (`metric_kinds.cpp`'s config schema:
 * `minLength` 1, `maxLength` 100). Mirrored so a name too long to have been
 * recorded is refused where it is typed. There is no character rule to mirror -
 * the engine imposes none, and inventing one here would refuse a name a run can
 * legitimately record.
 */
export const MAX_CUSTOM_METRIC_NAME_LENGTH = 100;

/**
 * One `custom.<name>.<stat>` row as the user is editing it.
 *
 * `id` is the row's identity for React and for the remove button, minted with
 * `generateId` like every other repeatable row in the app (`KeyValueEditor`'s
 * `createEmptyKeyValue`) - never the name, which is blank on a fresh row and
 * changes under the user's cursor.
 */
export interface CustomBudgetDraft {
	id: string;
	name: string;
	stat: CustomBudgetStat;
	/** Raw text, parsed like the fixed budgets above. Blank means "not declared". */
	value: string;
}

export function emptyCustomBudgetRow(): CustomBudgetDraft {
	return { id: generateId(), name: "", stat: CUSTOM_BUDGET_STATS[0], value: "" };
}

/** How a row's budget reads in a message, and travels on the wire. */
export function customBudgetKey(name: string, stat: CustomBudgetStat): `custom.${string}` {
	return `custom.${name}.${stat}`;
}

/**
 * What the engine would reject about one custom row, phrased for the dialog, or
 * `undefined` when there is nothing to say.
 *
 * A row with neither a name nor a value is an unused slot rather than a
 * mistake - the same rule a blank fixed field follows. A row with only one of
 * the two is *not*: half a budget is the "typed but never judged" failure this
 * file exists to prevent, so it is said out loud rather than dropped.
 */
export function customBudgetRowError(row: CustomBudgetDraft): string | undefined {
	const name = row.name.trim();
	const raw = row.value.trim();
	if (name === "" && raw === "") return undefined;

	if (name === "") {
		return "A custom metric budget needs the name the metric is recorded under, or clear its value.";
	}
	if (name.length > MAX_CUSTOM_METRIC_NAME_LENGTH) {
		return `A custom metric name is at most ${MAX_CUSTOM_METRIC_NAME_LENGTH} characters.`;
	}

	const label = customBudgetKey(name, row.stat);
	if (raw === "" || !Number.isFinite(Number(raw))) {
		return `${label} must be a number, or clear the name to drop the budget.`;
	}
	// The engine's own bound on this family, and its own words for it: every
	// custom stat is a ceiling, so a negative one is unmeetable rather than
	// strict.
	if (Number(raw) < 0) {
		return `${label} must be zero or greater - it is a ceiling on a recorded metric.`;
	}
	return undefined;
}

/**
 * The first thing wrong with the custom rows as a set, or `null`.
 *
 * Aggregated here rather than in each dialog so both gate their button on one
 * call, the way they already do on {@link budgetError}. The duplicate check is
 * the part no per-row function can make: two rows naming the same metric and
 * stat are one key in the payload, so the second would silently overwrite the
 * first - a budget typed and never judged, again.
 */
export function customBudgetsError(rows: readonly CustomBudgetDraft[]): string | null {
	const seen = new Set<string>();
	for (const row of rows) {
		const rowError = customBudgetRowError(row);
		if (rowError) return rowError;

		const name = row.name.trim();
		if (name === "" || row.value.trim() === "") continue;
		const key = customBudgetKey(name, row.stat);
		if (seen.has(key)) {
			return `${key} is declared twice - one budget per metric and stat.`;
		}
		seen.add(key);
	}
	return null;
}

/**
 * The `thresholds` payload for `POST /runs`, or `undefined` when nothing was
 * declared - never an empty object, which the engine rejects rather than
 * starting a run no verdict will be computed for.
 *
 * Assumes {@link budgetError} and {@link customBudgetsError} passed; an
 * unparseable field is skipped rather than sent as `NaN`, and so is a custom
 * row with a blank half. `failRun` is folded in only when at least one budget
 * was declared - the engine rejects `{ failRun: true }` alone, and a lone
 * flag with no budget to judge means the same thing here. A custom budget
 * counts as one: it is judged exactly as a fixed one is.
 */
export function buildThresholds(
	draft: BudgetDraft,
	failRun = false,
	customBudgets: readonly CustomBudgetDraft[] = []
): RunThresholds | undefined {
	const thresholds: RunThresholds = {};
	for (const field of BUDGET_FIELDS) {
		const raw = draft[field.key].trim();
		if (raw === "") continue;
		const value = Number(raw);
		if (!Number.isFinite(value)) continue;
		thresholds[field.key] = value;
	}
	for (const row of customBudgets) {
		const name = row.name.trim();
		const raw = row.value.trim();
		if (name === "" || raw === "") continue;
		const value = Number(raw);
		if (!Number.isFinite(value)) continue;
		thresholds[customBudgetKey(name, row.stat)] = value;
	}
	if (Object.keys(thresholds).length === 0) return undefined;
	if (failRun) thresholds.failRun = true;
	return thresholds;
}
