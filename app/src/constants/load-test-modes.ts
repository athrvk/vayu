/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The load-test modes, and the words for them - the single source of truth.
 *
 * This existed in four places, giving four answers. `utils/helpers.ts` said
 * "Iterations" and "Ramp Up"; the config dialog said "Fixed Iterations" and
 * "Ramp-Up"; `DashboardHeader` matched on `"rps"` / `"concurrency"`, which are
 * not values `LoadTestMode` can hold, so it fell through and printed the raw
 * `constant_rps` into the header. Same run, three different names depending on
 * which screen you were looking at.
 *
 * Renaming a mode is now a one-line edit here. That was the point: the previous
 * arrangement made a rename risky enough to talk yourself out of, which is how
 * the drift set in.
 */

import type { LoadTestMode } from "@/types";

export interface LoadTestModeInfo {
	value: LoadTestMode;
	/** Title-case name. Used wherever a run's mode is shown. */
	label: string;
	/** One line, for pickers. Not shown alongside `label` elsewhere. */
	description: string;
}

export const LOAD_TEST_MODES: readonly LoadTestModeInfo[] = [
	{
		value: "constant_rps",
		label: "Constant RPS",
		description: "Hold a fixed request rate for a set time.",
	},
	{
		value: "constant_concurrency",
		label: "Constant Concurrency",
		description: "Keep a fixed number of connections busy.",
	},
	{
		value: "iterations",
		label: "Fixed Iterations",
		description: "Send an exact number of requests, then stop.",
	},
	{
		value: "ramp_up",
		label: "Ramp-Up",
		description: "Climb to the target concurrency over a ramp.",
	},
];

const BY_VALUE = new Map<string, LoadTestModeInfo>(LOAD_TEST_MODES.map((m) => [m.value, m]));

/**
 * Words for a mode.
 *
 * Takes `string`, not `LoadTestMode`: modes arrive from stored runs and from
 * the engine, so an unrecognised value is a real possibility rather than a type
 * error. Unknown values are humanised (`some_new_mode` → `Some new mode`)
 * instead of being dropped or shown raw - a run from a newer engine should
 * still read as a name, not as a snake_case token.
 */
export function loadTestModeLabel(mode: string | undefined | null): string {
	if (!mode) return "";
	const known = BY_VALUE.get(mode);
	if (known) return known.label;
	const words = mode.replace(/_/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The mode's one-line description, or `""` when it is not one we know. */
export function loadTestModeDescription(mode: string | undefined | null): string {
	return (mode && BY_VALUE.get(mode)?.description) || "";
}
