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
import { pluralize } from "@/modules/dashboard/utils/format";

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
		label: "Constant Virtual Users",
		description: "Keep a fixed number of virtual users busy.",
	},
	{
		value: "iterations",
		label: "Fixed Iterations",
		description: "Send an exact number of requests, then stop.",
	},
	{
		value: "ramp_up",
		label: "Ramp-Up",
		description: "Climb to the target number of virtual users over a ramp.",
	},
	{
		value: "capacity",
		label: "Capacity Discovery",
		description: "Step up until latency breaks its budget, then report the limit.",
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

/** The unit for exactly one, for callers that format the count themselves. */
export const CONCURRENCY_UNIT_SINGULAR = "virtual user";

/** The unit `formatConcurrency` speaks, plural. Exported for the guards that pin it. */
export const CONCURRENCY_UNIT = `${CONCURRENCY_UNIT_SINGULAR}s`;

/** The field label for the same quantity: "Virtual users". */
export const CONCURRENCY_LABEL = "Virtual users";

/**
 * A run's concurrency, in words: "1 virtual user", "64 virtual users".
 *
 * The UI once called this number five things - "Connections", "Concurrency",
 * "VUs", "workers" and "concurrent users" - and two screens described one run
 * differently. "Virtual users" is the owner's pick (#2128); `workers` in
 * particular is wrong, not merely inconsistent, because the engine owns that
 * name for its libcurl event-loop thread count. The API and MCP field names
 * (`concurrency`, `startConcurrency`, `maxConcurrency`) keep their spelling;
 * only copy a person reads changes. The open-loop in-flight measurement keeps
 * "In-flight requests" and does not use this helper.
 *
 * Callers pass the number and render the result; nobody appends the unit
 * themselves, which is what lets every surface stay in step. Prose that wants
 * the noun without a count reads `CONCURRENCY_UNIT` / `CONCURRENCY_LABEL`.
 */
export function formatConcurrency(concurrency: number): string {
	return `${concurrency} ${pluralize(concurrency, CONCURRENCY_UNIT_SINGULAR, CONCURRENCY_UNIT)}`;
}

/**
 * @deprecated Prefer `loadTestModeLabel` above.
 * Kept as a thin alias so existing call sites keep working; it used to hold its
 * own copy of the names, which is how "Iterations" and "Fixed Iterations" ended
 * up on screen for the same run.
 */
export function loadTestTypeToLabel(type: LoadTestMode | string): string {
	return loadTestModeLabel(type);
}
