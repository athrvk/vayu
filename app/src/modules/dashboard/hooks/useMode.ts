/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The single source of truth for the dashboard's load-test mode. The run-config `mode` string is
 * freeform, so every mode-adaptive component MUST derive its behaviour from this discriminator
 * rather than re-parse the raw string, and the mapping lives in this file only.
 */

import { LOAD_TEST_MODES } from "@/constants/load-test-modes";
import type { LoadTestMode } from "@/types";

/** Dashboard-facing alias of the canonical {@link LoadTestMode}. */
export type LoadMode = LoadTestMode;

/**
 * Derived from `LOAD_TEST_MODES`, not hand-listed: a hand-written `Set<LoadMode>` is invisible to
 * the type checker when a member is *missing*, and a missing mode is normalised to `constant_rps`,
 * which turns every `case` arm for it downstream into dead code rendering open-loop cards. Derived,
 * a mode a user can *start* is by construction one the dashboard can *render*, and
 * `load-test-modes.test.ts` pins `LOAD_TEST_MODES` to the union, so the whole chain has one guard
 * rather than three lists to keep in step.
 */
const KNOWN_MODES: ReadonlySet<LoadMode> = new Set<LoadMode>(
	LOAD_TEST_MODES.map((mode) => mode.value)
);

/**
 * Normalise a raw run-config mode string into a {@link LoadMode}. Unknown or absent values fall
 * back to `constant_rps`, the model runs without an explicit mode tag were made under, so they
 * render as they always have.
 */
export function resolveMode(rawMode?: string): LoadMode {
	if (rawMode && KNOWN_MODES.has(rawMode as LoadMode)) {
		return rawMode as LoadMode;
	}
	return "constant_rps";
}

/**
 * Hook form of {@link resolveMode}: pure and synchronous, a hook so call sites stay consistent and
 * a store or config lookup can join it without a signature change.
 */
export function useMode(rawMode?: string): LoadMode {
	return resolveMode(rawMode);
}
