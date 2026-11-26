/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestConfig } from "@/types";
import type { StartLoadTestRequest } from "@/types/api";
import { successSamplePeriod } from "@/constants/load-test";
import { runDataFileName } from "@/lib/run-data-file";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";
import { type BudgetDraft, type CustomBudgetDraft, buildThresholds } from "./budgets";
import { budgetsToSend, type CarriedBudgets } from "./carried-budgets";
import { type MonitorDraft, buildMonitor } from "./monitor";
import { type ProfileParams, appliesRetryAfter, profileParams } from "./profile";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

/**
 * The `elements.scripts` run override (#1594), with `RunCollectionDialog`'s values and default: "As
 * marked" lets each inherited `script.*` element's `config.inline` decide; the others force every
 * one.
 */
export type ScriptsOverride = "asMarked" | "allInline" | "allDeferred";
export const SCRIPTS_DEFAULT: ScriptsOverride = "asMarked";

/** What the dialog holds when Start is pressed. */
export interface LoadTestDraft {
	profile: LoadTestProfile;
	sampleRate: number;
	slowThreshold: number;
	saveTimingBreakdown: boolean;
	retryAfterBackoff: boolean;
	retryAfterMaxMs: number;
	/** Null when the field is blank. */
	maxInFlight: number | null;
	budgets: BudgetDraft;
	customBudgets: CustomBudgetDraft[];
	failRun: boolean;
	monitor: MonitorDraft;
	comment: string;
	/** `thresholds` keys still holding a value the user did not set this time (issue #2195). */
	carriedBudgets?: readonly string[];
	/**
	 * Where each still-carried fixed budget came from, since the Settings p99 seed is withheld from
	 * a capacity run or a streaming request while a memo or typed p99 is not (#2816, #3772).
	 */
	budgetSources?: CarriedBudgets["fixed"];
	scriptsOverride: ScriptsOverride;
	dataFile: SelectedDataFile | null;
	isStreamingRequest: boolean;
}

/** `MAX_CARRIED_BUDGETS` in `engine/src/http/routes/execution.cpp`. */
const MAX_CARRIED_BUDGETS = 64;

type NumericParam = Exclude<keyof ProfileParams, "mode">;

/** The single-request payload's spelling of each neutral parameter. */
const ENGINE_FIELD = {
	duration: "duration_seconds",
	rps: "rps",
	concurrency: "concurrency",
	iterations: "iterations",
	rampDuration: "ramp_duration_seconds",
	startConcurrency: "start_concurrency",
	sloMs: "slo_ms",
	stepDuration: "step_duration_seconds",
	maxInFlight: "max_in_flight",
} as const satisfies Record<NumericParam, keyof LoadTestConfig>;

function engineFields(params: ProfileParams) {
	const fields: Partial<Record<(typeof ENGINE_FIELD)[NumericParam], number>> = {};
	for (const key of Object.keys(ENGINE_FIELD) as NumericParam[]) {
		const value = params[key];
		if (value !== undefined) fields[ENGINE_FIELD[key]] = value;
	}
	return fields;
}

/**
 * The carried keys the payload actually judges, or `undefined` when none: a key with no budget
 * behind it (a skipped unparseable field) names nothing in the report. At most
 * `MAX_CARRIED_BUDGETS`: the engine refuses more, and the list only labels rows.
 */
function carriedInThresholds(
	carried: readonly string[] | undefined,
	thresholds: LoadTestConfig["thresholds"]
): string[] | undefined {
	const declared = new Set(Object.keys(thresholds ?? {}));
	const judged = (carried ?? []).filter((key) => declared.has(key)).slice(0, MAX_CARRIED_BUDGETS);
	return judged.length > 0 ? judged : undefined;
}

export function buildLoadTestConfig(draft: LoadTestDraft): LoadTestConfig {
	const { profile, dataFile } = draft;
	const budgets = budgetsToSend(
		draft.budgets,
		profile.mode,
		draft.isStreamingRequest,
		draft.budgetSources
	);
	const thresholds = buildThresholds(
		budgets,
		draft.failRun,
		draft.customBudgets,
		draft.isStreamingRequest
	);
	const carriedBudgets = carriedInThresholds(draft.carriedBudgets, thresholds);

	const config: LoadTestConfig = {
		mode: profile.mode,
		// The slider is a percentage, the engine's field a period; the memo keeps the percentage so
		// the control restores what the user set.
		success_sample_period: successSamplePeriod(draft.sampleRate),
		slow_threshold_ms: draft.slowThreshold,
		save_timing_breakdown: draft.saveTimingBreakdown,
		comment: draft.comment || undefined,
		// Absent when nothing was declared: the engine refuses an empty object.
		thresholds,
		// Absent when no endpoint was given, for the same reason.
		monitor: buildMonitor(draft.monitor),
		...(carriedBudgets ? { carriedBudgets } : {}),
		// Absent at the default, the "absent means what the user asked for" rule
		// `failOnSchemaError` follows in the collection-run dialog (#1594).
		...(draft.scriptsOverride !== SCRIPTS_DEFAULT
			? { elements: { scripts: draft.scriptsOverride } }
			: {}),
		// Absent when off or in a mode with no next request to hold, so the stored config says only
		// what the run did.
		...(draft.retryAfterBackoff && appliesRetryAfter(profile.mode)
			? { retryAfterBackoff: true, retryAfterMaxMs: draft.retryAfterMaxMs }
			: {}),
	};

	// The parsed rows, the array the preview showed, never a re-parse (#993); absent without a
	// file, so a run without data keeps its path. Their column names go too (#1007): the run
	// composes first, and composition must know which bare names a row binds or it resolves them
	// from the variable scopes.
	if (dataFile) {
		config.data = dataFile.parsed.rows;
		config.dataColumns = dataFile.parsed.columns;
		config.dataFileName = runDataFileName(dataFile.fileName);
		config.dataFileHash = dataFile.hash;
		config.dataFileCastNumbers = dataFile.parsed.castNumbers;
	}

	// Streaming requests only, and always sent then: the engine's default is the
	// `sseMaxStreamDurationMs` setting, which the dialog does not show, so eliding would bound the
	// run by a number the user never saw while the dialog showed two others.
	if (draft.isStreamingRequest) {
		config.stream_duration_seconds = profile.streamDuration;
		config.stream_max_events = profile.streamMaxEvents;
	}

	// `profileParams` leaves the duration out of `iterations` (`usesDuration`): a value the engine
	// discards would make the stored config claim something untrue.
	Object.assign(config, engineFields(profileParams(profile, draft.maxInFlight)));
	return config;
}

type WireTimings = Pick<
	StartLoadTestRequest,
	"duration" | "rampUpDuration" | "stepDuration" | "maxStreamDurationMs"
>;

/**
 * The config's second-valued fields as the run request spells them (`"Ns"`, and ms for the stream
 * cap). A field is absent because the mode does not send it, never because it is zero: a falsy test
 * here once turned a duration of 0 into none, run for the engine's 60 s default (#3542). Every key
 * is present, `undefined` when absent, so it overrides a stale one in the composed request.
 */
export function wireTimings(config: LoadTestConfig): WireTimings {
	const seconds = (value: number | undefined) => (value !== undefined ? `${value}s` : undefined);
	return {
		duration: seconds(config.duration_seconds),
		rampUpDuration: seconds(config.ramp_duration_seconds),
		stepDuration: seconds(config.step_duration_seconds),
		maxStreamDurationMs:
			config.stream_duration_seconds !== undefined
				? config.stream_duration_seconds * 1000
				: undefined,
	};
}
