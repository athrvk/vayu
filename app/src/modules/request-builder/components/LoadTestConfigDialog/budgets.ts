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
 * one table because the same five metrics drive the fields, the validation and
 * the payload - three hand-written lists would drift, and the way that failure
 * shows up is a budget the user typed and the engine never judged.
 *
 * The ranges mirror `engine/src/core/threshold_eval.cpp`. They are a courtesy,
 * not the gate: the engine rejects an out-of-range budget with a 400 whatever
 * this file thinks, and these exist so the user is told before the run rather
 * than after it fails to start.
 */

import type { RunThresholds } from "@/types";

export type BudgetKey = keyof RunThresholds;

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
 * The `thresholds` payload for `POST /runs`, or `undefined` when nothing was
 * declared - never an empty object, which the engine rejects rather than
 * starting a run no verdict will be computed for.
 *
 * Assumes {@link budgetError} passed; an unparseable field is skipped rather
 * than sent as `NaN`.
 */
export function buildThresholds(draft: BudgetDraft): RunThresholds | undefined {
	const thresholds: RunThresholds = {};
	for (const field of BUDGET_FIELDS) {
		const raw = draft[field.key].trim();
		if (raw === "") continue;
		const value = Number(raw);
		if (!Number.isFinite(value)) continue;
		thresholds[field.key] = value;
	}
	return Object.keys(thresholds).length > 0 ? thresholds : undefined;
}
