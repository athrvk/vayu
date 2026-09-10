/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** A wall-clock time (e.g. "2:14:03 PM") for a list row, from epoch milliseconds. */
export function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString();
}
