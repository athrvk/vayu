/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useMode - the single source of truth for the dashboard's load-test mode.
 *
 * The engine/run-config `mode` string is freeform (and historically defaulted
 * to the constant_rps model). Every mode-adaptive component MUST derive its
 * behaviour from this discriminator rather than re-parsing the raw string, so
 * the mapping lives in exactly one place (Plan 4 code-quality gate #5).
 */

import type { LoadTestMode } from "@/types";

/** Dashboard-facing alias of the canonical {@link LoadTestMode}. */
export type LoadMode = LoadTestMode;

const KNOWN_MODES: ReadonlySet<LoadMode> = new Set<LoadMode>([
	"constant_rps",
	"constant_concurrency",
	"iterations",
	"ramp_up",
]);

/**
 * Normalise a raw run-config mode string into a {@link LoadMode}.
 *
 * Unknown/absent values fall back to `constant_rps` - the legacy model the
 * dashboard was originally built around, so behaviour is unchanged for runs
 * that predate explicit mode tagging.
 */
export function resolveMode(rawMode?: string): LoadMode {
	if (rawMode && KNOWN_MODES.has(rawMode as LoadMode)) {
		return rawMode as LoadMode;
	}
	return "constant_rps";
}

/**
 * Hook form of {@link resolveMode}. Pure and synchronous - there is no state
 * to subscribe to, but exposing it as a hook keeps call sites consistent and
 * leaves room to fold in store/config lookups later without a signature change.
 */
export function useMode(rawMode?: string): LoadMode {
	return resolveMode(rawMode);
}
