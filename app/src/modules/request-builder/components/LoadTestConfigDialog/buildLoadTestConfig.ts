/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestConfig } from "@/types";
import { successSamplePeriod } from "@/constants/load-test";
import { runDataFileName } from "@/lib/run-data-file";
import type { SelectedDataFile } from "@/modules/collections/DataFilePicker";
import { type BudgetDraft, type CustomBudgetDraft, buildThresholds } from "./budgets";
import { type MonitorDraft, buildMonitor } from "./monitor";
import { usesDuration } from "./profile";
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
	/** Null when the field is blank. */
	maxInFlight: number | null;
	budgets: BudgetDraft;
	customBudgets: CustomBudgetDraft[];
	failRun: boolean;
	monitor: MonitorDraft;
	comment: string;
	scriptsOverride: ScriptsOverride;
	dataFile: SelectedDataFile | null;
	isStreamingRequest: boolean;
}

/** The profile's own parameters, which differ per mode. */
function applyProfile(
	config: LoadTestConfig,
	profile: LoadTestProfile,
	maxInFlight: number | null
) {
	switch (profile.mode) {
		case "constant_rps":
			config.rps = profile.rps;
			if (maxInFlight != null && maxInFlight > 0) config.max_in_flight = maxInFlight;
			break;
		case "constant_concurrency":
			config.concurrency = profile.concurrency;
			break;
		case "iterations":
			config.iterations = profile.iterations;
			config.concurrency = profile.concurrency;
			break;
		case "ramp_up":
			config.concurrency = profile.concurrency;
			config.ramp_duration_seconds = profile.rampDuration;
			config.start_concurrency = profile.startConcurrency;
			break;
		case "capacity":
			// `concurrency` is the ceiling the search will not climb past and
			// `start_concurrency` is where it begins - the same two fields the
			// ramp owns, reused rather than respelled, so one cap in Settings
			// bounds both modes.
			config.concurrency = profile.concurrency;
			config.start_concurrency = profile.startConcurrency;
			config.slo_ms = profile.sloMs;
			config.step_duration_seconds = profile.stepDuration;
			break;
	}
}

export function buildLoadTestConfig(draft: LoadTestDraft): LoadTestConfig {
	const { profile, dataFile } = draft;

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
		thresholds: buildThresholds(draft.budgets, draft.failRun, draft.customBudgets),
		// Absent when no endpoint was given, for the same reason.
		monitor: buildMonitor(draft.monitor),
		// Absent at the default, the same "absent already means what the
		// user asked for" rule `failOnSchemaError` follows on the
		// collection-run dialog (issue #1594).
		...(draft.scriptsOverride !== SCRIPTS_DEFAULT
			? { elements: { scripts: draft.scriptsOverride } }
			: {}),
	};

	// Omitted in `iterations` - see `usesDuration`. Sending a value the engine
	// discards makes the stored run config claim something untrue about it.
	if (usesDuration(profile.mode)) config.duration_seconds = profile.duration;

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

	applyProfile(config, profile, draft.maxInFlight);
	return config;
}
