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
