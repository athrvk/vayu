/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestConfig } from "@/types";
import type { LoadTestLimits } from "@/constants/load-test";
import { CONCURRENCY_LABEL, CONCURRENCY_UNIT } from "@/constants/load-test-modes";
import { rangeError } from "../../utils/loadTestValidation";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

/**
 * Duration is meaningless in `iterations`: the engine stops on `requests_sent < iterations` and
 * that branch of `load_strategy.cpp` never reads duration (`docs/engine/api-reference/load-runs.md`
 * lists the field for constant_rps / constant_concurrency / ramp_up only). The OAuth guard is
 * handed `null` in this mode for the same reason.
 */
export function usesDuration(mode: LoadTestConfig["mode"]): boolean {
	return mode !== "iterations";
}

/**
 * Whether a virtual user has a "next request" to hold. `constant_rps` sends on a schedule, so the
 * engine skips Retry-After back-off there with a warning (#3782); the dialog hides the control.
 */
export function appliesRetryAfter(mode: LoadTestConfig["mode"]): boolean {
	return mode !== "constant_rps";
}

/** The cap is on screen only with the option on, in a mode that applies it. */
export function retryAfterCapError(
	mode: LoadTestConfig["mode"],
	limits: LoadTestLimits,
	backoff: boolean,
	capMs: number
): string | null {
	if (!backoff || !appliesRetryAfter(mode)) return null;
	return rangeError("Longest Retry-After wait", capMs, limits.RETRY_AFTER_MAX_MS, {
		whole: true,
		engineBound: true,
	});
}

/**
 * The dialog's name for the virtual-user count per mode, shared with the range message it must
 * match.
 */
export function concurrencyLabel(mode: LoadTestConfig["mode"]): string {
	if (mode === "ramp_up") return `Target ${CONCURRENCY_UNIT}`;
	if (mode === "capacity") return `Maximum ${CONCURRENCY_UNIT}`;
	return CONCURRENCY_LABEL;
}

/** What the dialog calls the duration in each mode that sends one. */
export function durationLabel(mode: LoadTestConfig["mode"]): string {
	if (mode === "ramp_up") return "Total duration";
	if (mode === "capacity") return "Give up after";
	return "Duration";
}

/**
 * The parameters a mode sends, in the dialog's units and names, and nothing else: an unused one is
 * absent, never `undefined`, so a payload cannot claim a field the engine discards. Neutral on
 * purpose: the single-request payload spells these snake_case (`LoadTestConfig`), the scenario one
 * camelCase with `"Ns"` strings (`StartScenarioRunRequest`), and both map from here, so which
 * fields a mode owns is decided once.
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
 * @param maxInFlight  Constant RPS only: a positive in-flight cap. Null or non-positive lets the
 *        engine derive it.
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
			// `concurrency` is the ceiling the search never passes and `startConcurrency` where it
			// begins: the ramp's fields reused, so one Settings cap bounds both modes.
			params.concurrency = profile.concurrency;
			params.startConcurrency = profile.startConcurrency;
			params.sloMs = profile.sloMs;
			params.stepDuration = profile.stepDuration;
			break;
	}
	return params;
}
