/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The four load profiles.
 *
 * Split from `ProfilePicker.tsx` so that file exports only a component — mixing
 * constants in breaks fast refresh, which the linter flags.
 *
 * Names are kept exactly as they were. "Constant RPS" and "Fixed Iterations"
 * are what the history list, the dashboard and every saved run already say;
 * renaming them here would only desynchronise the vocabulary for no gain.
 */

import type { LoadTestConfig } from "@/types";

export type LoadTestMode = LoadTestConfig["mode"];

export interface ProfileOption {
	value: LoadTestMode;
	label: string;
	description: string;
}

export const PROFILES: readonly ProfileOption[] = [
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
