/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestConfig } from "@/types";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

/**
 * Duration is meaningless in `iterations`: the engine stops on
 * `requests_sent < iterations` and its branch in `load_strategy.cpp` never
 * reads duration - `docs/engine/api-reference.md` documents the field as
 * "constant_rps / constant_concurrency / ramp_up". The old dialog showed it
 * anyway, second on screen, and persisted whatever you typed. It already
 * half-knew: the OAuth guard is handed `null` in this mode precisely because
 * a duration-based warning would be nonsense.
 */
export function usesDuration(mode: LoadTestConfig["mode"]): boolean {
	return mode !== "iterations";
}

/**
 * The parameters a mode actually sends, in the dialog's own units and names and
 * with nothing else: an unused one is absent, never `undefined`, so a payload
 * built from it cannot claim a field the engine discards.
 *
 * Neutral on purpose. The single-request payload spells these snake_case
 * (`LoadTestConfig`) and the scenario payload camelCase with `"Ns"` strings
 * (`StartScenarioRunRequest`); both map from here, so which fields a mode owns
 * is decided in one place.
 */
export interface ProfileParams {
	mode: LoadTestConfig["mode"];
	duration?: number;
	rps?: number;
	concurrency?: number;
	iterations?: number;
	rampDuration?: number;
	startConcurrency?: number;
	sloMs?: number;
	stepDuration?: number;
	maxInFlight?: number;
}

/**
 * @param maxInFlight  Constant RPS only: a positive cap on requests in flight.
 *                     Null or non-positive leaves the engine to derive it.
 */
export function profileParams(
	profile: LoadTestProfile,
	maxInFlight: number | null = null
): ProfileParams {
	const { mode } = profile;
	const params: ProfileParams = { mode };
	if (usesDuration(mode)) params.duration = profile.duration;

	switch (mode) {
		case "constant_rps":
			params.rps = profile.rps;
			if (maxInFlight != null && maxInFlight > 0) params.maxInFlight = maxInFlight;
			break;
		case "constant_concurrency":
			params.concurrency = profile.concurrency;
			break;
		case "iterations":
			params.iterations = profile.iterations;
			params.concurrency = profile.concurrency;
			break;
		case "ramp_up":
			params.concurrency = profile.concurrency;
			params.rampDuration = profile.rampDuration;
			params.startConcurrency = profile.startConcurrency;
			break;
		case "capacity":
			// `concurrency` is the ceiling the search will not climb past and
			// `startConcurrency` is where it begins - the same two fields the
			// ramp owns, reused rather than respelled, so one cap in Settings
			// bounds both modes.
			params.concurrency = profile.concurrency;
			params.startConcurrency = profile.startConcurrency;
			params.sloMs = profile.sloMs;
			params.stepDuration = profile.stepDuration;
			break;
	}
	return params;
}
