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

import { LOAD_TEST_MODES } from "@/constants/load-test-modes";
import type { LoadTestMode } from "@/types";

/** Dashboard-facing alias of the canonical {@link LoadTestMode}. */
export type LoadMode = LoadTestMode;

/**
 * Derived from `LOAD_TEST_MODES`, not hand-listed.
 *
 * This was a third copy of the mode vocabulary - after the `LoadTestMode` union
 * and `LOAD_TEST_MODES` itself - and a hand-written `Set<LoadMode>` literal is
 * invisible to the type checker when a member is *missing*, only when one is
 * spurious. So `capacity` shipped in the union, in the picker and in both
 * mode-adaptive rows while this set still had four entries: `resolveMode`
 * normalised it to `constant_rps`, and every `case "capacity"` arm downstream
 * was dead code that rendered open-loop cards for a closed-loop search.
 *
 * Deriving it makes that unrepresentable. A mode a user can *start* is now by
 * construction a mode the dashboard can *render*, and `LOAD_TEST_MODES` is
 * already pinned to the union by `load-test-modes.test.ts`, so the whole chain
 * has one guard rather than three lists to keep in step.
 */
const KNOWN_MODES: ReadonlySet<LoadMode> = new Set<LoadMode>(
	LOAD_TEST_MODES.map((mode) => mode.value)
);

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
