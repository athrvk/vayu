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
	retryAfterBackoff: boolean;
	retryAfterMaxMs: number;
	/**
	 * The stream caps (#576), memoed like every field so a repeat run need not re-bound them.
	 * Stored even for a non-streaming request: the memo is one object, and dropping keys per
	 * request kind would make "what did I set last time" depend on which request ran last.
	 */
	streamDuration: number;
	streamMaxEvents: number;
	/**
	 * Memoed as typed, blanks included, so a cleared field stays cleared, and a restored draft
	 * tells the p99 prefill it had its turn (else declining the SLO budget once is undone on the
	 * next open). Partial because a Capacity or streaming run leaves the Settings p99 seed out
	 * (`budgetsToRemember`, #2816, #3772): written, it would restore as the user's own and be sent.
	 */
	budgets: Partial<BudgetDraft>;
	/**
	 * The request whose Start last changed the budgets, so the next dialog can name the source of
	 * carried budgets (#2194): provenance for the one global memo, not per-request storage. Absent
	 * in older memos and when no saved request could be named.
	 */
	budgetsFrom?: BudgetsOrigin;
	/**
	 * The `custom.<name>.<stat>` rows (#1579), memoed like the fixed budgets: a metric name belongs
	 * to the plan, not one run, so retyping it per run is the friction the memo removes. An older
	 * memo without it restores no rows.
	 */
	customBudgets: CustomBudgetDraft[];
	/**
	 * Whether a missed budget fails the run rather than only reporting it; memoed with `budgets`.
	 */
	failRun: boolean;
	/**
	 * The monitoring endpoint, memoed: it belongs to the *target*, not one run, so retyping a
	 * `/metrics` URL and its names every run is the friction the memo removes.
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
 * The memo as the fields start: range-bound numbers clamped into the current limits, absent fields
 * defaulted. `maxInFlight` is a string: optional, and blank means "derive it".
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
 * The ceilings are a user setting (Settings -> Load testing), so every range is resolved, and
 * restored values are clamped into it: a ceiling lowered since the memo was written would otherwise
 * seed a field above its own `max`, which a number input shows without complaint.
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
		// Capacity Discovery searches for the edge of this budget, seeded from `sloThresholdMs`
		// like the p99 budget: the search and the chart annotation read one number, and a mode
		// default would be a third notion of "too slow".
		sloMs: restore(saved.sloMs, seeds.sloThresholdMs, "SLO_MS"),
	};

	const customBudgets = saved.customBudgets ?? [];

	return {
		profile,
		maxInFlight: saved.maxInFlight != null ? String(saved.maxInFlight) : "",
		// Clamped like the rest, and load-bearing: a config saved when the slider's floor was 0
		// restores that 0, since `saved.sampleRate ?? DEFAULT` keeps a present 0.
		sampleRate: restore(
			saved.sampleRate,
			LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT,
			"SAMPLE_RATE_PCT"
		),
		slowThreshold: saved.slowThreshold ?? LOAD_TEST_DEFAULTS.SLOW_THRESHOLD_MS,
		saveTimingBreakdown: saved.saveTimingBreakdown ?? LOAD_TEST_DEFAULTS.SAVE_TIMING_BREAKDOWN,
		// An older memo carries neither key.
		retryAfterBackoff: saved.retryAfterBackoff ?? LOAD_TEST_DEFAULTS.RETRY_AFTER_BACKOFF,
		retryAfterMaxMs: restore(
			saved.retryAfterMaxMs,
			LOAD_TEST_DEFAULTS.RETRY_AFTER_MAX_MS,
			"RETRY_AFTER_MAX_MS"
		),
		// Budgets and monitor merge onto an empty draft, never swapped whole: an older build's
		// block lacks fields added since, and `budgetError` / `monitorError` read every current
		// key, so a stale object crashed the dialog on `undefined.trim()`. The p99 budget is seeded
		// from the capacity SLO on a first run only: once memoed, a cleared p99 stays cleared.
		budgets: {
			...emptyBudgetDraft(),
			[SLO_SEEDED_KEY]: String(seeds.sloThresholdMs),
			...saved.budgets,
		},
		budgetsFrom: restoreBudgetsOrigin(saved),
		carried: findCarriedBudgets(saved.budgets, customBudgets),
		customBudgets,
		failRun: saved.failRun ?? false,
		// The scrape cadence too is seeded on a first run only; once memoed, the user's interval
		// stays.
		monitor: { ...emptyMonitorDraft(seeds.monitorIntervalMs), ...saved.monitor },
	};
}

/**
 * The last run's settings: read once on open, clamped into @p limits, written by `save` at Start.
 */
export function useSavedLoadTestConfig(limits: LoadTestLimits, seeds: RestoreSeeds) {
	const [initial] = useState(() => restoreConfig(loadSavedConfig(), limits, seeds));
	return { initial, save: saveConfig };
}
