/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestConfig } from "@/types";

/**
 * Duration is meaningless in `iterations`: the engine stops on
 * `requests_sent < iterations` and its branch in `load_strategy.cpp` never
 * reads duration - `docs/engine/api-reference.md` documents the field as
 * "constant_rps / constant_concurrency / ramp_up". The old dialog showed it
 * anyway, second on screen, and persisted whatever you typed. It already
 * half-knew: the OAuth guard is handed `null` in this mode precisely because
 * a duration-based warning would be nonsense.
 */
export function usesDuration(mode: LoadTestConfig["mode"]): boolean {
	return mode !== "iterations";
}
