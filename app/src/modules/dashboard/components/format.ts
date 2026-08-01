/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Number formatting for the dashboard cards. Separate from `shared.tsx`, which
 * re-exports components: a module holding both cannot be hot-reloaded.
 */

/** Format a possibly-undefined number, falling back to a dash. */
export function fmt(v: number | undefined, digits = 1): string {
	return v !== undefined ? v.toFixed(digits) : "-";
}
