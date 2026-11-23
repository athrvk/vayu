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
 * The `elements.scripts` run override (issue #1594), the same three values
 * and the same default `RunCollectionDialog`'s Scripts toggle uses - "As
 * marked" leaves each inherited `script.*` element's own `config.inline` to
 * decide, the other two force every one of this run's elements regardless.
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
	 * Where each still-carried fixed budget came from. Beside the key list
	 * because the Settings p99 seed is withheld from a capacity run or a streaming
	 * request while a memo or typed p99 is not (issues #2816, #3772).
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
 * The carried keys that the payload actually judges, or `undefined` when none
 * remain - a key with no budget behind it (an unparseable field the payload
 * skipped) names nothing the report holds. At most `MAX_CARRIED_BUDGETS`: the
 * engine refuses a longer list, and this one only labels rows.
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
		// The slider is a percentage; the engine's field is a period. The
		// memo keeps the percentage, so the control restores to what the user
		// set rather than to a converted number.
		success_sample_period: successSamplePeriod(draft.sampleRate),
		slow_threshold_ms: draft.slowThreshold,
		save_timing_breakdown: draft.saveTimingBreakdown,
		comment: draft.comment || undefined,
		// Absent when nothing was declared - the engine rejects an empty
		// object rather than starting a run no verdict can be computed for.
		thresholds,
		// Absent when no endpoint was given, for the same reason.
		monitor: buildMonitor(draft.monitor),
		...(carriedBudgets ? { carriedBudgets } : {}),
		// Absent at the default, the same "absent already means what the
		// user asked for" rule `failOnSchemaError` follows on the
		// collection-run dialog (issue #1594).
		...(draft.scriptsOverride !== SCRIPTS_DEFAULT
			? { elements: { scripts: draft.scriptsOverride } }
			: {}),
		// Absent when off or in a mode that has no next request to hold back,
		// so the stored config says only what the run did.
		...(draft.retryAfterBackoff && appliesRetryAfter(profile.mode)
			? { retryAfterBackoff: true, retryAfterMaxMs: draft.retryAfterMaxMs }
			: {}),
	};

	// The parsed rows themselves - the same array the preview showed, never
	// a re-parse (issue #993). Absent when no file was picked, which is what
	// keeps a run without data on exactly the path it took before.
	//
	// Their column names travel with them (issue #1007): the run composes
	// before it starts, and composition has to be told which bare names a row
	// will bind or it resolves them from the variable scopes first.
	if (dataFile) {
		config.data = dataFile.parsed.rows;
		config.dataColumns = dataFile.parsed.columns;
		config.dataFileName = runDataFileName(dataFile.fileName);
		config.dataFileHash = dataFile.hash;
		config.dataFileCastNumbers = dataFile.parsed.castNumbers;
	}

	// Streaming requests only. Always sent when the request streams, never
	// elided as "the engine has defaults": the engine's default is the
	// user's `sseMaxStreamDurationMs` setting, which the dialog does not
	// show, so eliding would mean the run is bounded by a number the user
	// was never told about while the dialog displayed two others.
	if (draft.isStreamingRequest) {
		config.stream_duration_seconds = profile.streamDuration;
		config.stream_max_events = profile.streamMaxEvents;
	}

	// `profileParams` leaves the duration out of `iterations` (see
	// `usesDuration`): sending a value the engine discards makes the stored run
	// config claim something untrue about it.
	Object.assign(config, engineFields(profileParams(profile, draft.maxInFlight)));
	return config;
}

type WireTimings = Pick<
	StartLoadTestRequest,
	"duration" | "rampUpDuration" | "stepDuration" | "maxStreamDurationMs"
>;

/**
 * The config's second-valued fields in the run request's spelling (`"Ns"`
 * strings, and milliseconds for the stream cap). A field is absent because the
 * mode does not send it, never because it is zero: a falsy test here turned a
 * duration of 0 into no duration, which the engine ran for its 60 s default
 * (#3542). Every key is present, `undefined` when absent, so it overrides a
 * stale one in the composed request it is spread over.
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
