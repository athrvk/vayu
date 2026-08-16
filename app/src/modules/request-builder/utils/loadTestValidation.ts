/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pure validation helpers for the load-test config dialog. Kept
 * component-free so they can be unit-tested in isolation.
 */

/**
 * For ramp_up runs, `duration` is the TOTAL test time and must include the
 * ramp. A total shorter than the ramp would end the test mid-ramp, so it is
 * rejected. Returns a user-facing error message when invalid, or null when the
 * config is fine (including for all non-ramp_up modes).
 */
export function validateRampDuration(
	mode: string | undefined,
	duration: number,
	rampDuration: number
): string | null {
	if (mode !== "ramp_up") return null;
	if (duration < rampDuration) {
		return `Total duration (${duration}s) must be at least the ramp duration (${rampDuration}s), since the ramp runs within the total. Increase the total duration or shorten the ramp.`;
	}
	return null;
}

/**
 * Both profiles that show the Start field - Ramp-Up and Capacity Discovery -
 * climb from `startConcurrency`, and neither can climb from nothing: the
 * engine floors the field at 1 (`startConcurrency` in `validate_run_config`,
 * `engine/src/http/routes/execution.cpp`) and answers a lower value with a 400.
 * Without this rule that 400 is the only feedback, arriving after Start is
 * pressed - and the field reaches 0 easily, because clearing a number input
 * reads back as `Number("") === 0`.
 *
 * A ramp from 0 is also the case measured in issue #694: the concurrency
 * integral truncates on the first ticks, showing ~0.8% structural lag on a
 * healthy run. Refusing the value rather than silently raising it to 1 means
 * the run that starts is the run the user described.
 *
 * Returns a user-facing message when invalid, or null (including for every
 * mode that does not send a start).
 */
export function validateStartConcurrencyFloor(
	mode: string | undefined,
	startConcurrency: number
): string | null {
	if (mode !== "ramp_up" && mode !== "capacity") return null;
	if (!Number.isFinite(startConcurrency)) {
		return "Start must be a number of connections, and at least 1.";
	}
	if (startConcurrency < 1) {
		return `Start (${startConcurrency}) must be at least 1, since the run climbs from it and cannot climb from nothing. The engine rejects a lower start rather than raising it for you.`;
	}
	return null;
}

/**
 * Ramp-Up climbs from `startConcurrency` to `concurrency`. A start above the
 * target is a ramp *down*, which contradicts the profile the user picked and is
 * almost always a transposed pair rather than an intent - the engine would
 * happily run it, shedding connections over the ramp.
 *
 * Returns a user-facing message when invalid, or null (including for every
 * non-ramp mode).
 */
export function validateStartConcurrency(
	mode: string | undefined,
	startConcurrency: number,
	concurrency: number
): string | null {
	if (mode !== "ramp_up") return null;
	if (startConcurrency > concurrency) {
		return `Start (${startConcurrency}) is above the target (${concurrency}), so this would ramp down rather than up. Lower the start or raise the target.`;
	}
	return null;
}

/**
 * Capacity Discovery climbs from `startConcurrency` toward `concurrency`. A
 * start at or above the ceiling is a search with nothing to search: the engine
 * measures the one level and stops `cap_reached`, which is a legitimate run but
 * never the one the user meant when they picked the profile whose whole job is
 * to find a limit.
 *
 * Returns a user-facing message when invalid, or null (including for every
 * non-capacity mode).
 */
export function validateCapacityRange(
	mode: string | undefined,
	startConcurrency: number,
	concurrency: number
): string | null {
	if (mode !== "capacity") return null;
	if (startConcurrency >= concurrency) {
		return `The search starts at ${startConcurrency} and stops at ${concurrency}, so it has only one level to measure and cannot find a limit. Lower the start or raise the ceiling.`;
	}
	return null;
}
