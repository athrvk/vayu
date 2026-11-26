/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Pure validation helpers for the load-test dialogs, component-free to unit-test in isolation. */

import type { LimitRange } from "@/constants/load-test";

/**
 * The one range rule both load dialogs refuse a field by: finite, inside `range`, an integer when
 * `whole`. A number input's `min`/`max` are advisory (a typed value still reaches state), so
 * without this an over-ceiling value starts a run Settings forbid. `engineBound` marks a range
 * Settings cannot move, so the message does not point there.
 */
export function rangeError(
	label: string,
	value: number,
	range: LimitRange,
	{ whole, engineBound = false }: { whole: boolean; engineBound?: boolean }
): string | null {
	const shape = whole ? "a whole number" : "a number";
	const within = Number.isFinite(value) && value >= range.MIN && value <= range.MAX;
	if (within && (!whole || Number.isInteger(value))) return null;
	const source = engineBound ? "" : ", the ceiling set in Settings";
	return `${label} must be ${shape} from ${range.MIN.toLocaleString("en-US")} to ${range.MAX.toLocaleString("en-US")}${source}.`;
}

/**
 * For ramp_up, `duration` is the TOTAL time including the ramp, so a total shorter than the ramp
 * (ending mid-ramp) is refused. A user-facing message when invalid, else null (every other mode
 * too).
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
 * Ramp-Up and Capacity Discovery climb from `startConcurrency`, never from nothing: the engine
 * floors it at 1 (`validate_run_config`, `engine/src/http/routes/execution.cpp`) and 400s a lower
 * value, which without this rule is the only feedback, arriving after Start, and the field reaches
 * 0 easily (a cleared input reads `Number("") === 0`). A ramp from 0 is also #694's case: the
 * concurrency integral truncates early, showing ~0.8% lag on a healthy run. Refused, not silently
 * raised to 1, so the run is the one described. A message when invalid, else null (every mode
 * sending no start too).
 */
export function validateStartConcurrencyFloor(
	mode: string | undefined,
	startConcurrency: number
): string | null {
	if (mode !== "ramp_up" && mode !== "capacity") return null;
	if (!Number.isFinite(startConcurrency)) {
		return "Start must be a number of virtual users, and at least 1.";
	}
	if (startConcurrency < 1) {
		return `Start (${startConcurrency}) must be at least 1, since the run climbs from it and can't climb from nothing. Vayu's engine rejects a lower start rather than raising it for you.`;
	}
	return null;
}

/**
 * Ramp-Up climbs from `startConcurrency` to `concurrency`; a start above the target is a ramp
 * *down*, contradicting the profile and almost always a transposed pair (the engine would shed
 * users over the ramp). A message when invalid, else null (every non-ramp mode too).
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
 * Capacity Discovery climbs from `startConcurrency` toward `concurrency`; a start at or above the
 * ceiling has nothing to search: the engine measures one level and stops `cap_reached`, a
 * legitimate run but never the intent of the profile whose job is finding a limit. A message when
 * invalid, else null (every non-capacity mode too).
 */
export function validateCapacityRange(
	mode: string | undefined,
	startConcurrency: number,
	concurrency: number
): string | null {
	if (mode !== "capacity") return null;
	if (startConcurrency >= concurrency) {
		return `The search starts at ${startConcurrency} and stops at ${concurrency}, so it has only one level to measure and can't find a limit. Lower the start or raise the ceiling.`;
	}
	return null;
}
