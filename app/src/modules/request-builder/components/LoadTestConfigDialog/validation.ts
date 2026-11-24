/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestLimitKey, LoadTestLimits } from "@/constants/load-test";
import type { ResolvedElement } from "@/types";
import {
	rangeError,
	validateCapacityRange,
	validateRampDuration,
	validateStartConcurrency,
	validateStartConcurrencyFloor,
} from "../../utils/loadTestValidation";
import {
	budgetError,
	customBudgetsError,
	type BudgetDraft,
	type CustomBudgetDraft,
} from "./budgets";
import { monitorError, type MonitorDraft } from "./monitor";
import {
	concurrencyLabel,
	durationLabel,
	profileParams,
	retryAfterCapError,
	type ProfileParams,
} from "./profile";
import { scenarioOnlyError } from "./scenario-only";
import { scenarioStreamCapError } from "./scenarioProfile";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

/** Each rule's message, or null when the draft passes it. */
export interface DraftErrors {
	rampDurationError: string | null;
	startFloorError: string | null;
	startConcurrencyError: string | null;
	capacityRangeError: string | null;
	/** A field outside the range it shows: zero, negative, fractional or past its ceiling. */
	profileRangeError: string | null;
	budgetsError: string | null;
	monitoringError: string | null;
	/** An enabled element only a scenario can run (#3050); no field in the dialog fixes it. */
	scenarioOnlyError: string | null;
}

interface DraftToValidate {
	profile: LoadTestProfile;
	budgets: BudgetDraft;
	customBudgets: CustomBudgetDraft[];
	monitor: MonitorDraft;
	/** The engine's `monitorMaxSeries` setting. */
	maxSeries: number;
	/** The enabled scenario-only elements the run would carry (`scenarioOnlyElements`). */
	scenarioOnly: readonly ResolvedElement[];
	/** Whether the request streams, which is what puts the stream budgets in play. */
	isStreamingRequest: boolean;
	/** The ranges in force: the shipped ones under the user's Settings ceilings. */
	limits: LoadTestLimits;
	slowThreshold: number;
	retryAfterBackoff: boolean;
	retryAfterMaxMs: number;
	/** The field as typed; blank derives the cap, so only a typed value is checked. */
	maxInFlight: string;
}

type RangedParam = Exclude<keyof ProfileParams, "mode" | "maxInFlight">;

interface FieldRange {
	label: (mode: LoadTestProfile["mode"]) => string;
	limit: LoadTestLimitKey;
	whole: boolean;
	/** A range Settings does not move, so the message does not point there. */
	engineBound?: boolean;
}

/** In the order the fields appear on screen, so the first refusal is the topmost field. */
const PROFILE_RANGES: Record<RangedParam, FieldRange> = {
	rps: { label: () => "Target rate", limit: "RPS", whole: false },
	concurrency: { label: concurrencyLabel, limit: "CONCURRENCY", whole: true },
	iterations: { label: () => "Requests", limit: "ITERATIONS", whole: true },
	duration: { label: durationLabel, limit: "DURATION_S", whole: false },
	sloMs: { label: () => "Latency budget", limit: "SLO_MS", whole: false, engineBound: true },
	stepDuration: {
		label: () => "Hold each level for",
		limit: "STEP_DURATION_S",
		whole: false,
		engineBound: true,
	},
	startConcurrency: { label: () => "Start from", limit: "START_CONCURRENCY", whole: true },
	rampDuration: { label: () => "Ramp duration", limit: "RAMP_DURATION_S", whole: false },
};

/** The profile's own fields: exactly the ones `profileParams` says the mode sends. */
function profileFieldError(
	profile: LoadTestProfile,
	limits: LoadTestLimits,
	startFloorError: string | null
): string | null {
	const params = profileParams(profile);
	for (const key of Object.keys(PROFILE_RANGES) as RangedParam[]) {
		const value = params[key];
		// The floor rule already names a start below 1, in its own words.
		if (value === undefined || (key === "startConcurrency" && startFloorError)) continue;
		const { label, limit, whole, engineBound } = PROFILE_RANGES[key];
		const error = rangeError(label(profile.mode), value, limits[limit], { whole, engineBound });
		if (error) return error;
	}
	return null;
}

/**
 * The first field outside its range, among the ones this draft would send. A
 * field the mode does not send is hidden, so a stale value in it is nobody's
 * mistake (the stream caps only when the request streams).
 */
function rangeErrorOf(
	{
		profile,
		limits,
		slowThreshold,
		maxInFlight,
		retryAfterBackoff,
		retryAfterMaxMs,
		isStreamingRequest,
	}: DraftToValidate,
	startFloorError: string | null
): string | null {
	return (
		profileFieldError(profile, limits, startFloorError) ??
		// `max_in_flight` is the constant-rate cap, and blank is its valid "derive it".
		(profile.mode === "constant_rps" && maxInFlight.trim() !== ""
			? rangeError("Max in-flight requests", Number(maxInFlight), limits.MAX_IN_FLIGHT, {
					whole: true,
					engineBound: true,
				})
			: null) ??
		rangeError("Slow request threshold", slowThreshold, limits.SLOW_THRESHOLD_MS, {
			whole: false,
			engineBound: true,
		}) ??
		retryAfterCapError(profile.mode, limits, retryAfterBackoff, retryAfterMaxMs) ??
		(isStreamingRequest ? scenarioStreamCapError(profile, limits) : null)
	);
}

export function validateLoadTestDraft(draft: DraftToValidate): DraftErrors {
	const {
		profile,
		budgets,
		customBudgets,
		monitor,
		maxSeries,
		scenarioOnly,
		isStreamingRequest,
	} = draft;
	const { mode, duration, concurrency, rampDuration, startConcurrency } = profile;
	// Checked before the two range rules, which both compare the start against
	// the target: a start below the floor is wrong on its own terms, and saying
	// so is more useful than "this would ramp down".
	const startFloorError = validateStartConcurrencyFloor(mode, startConcurrency);
	return {
		rampDurationError: validateRampDuration(mode, duration, rampDuration),
		startFloorError,
		startConcurrencyError: validateStartConcurrency(mode, startConcurrency, concurrency),
		capacityRangeError: validateCapacityRange(mode, startConcurrency, concurrency),
		profileRangeError: rangeErrorOf(draft, startFloorError),
		// One message slot for both budget families: a custom row is refused on the
		// same terms a fixed field is, so the notice reads the same either way.
		budgetsError: budgetError(budgets, isStreamingRequest) ?? customBudgetsError(customBudgets),
		monitoringError: monitorError(monitor, maxSeries),
		scenarioOnlyError: scenarioOnlyError(scenarioOnly),
	};
}

/** The message that stops Start, in the order the rules are reported. */
export function firstBlockingError(errors: DraftErrors): string | null {
	return (
		errors.rampDurationError ??
		errors.startFloorError ??
		errors.startConcurrencyError ??
		errors.capacityRangeError ??
		errors.profileRangeError ??
		errors.budgetsError ??
		errors.monitoringError ??
		errors.scenarioOnlyError
	);
}
