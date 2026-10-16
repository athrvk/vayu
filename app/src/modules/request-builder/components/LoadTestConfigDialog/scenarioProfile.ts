/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The load profile of a collection run: which modes a scenario accepts, the
 * fields a chosen mode sends in the scenario payload's spelling, and the rules
 * that stop Run.
 *
 * The per-mode field selection is `profileParams`, shared with the
 * single-request payload; only the spelling differs. A scenario's is camelCase
 * with `"Ns"` duration strings, and the same object seeds the dashboard's
 * `LoadTestRunConfig`, which reads those exact keys - so what the user is shown
 * while the run is live cannot drift from what the engine was sent.
 */

import {
	type LimitRange,
	type LoadTestLimits,
	LOAD_TEST_DEFAULTS,
	LOAD_TEST_LIMITS,
} from "@/constants/load-test";
import { CONCURRENCY_LABEL } from "@/constants/load-test-modes";
import type { StartScenarioRunRequest } from "@/types/api";
import {
	validateRampDuration,
	validateStartConcurrency,
	validateStartConcurrencyFloor,
} from "../../utils/loadTestValidation";
import { profileParams } from "./profile";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

/**
 * `constant_rps` and `capacity` are a `400` engine-side for a scenario: an
 * open-loop rate over a multi-step sequence is an arrival-rate executor Vayu
 * does not implement, and a capacity search judges one windowed p99 where a
 * sequence has one per step.
 */
export const SCENARIO_LOAD_MODES = ["constant_concurrency", "iterations", "ramp_up"] as const;

export type ScenarioLoadMode = (typeof SCENARIO_LOAD_MODES)[number];

export type ScenarioLoadProfile = LoadTestProfile & { mode: ScenarioLoadMode };

export function isScenarioLoadMode(mode: string): mode is ScenarioLoadMode {
	return (SCENARIO_LOAD_MODES as readonly string[]).includes(mode);
}

/**
 * A fresh collection run starts from its own numbers, not from the
 * single-request dialog's memo: a sequence multiplies its step count by the
 * virtual-user count (and by the pass count, in Fixed passes), so numbers
 * borrowed from a lone request would aim a folder's worth of requests at a
 * target nobody has decided to load. The fields no scenario mode reads (`rps`,
 * `stepDuration`, `sloMs`, the stream caps) are the single-request defaults and
 * never leave `profileParams`.
 */
export const SCENARIO_PROFILE_DEFAULTS: ScenarioLoadProfile = {
	mode: "constant_concurrency",
	duration: 30,
	rps: LOAD_TEST_DEFAULTS.RPS,
	concurrency: 10,
	iterations: 100,
	rampDuration: 10,
	startConcurrency: LOAD_TEST_DEFAULTS.START_CONCURRENCY,
	stepDuration: LOAD_TEST_DEFAULTS.STEP_DURATION_S,
	sloMs: LOAD_TEST_LIMITS.SLO_MS.MIN,
	streamDuration: LOAD_TEST_DEFAULTS.STREAM_DURATION_S,
	streamMaxEvents: LOAD_TEST_DEFAULTS.STREAM_MAX_EVENTS,
};

/** The load half of a scenario payload, and the dashboard's seed for the run. */
export type ScenarioLoadFields = Pick<
	StartScenarioRunRequest,
	"mode" | "duration" | "concurrency" | "startConcurrency" | "rampUpDuration" | "iterations"
> & { mode: ScenarioLoadMode; concurrency: number };

export function scenarioLoadFields(profile: ScenarioLoadProfile): ScenarioLoadFields {
	const { duration, iterations, rampDuration, startConcurrency } = profileParams(profile);
	return {
		mode: profile.mode,
		// Every mode a scenario accepts runs virtual users.
		concurrency: profile.concurrency,
		...(duration !== undefined && { duration: `${duration}s` }),
		...(iterations !== undefined && { iterations }),
		...(startConcurrency !== undefined && { startConcurrency }),
		...(rampDuration !== undefined && { rampUpDuration: `${rampDuration}s` }),
	};
}

function rangeError(
	label: string,
	value: number,
	range: LimitRange,
	{ whole }: { whole: boolean }
): string | null {
	const shape = whole ? "a whole number" : "a number";
	const within = Number.isFinite(value) && value >= range.MIN && value <= range.MAX;
	if (within && (!whole || Number.isInteger(value))) return null;
	return `${label} must be ${shape} from ${range.MIN.toLocaleString("en-US")} to ${range.MAX.toLocaleString("en-US")}, the ceiling set in Settings.`;
}

/**
 * The message that stops Run, or null. Bounded by the user's Settings ceilings
 * (`limits`) so an over-ceiling value is refused here, before the request,
 * where the engine would accept it.
 */
export function scenarioProfileError(
	profile: ScenarioLoadProfile,
	limits: LoadTestLimits
): string | null {
	const { mode, duration, concurrency, iterations } = profile;
	return (
		rangeError(CONCURRENCY_LABEL, concurrency, limits.CONCURRENCY, { whole: true }) ??
		(mode === "iterations"
			? rangeError("Passes through the sequence", iterations, limits.ITERATIONS, {
					whole: true,
				})
			: rangeError("Duration", duration, limits.DURATION_S, { whole: false })) ??
		(mode === "ramp_up" ? rampError(profile, limits) : null)
	);
}

function rampError(
	{ duration, concurrency, rampDuration, startConcurrency }: ScenarioLoadProfile,
	limits: LoadTestLimits
): string | null {
	return (
		rangeError("Ramp duration", rampDuration, limits.RAMP_DURATION_S, { whole: false }) ??
		validateStartConcurrencyFloor("ramp_up", startConcurrency) ??
		validateStartConcurrency("ramp_up", startConcurrency, concurrency) ??
		validateRampDuration("ramp_up", duration, rampDuration)
	);
}
