/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import type { LoadTestConfig } from "@/types";
import { LOAD_TEST_DEFAULTS, clampToRange, type LoadTestLimits } from "@/constants/load-test";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { type BudgetDraft, type CustomBudgetDraft, emptyBudgetDraft } from "./budgets";
import { type MonitorDraft, emptyMonitorDraft } from "./monitor";
import {
	SLO_SEEDED_KEY,
	findCarriedBudgets,
	type BudgetsOrigin,
	type CarriedBudgets,
} from "./carried-budgets";

export interface SavedLoadTestConfig {
	mode: LoadTestConfig["mode"];
	duration: number;
	rps: number;
	concurrency: number;
	iterations: number;
	rampDuration: number;
	startConcurrency: number;
	stepDuration: number;
	sloMs: number;
	maxInFlight: number | null;
	sampleRate: number;
	slowThreshold: number;
	saveTimingBreakdown: boolean;
	/**
	 * The stream caps (issue #576), memoed like every other field so a second
	 * run of the same stream does not have to be re-bounded by hand. Stored
	 * even for a non-streaming request: the memo is one object, and dropping
	 * keys per request kind would make "what did I set last time" depend on
	 * which request happened to run last.
	 */
	streamDuration: number;
	streamMaxEvents: number;
	/**
	 * Budgets are memoed as typed, blanks included, so a cleared field stays
	 * cleared. A restored draft is also what tells the p99 prefill it has
	 * already had its turn - without it, declining the SLO budget once would be
	 * undone by the next dialog open. Partial because a Capacity run leaves the
	 * Settings p99 seed out (`budgetsToRemember`, issue #2816): written, it would
	 * restore as the user's own and the next capacity run would send it.
	 */
	budgets: Partial<BudgetDraft>;
	/**
	 * The request whose Start last changed the budgets above, so the next dialog
	 * can say where carried-over budgets came from (issue #2194). Provenance for
	 * the one global memo, not per-request storage. Absent from a memo written
	 * before this field existed, and when the budgets were written without a
	 * saved request to name.
	 */
	budgetsFrom?: BudgetsOrigin;
	/**
	 * The `custom.<name>.<stat>` rows (issue #1579), memoed for the same reason
	 * and in the same shape as the fixed budgets above: a metric name is a
	 * property of the plan, not of one run, so retyping it per run is friction
	 * the memo exists to remove. Absent from a memo written before this field
	 * existed, which restores as no rows.
	 */
	customBudgets: CustomBudgetDraft[];
	/**
	 * Whether a missed budget above should fail the run, not only report it -
	 * memoed alongside `budgets` for the same reason.
	 */
	failRun: boolean;
	/**
	 * The monitoring endpoint, memoed for the same reason the budgets are: it is
	 * a property of the *target* rather than of one run, so retyping a
	 * `/metrics` URL and its metric names for every run is the same friction the
	 * memo exists to remove.
	 */
	monitor: MonitorDraft;
}

/** The fields that describe the load itself, edited together by `ProfileFields`. */
export type LoadTestProfile = Pick<
	SavedLoadTestConfig,
	| "mode"
	| "duration"
	| "rps"
	| "concurrency"
	| "iterations"
	| "rampDuration"
	| "startConcurrency"
	| "stepDuration"
	| "sloMs"
	| "streamDuration"
	| "streamMaxEvents"
>;

/**
 * The memo as the dialog's fields start out: every range-bound number clamped
 * into the current limits, every absent field defaulted. `maxInFlight` is a
 * string because its field is optional and blank means "derive it".
 */
export type RestoredLoadTestConfig = Omit<
	SavedLoadTestConfig,
	keyof LoadTestProfile | "maxInFlight" | "budgets"
> & {
	profile: LoadTestProfile;
	budgets: BudgetDraft;
	maxInFlight: string;
	/** Which budget fields were filled by the memo or the SLO seed, not the user. */
	carried: CarriedBudgets;
};

/** Defaults that come from settings rather than from `LOAD_TEST_DEFAULTS`. */
interface RestoreSeeds {
	/** `sloThresholdMs`: the capacity SLO, and the p99 budget's first value. */
	sloThresholdMs: number;
	/** `monitorIntervalMs`: the scrape cadence a first run starts with. */
	monitorIntervalMs: number;
}

/** A memo is JSON from disk: only a well-formed origin is trusted. */
function restoreBudgetsOrigin(saved: Partial<SavedLoadTestConfig>): BudgetsOrigin | undefined {
	const name = saved.budgetsFrom?.requestName;
	return typeof name === "string" && name !== "" ? { requestName: name } : undefined;
}

function loadSavedConfig(): Partial<SavedLoadTestConfig> {
	try {
		const saved = localStorage.getItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG);
		if (saved) return JSON.parse(saved);
	} catch {
		// Corrupt or unavailable storage - fall back to defaults.
	}
	return {};
}

function saveConfig(config: SavedLoadTestConfig): void {
	try {
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify(config));
	} catch {
		// Quota or private mode - losing the memo is not worth failing the run.
	}
}

/**
 * The ceilings are a user setting (Settings -> Load testing), so every range
 * is resolved rather than read off the constant. Restored values are clamped
 * into it: the memo is written by a past run, and a ceiling lowered since then
 * would otherwise seed a field above its own `max` - which a number input
 * shows without complaint.
 */
function restoreConfig(
	saved: Partial<SavedLoadTestConfig>,
	limits: LoadTestLimits,
	seeds: RestoreSeeds
): RestoredLoadTestConfig {
	const restore = (value: number | undefined, fallback: number, key: keyof LoadTestLimits) =>
		clampToRange(value ?? fallback, limits[key]);

	const profile: LoadTestProfile = {
		mode: saved.mode ?? LOAD_TEST_DEFAULTS.MODE,
		duration: restore(saved.duration, LOAD_TEST_DEFAULTS.DURATION_S, "DURATION_S"),
		rps: restore(saved.rps, LOAD_TEST_DEFAULTS.RPS, "RPS"),
		concurrency: restore(saved.concurrency, LOAD_TEST_DEFAULTS.CONCURRENCY, "CONCURRENCY"),
		iterations: restore(saved.iterations, LOAD_TEST_DEFAULTS.ITERATIONS, "ITERATIONS"),
		rampDuration: restore(
			saved.rampDuration,
			LOAD_TEST_DEFAULTS.RAMP_DURATION_S,
			"RAMP_DURATION_S"
		),
		startConcurrency: restore(
			saved.startConcurrency,
			LOAD_TEST_DEFAULTS.START_CONCURRENCY,
			"START_CONCURRENCY"
		),
		stepDuration: restore(
			saved.stepDuration,
			LOAD_TEST_DEFAULTS.STEP_DURATION_S,
			"STEP_DURATION_S"
		),
		streamDuration: restore(
			saved.streamDuration,
			LOAD_TEST_DEFAULTS.STREAM_DURATION_S,
			"STREAM_DURATION_S"
		),
		streamMaxEvents: restore(
			saved.streamMaxEvents,
			LOAD_TEST_DEFAULTS.STREAM_MAX_EVENTS,
			"STREAM_MAX_EVENTS"
		),
		// Capacity Discovery searches for the edge of this budget. Seeded from the
		// same `sloThresholdMs` setting the p99 budget is - the search and the
		// chart annotation are two readings of one number, and giving the mode its
		// own default would be a third notion of "too slow".
		sloMs: restore(saved.sloMs, seeds.sloThresholdMs, "SLO_MS"),
	};

	const customBudgets = saved.customBudgets ?? [];

	return {
		profile,
		maxInFlight: saved.maxInFlight != null ? String(saved.maxInFlight) : "",
		// Clamped like the rest, and load-bearing for a second reason: a config
		// saved when the slider's floor was 0 restores that 0, because
		// `saved.sampleRate ?? DEFAULT` keeps a present 0.
		sampleRate: restore(
			saved.sampleRate,
			LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT,
			"SAMPLE_RATE_PCT"
		),
		slowThreshold: saved.slowThreshold ?? LOAD_TEST_DEFAULTS.SLOW_THRESHOLD_MS,
		saveTimingBreakdown: saved.saveTimingBreakdown ?? LOAD_TEST_DEFAULTS.SAVE_TIMING_BREAKDOWN,
		// Budgets and monitor are merged onto an empty draft rather than swapped
		// wholesale: a block saved by an older build predates whatever field this
		// build added since, and `budgetError` / `monitorError` read every
		// current key unconditionally - a stale object missing one crashed the
		// dialog outright on `undefined.trim()`.
		//
		// The p99 budget is seeded from the capacity SLO only on a first run:
		// once a draft has been memoed, a cleared p99 stays cleared.
		budgets: {
			...emptyBudgetDraft(),
			[SLO_SEEDED_KEY]: String(seeds.sloThresholdMs),
			...saved.budgets,
		},
		budgetsFrom: restoreBudgetsOrigin(saved),
		carried: findCarriedBudgets(saved.budgets, customBudgets),
		customBudgets,
		failRun: saved.failRun ?? false,
		// The scrape cadence is likewise seeded only on a first run: once a draft
		// has been memoed, the interval the user set stays set.
		monitor: { ...emptyMonitorDraft(seeds.monitorIntervalMs), ...saved.monitor },
	};
}

/**
 * The last run's settings: read once when the dialog opens, clamped into
 * @p limits, and written back by `save` when a run starts.
 */
export function useSavedLoadTestConfig(limits: LoadTestLimits, seeds: RestoreSeeds) {
	const [initial] = useState(() => restoreConfig(loadSavedConfig(), limits, seeds));
	return { initial, save: saveConfig };
}
